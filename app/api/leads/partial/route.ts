import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { normaliseConsentSource } from '@/lib/consent'
import { apiLogger } from '@/lib/logger'
import { rateLimit, tooManyRequests, LIMITS, clientIp } from '@/lib/rate-limit'
import { quoteCaptureRouteDeps } from '@/lib/quote-capture-deps'
import { PRICE_BOOK_VERSION } from '@/lib/pricing-config'
import { pricePartialLead } from '@/lib/partial-lead-pricing'

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
//    - SILENT WITHOUT CONSENT: no Discord, no email, no promotional automation.
//      Entering an email is not consent.
//  Mirrors /api/contact for CORS + sanitize + rate-limit + honeypot.
//
//  ── STEP 1 IS NO LONGER A DEAD END (owner spec 2026-08-07) ──────────────
//  This route stored the lead and its consent and then scheduled NOTHING. So
//  somebody could start a booking, type their email, deliberately tick "yes,
//  email me", leave before /api/bookings — and never hear from us again. The
//  capture was working perfectly and going nowhere.
//
//  A consented, eligible partial lead now enters the SAME non-quote nurture
//  every other consented lead uses (journeys.onLeadCaptured, Sequence B). No
//  second email universe: one sequence, one set of stop rules, one send gate.
//  onLeadCaptured refuses on its own for a lead with no explicit opt-in, one
//  that already has a real quote, a previous customer, or a converted/lost
//  lead — so this call is safe for every visitor, and silent for most.
//
//  AND IT HANDS OVER CLEANLY. When the visitor does reach /api/bookings, the
//  booking hand-over (journeys.onBookingCreated) converts the lead and cancels
//  Sequence B before starting the abandoned-checkout journey — so nobody ever
//  holds "still thinking about moving?" and "you left something behind" at the
//  same time. If a real quote arrives instead, ensureQuoteJourney cancels
//  Sequence B and Sequence A takes over. The booking always wins.
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

/**
 * Parse a move date without ever rejecting the submission.
 *
 * A visitor typing a half-finished or nonsense date must still have their lead
 * captured — losing the whole contact over an unparseable optional field would
 * be the worst possible trade.
 */
function parseMoveDate(raw?: string | null): Date | null {
  if (!raw) return null
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return null
  // Bounded: a typo like year 0202 or 9999 is not a move date.
  const year = d.getUTCFullYear()
  if (year < 2020 || year > 2100) return null
  return d
}

// ── Sanitizer: strip ASCII control chars, collapse whitespace. ──
function sanitizeText(value: string): string {
  return value.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim()
}
/**
 * An OPTIONAL string field, tolerant of an explicit `null`.
 *
 * WHY THE preprocess. Zod's `.optional()` accepts `undefined` and REJECTS
 * `null`, so a client that serialises a missing value as `null` fails the
 * whole request on shape. That is not a theoretical shape quibble: the quote
 * page briefly sent `priceBookVersion: null` from a cached mirror that
 * predated the field, which 422'd the submission BEFORE the retired-package
 * check could run — and the browser, which only handles `pricing_expired`
 * specially, fell through and revealed the stale price it had cached.
 *
 * For an OPTIONAL field, `null` and `undefined` mean the same thing: the
 * client does not have a value. Normalising them together loses nothing and
 * removes an entire class of lead-destroying 422s from older clients.
 */
