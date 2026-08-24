import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { apiLogger } from '@/lib/logger'
import { rateLimit, tooManyRequests, LIMITS, clientIp } from '@/lib/rate-limit'
import { quoteCaptureRouteDeps } from '@/lib/quote-capture-deps'

import { quoteEstimate, compareClientTotal } from '@/lib/quote-estimate'
import { PRICE_BOOK_VERSION } from '@/lib/pricing-config'
import { pendingSnapshot } from '@/lib/quote-snapshot'
import { isValidMoveDate, parseMoveDate } from '@/lib/quote-date'
import { composeAccessDetails } from '@/lib/quote-access-details'
import { CONSENT_VERSION, normaliseConsentSource } from '@/lib/consent'
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

// OPT-IN FLAG. Deliberately OFF unless explicitly enabled.
//
// This is a NEW dedicated route that nothing depends on until the website is
// pointed at it, so the safe default is inert: merging this PR deploys the
// endpoint without exposing it, and the live quote page carries on using the
// existing /api/leads path exactly as it does today. Turn it on only once the
// API and worker deployments are healthy, then point the site at it.
//
// Disabled answers { ok:true, captured:false, reason:'feature_disabled' } — the
// customer still sees their estimate, which is the whole point of the flag.
const enabled = () => process.env.QUOTE_LEAD_CAPTURE_ENABLED === 'true'

