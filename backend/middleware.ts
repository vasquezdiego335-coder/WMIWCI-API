import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromRequest, verifyCsrfToken, generateCsrfToken } from './src/lib/auth'
import { UserRole } from '@prisma/client'

// ── Route permission map ──────────────────────────────────────
const PROTECTED_ROUTES: { pattern: RegExp; roles: UserRole[] }[] = [
  { pattern: /^\/admin(\/|$)/, roles: [UserRole.OWNER, UserRole.MANAGER] },
  { pattern: /^\/api\/admin/, roles: [UserRole.OWNER, UserRole.MANAGER] },
  { pattern: /^\/api\/files\/upload/, roles: [UserRole.OWNER, UserRole.MANAGER, UserRole.CREW] },
]

// ── Rate limiting — simple in-memory counter ──────────────────
const ipCounts = new Map<string, { count: number; resetAt: number }>()

function checkRateLimit(ip: string, max: number, windowMs: number): boolean {
  const now = Date.now()
  const entry = ipCounts.get(ip)

  if (!entry || entry.resetAt < now) {
    ipCounts.set(ip, { count: 1, resetAt: now + windowMs })
    return true
  }
  if (entry.count >= max) return false
  entry.count++
  return true
}

// ── Rate limit configs per route type ────────────────────────
function getRateLimitConfig(pathname: string): { max: number; window: number } | null {
  if (pathname.startsWith('/api/auth/login')) {
    return { max: parseInt(process.env.RATE_LIMIT_LOGIN ?? '10', 10), window: 15 * 60 * 1000 }
  }
  if (pathname.startsWith('/api/bookings') && !pathname.includes('/admin')) {
    return { max: parseInt(process.env.RATE_LIMIT_BOOKING ?? '5', 10), window: 60 * 60 * 1000 }
  }
  return null
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '127.0.0.1'

  // ── Rate limiting ─────────────────────────────────────────
  const rateConfig = getRateLimitConfig(pathname)
  if (rateConfig) {
    const allowed = checkRateLimit(ip, rateConfig.max, rateConfig.window)
    if (!allowed) {
      return NextResponse.json(
        { error: 'Too many requests. Please slow down.' },
        { status: 429, headers: { 'Retry-After': '60' } }
      )
    }
  }

  // ── Skip webhooks entirely ────────────────────────────────
  if (
    pathname === '/api/stripe/webhook' ||
    pathname === '/api/discord/interactions'
  ) {
    return NextResponse.next()
  }

  // ── CSRF check on state-mutating API calls ─────────────────
  if (pathname.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const csrfExempt = ['/api/stripe/', '/api/discord/'].some((p) =>
      pathname.startsWith(p)
    )
    if (!csrfExempt && !verifyCsrfToken(req)) {
      return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 })
    }
  }

  // ── Auth check for protected routes ───────────────────────
  const match = PROTECTED_ROUTES.find((r) => r.pattern.test(pathname))
  if (match) {
    const session = await getSessionFromRequest(req)
    if (!session) {
      if (pathname.startsWith('/api/')) {
        return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
      }
      const loginUrl = new URL('/admin/login', req.url)
      loginUrl.searchParams.set('next', pathname)
      return NextResponse.redirect(loginUrl)
    }

    if (!match.roles.includes(session.role)) {
      if (pathname.startsWith('/api/')) {
        return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 })
      }
      return NextResponse.redirect(new URL('/admin', req.url))
    }
  }

  // ── Set CSRF cookie on all non-API requests ────────────────
  const res = NextResponse.next()
  if (!pathname.startsWith('/api/')) {
    const csrfToken = generateCsrfToken()
    res.cookies.set('moveit_csrf', csrfToken, {
      httpOnly: false,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/',
      maxAge: 60 * 60 * 24,
    })
  }

  return res
}

// ── MATCHER: ONLY PROTECT ADMIN ROUTES ───────────────────────
export const config = {
  matcher: [
    '/admin/:path*',
    '/api/admin/:path*',
  ],
}
