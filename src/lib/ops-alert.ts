// ════════════════════════════════════════════════════════════════════════
//  OPS ALERT DELIVERY (audit E-04 follow-up, 2026-07-27)
//  ---------------------------------------------------------------------
//  Puts CRITICAL conditions somewhere a human actually looks. The monitoring
//  sweep already logs them, but a log line is only an alert if someone is
//  reading the logs, and nobody watches a log stream continuously.
//
//  WHY NOT REUSE src/bot/discord-rest.ts: it imports discord.js for its embed
//  builders, and discord.js pulls in @discordjs/ws → zlib-sync, an optional
//  native module. Importing it from here dragged the entire Discord client into
//  the Next.js bundle for /api/admin/email-marketing/health and BROKE THE
//  PRODUCTION BUILD. A monitoring module must not depend on a chat library.
//
//  So this is a bare HTTPS POST to the Discord REST API — no SDK, no native
//  deps, nothing to bundle. It is the same endpoint the bot uses.
//
//  DESIGN RULES
//   1. Never throws. Alerting must not be able to break the thing that
//      produced the alert.
//   2. Reports whether a channel ACCEPTED the message, so "we alerted" and
//      "we could not reach anyone" stay distinguishable afterwards.
//   3. CRITICAL only. A channel that pings for routine warnings gets muted,
//      and a muted channel is worse than no channel at all.
// ════════════════════════════════════════════════════════════════════════

import { queueLogger } from './logger'
//  THE SAME neutraliser the rich lead card and the deposit notice already use.
//  Imported rather than reimplemented, so the owner-facing renderers cannot
//  drift into three different ideas of what is safe to post.
import { discordSafe } from './booking-display'

const log = queueLogger.child({ mod: 'ops-alert' })

const REQUEST_TIMEOUT_MS = 5000

/**
 * Is this value REALLY configured?
 *
 * Placeholder-aware. A literal `PASTE_ALERTS_CHANNEL_ID` was previously treated
 * as a real channel id, so the alert path reported itself configured and
 * Discord answered `400 Invalid Form Body`. Unconfigured must LOOK
 * unconfigured, not broken.
 */
const configured = (v?: string): boolean => {
  const t = v?.trim()
  if (!t) return false
  return !/^(REPLACE|PASTE|PUT|ADD|SET|INSERT|YOUR|CHANGE|EXAMPLE|SAMPLE|TODO|XXX)([_-]|$)/i.test(t) && !t.includes('REPLACE')
}

export type AlertLine = { message: string; action?: string }

export type AlertResult = {
  /** True only when Discord accepted the message. */
  delivered: boolean
  /** Why it was not delivered, when it was not. */
  reason?: string
}

/**
 * Post a critical alert to the first configured ops channel.
 *
 * Channel order is deliberate: the alerts channel first, operations as a
 * fallback, so a missing alerts channel degrades to somewhere visible rather
 * than to silence.
 */
export async function postOpsAlert(title: string, lines: AlertLine[]): Promise<AlertResult> {
  return postToChannels(['DISCORD_CHANNEL_ALERTS', 'DISCORD_CHANNEL_OPERATIONS'], title, lines, 'ops alert')
}

/**
 * Post to the first configured channel in `channelVars`, in order.
 *
 * Extracted so a NON-incident notice (a new lead) can reuse this exact
 * transport without landing in the alerts channel. Rule 3 in the header is why
 * that separation matters: a channel that pings for routine traffic gets muted,
 * and once the alerts channel is muted the critical alerts are gone too.
 *
 * Fallback order is the caller's business; degrading to a visible channel beats
 * degrading to silence.
 */
export async function postToChannels(
  channelVars: string[],
  title: string,
  lines: AlertLine[],
  label = 'notice'
): Promise<AlertResult> {
  if (lines.length === 0) return { delivered: false, reason: 'nothing to report' }

  const token = process.env.DISCORD_BOT_TOKEN?.trim()
  if (!configured(token)) return { delivered: false, reason: 'DISCORD_BOT_TOKEN is not configured' }

  const channelId = channelVars.map((v) => process.env[v]?.trim()).find((c) => configured(c))
  if (!channelId) {
    return { delivered: false, reason: `no configured channel among ${channelVars.join(', ')}` }
  }

  // Cap the body: Discord rejects messages over 2000 characters outright, and
  // a rejected alert is a silent alert.
  // ── CUSTOMER TEXT REACHES THIS STRING (security fix, V3) ───────────────
  //  A lead card carries the customer's own name, email, "how did you hear
  //  about us?" answer, referrer and utm values. Those are attacker-controlled
  //  for the price of one form submission, and this path posted them raw. A
  //  name of "@everyone" would have pinged the whole guild from the owner's
  //  own bot. The rich card and the deposit notice already neutralise this;
  //  the plain lead notice — the path the incident actually used — did not.
  //
  //  TWO INDEPENDENT DEFENCES, because either alone can be worked around:
  //   1. discordSafe() breaks mention SYNTAX in the text. It is the SAME
  //      helper the other renderers use, deliberately not a second copy.
  //   2. allowed_mentions:{parse:[]} tells Discord to resolve NOTHING, which
  //      also covers syntax nobody thought of.
  //
  //  Per-line caps keep one long field from crowding out the lines below it;
  //  the whole message is capped again at the Discord limit afterwards.
  const body = lines
    .slice(0, 8)
    .map((l) =>
      l.action
        ? `• ${discordSafe(l.message, 400)}\n  → ${discordSafe(l.action, 200)}`
        : `• ${discordSafe(l.message, 400)}`,
    )
    .join('\n')
  const content = `${discordSafe(title, 200)}\n${body}`.slice(0, 1900)

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
      //  parse: [] disables @everyone, @here, user and role resolution for
      //  this message whatever the text turns out to contain.
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer))

    if (!res.ok) {
      // Read the reason, but never let a body-parse failure mask the status.
      const detail = await res.text().catch(() => '')
      const reason = `Discord returned ${res.status}${detail ? `: ${detail.slice(0, 160)}` : ''}`
      log.error({ status: res.status, channelId }, `${label} REJECTED — ${reason}`)
      return { delivered: false, reason }
    }
    log.info({ channelId, lines: lines.length }, `${label} delivered`)
    return { delivered: true }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    log.error({ err: reason, channelId }, `${label} could not be delivered`)
    return { delivered: false, reason }
  }
}