const str = (max: number) =>
  z.preprocess(
    (v) => (v === null ? undefined : v),
    z.string().transform(sanitizeText).pipe(z.string().max(max)).optional(),
  ) as z.ZodType<string | undefined>

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
  /* WAS THE CHECKBOX ON SCREEN? (incident fix 2026-08-25)
     `marketingConsent` alone could not answer this. The booking form sent a
     value only once the box had been CLICKED, so a visitor who saw it and left
     it alone arrived indistinguishable from one whose form has no box at all —
     and the owner card said "Marketing: not asked" about a customer we had in
     fact asked. TRUE = the disclosure was displayed; FALSE = this surface
     carries no marketing question; absent = the client cannot say, and the
     server infers NOTHING. */
  marketingConsentPresented: z.boolean().optional(),
  consentVersion: str(40),
  source: str(60),
  foundUs: str(60),
  /* WAS "How did you hear about us?" REACHED? It sits on card4 of the booking
     form, four steps after the contact details that trigger this capture, so a
     partial lead must be able to say "not yet" rather than letting the absence
     of an answer be read as one. */
  foundUsPresented: z.boolean().optional(),
  utmSource: str(80),
  utmMedium: str(80),
  utmCampaign: str(120),
  utmContent: str(120),
  utmTerm: str(120),
  landingPage: str(500),
  referrer: str(500),
  /* THE QR SCAN ID. All 2,500 printed door hangers share ONE code, so `source`
     can say "a door hanger" and never "which scan" — this is the only value
     that ties a lead back to an individual card, and therefore the only thing
     that makes scan-to-booking conversion answerable.

     It was accepted by /api/leads/quote-capture and by /api/bookings but NOT
     here, so every lead captured through the BOOKING FORM arrived with
     attribution_id NULL however it was scanned. Shape-checked server-side by
     cleanAttributionId, so a mangled shared link drops the attribution rather
     than putting junk in the column the campaign report JOINs on. */
  attributionId: str(64),
  // Live estimate in DOLLARS; converted to cents for the Lead. Bounded.
  estimateTotal: z.number().nonnegative().max(1_000_000).optional(),
  // ── Move details (owner spec 2026-07-28) ──
  moveDate: z.string().max(40).optional(),
  pickupZip: str(12),
  destinationZip: str(12),
  /* ROUTEABLE-END EVIDENCE (V3). Bounded components the SERVER can check, plus
     a flag that the street/city line is non-empty. The flag alone is never
     enough — see deriveAddressCompleteness in leads.ts. The street line itself
     deliberately does not travel on a partial capture. */
  pickupState: str(2),
  destinationState: str(2),
  pickupAddressPresent: z.boolean().optional(),
  destinationAddressPresent: z.boolean().optional(),
  /* A promo code is NOT a marketing campaign. They are separate columns and
     separate inputs; conflating them filled the discount column with campaign
     slugs. /api/leads/quote-capture already keeps them apart — this route did
     not, so the two capture surfaces disagreed. */
  promoCode: str(60),
  serviceInterest: str(60),
  /* WHICH PRODUCT. Explicit beats inferred: a package key alone cannot be
     priced, because the same '1br' means a $550 flat full-service job or
     nothing at all on an hourly labor-only job. */
  serviceType: str(40),
  /* The booking form already sends this spelling to /api/bookings. Accepting
     only one of the two names is how the labor-only hole stays open for the
     surface that happens to use the other. */
  serviceTypeKey: str(40),
  /* Structured labor-only inputs. An hourly figure needs BOTH, and is refused
     below the published two-hour minimum rather than silently billed up. */
  laborWorkers: z.number().int().min(1).max(20).nullish(),
  laborMinutes: z.number().int().min(0).max(24 * 60).nullish(),
  /* Home size from the quick quote form ("2br"). Its own field so it never
     shares a column with real job types like "full-move". */
  moveSize: str(30),
  // ── Which SURFACE captured the consent. Validated against the controlled
  //    vocabulary; an unrecognised value is dropped rather than stored raw,
  //    which is what filled the lead table with `OTHER` in the first place.
  consentSource: str(40),
  // ── Honeypot — bots fill hidden fields; humans leave them empty.
  //  This was `z.string().max(0)`, which made the honeypot branch below
  //  UNREACHABLE: a filled value failed the schema, so the request returned as
  //  `invalid_shape` from the parse guard and the honeypot never ran. The trap
  //  reported the wrong reason for every bot that sprang it, and the branch
  //  that is supposed to be the trap was dead code one edit away from being
  //  "cleaned up" as unused.
  //
  //  A BOUNDED filled value is now accepted by the schema so the branch below
  //  can own the decision. The bound matters: this field is never stored or
  //  echoed, and an unbounded string is free memory for anyone who asks.
  company: z.string().max(200).optional(),
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

  // ── Honeypot tripped → generic success, nothing persisted ───────────────
  //  A bot that can tell rejection from acceptance tunes around the trap, so
  //  the shape here is deliberately the same `{ ok: true, skipped }` every
  //  other silent path returns. Nothing is written, nothing is queued, and the
  //  request stops HERE — before the pricing and persistence below.
  if (d.company && d.company.trim().length > 0) {
    return NextResponse.json({ ok: true, skipped: 'honeypot' })
  }

  // ══════════════════════════════════════════════════════════════════════
  //  THE BROWSER'S TOTAL IS NEVER STORED (blocker fix 2026-08-22)
  //
  //  This route used to write `estimateTotal` — a number the browser chose —
  //  straight into Lead.estimatedValue. That column is read by the Discord
  //  card, the customer email, the admin list, lifecycle automation and the
  //  booking hand-over, so a forged or stale figure propagated into all of
  //  them. Dropping it only for RETIRED keys (the first pass at this fix) was
  //  not enough: an active key or an unrecognised one carried the browser
  //  number through untouched.
  //
  //  The server now prices it, from the one canonical price book, or stores
  //  NOTHING. `estimateTotal` survives in the schema purely as a DIAGNOSTIC —
  //  it is compared and logged, never persisted.
  //
  //  WHAT THIS ROUTE CAN HONESTLY PRICE. It receives a package key and nothing
  //  else — no truck, no stairs, no heavy items, no mileage. So the figure it
  //  can vouch for is the PACKAGE SUBTOTAL, and it is marked authoritative
  //  because the server computed it. Anything richer (add-ons, routed miles)
  //  is settled later by /api/bookings, which has the full picture.
  // ══════════════════════════════════════════════════════════════════════
  //  SERVICE TYPE IS PART OF THE PRICE. A package key alone cannot be priced:
  //  the same '1br' means a $550 flat full-service job or nothing at all on an
  //  hourly labor-only job. See partial-lead-pricing.ts.
  const pricing = pricePartialLead({
    moveSize: d.moveSize,
    estimateTotal: d.estimateTotal,
    serviceType: d.serviceType,
    serviceTypeKey: d.serviceTypeKey,
    serviceInterest: d.serviceInterest,
    laborWorkers: d.laborWorkers,
    laborMinutes: d.laborMinutes,
  })

  if (pricing.refusedSize) {
    apiLogger.warn(
      { reason: pricing.refusedReason, priceBookVersion: PRICE_BOOK_VERSION },
      'POST /api/leads/partial — refused the submitted move size; lead saved without a service or an estimate'
    )
  }
  if (pricing.serviceType !== 'full_service' && d.moveSize) {
    apiLogger.info(
      { serviceType: pricing.serviceType },
      'POST /api/leads/partial — a move size was submitted for a non-full-service lead; no package price was derived'
    )
  }
  //  DIAGNOSTIC ONLY. Two numbers and a delta — never the payload, never stored.
  if (pricing.mismatch) {
    apiLogger.warn(pricing.mismatch, 'partial-lead estimate mismatch — server value used')
  }

  const result = await quoteCaptureRouteDeps().partialCapture(
    {
      email: d.email,
      firstName: d.firstName,
      lastName: d.lastName,
      phone: d.phone,
      bookingSessionId: d.bookingSessionId,
      formStep: d.formStep,
      marketingConsent: d.marketingConsent,
      marketingConsentPrompted: d.marketingConsentPresented,
      foundUsPrompted: d.foundUsPresented,
      // The capture surface, from the request. Falls back to BOOKING_FORM
      // because that is the only caller that historically omitted it.
      consentSource: normaliseConsentSource(d.consentSource) ?? 'BOOKING_FORM',
      consentVersion: d.consentVersion,
      source: d.source,
      foundUs: d.foundUs,
      utmSource: d.utmSource,
      utmMedium: d.utmMedium,
      utmCampaign: d.utmCampaign,
      utmContent: d.utmContent,
      utmTerm: d.utmTerm,
      landingPage: d.landingPage,
      referrer: d.referrer,
      attributionId: d.attributionId,
      // ── A UTM CAMPAIGN IS NOT A PROMO CODE (fix 2026-08-22) ────────────
      //  This was `promoCode: d.utmCampaign`, so every door-hanger and QR
      //  visit wrote its campaign slug into the DISCOUNT column. That column
      //  is read as a promo code by the admin and by anything reasoning about
      //  discounts, so a campaign name arrived looking like an entitlement
      //  nobody granted. Attribution already has its own columns — utmSource,
      //  utmCampaign, source — and they are populated above.
      //
      //  BEHAVIOUR CHANGE, deliberate: a campaign code no longer lands in
      //  promoCode from this route. Only an EXPLICIT promoCode does, which is
      //  exactly how /api/leads/quote-capture has always behaved.
      promoCode: d.promoCode,
      estimatedValue: pricing.estimateCents,
      //  Only a FULL-SERVICE subtotal produces a structured snapshot; a
      //  labor-only or unknown lead stores an amount without one, or nothing.
      quoteSnapshot: pricing.snapshot,
      //  Set because the SERVER computed the figure from the price book. It is
      //  what stops the booking form's own browser number overwriting it later
      //  (see leads.mayWriteEstimate).
      estimateAuthoritative: pricing.estimateCents != null,
      moveDate: parseMoveDate(d.moveDate),
      pickupZip: d.pickupZip,
      destinationZip: d.destinationZip,
      pickupState: d.pickupState,
      destinationState: d.destinationState,
      pickupAddressPresent: d.pickupAddressPresent,
      destinationAddressPresent: d.destinationAddressPresent,
      serviceInterest: d.serviceInterest,
      //  A refused key is dropped rather than recorded, so no new lead can end
      //  up with a withdrawn package as its official service.
      moveSize: pricing.moveSizeToStore,
    },
    'partial-lead',
  )

  // ── SEQUENCE B ENROLMENT ────────────────────────────────────────────────
  // Fired only when this submission could plausibly change the answer, because
  // the booking form calls this route from FIVE triggers (debounce, blur, nav,
  // consent toggle, exit beacon) and a lead is worth at most one enrolment:
  //   • isNew                    — the first capture; enrol if consent came with it
  //   • marketingConsent === true — the toggle-on save, which is exactly when a
  //                                previously-ineligible lead becomes eligible
  // Repeat saves that carry no consent claim skip it entirely, so the common
  // case costs nothing. Enrolment is idempotent anyway (stable job ids), so a
  // duplicate call could only ever cost a Redis round trip.
  //
  // Fire-and-forget: a Redis outage must never turn a silent, best-effort
  // capture into a visible failure. onLeadCaptured owns every refusal.
  if (result && (result.isNew || d.marketingConsent === true)) {
    void import('@/lib/journeys')
      .then((m) => m.onLeadCaptured(result.lead.id))
      .catch((err) =>
        apiLogger.warn({ err: String(err).slice(0, 200) }, 'lead nurture trigger failed (non-fatal)')
      )
  }

  // ── SERVER-DERIVED PRICING INFORMATION CARRIES ITS VERSION ─────────────
  //  This endpoint now prices server-side, so the response says which price
  //  book it used and what it concluded the product was. A client that gets a
  //  version it does not recognise knows its own copy is stale — the same
  //  signal the quick quote gets, on the endpoint that had no signal at all.
  //  Nothing here is a price the browser may display: the figure is on the
  //  lead, not in this body.
  return NextResponse.json({
    ok: true,
    captured: !!result,
    isNew: result?.isNew ?? false,
    priceBookVersion: PRICE_BOOK_VERSION,
    serviceType: pricing.serviceType,
    /** True when the submitted package key was withdrawn or unrecognised, so a
     *  caller can tell "we saved you but not your selection" from a clean save. */
    packageRefused: pricing.refusedSize,
    requiresReview: pricing.requiresReview,
  })
}

// Reject other verbs explicitly.
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ ok: false, error: 'method not allowed — use POST' }, { status: 405 })
}
