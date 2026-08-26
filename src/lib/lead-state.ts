// ════════════════════════════════════════════════════════════════════════
//  lead-state.ts — THE canonical business state of a lead, derived once.
//
//  ── THE INCIDENT THIS EXISTS TO STOP (2026-08-25) ───────────────────────
//  A real owner card went out reading:
//
//      New lead — <customer>
//      • 1 Bedroom · $550 package subtotal
//      • Transportation pending — $3 per routed mile, fuel included.
//      • Marketing: not asked
//      • From: OTHER
//
//  Two of those four lines were false, and both were false in the same way:
//  a MISSING value had been rendered as an AFFIRMATIVE ANSWER.
//
//    "Marketing: not asked"  The booking form DOES show the checkbox, on the
//                            very step that produced this lead. The customer
//                            saw it and left it alone. "Not asked" is a claim
//                            about US, and it was wrong.
//    "From: OTHER"           Nobody chose "Other". `OTHER` is the Prisma
//                            column default and the mapLeadSource() fallback,
//                            printed raw because the renderer did
//                            `SOURCE_LABELS[source] ?? source`.
//
//  The renderer was not the only place at fault, but it was the place where
//  the lie became visible — because it re-derived business meaning from
//  truthy/falsy checks on individual columns. So the derivation moves HERE,
//  into pure functions with named states, and the renderer is handed a view
//  model it cannot misread.
//
//  ── THE RULE THIS MODULE ENFORCES ──────────────────────────────────────
//  Absence is never an answer. Every state below distinguishes:
//
//    • the customer told us X
//    • we showed them the question and they did not answer
//    • they have not reached the question yet
//    • the question does not exist on the form they used
//    • the record predates the provenance we would need to tell those apart
//
//  A state is only ever asserted from EVIDENCE: an explicit value the client
//  sent, or a FORM CONTRACT (see FORM_CONTRACTS) that proves what a given
//  capture surface does and does not ask. Never from the mere absence of data.
//
//  PURE. No prisma, no clock, no network — every rule here is testable, and
//  the rules are the product.
// ════════════════════════════════════════════════════════════════════════

import { resolveServiceType } from './partial-lead-pricing'

// ════════════════════════════════════════════════════════════════════════
//  FORM CONTRACTS — what each capture surface actually asks
//
//  This is the ONLY thing that may license a "not asked" or a "not on this
//  form". It is a statement about our own HTML, not an inference from a null
//  column, which is exactly the distinction the incident turned on.
//
//  Keyed by the capture SURFACE (LeadSource values that name a form, plus the
//  consent-source vocabulary), because the marketing CHANNEL a person arrived
//  from says nothing about which questions the page put in front of them.
//
//  KEPT HONEST BY A TEST. `lead-state-form-contract.test.ts` reads the real
//  booking-form.html out of the site tree and asserts the entries below match
//  the markup — so a checkbox removed from the form cannot leave a stale
//  "we ask this" claim behind in the API.
// ════════════════════════════════════════════════════════════════════════

export type FormContract = {
  /** Does this surface put a marketing-email checkbox in front of the visitor? */
  presentsMarketingConsent: boolean
  /** Does it ask "How did you hear about us?" at all? */
  presentsSelfReportedSource: boolean
  /**
   * The ordered step ids, when the surface is a multi-step form. Lets a
   * PARTIAL capture prove the visitor had not yet REACHED a later question,
   * rather than guessing. Empty for single-page surfaces.
   */
  steps?: readonly string[]
  /** The step id on which the self-reported-source question appears. */
  selfReportedSourceStep?: string
  /** The step id on which the marketing checkbox appears. */
  marketingConsentStep?: string
}

/**
 * The booking form's card order and question placement.
 *
 * Mirrors `CARDS` in public/booking-form.html. The ids are NOT positional
 * ("cardsvc" is step 1, "card1" is step 2) — that mismatch already caused one
 * bug in the site's own step reporting, so the order is written out rather
 * than computed from the names.
 */
