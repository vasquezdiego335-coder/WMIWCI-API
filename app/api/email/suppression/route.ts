import { NextRequest, NextResponse } from 'next/server'
import crypto from 'node:crypto'
import { prisma } from '@/lib/db'
import { normalizeEmail } from '@/lib/email-tokens'
import { suppress } from '@/lib/email-suppression'
import type { SuppressionReason } from '@prisma/client'

// ════════════════════════════════════════════════════════════════════════
//  CROSS-SYSTEM SUPPRESSION  —  /api/email/suppression
//  ----------------------------------------------------------------------
//  THE GAP THIS CLOSES: two systems mail the same people from two providers —
//  WMIWCI-API (Resend, transactional + post-job) and Leadtracking (SendGrid,
//  the lead drip) — and each kept its OWN opt-out state. A customer who
//  unsubscribed from a Leadtracking drip would still receive an abandoned-
//  checkout email from the API, and vice-versa. One unsubscribe must mean
//  unsubscribed, everywhere.
//
//  This API makes THIS database the shared source of truth:
//    GET  ?email=…   → is this address suppressed?      (Leadtracking asks
//                      before every promotional send)
//    POST {email,reason} → record a suppression here    (Leadtracking pushes
//                      its own unsubscribes/bounces in)
//
//  AUTH: a shared secret in `x-suppression-key`, compared in constant time.
//  Without EMAIL_SUPPRESSION_API_KEY set, the route is DISABLED (503) rather
//  than open — an unauthenticated suppression endpoint is both a customer-
//  enumeration oracle and a denial-of-service vector against real mail.
//
//  Deliberately NOT public and NOT reachable from an email link: the customer-
//  facing path is /api/email/unsubscribe, which uses signed per-address tokens.
// ════════════════════════════════════════════════════════════════════════

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const VALID_REASONS: ReadonlySet<string> = new Set([
  'UNSUBSCRIBED',
  'HARD_BOUNCE',
  'SPAM_COMPLAINT',
  'INVALID_ADDRESS',
  'ADMIN_BLOCK',
  'PROVIDER_REJECTED',
])

/** Constant-time shared-secret check. Returns an error response, or null if OK. */
function authorize(req: NextRequest): NextResponse | null {
  const expected = process.env.EMAIL_SUPPRESSION_API_KEY?.trim()
  if (!expected) {
    return NextResponse.json({ ok: false, error: 'suppression_api_disabled' }, { status: 503 })
  }
  const given = req.headers.get('x-suppression-key')?.trim() ?? ''
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  return null
}

/** Is an address suppressed? Answers only for an authorized caller. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const denied = authorize(req)
  if (denied) return denied

  const email = normalizeEmail(req.nextUrl.searchParams.get('email') ?? '')
  if (!email) return NextResponse.json({ ok: false, error: 'email_required' }, { status: 400 })

  try {
    const row = await prisma.emailSuppression.findUnique({
      where: { email },
      select: { reason: true, scope: true, source: true, createdAt: true },
    })
    return NextResponse.json({
      ok: true,
      suppressed: Boolean(row),
      reason: row?.reason ?? null,
      scope: row?.scope ?? null,
      source: row?.source ?? null,
      since: row?.createdAt ?? null,
    })
  } catch {
    // FAIL CLOSED. A caller that cannot get an answer must not send.
    return NextResponse.json(
      { ok: false, suppressed: true, reason: 'suppression_read_failed' },
      { status: 503 }
    )
  }
}

/** Push a suppression in from another system (Leadtracking/SendGrid). */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const denied = authorize(req)
  if (denied) return denied

  let body: { email?: string; reason?: string; source?: string; detail?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 })
  }

  const email = normalizeEmail(body.email ?? '')
  if (!email) return NextResponse.json({ ok: false, error: 'email_required' }, { status: 400 })

  const reason = (body.reason ?? 'UNSUBSCRIBED').toUpperCase()
  if (!VALID_REASONS.has(reason)) {
    return NextResponse.json({ ok: false, error: 'invalid_reason' }, { status: 400 })
  }

  const created = await suppress({
    email,
    reason: reason as SuppressionReason,
    source: body.source ?? 'leadtracking',
    detail: body.detail,
  })

  // `created: false` means it was already covered — still a success (idempotent).
  return NextResponse.json({ ok: true, created })
}
