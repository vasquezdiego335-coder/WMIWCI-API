import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { apiLogger } from '@/lib/logger'
import { rateLimit, tooManyRequests, LIMITS, clientIp } from '@/lib/rate-limit'
import { capturePartialLeadSafe } from '@/lib/leads'
import { onQuoteRequestCaptured } from '@/lib/quote-capture'
import { quoteEstimate, compareClientTotal } from '@/lib/quote-estimate'
import { isValidMoveDate, parseMoveDate } from '@/lib/quote-date'
import type { QuoteLeadCaptureResponse } from '@/lib/quote-capture'

// ════════════════════════════════════════════════════════════════════════
//  POST /api/leads — PUBLIC, cross-origin. THE quick-quote capture endpoint.
//
//  WHY THIS FILE EXISTS. public/quote.html has POSTed here since it shipped,
//  but only `app/api/leads/partial/route.ts` ever existed — so every
//  quick-quote lead hit a 404 and was swallowed by the page's own
//  `.catch(function(){})`. Nobody was ever told.
//
//  ORDER OF OPERATIONS (each step's failure mode is deliberate):
//    1. feature flag        -> inert, honest response
//    2. rate limit          -> 429
//    3. parse              -> 422 naming only OUR field names, never values
//    4. honeypot           -> generic SUCCESS, nothing written (see below)
//    5. server pricing     -> the ONLY authoritative total
//    6. persist            -> failure still answers ok, estimate still shows
//    7. side effects       -> failure still answers ok, reported HONESTLY
//
//  THE RESPONSE IS A TYPED DISCRIMINATED UNION (QuoteLeadCaptureResponse).
//  The browser must be able to tell "saved and a copy is coming" from "saved
//  but we could not queue the email" from "not saved at all" — telling a
//  customer we emailed them when we did not is the failure this shape exists
//  to make impossible.
//
//  IT NEVER RETURNS THE LEAD ID. Dedupe is keyed on the client's own opaque
//  session id, so no internal identifier needs to reach the browser.
//
//  ENTERING AN EMAIL IS NOT CONSENT. `marketingConsent` stays TRI-STATE and is
//  forwarded only when the visitor actually touched the checkbox.
// ════════════════════════════════════════════════════════════════════════

export const runtime = 'nodejs'

const ALLOWED_ORIGINS = (
  process.env.CORS_ALLOWED_ORIGINS ??
  'http://localhost:3000,http://127.0.0.1:3000,http://localhost:8000,http://127.0.0.1:8000,https://www.wemoveitweclearit.com,https://wemoveitweclearit.com,https://www.moveitclearit.com,https://moveitclearit.com,https://wmiwci-backend.vercel.app'
)
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean)

/**
 * CORS is a BROWSER convention, not an access control — curl ignores it
 * entirely, which is why the rate limit, the honeypot and server-side pricing
 * carry the actual protection. What it must not do is reflect an arbitrary
 * origin: an unknown origin gets the canonical site, so a hostile page cannot
 * read the response.
 */
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

// KILL SWITCH, not a feature flag. This endpoint is the fix for a 404, so it
// is ON unless explicitly disabled — shipping it "off by default" would leave
// the quick quote exactly as broken as it was.
const enabled = () => process.env.QUOTE_LEAD_CAPTURE_ENABLED !== 'false'

/** Strip ASCII control chars, collapse whitespace. */
function sanitizeText(value: string): string {
  return value.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim()
}
const str = (max: number) => z.string().transform(sanitizeText).pipe(z.string().max(max)).optional()

