// ════════════════════════════════════════════════════════════════════════
//  lead-notification-transport.ts — the ONE real Discord call for a lead
//  notice, returning a typed outcome the processor can act on.
//
//  Separated from the processor so an integration test can drive the REAL
//  processor against a local receiver while production drives it against
//  Discord. The classification rules are shared, not duplicated.
// ════════════════════════════════════════════════════════════════════════
import { prisma } from './db'
import { categorizeResponse, categorizeThrown, type DeliveryOutcome } from './lead-notification-processor'
import { QUOTE_SNAPSHOT_SELECT } from './quote-snapshot'

/** Timeout for one provider request. */
export const PROVIDER_TIMEOUT_MS = 8000

/** Everything the owner card needs, read once. */
const CARD_SELECT = {
  id: true, name: true, email: true, phone: true, source: true, moveSize: true,
  moveDate: true, originZip: true, destinationZip: true,
  emailMarketingConsent: true, landingPage: true, utmSource: true, utmCampaign: true,
  formStep: true, utmMedium: true, referrer: true, attributionId: true,
  marketingConsentPrompted: true, marketingConsentSource: true,
  foundUs: true, foundUsPrompted: true,
  pickupAddressComplete: true, destinationAddressComplete: true,
  lifecycle: true, convertedBookingId: true, jobType: true,
  ...QUOTE_SNAPSHOT_SELECT,
} as const

/**
 * Build the card and POST it. Returns a typed outcome — never throws for a
 * provider condition, so the processor sees one shape for every path.
 */
export async function deliverLeadNotice(leadId: string, ref: string): Promise<DeliveryOutcome> {
  const now = new Date()
  const token = process.env.DISCORD_BOT_TOKEN
  const channelId =
    process.env.DISCORD_CHANNEL_LEADS || process.env.DISCORD_CHANNEL_NEWS || process.env.DISCORD_CHANNEL_OPERATIONS

  //  A MISSING TOKEN OR CHANNEL IS OUR FAULT, not a provider rejection. Saying
  //  so plainly is what stops a misconfigured deploy from looking like Discord
  //  being flaky — and no provider request is claimed to have happened.
  if (!token || !channelId) {
    return {
      delivered: false, httpStatus: null, retryAfter: null, category: 'configuration', ref,
      detail: !token ? 'DISCORD_BOT_TOKEN is not configured' : 'no lead channel is configured',
    }
  }

  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: CARD_SELECT })
  if (!lead) {
    return { delivered: false, httpStatus: null, retryAfter: null, category: 'cancelled', ref, detail: 'lead not found' }
  }

  const { formatLeadAlert, toLeadAlertInput } = await import('./lead-alert')
  const { discordSafe } = await import('./booking-display')
  const { title, lines } = formatLeadAlert(toLeadAlertInput(lead as never))
  const body = lines.slice(0, 8).map((l) => `• ${discordSafe(l.message, 400)}`).join('\n')
  const content = `${discordSafe(title, 200)}\n${body}`.slice(0, 1900)

  const base = process.env.DISCORD_API_BASE || 'https://discord.com'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS)
  try {
    const res = await fetch(`${base}/api/v10/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
      //  parse: [] — customer text can never resolve a mention.
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
      signal: controller.signal,
    })
    //  The body is attacker-influenced and unbounded: read a bounded excerpt
    //  only, and never persist it raw.
    let detail = ''
    if (!res.ok) detail = (await res.text().catch(() => '')).slice(0, 160).replace(/[\r\n]+/g, ' ')
    return categorizeResponse(res.status, res.headers.get('retry-after'), now, ref, detail)
  } catch (err) {
    return categorizeThrown(err, ref)
  } finally {
    clearTimeout(timer)
  }
}
