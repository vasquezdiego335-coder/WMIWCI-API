// ════════════════════════════════════════════════════════════════════════
//  NEW LEAD → DISCORD (owner request 2026-07-28)
//  ---------------------------------------------------------------------
//  THE GAP THIS CLOSES. Lead capture worked end to end -- quote form to
//  /api/leads to Neon, with tri-state consent, move size, both zips and the
//  source page. And then nothing happened. The lead sat in /admin/leads under
//  the "Opted in" filter until the owner happened to open the dashboard.
//
//  The owner's opening constraint for this whole system was that he cannot sit
//  watching an admin panel -- he is sick, driving, or carrying a couch. A
//  capture pipeline nobody is told about is a capture pipeline that loses the
//  first hour of every lead, which is the hour that converts.
//
//  DESIGN RULES
//   1. NOT the alerts channel. That one is for incidents. A channel that pings
//      for routine traffic gets muted, and a muted alerts channel means the
//      critical alerts are gone too. Leads go to their own channel, falling
//      back to news then operations.
//   2. EVERY new lead, not only marketing opt-ins. A quote request is worth
//      knowing about regardless of whether they ticked a box; the consent
//      state is one line ON the card. Missing a job is worse than a ping.
//   3. Exactly once, by construction. Fired only from the `isNew` branch of
//      capture, which is the same branch that fires `lead_created` -- a repeat
//      submission merges into the existing lead and takes the update path.
//   4. Never throws, never blocks. A Discord outage must not cost a lead. The
//      caller does not await it.
//   5. Consent is REPORTED, never asserted.
//
//  ── THE CARD NO LONGER DERIVES BUSINESS MEANING (fix 2026-08-25) ────────
//  A real card went out reading "Marketing: not asked" and "From: OTHER" for a
//  customer who had been shown the marketing checkbox and had never been asked
//  where they heard about us. Both lines were produced the same way: a null or
//  a column default, rendered through a `?? fallback`, as though it were an
//  answer somebody had given.
//
//  Every state on this card is now derived in lead-state.ts, from evidence,
//  and handed here as a finished view model. This file FORMATS. It does not
//  decide. That split is the fix: a formatter with no truthy checks in it
//  cannot invent a customer's intent, and the states it prints are the same
//  ones the admin and the automation read.
//
//  RAW ENUMS NEVER REACH THE OWNER. `OTHER` and `UNKNOWN` are not channels
//  anybody chose -- they are the Prisma default and the mapLeadSource()
//  fallback -- so they are filtered before rendering, exactly as
//  booking-display.ts `originLine()` has always filtered them. The two
//  owner-facing renderers disagreed, and this was the one without the guard.
// ════════════════════════════════════════════════════════════════════════

import { postToChannels, type AlertLine, type AlertResult } from './ops-alert'
import { apiLogger } from './logger'
import { PACKAGES, TRANSPORTATION_MILEAGE } from './pricing-config'
import { notificationQuoteOf, reviewReasonsOf, type LeadSnapshotRow } from './quote-snapshot'
import {
  acquisition,
  acquisitionLabel,
  isPartialStage,
  leadStage,
  LEAD_STAGE_LABEL,
  MARKETING_CONSENT_LABEL,
  marketingConsentState,
  selfReportedSource,
  selfReportedSourceLabel,
  transportation,
  transportationLabel,
  type LeadStage,
  type MarketingConsentState,
} from './lead-state'

const log = apiLogger.child({ mod: 'lead-alert' })

/** Channel order: a dedicated leads channel if one exists, else somewhere the
 *  owner still looks. Never DISCORD_CHANNEL_ALERTS -- see rule 1. */
const LEAD_CHANNELS = ['DISCORD_CHANNEL_LEADS', 'DISCORD_CHANNEL_NEWS', 'DISCORD_CHANNEL_OPERATIONS']

