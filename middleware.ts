import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromRequest, verifyCsrfToken, generateCsrfToken } from './src/lib/auth'
import { UserRole } from '@prisma/client'

// ── Route permission map ──────────────────────────────────────
const PROTECTED_ROUTES: { pattern: RegExp; roles: UserRole[] }[] = [
  { pattern: /^\/admin(\/|$)/, roles: [UserRole.OWNER, UserRole.MANAGER] },
  { pattern: /^\/api\/admin/, roles: [UserRole.OWNER, UserRole.MANAGER] },
  { pattern: /^\/api\/files\/upload/, roles: [UserRole.OWNER, UserRole.MANAGER, UserRole.CREW] },
]

// ── Rate limiting ─────────────────────────────────────────────
// Distributed, per-route rate limiting now lives in src/lib/rate-limit.ts and is
// enforced INSIDE each sensitive route handler (login, bookings, contact,
// notify/lead). The old in-memory limiter here was dead: its configured paths
// (/api/auth/login, /api/bookings) were never in the `matcher` below, and a
// per-instance Map does not hold across Railway/serverless instances anyway.

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl

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

// ── MATCHER: PROTECT ADMIN ROUTES (EXCEPT LOGIN) ──────────────
export const config = {
  matcher: [
    // Protect all /admin routes except /admin/login (listed individually)
    '/admin/bookings/:path*',
    '/admin/bookings',
    '/admin/customers/:path*',
    '/admin/customers',
    '/admin/jobs/:path*',
    '/admin/jobs',
    '/admin/staff/:path*',
    '/admin/staff',
    '/admin/schedule/:path*',
    '/admin/schedule',
    '/admin/queues/:path*',
    '/admin/queues',
    '/admin/payments/:path*',
    '/admin/payments',
    '/admin/discounts/:path*',
    '/admin/discounts',
    '/admin/expenses/:path*',
    '/admin/expenses',
    '/admin/owner-money/:path*',
    '/admin/owner-money',
    '/admin/action-center/:path*',
    '/admin/action-center',
    '/admin/roadmap/:path*',
    '/admin/roadmap',
    '/admin/logs/:path*',
    '/admin/logs',
    '/admin',  // protect the root /admin page
    '/api/admin/:path*',
  ],
}