/** Strip ASCII control chars, collapse whitespace. */
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

  // ── Site access (quick quote step 4) ────────────────────────────────────
  // The page asks about stairs and heavy items. Those answers were collected
  // and then DROPPED: zod strips unknown keys silently, so they never reached
  // the schema, the database, or the crew who would otherwise have found the
  // piano and the two flights of stairs on the day. A strict yes/no
  // vocabulary — anything else is rejected rather than stored as junk.
  // "not_sure" is a REAL answer, not a missing one. The form used to tell
  // people "if you're not sure, choose No", which files a guess as a fact and
  // sends a crew expecting no stairs. An honest unknown is worth more to the
  // person planning the job than a confident wrong answer.
  stairsPickup: z.enum(['yes', 'no', 'not_sure']).optional(),
  stairsDestination: z.enum(['yes', 'no', 'not_sure']).optional(),
  heavyItems: z.enum(['yes', 'no', 'not_sure']).optional(),

  // ── In-person estimate ──────────────────────────────────────────────────
  // Some moves are cheaper to price in person than to guess at. This mode
  // means the customer asked for a visit, so NO automatic number is produced,
  // stored, or emailed — see the pricing branch below.
  quoteMode: z.enum(['instant', 'in_person']).optional(),
  preferredDay: str(60),
  preferredTime: str(60),
  pickupAddress: str(200),
  visitNotes: str(1000),

  /** The date is a best guess and the customer says they can move it. */
  dateFlexible: z.boolean().optional(),

  // ── Move details ──
  moveDate: str(20),
  pickupZip: str(12),
  destinationZip: str(12),
  originCity: str(120),
  destCity: str(120),
  moveSize: str(40),
  /** The truck the browser thinks applies. ADVISORY ONLY: the server derives
   *  the minimum from the move size and corrects anything below it. */
  truckSize: str(20),
  /**
   * The browser's DISPLAYED total, in dollars. DIAGNOSTIC ONLY — it is compared
   * against the server's own calculation and logged on mismatch. It is never
   * stored, never emailed, never shown to the owner. See lib/quote-estimate.ts.
   */
  estimateTotal: z.number().nonnegative().max(1_000_000).optional(),
  /* The price book the BROWSER is running, echoed from the generated mirror.
     Diagnostic only — it can never influence a price. It exists so a stale
     client is visible in the logs as a version mismatch rather than being
     inferred from a wrong total after the fact. */
  priceBookVersion: str(40),

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
  // Ad click ids. ACCEPTED and bounded so the browser contract is stable, but
  // deliberately NOT persisted: storing them only pays off with the evidence
  // classifier, which is out of scope here (main owns the source taxonomy).
  gclid: str(200),
  fbclid: str(200),
  /**
   * The anonymous visitor id from the marketing tracker's /q/<code> QR
   * redirect (?aid=). This route is the MAJORITY door-hanger path — the
   * landing page's primary CTA points at /quote.html — so if the id does not
   * survive here, the campaign is unmeasurable no matter what the booking
   * route does.
   *
   * `.catch(undefined)` matches BookingSchema deliberately: a mangled tracking
   * parameter must DROP the attribution, never 422 a real customer's lead. A
   * single over-long or malformed value failing the whole request is exactly
   * how a lead gets silently lost — the customer is told we could not save
   * their information and the owner never hears about them.
   */
  attributionId: z
    .string()
    .regex(/^[a-f0-9]{8,64}$/i)
    .optional()
    .catch(undefined),
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
  // ── THE FEATURE FLAG NO LONGER SHORT-CIRCUITS PRICING SAFETY ───────────
  //  This used to be the FIRST line of the handler: flag off ⇒ HTTP 200
  //  `feature_disabled`, before parsing and before pricing. So with the flag
  //  unset — which is its default — a cached bundle submitting a withdrawn
  //  Studio got a 200 with no error, quote.html saw no `pricing_expired`, and
  //  fell straight through to unlock() showing the retired price out of its
  //  own stale mirror. A flag whose job is "do not WRITE leads yet" had
  //  quietly become "do not ENFORCE pricing either".
  //
  //  The flag now gates PERSISTENCE ONLY, and is checked after the request has
  //  been parsed and priced. See the `capture is disabled` branch below for
  //  what an ACTIVE package receives.
  //
  //  DELIBERATE TRADE: a disabled endpoint now consumes rate limit and parses
  //  bodies where it previously did neither. That is the cost of refusing a
  //  retired price in every configuration, and it is worth it — the rate limit
  //  still protects the endpoint, and nothing is written either way.
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
    return json({ ok: true, captured: false, reason: 'spam_discarded', priceBookVersion: PRICE_BOOK_VERSION })
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

  // ── IN-PERSON: NO AUTOMATIC NUMBER, AT ALL ──────────────────────────────
  // Not "a number we withhold" — none is produced, none is stored on the lead,
  // and none reaches the email. The point of asking for a visit is that the
  // move is easier to price after seeing it; quoting it anyway would answer a
  // question the customer explicitly declined to ask.
  const inPerson = d.quoteMode === 'in_person'

  // ── SERVER-AUTHORITATIVE PRICING ────────────────────────────────────────
  //  VALIDATE FIRST, IN EVERY MODE. This used to read
  //
  //      const priced = inPerson ? { ok: false, reason: 'manual_plan', … } : quoteEstimate(…)
  //
  //  so `quoteMode: 'in_person'` skipped quoteEstimate ENTIRELY — and with it
  //  the retired-package refusal and the package/truck validation below. A
  //  request for a withdrawn Studio was accepted and written as an in-person
  //  plan, and so was a package that does not exist and a truck we do not run.
  //  Asking for a visit is a statement about HOW the price is set; it is not a
  //  claim that the selection is valid, and it must not be a way around the
  //  gate that the whole 2026-08-22 incident was about.
  //
  //  So the selection is validated unconditionally, the refusals below run on
  //  that result, and ONLY an active, valid package is then converted into a
  //  manual in-person plan.
  const validated = quoteEstimate({ moveSize: d.moveSize, truckSize: d.truckSize })
  const priced =
    inPerson && validated.ok
      ? { ok: false as const, reason: 'manual_plan' as const, packageKey: d.moveSize ?? null }
      : validated
  // ── A WITHDRAWN PACKAGE IS AN EXPIRED PRICE, NOT A BAD REQUEST ──────────
  //  A visitor whose browser cached the price book from before a tier was
  //  retired submits a key that was perfectly valid when their page loaded.
  //  Answering 422 validation_error blames them; answering with the retired
  //  price (which is what happened on 2026-08-22) is far worse. Say the
  //  selection expired, name the current price book, write NOTHING.
  // ── STALE CLIENT, VISIBLE BEFORE IT MISPRICES ANYTHING ─────────────────
  //  A version mismatch means somebody is running a cached price book. That is
  //  worth knowing on EVERY request, not only the ones that happen to name a
  //  withdrawn package — a client can be stale and still pick a key that is
  //  coincidentally still active, which is silent by nature.
  if (d.priceBookVersion && d.priceBookVersion !== PRICE_BOOK_VERSION) {
    apiLogger.warn(
      { clientPriceBookVersion: d.priceBookVersion, serverPriceBookVersion: PRICE_BOOK_VERSION },
      'POST /api/leads/quote-capture — client is running a stale price book'
    )
  }

  if (!priced.ok && priced.reason === 'retired_package') {
    apiLogger.warn(
      { packageKey: priced.packageKey ?? '(unrecognised)', priceBookVersion: PRICE_BOOK_VERSION },
      'POST /api/leads/quote-capture — refused a retired package (stale client price book)'
    )
    return json(
      { ok: false, captured: false, error: 'pricing_expired', fields: ['moveSize'], priceBookVersion: PRICE_BOOK_VERSION },
      409
    )
  }
  if (!priced.ok && (priced.reason === 'unknown_package' || priced.reason === 'unsupported_truck')) {
    // Never silently default to a price for something we do not sell, and never
    // swap a retired truck size for a different one behind the customer's back.
    apiLogger.warn(
      { packageKey: priced.packageKey ?? '(unrecognised)', reason: priced.reason },
      'POST /api/leads/quote-capture — rejected package/truck'
    )
    return json(
      { ok: false, captured: false, error: 'validation_error', fields: [priced.reason === 'unsupported_truck' ? 'truckSize' : 'moveSize'] },
      422
    )
  }
  // 5BR+ / "not sure" cannot be auto-quoted from one truck — the move may need
  // several trucks or several trips. The LEAD IS STILL SAVED (that is the whole
  // point of the gate) and the owner quotes it by hand; it simply carries no
  // automatic estimate.
  const manualPlan = !priced.ok && priced.reason === 'manual_plan'

  // ══════════════════════════════════════════════════════════════════════
  //  REVIEW STATE — computed ONCE, returned, persisted and displayed.
  //
  //  `manualReview` used to be `inPerson || manualPlan`, which is false for a
  //  priced 3BR, a priced 4BR and any explicit larger-truck upgrade — exactly
  //  the cases where the server HAD decided a human must look. The flag was
  //  computed in quoteEstimate and then thrown away at the response boundary.
  // ══════════════════════════════════════════════════════════════════════
  const manualReview = inPerson || manualPlan || (priced.ok && priced.requiresReview)
  const reviewReasons: string[] = inPerson
    ? ['An in-person estimate was requested — the price is set after the visit.']
    : manualPlan
      ? ['This move may need more than one truck or more than one trip, so it is planned by hand.']
      : priced.ok
        ? priced.reviewReasons
        : []

  /** The estimate block, shared by every response that carries one. */
  const estimatePayload = priced.ok
    ? {
        totalDollars: priced.totalDollars,
        isStarting: priced.isStarting,
        packageLabel: priced.packageLabel,
        // The breakdown the owner asked the page to show: base package,
        // required truck upgrade, then routed mileage (calculated later,
        // separately) and any other add-ons.
        baseDollars: priced.baseDollars,
        truckSize: priced.truckSize,
        truckMinimum: priced.truckMinimum,
        truckUpgrade: priced.truckUpgrade,
        truckCorrected: priced.truckCorrected,
        /* The truck the package price already covers, so the page can say
           "15 ft truck included" instead of leaving a $0 line unexplained. */
        includedTruck: priced.includedTruck,
        /* A quick quote has ZIP codes only, so the routed mileage is NOT in
           this figure and the page must not present it as a finished price. */
        mileageStatus: 'pending' as const,
        priceBookVersion: priced.priceBookVersion,
        /* Server-authoritative. The page must NOT decide "starting at" from
           its own mirror's `price.kind`: a stale mirror would then hedge, or
           fail to hedge, according to a rule book we have since changed. */
        requiresReview: priced.requiresReview,
        reviewReasons: priced.reviewReasons,
      }
    : null

  // ══════════════════════════════════════════════════════════════════════
  //  CAPTURE DISABLED — PRICE HONESTLY, PERSIST NOTHING.
  //
  //  The flag means "do not write leads yet". It must never mean "do not
  //  enforce pricing": every refusal above has already run, so a withdrawn
  //  package is a 409 in EVERY configuration of this flag.
  //
  //  An ACTIVE package still gets the SERVER's price. That is strictly safer
  //  than the old behaviour, which returned a bare 200 and left the browser to
  //  display whatever its own cached mirror said. Nothing is stored, nothing is
  //  emailed, and the response says so — `captured: false`.
  // ══════════════════════════════════════════════════════════════════════
  if (!enabled()) {
    return json({
      ok: true,
      captured: false,
      reason: 'feature_disabled',
      priceBookVersion: PRICE_BOOK_VERSION,
      estimate: estimatePayload,
      manualReview,
      reviewReasons,
    })
  }

  /** The frozen record, or null when there is deliberately no number. */
  const capturedSnapshot = priced.ok
    ? (() => {
        const built = pendingSnapshot({
          baseCents: Math.round(priced.baseDollars * 100),
          truckCents: Math.round(priced.truckUpgrade * 100),
          totalCents: priced.totalCents,
          includedTruck: priced.includedTruck,
          // ALWAYS 'pending' here: the quick quote collects ZIP codes, and a
          // routed-mile charge needs real addresses. It is settled later, when
          // the booking supplies them.
          priceBookVersion: priced.priceBookVersion,
          requiresReview: priced.requiresReview,
          reviewReasons: priced.reviewReasons,
        })
        if (!built.ok) {
          // The arithmetic comes straight from the price book, so this means
          // the price book itself is inconsistent. Store nothing rather than
          // something that cannot be explained.
          apiLogger.error({ reason: built.reason }, 'refusing to store an inconsistent quote snapshot')
          return null
        }
        return built.snapshot
      })()
    : null

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

  const result = await quoteCaptureRouteDeps().capture(
    {
      email: d.email,
      firstName: d.firstName,
      lastName: d.lastName,
      phone: d.phone,
      bookingSessionId: d.bookingSessionId,
      // The MODE, not just the step. The confirmation email and the owner's
      // card both read this back OFF THE LEAD rather than trusting a flag
      // passed alongside them — so a resend months later is still labelled
      // correctly, and admin can filter on it without parsing prose.
      formStep: inPerson ? 'quote_in_person' : d.formStep || 'quote',
      marketingConsent: d.marketingConsent,
      // CONSENT EVIDENCE — source, version and timestamp travel together or the
      // record proves nothing (see lib/consent.ts). Normalised HERE against the
      // controlled vocabulary so an unrecognised value falls back to THIS
      // surface rather than to the partial-capture default of BOOKING_FORM,
      // which would file a quick-quote opt-in under the wrong form. The version
      // defaults to the disclosure currently shipped, so a cached page that
      // predates the field still records what it showed.
      consentSource: normaliseConsentSource(d.consentSource) ?? 'QUICK_QUOTE_FORM',
      consentVersion: d.consentVersion || CONSENT_VERSION,
      contactPreference: d.contactPreference,
      bestTimeToCall: d.bestTimeToCall,
      accessDetails: composeAccessDetails(d),
      moveDate: parseMoveDate(d.moveDate),
      pickupZip: d.pickupZip,
      destinationZip: d.destinationZip,
      moveSize: priced.ok ? priced.packageKey : d.moveSize,
      source: d.source,
      foundUs: d.foundUs,
      utmSource: d.utmSource,
      utmMedium: d.utmMedium,
      utmCampaign: d.utmCampaign,
      utmContent: d.utmContent,
      utmTerm: d.utmTerm,
      landingPage: d.landingPage,
      referrer: d.referrer,
      // The scan that produced this lead. FIRST-TOUCH on the lead: a later
      // submission never overwrites it (see buildPartialLeadUpdate).
      attributionId: d.attributionId,
      // A REAL promo code only. Previously this was `d.utmCampaign`, which put
      // marketing campaign slugs in the discount column.
      promoCode: d.promoCode,
      // SERVER value. The browser's number never reaches the database.
      estimatedValue: serverCents,
      // ...and it is FLAGGED as the server's, so the booking form's own
      // figure — computed in the browser, and without the truck upgrade —
      // cannot later overwrite the number we are about to email. See
      // leads.mayWriteEstimate.
      estimateAuthoritative: true,
      // ── THE STRUCTURED RECORD (owner spec 2026-08-22) ──────────────────
      //  One number cannot say whether it is a finished price or a package
      //  subtotal with the drive still unmeasured. This writes the components
      //  the server actually computed, so every downstream surface can be
      //  honest about what is and is not included.
      //
      //  mileageStatus is ALWAYS 'pending' here: the quick quote collects ZIP
      //  codes only, and a routed-mile charge needs real addresses. It is
      //  settled later, when the booking supplies them.
      //  Built through the VALIDATING constructor, so a total that is not the
      //  sum of its parts, or a review flag with no reason, cannot be stored.
      quoteSnapshot: capturedSnapshot,
      //  REVIEW WITHOUT A NUMBER. An in-person request and a 5BR manual plan
      //  both need a human and both deliberately have NO total. Review state
      //  used to live only inside the snapshot, so exactly the leads that most
      //  needed attention recorded none — and inventing a total merely to have
      //  somewhere to put the flag would be worse than losing it.
      reviewReasonsOnly: capturedSnapshot ? undefined : reviewReasons,
    },
    'quote-lead',
    undefined,
    // The owner's card comes from onQuoteRequestCaptured below — the rich one,
    // with the estimate, the contact preference and the action buttons. Without
    // this the owner would get two pings for every new quick-quote lead.
    { notifyOwner: false }
  )

  // ── PRICED, THEN NOT SAVED ──────────────────────────────────────────────
  //  Persistence failed after pricing succeeded (capturePartialLeadSafe has
  //  already logged it). Two things were wrong with answering HTTP 200 here:
  //
  //    • An outage looked exactly like a success to every proxy, uptime check
  //      and log aggregator. Nothing alerted, because nothing was failing as
  //      far as HTTP was concerned — the only evidence was a field in a body
  //      nobody was reading. That is how a lead-loss window stays open.
  //    • The browser was left to infer failure. With no server estimate in the
  //      response, the page's only way to show a number was its OWN mirror,
  //      which is precisely the fallback that displayed a retired $379.
  //
  //  So it is a 503 — the honest code for "we are the problem, try again" —
  //  and it carries the pricing the server ALREADY computed, so the customer
  //  still sees the real, authoritative figure while being told plainly that
  //  we could not save it. `estimate` is null for a hand-quoted move, which is
  //  a different thing from having a number and withholding it.
  if (!result) {
    return json(
      {
        ok: false,
        captured: false,
        error: 'server_error',
        priceBookVersion: PRICE_BOOK_VERSION,
        estimate: estimatePayload,
        manualReview,
        reviewReasons,
      },
      503
    )
  }

  // Side effects. Awaited so a serverless invocation cannot freeze before they
  // run; neither throws, and neither can change `captured`.
  const outcome = await quoteCaptureRouteDeps().onCaptured(result.lead.id, { locale: d.locale })

  apiLogger.info(
    {
      isNew: result.isNew,
      emailStatus: outcome.emailStatus,
      notificationStatus: outcome.notificationStatus,
      // Marketing enrollment, for the log ONLY — it never reaches the browser.
      // 'skipped: no_consent' is the expected, healthy answer for most leads.
      automationStatus: outcome.automation?.status ?? 'not_run',
      automationReason:
        outcome.automation && outcome.automation.status !== 'enrolled' ? outcome.automation.reason : undefined,
      // Which lifecycle sequence the lead was routed into. 'quote' when a real
      // number was produced, 'nurture' for an in-person / manual-review job.
      // Log only — never returned to the browser.
      sequence: outcome.sequence ?? 'none',
      packageKey: priced.ok ? priced.packageKey : null,
    },
    'quote lead captured'
  )

  return json({
    ok: true,
    captured: true,
    emailStatus: outcome.emailStatus,
    notificationStatus: outcome.notificationStatus,
    // ── TOP-LEVEL, NOT ONLY INSIDE `estimate` ────────────────────────────
    //  A client must be able to learn its price book is stale even on the
    //  paths that carry NO estimate — an in-person request or a manual-plan
    //  5BR. Nesting it only inside `estimate` made the one field that detects
    //  staleness absent from exactly the responses a stale client might get.
    priceBookVersion: PRICE_BOOK_VERSION,
    // The server's own number, so a browser showing a stale price can correct
    // itself. Safe to expose: it is the price we publish. Built ONCE above, so
    // the disabled-capture path and this one cannot describe the same quote
    // two different ways.
    estimate: estimatePayload,
    /** True when this move is quoted by a human rather than automatically: an
     *  in-person visit, a 5BR manual truck plan, OR a priced package the server
     *  flagged (a 3BR/4BR floor, an explicit larger truck). That last case is
     *  the one `inPerson || manualPlan` missed entirely. */
    manualReview,
    /** WHY, so neither the page nor the owner has to guess. */
    reviewReasons,
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