const BOOKING_FORM_STEPS = ['cardsvc', 'card1', 'card2', 'card3', 'card4', 'card5'] as const

export const FORM_CONTRACTS: Record<string, FormContract> = {
  //  #emailOptIn lives on card1 (Contact); #foundUs lives on card4
  //  (Addresses & Access) — four steps later, which is precisely why a
  //  contact-step capture must not be able to answer for it.
  BOOKING_FORM: {
    presentsMarketingConsent: true,
    presentsSelfReportedSource: true,
    steps: BOOKING_FORM_STEPS,
    marketingConsentStep: 'card1',
    selfReportedSourceStep: 'card4',
  },
  //  The quick quote asks for consent and never asks how they heard.
  QUICK_QUOTE_FORM: { presentsMarketingConsent: true, presentsSelfReportedSource: false },
  HOMEPAGE_ESTIMATE: { presentsMarketingConsent: true, presentsSelfReportedSource: false },
  SERVICES_PAGE: { presentsMarketingConsent: true, presentsSelfReportedSource: false },
  CONTACT_FORM: { presentsMarketingConsent: true, presentsSelfReportedSource: false },
  MOVING_CHECKLIST: { presentsMarketingConsent: true, presentsSelfReportedSource: false },
}

export const formContract = (surface?: string | null): FormContract | null => {
  const key = (surface ?? '').trim().toUpperCase()
  return key ? (FORM_CONTRACTS[key] ?? null) : null
}

/**
 * Had the visitor reached `question` by the time they were at `at`?
 *
 * Returns null when the answer cannot be established — an unknown step id, or
 * a surface with no declared order. Null means "we do not know", and every
 * caller must treat it that way rather than defaulting to a convenient side.
 */
export function hasReachedStep(
  contract: FormContract | null,
  at?: string | null,
  question?: string,
): boolean | null {
  if (!contract?.steps?.length || !question) return null
  const here = contract.steps.indexOf((at ?? '').trim())
  const target = contract.steps.indexOf(question)
  if (here < 0 || target < 0) return null
  return here >= target
}

// ════════════════════════════════════════════════════════════════════════
//  MARKETING CONSENT
// ════════════════════════════════════════════════════════════════════════

export type MarketingConsentState =
  /** Shown the disclosure and affirmatively agreed. The ONLY sendable state. */
  | 'OPTED_IN'
  /** Shown the disclosure and did not agree. We asked; the answer was no. */
  | 'NOT_OPTED_IN'
  /** The originating form genuinely carries no marketing question. */
  | 'NOT_ASKED'
  /** No provenance: we cannot prove whether the question was ever put to them. */
  | 'UNKNOWN_LEGACY'

export type MarketingConsentRow = {
  emailMarketingConsent?: boolean | null
  /** TRUE when the originating form displayed the checkbox. Null on records
   *  captured before the client reported it. */
  marketingConsentPrompted?: boolean | null
  /** The capture surface that recorded the decision, e.g. 'BOOKING_FORM'. */
  marketingConsentSource?: string | null
  marketingConsentAt?: Date | string | null
  marketingConsentVersion?: string | null
  /** Which form produced the lead, when consent itself recorded no surface. */
  captureSurface?: string | null
}

/**
 * The consent state, from evidence only.
 *
 * ORDER MATTERS. An explicit boolean is the strongest evidence there is and is
 * read first — it is the customer's own answer. Only when there is no answer at
 * all do we ask whether the question was even on the page, and only a form
 * CONTRACT (or the client saying so outright) may settle that.
 */