const QuoteLeadSchema = z.object({
  // ── Required contact block. Validated STRICTLY here even though the browser
  //    validates too: the browser gate is UX, this one is the contract.
  firstName: z.string().transform(sanitizeText).pipe(z.string().min(1).max(100)),
  lastName: z.string().transform(sanitizeText).pipe(z.string().min(1).max(100)),
  phone: z.string().transform(sanitizeText).pipe(z.string().min(7).max(25)),
  email: z.string().transform((v) => sanitizeText(v).toLowerCase()).pipe(z.string().email().max(200)),

  // ── Optional preferences ──
  contactPreference: str(40),
  bestTimeToCall: str(120),

  // ── Move details ──
  moveDate: str(20),
  pickupZip: str(12),
  destinationZip: str(12),
  originCity: str(120),
  destCity: str(120),
  moveSize: str(40),
  /**
   * The browser's DISPLAYED total, in dollars. DIAGNOSTIC ONLY — it is compared
   * against the server's own calculation and logged on mismatch. It is never
   * stored, never emailed, never shown to the owner. See lib/quote-estimate.ts.
   */
  estimateTotal: z.number().nonnegative().max(1_000_000).optional(),

  // ── Identity / consent ──
  bookingSessionId: str(80),
  formStep: str(40),
  /** TRI-STATE: present only when the visitor actually toggled the checkbox. */
  marketingConsent: z.boolean().optional(),
  consentSource: str(60),
  consentVersion: str(40),
  locale: str(8),

  // ── Attribution. A promo code is NOT a marketing campaign; they are separate
  //    columns and separate inputs. Conflating them (promoCode = utmCampaign)
  //    filled the discount column with campaign slugs.
  promoCode: str(60),
  source: str(60),
  foundUs: str(60),
  utmSource: str(80),
  utmMedium: str(80),
  utmCampaign: str(120),
  utmContent: str(120),
  utmTerm: str(120),
  gclid: str(200),
  fbclid: str(200),
  landingPage: str(500),
  referrer: str(500),

  /**
   * HONEYPOT. Bounded but PERMISSIVE on purpose.
   *
   * This was `z.string().max(0).optional()`, which made the honeypot branch
   * below unreachable: a filled field failed schema validation first, so the
   * bot got a 422 that named `company` — telling it exactly which field to
   * leave alone next time. It must PARSE, then be silently discarded.
   */
  company: z.string().trim().max(200).optional(),
})

export async function POST(req: NextRequest): Promise<NextResponse> {
  const res = await handle(req)
  for (const [k, v] of Object.entries(corsHeaders(req.headers.get('origin')))) res.headers.set(k, v)
  return res
}

const json = (body: QuoteLeadCaptureResponse, status = 200) => NextResponse.json(body, { status })

