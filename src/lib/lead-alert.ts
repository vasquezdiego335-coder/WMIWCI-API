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
//   5. Consent is REPORTED, never asserted. "opted in" appears only for a
//      literal true; null renders as "not asked", which is the honest word for
//      a visitor who never saw or never touched the box.
// ════════════════════════════════════════════════════════════════════════

import { postToChannels, type AlertLine, type AlertResult } from './ops-alert'
import { apiLogger } from './logger'
import { PACKAGES } from './pricing-config'
import { notificationQuoteOf, reviewReasonsOf, type LeadSnapshotRow } from './quote-snapshot'

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
  utmCampaign?: string | null
  /** The capture MODE, read back off the lead. 'quote_in_person' means the
   *  customer asked for a visit, so there is deliberately no number. */
  formStep?: string | null
}

/** Must match IN_PERSON_LABEL in the capture route: ONE string across the
 *  lead notes, this card, the confirmation email and the admin list, so the
 *  same request cannot end up with three different names. */
export const IN_PERSON_ALERT_LABEL = 'In-Person Estimate Requested'
export const isInPersonRequest = (formStep?: string | null): boolean =>
  (formStep ?? '').trim().toLowerCase() === 'quote_in_person'

/** Human labels for the capture surfaces, so the card does not read like a
 *  database dump. Unknown sources fall through to the raw value -- inventing a
 *  friendly name for something unrecognised would hide a mis-tagged form. */
const SOURCE_LABELS: Record<string, string> = {
  QUICK_QUOTE_FORM: 'Quick quote form',
  SERVICES_PAGE: 'Services page',
  BOOKING_FORM: 'Booking form',
  HOMEPAGE_ESTIMATE: 'Homepage estimate',
  CONTACT_FORM: 'Contact form',
  DOOR_HANGER: 'Door hanger',
  REFERRAL: 'Referral',
  WEBSITE: 'Website',
}

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
 * The three states are genuinely different and the card must not flatten them:
 * `true` they asked for email, `false` they were shown the box and left it,
 * `null`/undefined they were never asked at all.
 */
export function consentLine(consent?: boolean | null): string {
  if (consent === true) return 'Marketing: OPTED IN — they asked to hear from you'
  if (consent === false) return 'Marketing: not opted in'
  return 'Marketing: not asked'
}

/**
 * THE ONE mapping from a stored `leads` row to a plain-notice input.
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
    utmCampaign?: string | null
    formStep?: string | null
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
    utmCampaign: row.utmCampaign ?? null,
    formStep: row.formStep ?? null,
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
 * Build the card. PURE -- no network, no clock beyond the passed date, so the
 * wording is testable without Discord.
 */
export function formatLeadAlert(lead: LeadAlertInput): { title: string; lines: AlertLine[] } {
  const who = (lead.name ?? '').trim() || 'Someone'
  const optedIn = lead.emailMarketingConsent === true
  const inPerson = isInPersonRequest(lead.formStep)

  // An in-person request is a DIFFERENT job for the owner — someone has to go
  // and look at it — so it has to be recognisable in the notification list
  // without opening anything.
  const title = inPerson
    ? `🏠 ${IN_PERSON_ALERT_LABEL} — ${who}`
    : optedIn
      ? `🟢 New lead — ${who} (opted in)`
      : `🟡 New lead — ${who}`

  const lines: AlertLine[] = []
  if (inPerson) lines.push({ message: `${IN_PERSON_ALERT_LABEL} — no automatic price was produced.` })

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
  const q = notificationQuoteOf(lead)
  const est = money(q.quotedCents)

  if (est) {
    if (!q.hasSnapshot) {
      // A HISTORICAL lead, captured before the snapshot columns existed. It
      // keeps exactly the wording it always had.
      job.push(`est. ${est}`)
    } else if (q.mileageStatus === 'pending') {
      // A subtotal, said plainly. The drive is disclosed on the next line.
      job.push(`${est} package subtotal`)
    } else if (q.mileageStatus === 'calculated') {
      job.push(`est. ${est}`)
    }
    // A snapshot whose mileage state we cannot read is the one case where the
    // amount is SUPPRESSED rather than captioned: calling it final would be a
    // guess, and calling it a subtotal would be one too.
  }
  if (job.length) lines.push({ message: job.join('  ·  ') })

  if (est && q.mileagePending) {
    lines.push({ message: 'Transportation pending — $3 per routed mile, fuel included.' })
  }
  if (est && q.mileageStatus === 'calculated' && q.billableMiles && q.mileageCents !== null) {
    lines.push({
      message: `Includes transportation: ${q.billableMiles} routed miles at $3/mile = ${money(q.mileageCents)}.`,
    })
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

  lines.push({ message: consentLine(lead.emailMarketingConsent) })

  // Where it came from — the whole point of the source tagging.
  const src = lead.source ? SOURCE_LABELS[lead.source] ?? lead.source : null
  const campaign = [lead.utmSource?.trim(), lead.utmCampaign?.trim()].filter(Boolean).join(' / ')
  const from = [src, campaign || null].filter(Boolean).join('  ·  ')
  if (from) lines.push({ message: `From: ${from}` })

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
