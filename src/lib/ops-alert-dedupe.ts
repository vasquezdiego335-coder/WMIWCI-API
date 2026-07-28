// ════════════════════════════════════════════════════════════════════════
//  OPS ALERT DEDUPLICATION (owner report 2026-07-28)
//  ---------------------------------------------------------------------
//  WHAT HAPPENED. A single test campaign sat in a state the dispatch sweep
//  refused. The monitoring cron runs every ten minutes, found the same
//  CRITICAL every time, and posted it to Discord every time — FIFTY IDENTICAL
//  MESSAGES over eight hours, all describing one problem that had not changed
//  since the first one.
//
//  That is not a monitoring system. It is a way to teach an owner to mute the
//  channel, and a muted channel is worse than no channel: the next alert, the
//  one that matters, arrives somewhere nobody is looking.
//
//  THE RULE: a critical alerts IMMEDIATELY the first time, then not again for
//  the cooldown unless it CHANGES. Changing means different check ids, a
//  different count, or different text — anything that gives an owner new
//  information. "Still true" is not new information.
//
//  WHY A DATABASE ROW AND NOT A MODULE VARIABLE: this deploys to Railway,
//  where more than one container can run the cron. An in-memory flag would
//  deduplicate per-process, which is to say not at all — two containers would
//  simply halve nothing and send twice.
//
//  FAILS OPEN, DELIBERATELY. If the dedupe state cannot be read or written,
//  the alert is SENT. A monitoring system whose deduplication failure mode is
//  silence has the failure mode backwards; too many alerts is a nuisance, none
//  is an outage nobody hears about.
// ════════════════════════════════════════════════════════════════════════

import crypto from 'node:crypto'
import { prisma } from './db'
import { queueLogger } from './logger'

const log = queueLogger.child({ mod: 'ops-alert-dedupe' })

/** How long an UNCHANGED critical stays quiet before it is repeated. */
export const ALERT_COOLDOWN_MS = Number(process.env.OPS_ALERT_COOLDOWN_MS) || 6 * 60 * 60 * 1000

/**
 * Identity of an alert's CONTENT.
 *
 * Built from the check ids and their messages, so the same problem produces the
 * same signature run after run. Timestamps embedded in the message text are
 * stripped first — the refusal note carries the time it was refused, and
 * without this every ten-minute run would look like a brand new problem and
 * the deduplication would do nothing at all.
 */
export function alertSignature(title: string, lines: Array<{ message: string; action?: string }>): string {
  const normalised = lines
    .map((l) => l.message)
    .sort()
    .join('|')
    // ISO timestamps and clock times move on their own; they are not changes.
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, '<ts>')
    .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, '<time>')
  return crypto.createHash('sha1').update(`${title}::${normalised}`).digest('hex').slice(0, 32)
}

export type AlertGate = { send: true; reason: string } | { send: false; reason: string }

/** Pure decision, so the policy is testable without a database or a clock. */
export function decideOpsAlert(input: {
  signature: string
  lastSignature: string | null
  lastSentAt: Date | null
  now: Date
  cooldownMs?: number
}): AlertGate {
  const cooldown = input.cooldownMs ?? ALERT_COOLDOWN_MS
  if (input.lastSignature !== input.signature) {
    return { send: true, reason: 'New or changed condition.' }
  }
  if (!input.lastSentAt) return { send: true, reason: 'Never sent.' }
  const age = input.now.getTime() - input.lastSentAt.getTime()
  if (age >= cooldown) {
    return { send: true, reason: `Unchanged, but ${Math.round(age / 3600_000)}h since the last notice.` }
  }
  return {
    send: false,
    reason: `Identical to the alert sent ${Math.round(age / 60_000)} minutes ago; next repeat in ${Math.round((cooldown - age) / 60_000)} minutes.`,
  }
}

/**
 * Should this alert go out? Records the decision when it does.
 *
 * `key` namespaces the state so different alert sources cannot suppress each
 * other. Reuses the agent settings singleton as a tiny key/value store rather
 * than adding a table for two columns.
 */
export async function shouldSendOpsAlert(
  key: string,
  title: string,
  lines: Array<{ message: string; action?: string }>,
  now: Date = new Date()
): Promise<AlertGate> {
  const signature = `${key}:${alertSignature(title, lines)}`
  try {
    const row = await prisma.emailAgentSettings.findUnique({
      where: { id: 'singleton' },
      select: { opsAlertSignature: true, opsAlertSentAt: true },
    })
    const gate = decideOpsAlert({
      signature,
      lastSignature: row?.opsAlertSignature ?? null,
      lastSentAt: row?.opsAlertSentAt ?? null,
      now,
    })
    if (gate.send) {
      await prisma.emailAgentSettings
        .upsert({
          where: { id: 'singleton' },
          create: { id: 'singleton', opsAlertSignature: signature, opsAlertSentAt: now },
          update: { opsAlertSignature: signature, opsAlertSentAt: now },
        })
        .catch((err) => log.warn({ err: String(err).slice(0, 160) }, 'could not record the alert signature'))
    }
    return gate
  } catch (err) {
    // FAIL OPEN. See the header.
    log.warn({ err: String(err).slice(0, 160) }, 'alert dedupe unavailable — sending the alert')
    return { send: true, reason: 'Deduplication state unavailable; sending rather than risking silence.' }
  }
}
