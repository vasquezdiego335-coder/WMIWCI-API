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
  return !/^(REPLACE|PASTE|YOUR|CHANGE_?ME|TODO|XXX)/i.test(t) && !t.includes('REPLACE')
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
  if (lines.length === 0) return { delivered: false, reason: 'nothing to report' }

  const token = process.env.DISCORD_BOT_TOKEN?.trim()
  if (!configured(token)) return { delivered: false, reason: 'DISCORD_BOT_TOKEN is not configured' }

  const channelId = [process.env.DISCORD_CHANNEL_ALERTS, process.env.DISCORD_CHANNEL_OPERATIONS]
    .map((c) => c?.trim())
    .find((c) => configured(c))
  if (!channelId) return { delivered: false, reason: 'no alerts or operations channel is configured' }

  // Cap the body: Discord rejects messages over 2000 characters outright, and
  // a rejected alert is a silent alert.
  const body = lines
    .slice(0, 5)
    .map((l) => (l.action ? `• ${l.message}\n  → ${l.action}` : `• ${l.message}`))
    .join('\n')
  const content = `${title}\n${body}`.slice(0, 1900)

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer))

    if (!res.ok) {
      // Read the reason, but never let a body-parse failure mask the status.
      const detail = await res.text().catch(() => '')
      const reason = `Discord returned ${res.status}${detail ? `: ${detail.slice(0, 160)}` : ''}`
      log.error({ status: res.status, channelId }, `ops alert REJECTED — ${reason}`)
      return { delivered: false, reason }
    }
    log.info({ channelId, lines: lines.length }, 'ops alert delivered')
    return { delivered: true }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    log.error({ err: reason, channelId }, 'ops alert could not be delivered')
    return { delivered: false, reason }
  }
}