export type LeadAlertInput = {
  id: string
  name?: string | null
  email?: string | null
  phone?: string | null
  source?: string | null
  moveSize?: string | null
  moveDate?: Date | string | null
  originZip?: string | null
  destinationZip?: string | null
  estimatedValue?: number | null // cents — LIVE, may be raised later
  // ── The frozen quote snapshot, exactly as stored. Optional: a lead captured
  //    before these columns existed renders as it always did. Every field is
  //    supplied by `toLeadAlertInput()`, which BOTH production paths call. ──
  quoteTotalCents?: number | null
  quoteBaseCents?: number | null
  quoteTruckCents?: number | null
  quoteIncludedTruck?: string | null
  quoteMileageStatus?: string | null
  quotePriceBookVersion?: string | null
  quoteMileageCents?: number | null
  quoteBillableMiles?: number | null
  quoteRequiresReview?: boolean | null
  /** Already split out of the stored newline-joined text. */
  reviewReasons?: string[] | null
  emailMarketingConsent?: boolean | null
  landingPage?: string | null
  utmSource?: string | null
  utmMedium?: string | null
  utmCampaign?: string | null
  referrer?: string | null
  attributionId?: string | null
  /** The capture MODE, read back off the lead. 'quote_in_person' means the
   *  customer asked for a visit, so there is deliberately no number. */
  formStep?: string | null

  // ── PROVENANCE (2026-08-25). What we can PROVE about the questions asked. ──
  /** TRUE when the originating form displayed the marketing checkbox. */
  marketingConsentPrompted?: boolean | null
  /** Which surface recorded the consent decision, e.g. 'BOOKING_FORM'. */
  marketingConsentSource?: string | null
  /** The customer's own "How did you hear about us?" answer, verbatim. */
  foundUs?: string | null
  /** TRUE when that question was actually put in front of them. */
  foundUsPrompted?: boolean | null
  /** Partial-capture lifecycle: PARTIAL / IN_PROGRESS / SUBMITTED / CONVERTED. */
  lifecycle?: string | null
  convertedBookingId?: string | null
  /** Used to recognise a labor-only job, which has no routed mileage. */
  jobType?: string | null
  /** Address completeness, so "we are waiting for them" and "routing failed"
   *  can never render as the same sentence. */
  pickupAddressComplete?: boolean | null
  destinationAddressComplete?: boolean | null
}

/** Must match IN_PERSON_LABEL in the capture route: ONE string across the
 *  lead notes, this card, the confirmation email and the admin list, so the
 *  same request cannot end up with three different names. */
export const IN_PERSON_ALERT_LABEL = 'In-Person Estimate Requested'
export const isInPersonRequest = (formStep?: string | null): boolean =>
  (formStep ?? '').trim().toLowerCase() === 'quote_in_person'

/** Move-size keys are the price-book keys; spell them for a human.
 *
 *  DERIVED, NOT TRANSCRIBED (fix 2026-08-22). This was a hand-written second
 *  label book, and it had already drifted: it called the tiers "Little studio"
 *  / "Half studio" / "Full studio" while the price book — and therefore the
 *  quote page, the emails and the quick-quote Discord card — called the same
 *  keys "Small Studio" / "Standard Studio" / "Large Studio". One owner could
 *  read two different names for one booking depending on which alert fired.
 *  Retired keys stay resolvable here on purpose: an alert about a historical
 *  lead must still say what that lead bought. */
const SIZE_LABELS: Record<string, string> = Object.fromEntries(
  Object.values(PACKAGES).map((p) => [p.key, p.label])
)

const money = (cents?: number | null): string | null =>
  typeof cents === 'number' && cents > 0 ? `$${(cents / 100).toLocaleString('en-US')}` : null

const day = (d?: Date | string | null): string | null => {
  if (!d) return null
  const t = d instanceof Date ? d : new Date(d)
  if (Number.isNaN(t.getTime())) return null
  return t.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/New_York' })
}

/**
 * Consent, stated honestly.
 *
 * ── WHY THIS TAKES PROVENANCE NOW ──────────────────────────────────────
 * It used to take a bare `boolean | null` and map `null` to "not asked". That
 * single line is what put "Marketing: not asked" on a card for a customer who
 * had the checkbox on screen the whole time: the booking form only sent a
 * value when the box had been CLICKED, so "shown and left alone" arrived
 * indistinguishable from "never shown".
 *
 * A bare null cannot answer the question, so it no longer pretends to. "Not
 * asked" is now a claim that requires proof — the client saying the box was
 * absent, or a form contract that says the surface has none.
 */
export function consentLine(
  consent?: boolean | null,
  provenance?: { marketingConsentPrompted?: boolean | null; marketingConsentSource?: string | null; captureSurface?: string | null },
): string {
  const state = marketingConsentState({
    emailMarketingConsent: consent ?? null,
    marketingConsentPrompted: provenance?.marketingConsentPrompted ?? null,
    marketingConsentSource: provenance?.marketingConsentSource ?? null,
    captureSurface: provenance?.captureSurface ?? null,
  })
  return `Marketing email: ${MARKETING_CONSENT_LABEL[state]}`
}

