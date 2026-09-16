import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { apiLogger } from '@/lib/logger'
import { rateLimit, LIMITS, clientIp } from '@/lib/rate-limit'
import { offerSignupEnabled } from '@/lib/consent/grant-safeguards'
import { captureClient } from '@/lib/capture-basis'
import { offerSignupResponseBody, processOfferSignup } from '@/lib/offer-signup'

// ════════════════════════════════════════════════════════════════════════
//  POST /api/leads/offer-signup — PUBLIC, cross-origin. The 10%-off popup
//  (email consent release 2026-09-16, DESIGN-v2 §4 and §1 P5).
//
//  Replaces the legacy popup's post to the Leadtracking service. Loaded on six
//  pages (index, about, contact, faq, pricing, services), so the CORS allowlist
//  is the same www + apex set every other capture route uses.
//
//  DARK BY DEFAULT: unless OFFER_SIGNUP_ENABLED === 'true' this answers 404 and
//  does nothing at all. GET answers { ok: true, available: true } while it is
//  on; the popup asks that before it opens, so it never opens while dark.
//
//  THE RESPONSE NEVER DEPENDS ON THE ADDRESS. A well-formed request ALWAYS gets
//      200 { ok: true, code: 'MOVE10' }
//  whether the address is new, already known, suppressed, a test identity,
//  throttled, or the request tripped the honeypot or the per-IP rate limit.
//  Anything else would let the popup be used to learn whether somebody is on
//  our list. Only a MALFORMED request (not JSON, no usable email shape) is 400.
//
//  WHAT HAPPENS BEHIND IT lives in src/lib/offer-signup.ts (owner direction
//  2026-09-16): the lead is saved and the popup notice is recorded like every
//  other form's (never as an opt-in), and the address enters the existing
//  general lead nurture. No confirmation step.
// ════════════════════════════════════════════════════════════════════════

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

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
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

const notFound = () => NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 })

export async function OPTIONS(req: NextRequest): Promise<NextResponse> {
  if (!offerSignupEnabled()) return notFound()
  return new NextResponse(null, { status: 204, headers: corsHeaders(req.headers.get('origin')) })
}

/** Strip ASCII control chars, collapse whitespace. */
function sanitizeText(value: string): string {
  return value.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim()
}

const optionalText = (max: number) =>
  z.preprocess((v) => (v === null ? undefined : v), z.string().transform(sanitizeText).pipe(z.string().max(max)).optional())

const OfferSignupSchema = z.object({
  // The ONLY field whose shape decides 400. Everything else is lenient.
  email: z.string().transform((v) => sanitizeText(v).toLowerCase()).pipe(z.string().email().max(200)),
  locale: optionalText(8).catch(undefined),
  // Honeypot: bounded, so the handler — not the schema — decides.
  company: z.string().max(200).optional().catch(undefined),
  turnstileToken: z.string().max(2048).optional().catch(undefined),
  marketingNotice: z
    .object({ version: z.string().trim().max(64), trigger: z.string().trim().max(20).optional() })
    .optional()
    .catch(undefined),
  emailUserTyped: z.boolean().optional().catch(undefined),
  // Attribution the popup sends, stored on the lead.
  utmSource: optionalText(80).catch(undefined),
  utmMedium: optionalText(80).catch(undefined),
  utmCampaign: optionalText(120).catch(undefined),
  utmContent: optionalText(120).catch(undefined),
  utmTerm: optionalText(120).catch(undefined),
  referrer: optionalText(500).catch(undefined),
  landingPage: optionalText(500).catch(undefined),
})

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!offerSignupEnabled()) return notFound()
  const res = await handle(req)
  for (const [k, v] of Object.entries(corsHeaders(req.headers.get('origin')))) res.headers.set(k, v)
  return res
}

async function handle(req: NextRequest): Promise<NextResponse> {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid_request' }, { status: 400 })
  }
  const parsed = OfferSignupSchema.safeParse(body)
  if (!parsed.success) {
    // Names only OUR field list, never a value.
    return NextResponse.json({ ok: false, error: 'invalid_request' }, { status: 400 })
  }
  const d = parsed.data

  // Per-IP request limit. Exceeding it changes nothing the caller can see: the
  // code is public, and a different answer would itself be a signal.
  const rl = await rateLimit(LIMITS.coupon, [clientIp(req)])
  if (!rl.ok) {
    apiLogger.warn('POST /api/leads/offer-signup — rate limited (identical response)')
    return NextResponse.json(offerSignupResponseBody())
  }

  const outcome = await processOfferSignup({
    email: d.email,
    locale: d.locale,
    honeypot: d.company,
    turnstileToken: d.turnstileToken,
    marketingNotice: d.marketingNotice,
    emailUserTyped: d.emailUserTyped,
    attribution: {
      utmSource: d.utmSource,
      utmMedium: d.utmMedium,
      utmCampaign: d.utmCampaign,
      utmContent: d.utmContent,
      utmTerm: d.utmTerm,
      referrer: d.referrer,
      landingPage: d.landingPage,
    },
    client: captureClient(req),
  })
  // Log only — no address, and never part of the response.
  apiLogger.info(
    {
      status: outcome.status,
      reason: 'reason' in outcome ? outcome.reason : undefined,
      basis: outcome.status === 'saved' ? outcome.basis : undefined,
      scheduled: outcome.status === 'saved' ? outcome.scheduled : undefined,
    },
    'POST /api/leads/offer-signup handled',
  )
  return NextResponse.json(offerSignupResponseBody())
}

/**
 * "IS SIGN-UP LIVE?" — the popup asks this before it opens (popup.js
 * checkAvailable), so a site deployed before OFFER_SIGNUP_ENABLED is on keeps
 * the popup CLOSED instead of showing a form whose every submit fails, and
 * turning the flag off closes it again. A plain GET (no preflight) that says
 * nothing but the flag; while dark it is the same 404 as every other verb.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!offerSignupEnabled()) return notFound()
  const res = NextResponse.json({ ok: true, available: true }, { headers: { 'Cache-Control': 'no-store' } })
  for (const [k, v] of Object.entries(corsHeaders(req.headers.get('origin')))) res.headers.set(k, v)
  return res
}
