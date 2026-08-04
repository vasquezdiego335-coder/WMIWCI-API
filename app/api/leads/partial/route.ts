import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { apiLogger } from '@/lib/logger'
import { rateLimit, tooManyRequests, LIMITS, clientIp } from '@/lib/rate-limit'
import { capturePartialLeadSafe } from '@/lib/leads'

// ════════════════════════════════════════════════════════════════════════
//  POST /api/leads/partial — PUBLIC, cross-origin (called from the static
//  booking form the instant a valid email is entered in Step 1).
//
//  Captures a properly-attributed PARTIAL booking lead BEFORE the visitor
//  reaches Continue / pricing / Stripe, so a door-hanger scan that abandons
//  still shows up as ONE lead. Deliberately best-effort + non-blocking:
//    - FEATURE-FLAGGED: unless PARTIAL_BOOKING_EMAIL_CAPTURE_ENABLED === 'true'
//      this route writes NOTHING and answers { ok:true, skipped:'flag_off' } —
//      so the form behaves exactly as it did before the feature.
//    - Never 500s for a business reason (capturePartialLeadSafe never throws);
//      the client fires this fire-and-forget and ignores the response.
//    - SILENT: no Discord/email/SMS, no promotional automation — entering an
//      email is not consent, and this must not spam the owner or the visitor.
//  Mirrors /api/contact for CORS + sanitize + rate-limit + honeypot.
// ════════════════════════════════════════════════════════════════════════

export const runtime = 'nodejs'

const ALLOWED_ORIGINS = (
  process.env.CORS_ALLOWED_ORIGINS ??
  'http://localhost:3000,http://127.0.0.1:3000,http://localhost:8000,http://127.0.0.1:8000,https://www.wemoveitweclearit.com,https://wemoveitweclearit.com,https://www.moveitclearit.com,https://moveitclearit.com,https://wmiwci-backend.vercel.app'
)
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean)

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

export async function OPTIONS(req: NextRequest): Promise<NextResponse> {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req.headers.get('origin')) })
}

const flagOn = () => process.env.PARTIAL_BOOKING_EMAIL_CAPTURE_ENABLED === 'true'

// ── Sanitizer: strip ASCII control chars, collapse whitespace. ──
function sanitizeText(value: string): string {
  return value.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim()
}
const str = (max: number) => z.string().transform(sanitizeText).pipe(z.string().max(max)).optional()

const PartialSchema = z.object({
  // Email is validated + normalized server-side by capturePartialLead; keep the
  // schema lenient so a half-typed value is a silent no-op, never a 422.
  email: z.string().transform((v) => sanitizeText(v).toLowerCase()).pipe(z.string().max(200)).optional(),
  firstName: str(100),
  lastName: str(100),
  phone: str(25),
  bookingSessionId: str(80),
  formStep: str(40),
  // TRI-STATE consent: present boolean only when the visitor actually toggled the
  // checkbox; omitted = never interacted (server leaves any stored value alone).
  marketingConsent: z.boolean().optional(),
  consentVersion: str(40),
  source: str(60),
  foundUs: str(60),
  // ── Added 2026-08-03. z.object() STRIPS unknown keys rather than rejecting
  //    them, so the booking form was free to send these and have them silently
  //    evaporate — the exact failure mode that lost the access answers in the
  //    2026-07-28 review. If the form sends it, the schema must name it.
  contactPreference: str(40),
  bestTimeToCall: str(120),
  /** Ad click ids. Presence alone proves the paying channel. */
  gclid: str(200),
  fbclid: str(200),
  utmSource: str(80),
  utmMedium: str(80),
  utmCampaign: str(120),
  utmContent: str(120),
  utmTerm: str(120),
  landingPage: str(500),
  referrer: str(500),
  // Live estimate in DOLLARS; converted to cents for the Lead.
  //
  // NOTE: this endpoint deliberately still trusts the caller's figure. It is
  // the shared handler behind the DEPLOYED /api/leads alias, whose six capture
  // surfaces send an estimate WITHOUT a package key — re-pricing here would
  // blank their stored value. Server-authoritative pricing lives on the new
  // /api/leads/quote-capture endpoint, which receives a package key it can
  // actually price. Tightening this route is a separate, coordinated change.
  estimateTotal: z.number().nonnegative().max(1_000_000).optional(),
  // HONEYPOT. Bounded but PERMISSIVE: `.max(0)` made the discard branch below
  // unreachable (zod 422'd first) AND named the trap field back to the bot.
  company: z.string().trim().max(200).optional(),
})

export async function POST(req: NextRequest): Promise<NextResponse> {
  const res = await handle(req)
  for (const [k, v] of Object.entries(corsHeaders(req.headers.get('origin')))) res.headers.set(k, v)
  return res
}

async function handle(req: NextRequest): Promise<NextResponse> {
  // Flag OFF ⇒ inert. No parsing, no writes, no rate-limit consumption.
  if (!flagOn()) return NextResponse.json({ ok: true, skipped: 'flag_off' })

  const rl = await rateLimit(LIMITS.partialLead, [clientIp(req)])
  if (!rl.ok) return tooManyRequests(rl) // fail-open config: only blocks when Upstash-backed

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON' }, { status: 400 })
  }

  const parsed = PartialSchema.safeParse(body)
  if (!parsed.success) {
    // Shape/length problems are a client bug, not a customer error — 200 so the
    // fire-and-forget caller never surfaces anything, but record why for triage.
    apiLogger.warn({ issues: parsed.error.flatten() }, '/api/leads/partial — validation skipped')
    return NextResponse.json({ ok: true, skipped: 'invalid_shape' })
  }

  const d = parsed.data

  // Honeypot tripped → pretend success, drop silently.
  if (d.company && d.company.length > 0) return NextResponse.json({ ok: true, skipped: 'honeypot' })

  const result = await capturePartialLeadSafe(
    {
      email: d.email,
      firstName: d.firstName,
      lastName: d.lastName,
      phone: d.phone,
      bookingSessionId: d.bookingSessionId,
      formStep: d.formStep,
      marketingConsent: d.marketingConsent,
      consentSource: 'booking_step_1',
      consentVersion: d.consentVersion,
      source: d.source,
      foundUs: d.foundUs,
      contactPreference: d.contactPreference,
      bestTimeToCall: d.bestTimeToCall,
      gclid: d.gclid,
      fbclid: d.fbclid,
      utmSource: d.utmSource,
      utmMedium: d.utmMedium,
      utmCampaign: d.utmCampaign,
      utmContent: d.utmContent,
      utmTerm: d.utmTerm,
      landingPage: d.landingPage,
      referrer: d.referrer,
      promoCode: d.utmCampaign, // door-hanger/QR campaign code doubles as the promo code slot
      estimatedValue: typeof d.estimateTotal === 'number' ? Math.round(d.estimateTotal * 100) : null,
    },
    'partial-lead',
  )

  return NextResponse.json({ ok: true, captured: !!result, isNew: result?.isNew ?? false })
}

// Reject other verbs explicitly.
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ ok: false, error: 'method not allowed — use POST' }, { status: 405 })
}