/**
 * THE ONE mapping from a stored `crm_leads` row to a plain-notice input.
 *
 * WHY IT IS EXPORTED. The previous round tested `formatLeadAlert()` with a
 * hand-assembled ideal object, while BOTH production callers
 * (leads.notifyOwnerOfNewLead and quote-capture's postLeadNoticeDirect) passed
 * a row with no `quote_*` fields at all — one path did not even SELECT them.
 * The formatter was correct, the wiring was missing, and no test could tell
 * the difference because no test used the wiring.
 *
 * Both callers now go through this function, and so do the tests. If it stops
 * carrying a field, every one of them notices at once.
 */
export function toLeadAlertInput(
  row: {
    id: string
    name?: string | null
    email?: string | null
    phone?: string | null
    source?: unknown
    moveSize?: string | null
    moveDate?: Date | string | null
    originZip?: string | null
    destinationZip?: string | null
    emailMarketingConsent?: boolean | null
    landingPage?: string | null
    utmSource?: string | null
    utmMedium?: string | null
    utmCampaign?: string | null
    referrer?: string | null
    attributionId?: string | null
    formStep?: string | null
    marketingConsentPrompted?: boolean | null
    marketingConsentSource?: string | null
    foundUs?: string | null
    foundUsPrompted?: boolean | null
    lifecycle?: unknown
    convertedBookingId?: string | null
    jobType?: string | null
    pickupAddressComplete?: boolean | null
    destinationAddressComplete?: boolean | null
  } & LeadSnapshotRow,
): LeadAlertInput {
  return {
    id: row.id,
    name: row.name ?? null,
    email: row.email ?? null,
    phone: row.phone ?? null,
    source: row.source == null ? null : String(row.source),
    moveSize: row.moveSize ?? null,
    moveDate: row.moveDate ?? null,
    originZip: row.originZip ?? null,
    destinationZip: row.destinationZip ?? null,
    emailMarketingConsent: row.emailMarketingConsent ?? null,
    landingPage: row.landingPage ?? null,
    utmSource: row.utmSource ?? null,
    utmMedium: row.utmMedium ?? null,
    utmCampaign: row.utmCampaign ?? null,
    referrer: row.referrer ?? null,
    attributionId: row.attributionId ?? null,
    formStep: row.formStep ?? null,
    // ── PROVENANCE. Missing ONE of these is how a question we never asked
    //    turns back into an answer the customer never gave.
    marketingConsentPrompted: row.marketingConsentPrompted ?? null,
    marketingConsentSource: row.marketingConsentSource ?? null,
    foundUs: row.foundUs ?? null,
    foundUsPrompted: row.foundUsPrompted ?? null,
    lifecycle: row.lifecycle == null ? null : String(row.lifecycle),
    convertedBookingId: row.convertedBookingId ?? null,
    jobType: row.jobType ?? null,
    pickupAddressComplete: row.pickupAddressComplete ?? null,
    destinationAddressComplete: row.destinationAddressComplete ?? null,
    // The whole frozen snapshot, verbatim. Missing ONE of these is how a
    // disclosure silently disappears from the notice nobody watches.
    estimatedValue: row.estimatedValue ?? null,
    quoteTotalCents: row.quoteTotalCents ?? null,
    quoteBaseCents: row.quoteBaseCents ?? null,
    quoteTruckCents: row.quoteTruckCents ?? null,
    quoteIncludedTruck: row.quoteIncludedTruck ?? null,
    quoteMileageStatus: row.quoteMileageStatus ?? null,
    quotePriceBookVersion: row.quotePriceBookVersion ?? null,
    quoteMileageCents: row.quoteMileageCents ?? null,
    quoteBillableMiles: row.quoteBillableMiles ?? null,
    quoteRequiresReview: row.quoteRequiresReview ?? null,
    reviewReasons: reviewReasonsOf(row),
  }
}

/**
 * The capture surface, for the form-contract lookup.
 *
 * `marketingConsentSource` is the surface that RECORDED a consent decision and
 * is the strongest signal, but it is null on exactly the leads that never made
 * one. A `source` that names one of our own forms is the fallback; a marketing
 * CHANNEL (google, door hanger) is not a surface and is ignored here.
 */
