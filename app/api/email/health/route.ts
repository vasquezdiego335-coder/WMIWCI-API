import { NextRequest, NextResponse } from 'next/server'
import crypto from 'node:crypto'
import { runDiagnostics, recentBlocks } from '@/lib/email-diagnostics'

// ════════════════════════════════════════════════════════════════════════
//  EMAIL HEALTH  —  GET /api/email/health
//  ----------------------------------------------------------------------
//  Reports what the RUNNING container believes about its email configuration.
//  During staging this is the difference between guessing and knowing: a
//  variable set in the wrong Railway environment, a service that missed a
//  redeploy, or a secret pasted with a trailing newline all look identical from
//  the outside until you can ask the container directly.
//
//  AUTH: the shared suppression key, so this is not public. It reveals no
//  secret VALUES — only presence, length, and a SHA-256 fingerprint prefix.
//  The fingerprint is the point: run this against the API and the worker and
//  compare. If EMAIL_TOKEN_SECRET differs between them, the worker signs
//  unsubscribe links the API cannot verify, and every one of them is dead.
//
//  Deliberately NOT gated behind admin login: you need it working before the
//  admin app is trustworthy, and during an incident.
// ════════════════════════════════════════════════════════════════════════

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function authorize(req: NextRequest): NextResponse | null {
  const expected = process.env.EMAIL_SUPPRESSION_API_KEY?.trim()
  if (!expected) {
    // Without a key there is nothing to authenticate against. Refuse rather
    // than expose configuration state to the internet.
    return NextResponse.json(
      { ok: false, error: 'diagnostics_disabled', hint: 'set EMAIL_SUPPRESSION_API_KEY to enable this endpoint' },
      { status: 503 }
    )
  }
  const given = (req.headers.get('x-suppression-key') ?? req.nextUrl.searchParams.get('key') ?? '').trim()
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  return null
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const denied = authorize(req)
  if (denied) return denied

  const diagnostics = await runDiagnostics()

  // ?blocks=1 adds the most recent refusals — the "why didn't this customer
  // get their email?" view, without needing database access.
  const wantBlocks = req.nextUrl.searchParams.get('blocks') === '1'
  const blocks = wantBlocks ? await recentBlocks(20) : undefined

  // 'blocked' means a check FAILED, so a non-200 makes it visible to any
  // uptime monitor pointed here.
  const httpStatus = diagnostics.status === 'blocked' ? 503 : 200

  return NextResponse.json({ ...diagnostics, ...(blocks ? { recentBlocks: blocks } : {}) }, { status: httpStatus })
}