export function marketingConsentState(row: MarketingConsentRow): MarketingConsentState {
  if (row.emailMarketingConsent === true) return 'OPTED_IN'
  if (row.emailMarketingConsent === false) return 'NOT_OPTED_IN'

  // ── THE SERVER OWNS THE FORM CONTRACT (security fix, V3) ────────────────
  //  `marketingConsentPrompted` arrives from a PUBLIC endpoint. Anyone can POST
  //  `marketingConsentPresented: false` while naming BOOKING_FORM, and the card
  //  would then report "Not asked" about a form we KNOW carries the checkbox —
  //  turning the owner's compliance record into something a stranger can edit.
  //
  //  For a surface whose contract the server knows, the REGISTRY WINS over any
  //  contradictory client claim. The client flag is authoritative only where
  //  the server genuinely cannot know: an unregistered or dynamic surface.
  //  CONTRADICTION vs ABSENCE. The registry overrides a client that ASSERTS
  //  something we know to be false; it does not manufacture an answer out of a
  //  client that said nothing. A legacy row predates the flag entirely and its
  //  silence is not a contradiction — the checkbox may genuinely have been
  //  added to that form after the row was written.
  const known = formContract(row.marketingConsentSource ?? row.captureSurface)
  if (known?.presentsMarketingConsent && row.marketingConsentPrompted === false) {
    //  The client claimed this form never asked. We know it does. With no
    //  opt-in recorded, the truthful state is a decline, and it can never be
    //  downgraded to "we never asked them".
    return 'NOT_OPTED_IN'
  }
  if (known && !known.presentsMarketingConsent && row.marketingConsentPrompted === true) {
    //  The mirror attack: a surface we know has no checkbox cannot be talked
    //  INTO having asked.
    return 'NOT_ASKED'
  }
  //  A known non-asking surface with no client claim can still answer, because
  //  the contract alone settles it.
  if (known && !known.presentsMarketingConsent) return 'NOT_ASKED'

  // Unknown surface: the client's report is the only evidence there is.
  if (row.marketingConsentPrompted === true) {
    // Shown, and no opt-in was ever recorded. That is a decline, not a silence:
    // an opt-in would have arrived as `true` from the same client that told us
    // the box was on screen.
    return 'NOT_OPTED_IN'
  }
  if (row.marketingConsentPrompted === false) return 'NOT_ASKED'

  //  Nothing explicit and no registered contract. The honest answer is that
  //  this row cannot say — deliberately NOT 'NOT_ASKED', which is the ambiguity
  //  the original incident turned on.
  return 'UNKNOWN_LEGACY'
}

/** Owner-facing wording. Never a raw state name. */
export const MARKETING_CONSENT_LABEL: Record<MarketingConsentState, string> = {
  OPTED_IN: 'Opted in — they asked to hear from you',
  NOT_OPTED_IN: 'Not opted in',
  NOT_ASKED: 'Not asked — this form has no marketing checkbox',
  UNKNOWN_LEGACY: 'Unknown — captured before we recorded whether the box was shown',
}

/**
 * May we send marketing to this lead?
 *
 * ONLY an explicit opt-in. Stated as its own function so no caller can reach
 * the same conclusion from a truthy check on a state name.
 */
export const isSendableConsent = (s: MarketingConsentState): boolean => s === 'OPTED_IN'

// ════════════════════════════════════════════════════════════════════════
//  THE CUSTOMER'S OWN "HOW DID YOU HEAR ABOUT US?" ANSWER
//
//  Deliberately SEPARATE from tracked acquisition below. One is what the
//  customer told us; the other is what our own tracking observed. Collapsing
//  them into a single "From:" line is what let a column default masquerade as
//  a customer's answer.
// ════════════════════════════════════════════════════════════════════════

export type SelfReportedSourceState =
  /** They have not got to that step of the form yet. */
  | 'NOT_REACHED'
  /** They saw the (optional) question and submitted without answering. */
  | 'PRESENTED_NOT_ANSWERED'
  /** They picked a real option. */
  | 'ANSWERED_KNOWN'
  /** They explicitly picked "Other". The ONE case that may say "Other". */
  | 'ANSWERED_OTHER'
  /** The originating form never asks this question. */
  | 'NOT_ON_FORM'
  /** No provenance either way. */
  | 'UNKNOWN_LEGACY'