function captureSurfaceOf(lead: LeadAlertInput): string | null {
  const consentSurface = (lead.marketingConsentSource ?? '').trim()
  if (consentSurface) return consentSurface
  const src = (lead.source ?? '').trim().toUpperCase()
  return src.endsWith('_FORM') || src.endsWith('_PAGE') || src === 'HOMEPAGE_ESTIMATE' || src === 'MOVING_CHECKLIST'
    ? src
    : null
}

/** The emoji + wording for a title, chosen from the STATE rather than from a
 *  chain of ternaries nobody can read. */
function titleFor(stage: LeadStage, who: string, consent: MarketingConsentState, needsTravelReview: boolean): string {
  if (needsTravelReview) return `🟠 ${LEAD_STAGE_LABEL.COMPLETED} — manual travel review · ${who}`
  if (stage === 'COMPLETED') return `🟢 ${LEAD_STAGE_LABEL.COMPLETED} — ${who}`
  if (isPartialStage(stage)) {
    return consent === 'OPTED_IN'
      ? `🟢 New partial lead — ${who} (opted in)`
      : `🟡 New partial lead — ${who}`
  }
  //  An ordinary CRM lead, with no partial-capture lifecycle at all.
  return consent === 'OPTED_IN' ? `🟢 New lead — ${who} (opted in)` : `🟡 New lead — ${who}`
}

/**
 * Build the card. PURE -- no network, no clock beyond the passed date, so the
 * wording is testable without Discord.
 *
 * Every business state comes from lead-state.ts. Nothing below decides what a
 * missing value means.
 */
