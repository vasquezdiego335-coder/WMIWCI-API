import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromRequest, verifyCsrfToken, generateCsrfToken } from './src/lib/auth'
import { UserRole } from '@prisma/client'

// ── Route permission map ──────────────────────────────────────
const PROTECTED_ROUTES: { pattern: RegExp; roles: UserRole[] }[] = [
  { pattern: /^\/admin(\/|$)/, roles: [UserRole.OWNER, UserRole.MANAGER] },
  { pattern: /^\/api\/admin/, roles: [UserRole.OWNER, UserRole.MANAGER] },
  { pattern: /^\/api\/files\/upload/, roles: [UserRole.OWNER, UserRole.MANAGER, UserRole.CREW] },
  // ── Stage 5: the crew operational surface. CREW may reach it (and only it);
  //    owners and managers may use the same worker view while keeping their own
  //    permissions. Route handlers still enforce own-assignment ownership.
  { pattern: /^\/crew(\/|$)/, roles: [UserRole.OWNER, UserRole.MANAGER, UserRole.CREW] },
  { pattern: /^\/api\/crew/, roles: [UserRole.OWNER, UserRole.MANAGER, UserRole.CREW] },
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
      // Send the user to a surface their role CAN reach. Redirecting a CREW
      // session to /admin would re-fail this same gate on every request — the
      // confirmed login redirect loop. The role gates above are unchanged.
      const fallback = session.role === UserRole.CREW ? '/crew' : '/admin'
      return NextResponse.redirect(new URL(fallback, req.url))
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
    '/admin/scheduling/:path*',
    '/admin/scheduling',
    '/admin/queues/:path*',
    '/admin/queues',
    // Stage 3B: reporting pages must be auth-gated by the middleware too, not
    // only by the layout redirect.
    '/admin/reports/:path*',
    '/admin/reports',
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
    // ── Moving OS Phase 1 surfaces (2026-08-12 auth audit, fix-doc item 8) ──
    // These pages shipped WITHOUT matcher entries, so the PROTECTED_ROUTES gate
    // above never ran for them: middleware executes ONLY on paths listed here.
    // The (dashboard) layout still redirects, but until these lines existed the
    // layout was the SINGLE gate — and a page moved out of that layout (see
    // /admin/closeout-summary below) would have had none at all. Same class of
    // gap as /api/files/upload, which is in PROTECTED_ROUTES but deliberately
    // absent here (customers upload with a booking token, not a session — see
    // src/lib/__tests__/admin-route-coverage.test.ts for why that one stays out).
    '/admin/book/:path*',
    '/admin/book',
    '/admin/trucks/:path*',
    '/admin/trucks',
    '/admin/leads/:path*',
    '/admin/leads',
    // Pre-existing gaps of the identical class, found by the same audit.
    '/admin/email-marketing/:path*',
    '/admin/email-marketing',
    // Printable closeout summary renders OUTSIDE the (dashboard) layout on
    // purpose (no chrome), so it never had a layout gate — only its own
    // getSession + money.view_company_profit check. Now gated here too.
    '/admin/closeout-summary/:path*',
    '/admin',  // protect the root /admin page
    // Covers every /api/admin/* route including [id] instances
    // (e.g. /api/admin/leads/abc123) — verified in admin-route-coverage.test.ts.
    '/api/admin/:path*',
    // Stage 5 crew operational surface.
    '/crew/:path*',
    '/crew',
    '/api/crew/:path*',
  ],
}