export type SelfReportedSourceRow = {
  /** The customer's own answer, verbatim. */
  foundUs?: string | null
  /** TRUE when the question was actually put in front of them. */
  foundUsPrompted?: boolean | null
  /** Which form produced this lead. */
  captureSurface?: string | null
  /** Furthest step reached, for a partial capture. */
  formStep?: string | null
}

/** The literal option meaning "none of the above" on our own dropdowns. */
const OTHER_ANSWERS = new Set(['other', 'others', 'something else'])

export type SelfReportedSource = {
  state: SelfReportedSourceState
  /** The answer as the customer gave it, only when they actually gave one. */
  answer: string | null
}

export function selfReportedSource(row: SelfReportedSourceRow): SelfReportedSource {
  const answer = (row.foundUs ?? '').trim()
  if (answer) {
    return {
      state: OTHER_ANSWERS.has(answer.toLowerCase()) ? 'ANSWERED_OTHER' : 'ANSWERED_KNOWN',
      answer,
    }
  }

  const contract = formContract(row.captureSurface)
  //  A form that never asks can say so without any per-lead flag.
  if (contract && !contract.presentsSelfReportedSource) return { state: 'NOT_ON_FORM', answer: null }

  if (row.foundUsPrompted === true) return { state: 'PRESENTED_NOT_ANSWERED', answer: null }
  if (row.foundUsPrompted === false) return { state: 'NOT_REACHED', answer: null }

  //  No flag. A multi-step form can still PROVE the question was out of reach:
  //  if the furthest step recorded comes before the step that carries it, the
  //  visitor demonstrably never saw it. That is a fact about our own form, not
  //  a guess about the customer.
  const reached = hasReachedStep(contract, row.formStep, contract?.selfReportedSourceStep)
  if (reached === false) return { state: 'NOT_REACHED', answer: null }

  return { state: 'UNKNOWN_LEGACY', answer: null }
}

export function selfReportedSourceLabel(s: SelfReportedSource): string {
  switch (s.state) {
    case 'ANSWERED_KNOWN':
      return s.answer ?? 'Answered'
    case 'ANSWERED_OTHER':
      return 'Other (their words)'
    case 'PRESENTED_NOT_ANSWERED':
      return 'Not provided — they skipped the optional question'
    case 'NOT_REACHED':
      return 'Not reached yet'
    case 'NOT_ON_FORM':
      return 'Not asked on this form'
    case 'UNKNOWN_LEGACY':
      return 'Unknown — captured before we recorded this'
  }
}

// ════════════════════════════════════════════════════════════════════════
//  TRACKED ACQUISITION — what OUR tracking observed, never what they said
// ════════════════════════════════════════════════════════════════════════

export type AcquisitionState =
  /** At least one affirmative tracking signal. */
  | 'TRACKED'
  /** Affirmatively established as a direct visit. Requires positive evidence. */
  | 'DIRECT'
  /** No tracking signal survived. NOT the same as "they came directly". */
  | 'UNKNOWN'

export type AcquisitionRow = {
  source?: string | null
  utmSource?: string | null
  utmMedium?: string | null
  utmCampaign?: string | null
  utmContent?: string | null
  utmTerm?: string | null
  referrer?: string | null
  landingPage?: string | null
  attributionId?: string | null
  promoCode?: string | null
}

/**
 * Enum values that are NOT a marketing channel.
 *
 * `OTHER` is the Prisma column default and the mapLeadSource() fallback;
 * `UNKNOWN` is its explicit sibling. Neither is something a customer or a
 * campaign ever chose, so neither may be rendered as provenance. This mirrors
 * the guard booking-display.ts `originLine()` has always had — the two
 * owner-facing renderers disagreed, and the lead card was the one without it.
 */