async function handle(req: NextRequest): Promise<NextResponse> {
  if (!enabled()) return json({ ok: true, captured: false, reason: 'feature_disabled' })

  const rl = await rateLimit(LIMITS.quoteLead, [clientIp(req)])
  if (!rl.ok) {
    const res = json({ ok: false, captured: false, error: 'rate_limited' }, 429)
    // Preserve the house Retry-After behaviour from tooManyRequests().
    const stock = tooManyRequests(rl)
    const retry = stock.headers.get('Retry-After')
    if (retry) res.headers.set('Retry-After', retry)
    return res
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return json({ ok: false, captured: false, error: 'validation_error' }, 400)
  }

  const parsed = QuoteLeadSchema.safeParse(body)
  if (!parsed.success) {
    // The field LIST is safe to return — it names our own inputs, never their
    // values. The browser has already shown the customer the same messages, so
    // a 422 means the two gates disagree, which is worth surfacing.
    const fields = Object.keys(parsed.error.flatten().fieldErrors)
    apiLogger.warn({ fields }, 'POST /api/leads — validation failed')
    return json({ ok: false, captured: false, error: 'validation_error', fields }, 422)
  }

  const d = parsed.data

  // ── HONEYPOT ────────────────────────────────────────────────────────────
  // A generic SUCCESS: a bot that can tell rejection from acceptance will tune
  // around the trap. Nothing is written and nothing is queued.
  if (d.company && d.company.length > 0) {
    apiLogger.info({ trap: 'company' }, 'quote lead discarded (honeypot)')
    return json({ ok: true, captured: false, reason: 'spam_discarded' })
  }

  // ── MOVE DATE ───────────────────────────────────────────────────────────
  // Strict calendar validation, not a shape regex: `new Date('2026-02-31')`
  // silently becomes March 3rd, which would put a crew on the wrong day.
  if (d.moveDate) {
    const verdict = isValidMoveDate(d.moveDate)
    if (!verdict.ok) {
      apiLogger.warn({ reason: verdict.reason }, 'POST /api/leads — move date rejected')
      return json({ ok: false, captured: false, error: 'validation_error', fields: ['moveDate'] }, 422)
    }
  }

  // ── SERVER-AUTHORITATIVE PRICING ────────────────────────────────────────
  const priced = quoteEstimate({ moveSize: d.moveSize })
  if (!priced.ok && priced.reason === 'unknown_package') {
    // Never silently default to a price for something we do not sell.
    apiLogger.warn({ packageKey: priced.packageKey ?? '(unrecognised)' }, 'POST /api/leads — unknown package key')
    return json({ ok: false, captured: false, error: 'validation_error', fields: ['moveSize'] }, 422)
  }

  const serverCents = priced.ok ? priced.totalCents : null
  if (priced.ok) {
    const cmp = compareClientTotal(priced.totalDollars, d.estimateTotal)
    if (!cmp.matched) {
      // Two numbers and a package key — no payload, no identity. Either the
      // browser price book is stale (ours to fix) or someone is probing.
      apiLogger.warn(
        { packageKey: priced.packageKey, serverDollars: cmp.serverDollars, clientDollars: cmp.clientDollars, deltaDollars: cmp.deltaDollars },
        'quote total mismatch — server value used'
      )
    }
  }

  const result = await capturePartialLeadSafe(
    {
      email: d.email,
      firstName: d.firstName,
      lastName: d.lastName,
      phone: d.phone,
      bookingSessionId: d.bookingSessionId,
      formStep: d.formStep || 'quote',
      marketingConsent: d.marketingConsent,
      consentSource: d.consentSource || 'quick_quote_form',
      consentVersion: d.consentVersion,
      contactPreference: d.contactPreference,
      bestTimeToCall: d.bestTimeToCall,
      moveDate: parseMoveDate(d.moveDate),
      pickupZip: d.pickupZip,
      destinationZip: d.destinationZip,
      originCity: d.originCity,
      destCity: d.destCity,
      moveSize: priced.ok ? priced.packageKey : d.moveSize,
      source: d.source,
      foundUs: d.foundUs,
      utmSource: d.utmSource,
      utmMedium: d.utmMedium,
      utmCampaign: d.utmCampaign,
      utmContent: d.utmContent,
      utmTerm: d.utmTerm,
      gclid: d.gclid,
      fbclid: d.fbclid,
      landingPage: d.landingPage,
      referrer: d.referrer,
      // A REAL promo code only. Previously this was `d.utmCampaign`, which put
      // marketing campaign slugs in the discount column.
      promoCode: d.promoCode,
      // SERVER value. The browser's number never reaches the database.
      estimatedValue: serverCents,
    },
    'quote-lead'
  )

  // Persistence failed (DB down). The customer still gets their estimate —
  // capturePartialLeadSafe has already logged it.
  if (!result) {
    return json({ ok: false, captured: false, error: 'server_error' }, 200)
  }

  // Side effects. Awaited so a serverless invocation cannot freeze before they
  // run; neither throws, and neither can change `captured`.
  const outcome = await onQuoteRequestCaptured(result.lead.id, { locale: d.locale })

  apiLogger.info(
    {
      isNew: result.isNew,
      emailStatus: outcome.emailStatus,
      notificationStatus: outcome.notificationStatus,
      packageKey: priced.ok ? priced.packageKey : null,
    },
    'quote lead captured'
  )

  return json({
    ok: true,
    captured: true,
    emailStatus: outcome.emailStatus,
    notificationStatus: outcome.notificationStatus,
    // The server's own number, so a browser showing a stale price can correct
    // itself. Safe to expose: it is the price we publish.
    estimate: priced.ok
      ? { totalDollars: priced.totalDollars, isStarting: priced.isStarting, packageLabel: priced.packageLabel }
      : null,
  })
}

// Reject other verbs explicitly.
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ ok: false, error: 'method not allowed — use POST' }, { status: 405 })
}

// NOTE: a Next.js App Router route file may export ONLY route handlers and a
// fixed set of config keys — anything else fails `next build` with an opaque
// "not assignable to type 'never'" error that `tsc --noEmit` does not catch.
// MAX_BOOKING_HORIZON_DAYS is therefore imported from '@/lib/quote-date' by
// anything that needs it, and never re-exported from here.
