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
  estimatedValue?: number | null // cents
  emailMarketingConsent?: boolean | null
  landingPage?: string | null
  utmSource?: string | null
  utmCampaign?: string | null
}

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

/** Move-size keys are the price-book keys; spell them for a human. */
const SIZE_LABELS: Record<string, string> = {
  'little-studio': 'Little studio',
  'half-studio': 'Half studio',
  'full-studio': 'Full studio',
  '1br': '1 bedroom',
  '2br': '2 bedrooms',
  '3br': '3 bedrooms',
  '4br': '4 bedrooms',
  '5br': '5 bedrooms',
}

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
 * Build the card. PURE -- no network, no clock beyond the passed date, so the
 * wording is testable without Discord.
 */
export function formatLeadAlert(lead: LeadAlertInput): { title: string; lines: AlertLine[] } {
  const who = (lead.name ?? '').trim() || 'Someone'
  const optedIn = lead.emailMarketingConsent === true
  const title = optedIn ? `🟢 New lead — ${who} (opted in)` : `🟡 New lead — ${who}`

  const lines: AlertLine[] = []

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
  const est = money(lead.estimatedValue)
  if (est) job.push(`est. ${est}`)
  if (job.length) lines.push({ message: job.join('  ·  ') })

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