const NON_CHANNEL_SOURCES = new Set(['OTHER', 'UNKNOWN'])

export const isRealChannel = (source?: string | null): boolean => {
  const s = (source ?? '').trim().toUpperCase()
  return s.length > 0 && !NON_CHANNEL_SOURCES.has(s)
}

export type Acquisition = {
  state: AcquisitionState
  /** The marketing channel, when one is genuinely recorded. */
  channel: string | null
  utmSource: string | null
  utmMedium: string | null
  utmCampaign: string | null
  referrer: string | null
  landingPage: string | null
  attributionId: string | null
}

const trimmed = (v?: string | null): string | null => {
  const s = (v ?? '').trim()
  return s.length ? s : null
}

export function acquisition(row: AcquisitionRow): Acquisition {
  const channel = isRealChannel(row.source) ? (row.source ?? '').trim().toUpperCase() : null
  const utmSource = trimmed(row.utmSource)
  const utmMedium = trimmed(row.utmMedium)
  const utmCampaign = trimmed(row.utmCampaign)
  const referrer = trimmed(row.referrer)
  const attributionId = trimmed(row.attributionId)

  const tracked =
    !!channel || !!utmSource || !!utmMedium || !!utmCampaign || !!referrer || !!attributionId ||
    !!trimmed(row.utmContent) || !!trimmed(row.utmTerm)

  //  DIRECT IS NEVER INFERRED. A visit is only "direct" when the capture layer
  //  affirmatively recorded that there was no referrer and no campaign — which
  //  nothing does today. Losing the tracking parameters and calling the result
  //  "Direct" would invent an acquisition channel out of a dropped query
  //  string, so the absence of evidence stays UNKNOWN.
  return {
    state: tracked ? 'TRACKED' : 'UNKNOWN',
    channel,
    utmSource,
    utmMedium,
    utmCampaign,
    referrer,
    landingPage: trimmed(row.landingPage),
    attributionId,
  }
}

/** Human labels for the capture surfaces and channels the owner sees. */
const CHANNEL_LABELS: Record<string, string> = {
  GOOGLE: 'Google',
  FACEBOOK: 'Facebook',
  INSTAGRAM: 'Instagram',
  DOOR_HANGER: 'Door hanger',
  DOOR_HANGER_QR: 'Door hanger QR',
  YARD_SIGN: 'Yard sign',
  YARD_SIGN_QR: 'Yard sign QR',
  REFERRAL: 'Referral',
  CUSTOMER_REFERRAL: 'Customer referral',
  CRAIGSLIST: 'Craigslist',
  OFFERUP: 'OfferUp',
  RETURNING_CUSTOMER: 'Returning customer',
  WEBSITE: 'Website',
  QUICK_QUOTE_FORM: 'Quick quote form',
  SERVICES_PAGE: 'Services page',
  BOOKING_FORM: 'Booking form',
  HOMEPAGE_ESTIMATE: 'Homepage estimate',
  CONTACT_FORM: 'Contact form',
  MOVING_CHECKLIST: 'Moving checklist',
  GOOGLE_BUSINESS: 'Google Business',
  FACEBOOK_MARKETPLACE: 'Facebook Marketplace',
  MANUAL_ENTRY: 'Manual entry',
  EXISTING_CUSTOMER_OPT_IN: 'Existing customer opt-in',
}

/**
 * The acquisition line.
 *
 * An unrecognised value is still shown RAW — a mis-tagged campaign the owner
 * can see is fixable, and inventing a friendly name for it would hide the
 * mistake. `OTHER`/`UNKNOWN` never get here: they are filtered by
 * `isRealChannel` before this is called, because they are not values anything
 * chose.
 */