export function formatLeadAlert(lead: LeadAlertInput): { title: string; lines: AlertLine[] } {
  const who = (lead.name ?? '').trim() || 'Someone'
  const inPerson = isInPersonRequest(lead.formStep)
  const surface = captureSurfaceOf(lead)

  // ── THE CANONICAL STATES, derived once ─────────────────────────────────
  const stage = leadStage(lead)
  const consent = marketingConsentState({
    emailMarketingConsent: lead.emailMarketingConsent ?? null,
    marketingConsentPrompted: lead.marketingConsentPrompted ?? null,
    marketingConsentSource: lead.marketingConsentSource ?? null,
    captureSurface: surface,
  })
  const found = selfReportedSource({
    foundUs: lead.foundUs ?? null,
    foundUsPrompted: lead.foundUsPrompted ?? null,
    captureSurface: surface,
    formStep: lead.formStep ?? null,
  })
  const acq = acquisition(lead)
  const travel = transportation({
    quoteMileageStatus: lead.quoteMileageStatus ?? null,
    quoteMileageCents: lead.quoteMileageCents ?? null,
    quoteBillableMiles: lead.quoteBillableMiles ?? null,
    quoteTotalCents: lead.quoteTotalCents ?? null,
    pickupAddressComplete: lead.pickupAddressComplete ?? null,
    destinationAddressComplete: lead.destinationAddressComplete ?? null,
    jobType: lead.jobType ?? null,
    serviceInterest: lead.jobType ?? null,
  })

  const q = notificationQuoteOf(lead)
  const est = money(q.quotedCents)
  //  A completed request whose route could not be measured is the owner's
  //  problem to chase, not the customer's, so it is flagged in the TITLE —
  //  the only part of the notification a phone shows on the lock screen.
  const needsTravelReview = stage === 'COMPLETED' && travel.state === 'ROUTING_FAILED'

  const title = inPerson
    ? `🏠 ${IN_PERSON_ALERT_LABEL} — ${who}`
    : titleFor(stage, who, consent, needsTravelReview)

  const lines: AlertLine[] = []
  if (inPerson) lines.push({ message: `${IN_PERSON_ALERT_LABEL} — no automatic price was produced.` })

  //  WHERE THEY ARE IN THE FORM. A half-typed contact step and a finished move
  //  request used to arrive as an identical "New lead"; the owner could not
  //  tell one from the other without opening the admin.
  if (stage !== 'LEAD') lines.push({ message: `Stage: ${LEAD_STAGE_LABEL[stage]}` })

  // Contact first: this is what the owner acts on.
  const contact = [lead.phone?.trim(), lead.email?.trim()].filter(Boolean).join('  ·  ')
  if (contact) lines.push({ message: contact })

  // What they want.
  const job: string[] = []
  const size = lead.moveSize ? SIZE_LABELS[lead.moveSize] ?? lead.moveSize : null
  if (size) job.push(size)
  const route = [lead.originZip?.trim(), lead.destinationZip?.trim()].filter(Boolean)
  if (route.length === 2) job.push(`${route[0]} → ${route[1]}`)
  else if (route.length === 1) job.push(`from ${route[0]}`)
  const when = day(lead.moveDate)
  if (when) job.push(when)
  // ── THE PLAIN FALLBACK MUST BE AS HONEST AS THE RICH CARD ──────────────
  //  This notice goes out when the queue is down, so it is precisely the path
  //  nobody watches. It printed a bare "est. $779", which reads as a finished
  //  price — while the rich card, for the same lead, says the drive is not in
  //  that number yet. Two notices for one lead must not disagree.
  //
  //  Derived through notificationQuoteOf, the SAME mapping every other surface
  //  uses, so the frozen snapshot beats the mutable estimatedValue here for
  //  exactly the reason it does everywhere else.
  if (est) {
    if (!q.hasSnapshot) {
      // A HISTORICAL lead, captured before the snapshot columns existed. It
      // keeps exactly the wording it always had.
      job.push(`est. ${est}`)
    } else if (q.mileageStatus === 'pending' || q.mileageStatus === 'routing_failed') {
      // A subtotal, said plainly. The drive is disclosed on the next line.
      job.push(`${est} package subtotal`)
    } else if (q.mileageStatus === 'calculated') {
      job.push(`est. ${est}`)
    }
    // A snapshot whose mileage state we cannot read is the one case where the
    // amount is SUPPRESSED rather than captioned: calling it final would be a
    // guess, and calling it a subtotal would be one too.
  }
  if (job.length) lines.push({ message: `Move: ${job.join('  ·  ')}` })

  //  TRANSPORTATION AS A STATE, NOT A FLAG. "Pending" used to be the only
  //  thing this could say, so a routing FAILURE on a lead with two complete
  //  addresses would have read as though we were still waiting on the customer.
  //  Suppressed only for a pre-snapshot record, which genuinely knows nothing.
  if (travel.state !== 'UNKNOWN_LEGACY') {
    lines.push({ message: `Transportation: ${transportationLabel(travel, TRANSPORTATION_MILEAGE.ratePerMileCents)}` })
  }

  //  WHY IT NEEDS A HUMAN, on the notice the owner actually reads. The flag
  //  was computed server-side and then never shown anywhere.
  //
  //  `toLeadAlertInput` hands these over ALREADY SPLIT, so prefer that; the
  //  derived form is the fallback for a caller passing a raw row. Reading only
  //  the derived form silently dropped every reason, because the split array
  //  and the joined column are different fields.
  const reasons = lead.reviewReasons?.length ? lead.reviewReasons : q.reviewReasons
  if (reasons.length > 0) {
    lines.push({ message: `⚠️ Manual review: ${reasons.join(' ')}` })
  }

  lines.push({ message: consentLine(lead.emailMarketingConsent, { ...lead, captureSurface: surface }) })

  // ── TWO DIFFERENT FACTS, TWO DIFFERENT LINES ───────────────────────────
  //  What our tracking observed, and what the customer said. These used to
  //  share one "From:" line, so a column default could be read as the
  //  customer's own answer — which is exactly how "From: OTHER" happened.
  lines.push({ message: `Tracked acquisition: ${acquisitionLabel(acq)}` })
  lines.push({ message: `Customer-reported source: ${selfReportedSourceLabel(found)}` })

  return { title, lines }
}

/**
 * Tell the owner about a new lead. Fire-and-forget: never throws, and the
 * caller must not await it.
 */
export async function notifyNewLead(lead: LeadAlertInput): Promise<AlertResult> {
  try {
    const { title, lines } = formatLeadAlert(lead)
    const res = await postToChannels(LEAD_CHANNELS, title, lines, 'lead notice')
    if (!res.delivered) {
      // A lead that reached the database but not the owner is worth a log line
      // at warn: the capture succeeded, the notification did not.
      log.warn({ leadId: lead.id, reason: res.reason }, 'new-lead notice not delivered')
    }
    return res
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    log.warn({ leadId: lead.id, err: reason }, 'new-lead notice failed (non-fatal)')
    return { delivered: false, reason }
  }
}
