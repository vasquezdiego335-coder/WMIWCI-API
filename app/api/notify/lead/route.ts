import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { timingSafeEqual } from 'crypto'
import { notifyLead } from '@/lib/notify'
import { apiLogger } from '@/lib/logger'
import { rateLimit, tooManyRequests, LIMITS, clientIp } from '@/lib/rate-limit'
import { ingestLeadSafe } from '@/lib/leads'

// ════════════════════════════════════════════════════════════════════════
//  POST /api/notify/lead — internal, server-to-server.
//  Called by the marketing-tracker (Railway) whenever a new lead is created,
//  so WMIWCI-API can fan out the owner alert + customer auto-reply (SMS+email)
//  through its existing Twilio + Resend wiring.
//
//  Auth: shared secret in the `x-internal-token` header, compared in constant
//  time against INTERNAL_NOTIFY_TOKEN. Fails CLOSED (401) when the token is
//  unset or mismatched — this route can send real, billable messages.
//  NOTE: server-to-server only, so there is intentionally no CORS here.
// ════════════════════════════════════════════════════════════════════════

export const runtime = 'nodejs'

const Body = z.object({
  name: z.string().trim().max(100).optional(),
  phone: z.string().trim().max(25).optional(),
  email: z.string().trim().max(200).optional(),
  source: z.string().trim().max(60).optional(),
  found_us: z.string().trim().max(60).optional(),
  message: z.string().trim().max(2000).optional(),
  // Either key works; the tracker posts `language`, the rest of the app uses `locale`.
  language: z.string().trim().max(8).optional(),
  locale: z.string().trim().max(8).optional(),
})

function tokenOk(req: NextRequest): boolean {
  const expected = process.env.INTERNAL_NOTIFY_TOKEN?.trim()
  if (!expected) return false // fail closed: no token configured → reject
  const got = (req.headers.get('x-internal-token') ?? '').trim()
  // timingSafeEqual requires equal-length buffers; bail early on length mismatch.
  if (got.length !== expected.length) return false
  try {
    return timingSafeEqual(Buffer.from(got), Buffer.from(expected))
  } catch {
    return false
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!tokenOk(req)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  const rl = await rateLimit(LIMITS.notifyLead, [clientIp(req)])
  if (!rl.ok) return tooManyRequests(rl)


  let json: unknown
  try {
    json = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON' }, { status: 400 })
  }

  const parsed = Body.safeParse(json)
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'validation failed', details: parsed.error.flatten() },
      { status: 422 }
    )
  }

  const d = parsed.data
  // Persist to the admin Lead table BEFORE notifying (marketing tracker feed).
  await ingestLeadSafe(
    { name: d.name, phone: d.phone, email: d.email, message: d.message, source: d.source ?? 'marketing-tracker', foundUs: d.found_us },
    'notify-lead',
  )
  try {
    // notifyLead is internally guarded (each send is non-fatal); this await just
    // ensures the work is done before the serverless function freezes.
    await notifyLead({
      name: d.name,
      phone: d.phone,
      email: d.email,
      source: d.source,
      foundUs: d.found_us,
      message: d.message,
      locale: d.locale || d.language,
    })
  } catch (err) {
    apiLogger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'POST /api/notify/lead — notifyLead threw (unexpected)'
    )
    return NextResponse.json({ ok: false, error: 'notify failed' }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}

// Reject other verbs explicitly.
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ ok: false, error: 'method not allowed — use POST' }, { status: 405 })
}