export function acquisitionLabel(a: Acquisition): string {
  if (a.state === 'DIRECT') return 'Direct visit'
  const parts: string[] = []
  if (a.channel) parts.push(CHANNEL_LABELS[a.channel] ?? a.channel)
  const utm = [a.utmSource, a.utmMedium, a.utmCampaign].filter(Boolean).join(' · ')
  if (utm) parts.push(utm)
  if (!parts.length && a.referrer) parts.push(`referred by ${a.referrer}`)
  if (!parts.length) return 'Unknown — no tracking parameters survived'
  return parts.join(' · ')
}

// ════════════════════════════════════════════════════════════════════════
//  TRANSPORTATION
//
//  "Transportation pending" was TRUE for the incident lead — it had no
//  addresses yet — but the model behind it could only ever say "pending", so a
//  routing PROVIDER FAILURE on a lead with two complete addresses would have
//  rendered the identical words. The owner would read "we are still waiting for
//  the customer" about a job that is actually waiting for us.
// ════════════════════════════════════════════════════════════════════════

export type TransportationState =
  /** Full service, but we do not have both ends yet. The customer's move. */
  | 'WAITING_FOR_ADDRESSES'
  /** Both addresses are in and the route has not been measured yet. */
  | 'READY_TO_ROUTE'
  /** A real routed figure is recorded, with the miles behind it. */
  | 'ROUTED'
  /** Addresses are complete and routing failed. OURS to chase, not theirs. */
  | 'ROUTING_FAILED'
  /** Labor-only: the customer provides the truck. No routed miles are charged. */
  | 'NOT_APPLICABLE'
  /** Pre-snapshot record; nothing can be said about the drive. */
  | 'UNKNOWN_LEGACY'

/**
 * The stored `quote_mileage_status` vocabulary.
 *
 * `pending` and `calculated` are pre-existing and untouched. `routing_failed`
 * and `not_applicable` are NEW VALUES IN AN EXISTING NULLABLE TEXT COLUMN, so
 * they need no migration — and every reader below treats an unrecognised value
 * as unknown rather than as one of the good outcomes.
 */
export const MILEAGE_STATUS = {
  pending: 'pending',
  calculated: 'calculated',
  routingFailed: 'routing_failed',
  notApplicable: 'not_applicable',
} as const

export type TransportationRow = {
  quoteMileageStatus?: string | null
  quoteMileageCents?: number | null
  quoteBillableMiles?: number | null
  quoteTotalCents?: number | null
  /** Both ends of the move, as stored. */
  pickupAddressComplete?: boolean | null
  destinationAddressComplete?: boolean | null
  /** Used to recognise a labor-only job. */
  jobType?: string | null
  serviceType?: string | null
  serviceInterest?: string | null
}

export type Transportation = {
  state: TransportationState
  billableMiles: number | null
  mileageCents: number | null
}

export function transportation(row: TransportationRow): Transportation {
  const none = { billableMiles: null, mileageCents: null }
  const status = (row.quoteMileageStatus ?? '').trim().toLowerCase()

  //  LABOR-ONLY FIRST. The customer supplies the truck, so there is no route to
  //  wait for and no mileage to bill. Saying "awaiting addresses" here would
  //  invent a step that does not exist on this product.
  const product = resolveServiceType({
    serviceType: row.serviceType,
    serviceInterest: row.serviceInterest ?? row.jobType,
  })
  if (product === 'labor_only' || status === MILEAGE_STATUS.notApplicable) {
    return { state: 'NOT_APPLICABLE', ...none }
  }

  if (status === MILEAGE_STATUS.calculated) {
    const miles = typeof row.quoteBillableMiles === 'number' ? row.quoteBillableMiles : null
    const cents = typeof row.quoteMileageCents === 'number' ? row.quoteMileageCents : null
    //  A total claiming to contain a drive must be able to explain it. Without
    //  both numbers the claim is unsupported, so it degrades to a review state
    //  rather than printing a routed figure nobody can check.
    if (miles === null || cents === null) return { state: 'ROUTING_FAILED', ...none }
    return { state: 'ROUTED', billableMiles: miles, mileageCents: cents }
  }

  if (status === MILEAGE_STATUS.routingFailed) return { state: 'ROUTING_FAILED', ...none }

  if (status === MILEAGE_STATUS.pending) {
    const both = row.pickupAddressComplete === true && row.destinationAddressComplete === true
    return { state: both ? 'READY_TO_ROUTE' : 'WAITING_FOR_ADDRESSES', ...none }
  }

  return { state: 'UNKNOWN_LEGACY', ...none }
}

/**
 * Money, in the house style.
 *
 * Whole dollars lose the `.00`, because the published rule is "$3 per routed
 * mile" and every other surface — the price book note, the customer email, the
 * rich Discord card — writes it that way. A card that says "$3.00 per routed
 * mile" is not wrong, but it is a second wording for one rate, and two wordings
 * for one number is how the size labels drifted.
 */
const money = (cents: number): string =>
  cents % 100 === 0
    ? `$${(cents / 100).toLocaleString('en-US')}`
    : `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/**
 * The transportation line, in the owner's words.
 *
 * `perMileCents` is passed in rather than imported so this file stays free of
 * the price book — the rate is a pricing fact and has exactly one home.
 */
export function transportationLabel(t: Transportation, perMileCents: number): string {
  switch (t.state) {
    case 'ROUTED':
      return t.billableMiles !== null && t.mileageCents !== null
        ? `${t.billableMiles} routed miles · ${money(t.mileageCents)} · fuel included`
        : 'Routed'
    case 'READY_TO_ROUTE':
      return `Ready to route — addresses complete, ${money(perMileCents)} per routed mile, fuel included`
    case 'WAITING_FOR_ADDRESSES':
      return `Pending — awaiting pickup and destination addresses (${money(perMileCents)} per routed mile, fuel included)`
    case 'ROUTING_FAILED':
      return 'Manual review — route calculation unavailable'
    case 'NOT_APPLICABLE':
      return 'Not applicable — labor only, the customer provides transportation'
    case 'UNKNOWN_LEGACY':
      return 'Unknown — captured before transportation was recorded'
  }
}

// ════════════════════════════════════════════════════════════════════════
//  LIFECYCLE — a partial capture is not a completed request
//
//  Both used to arrive as an identical "New lead", so the owner could not tell
//  a half-typed contact step from a finished move request without opening the
//  admin.
// ════════════════════════════════════════════════════════════════════════

export type LeadStage =
  /** Contact details captured; the form is still being filled in. */
  | 'CONTACT_CAPTURED'
  /** Partway through, past the contact step. */
  | 'IN_PROGRESS'
  /** The whole move request was submitted. */
  | 'COMPLETED'
  /** Started and then left. */
  | 'ABANDONED'
  /** An ordinary CRM lead with no partial-capture lifecycle. */
  | 'LEAD'

export function leadStage(row: { lifecycle?: string | null; convertedBookingId?: string | null }): LeadStage {
  if (row.convertedBookingId) return 'COMPLETED'
  switch ((row.lifecycle ?? '').trim().toUpperCase()) {
    case 'PARTIAL':
      return 'CONTACT_CAPTURED'
    case 'IN_PROGRESS':
      return 'IN_PROGRESS'
    case 'SUBMITTED':
    case 'CONVERTED':
      return 'COMPLETED'
    case 'ABANDONED':
      return 'ABANDONED'
    default:
      return 'LEAD'
  }
}

export const LEAD_STAGE_LABEL: Record<LeadStage, string> = {
  CONTACT_CAPTURED: 'Contact captured',
  IN_PROGRESS: 'Part-way through the form',
  COMPLETED: 'Move request completed',
  ABANDONED: 'Abandoned',
  LEAD: 'Lead',
}

/** True while the customer is still filling the form in. */
export const isPartialStage = (s: LeadStage): boolean =>
  s === 'CONTACT_CAPTURED' || s === 'IN_PROGRESS'
