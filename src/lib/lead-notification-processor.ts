// ════════════════════════════════════════════════════════════════════════
//  lead-notification-processor.ts — THE production job processor.
//
//  This file exists so that the integration tests and the running worker
//  execute THE SAME CODE. The previous round's HTTP tests re-implemented the
//  claim/attempt/deliver sequence inside the test file, which proves the test's
//  own copy behaves — and says nothing about the worker that actually runs.
//  `src/workers/discord.worker.ts` now calls `processLeadNotification` and does
//  nothing else for this job type.
//
//  ── THE TYPED OUTCOME ─────────────────────────────────────────────────
//  A boolean `delivered` was not enough to act on: it could not distinguish a
//  429 that wants a specific wait from a 403 that will never succeed, nor a
//  configuration failure from a real provider rejection. Every hop now carries
//  the status, the parsed retry instruction, a failure CATEGORY and a safe
//  diagnostic reference.
//
//  ── WHAT MAY BE CALLED SUCCESS ────────────────────────────────────────
//  Only a confirmed 2xx. A timeout after the provider may have accepted is
//  `ambiguous`, and is retried — which is why the delivery guarantee is
//  at-least-once and NOT exactly-once. See NOTIFICATION_LIFECYCLE.
//
//  ── REDACTION ─────────────────────────────────────────────────────────
//  Provider bodies are attacker-influenced and unbounded. Nothing from a
//  response body is persisted or logged beyond a short, redacted excerpt, and
//  no token, webhook URL or customer field is ever written.
// ════════════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto'
import { prisma } from './db'
import { queueLogger } from './logger'
import {
  MAX_PROVIDER_ATTEMPTS,
  NOTIFICATION_STATUS,
  beginProviderAttempt,
  inspectClaim,
  recordFailure,
  recordSent,
  retryAfterToDate,
  safeError,
} from './lead-notification-outbox'

const log = queueLogger.child({ mod: 'lead-notification-processor' })

/** Why a delivery did not succeed. Drives retry-vs-park, and the alerting. */
export type FailureCategory =
  | 'rate_limited'      // 429 — the provider told us to wait
  | 'provider_error'    // 5xx — their side, worth retrying
  | 'network'           // refused / reset / DNS — never reached them
  | 'timeout'           // no answer in time; may or may not have landed
  | 'rejected'          // 4xx — they understood and said no
  | 'configuration'     // our token/channel is missing or wrong
  | 'cancelled'         // the lead no longer exists
  | 'none'

export type DeliveryOutcome = {
  delivered: boolean
  httpStatus: number | null
  /** Absolute instant the provider asked us to wait until, when it said so. */
  retryAfter: Date | null
  category: FailureCategory
  /** A correlation id. Safe to show a human; contains no customer data. */
  ref: string
  /** Short, redacted, bounded. Never a raw provider body. */
  detail: string
}

export type ProcessResult =
  | { action: 'sent'; ref: string }
  | { action: 'retry_scheduled'; ref: string; dueAt: Date | null; category: FailureCategory }
  | { action: 'terminal'; ref: string; category: FailureCategory }
  | { action: 'rescheduled_early'; dueAt: Date }
  | { action: 'skipped'; reason: 'gone_or_taken' | 'lead_missing' }

/** The transport, injectable so a test can point it at a local receiver. */
export type Deliver = (leadId: string, ref: string) => Promise<DeliveryOutcome>

/**
 * Turn any thrown transport error into a typed outcome.
 *
 * A thrown error used to reach the worker as an opaque failure, so a DNS
 * refusal and a rate limit were handled identically.
 */
export function categorizeThrown(err: unknown, ref: string): DeliveryOutcome {
  const msg = safeError(err)
  const aborted = err instanceof Error && (err.name === 'AbortError' || /abort|timed? ?out/i.test(err.message))
  return {
    delivered: false,
    httpStatus: null,
    retryAfter: null,
    category: aborted ? 'timeout' : 'network',
    ref,
    detail: msg.slice(0, 200),
  }
}

/** Classify a real HTTP response. Only 2xx is success. */
export function categorizeResponse(status: number, retryAfterHeader: string | null, now: Date, ref: string, detail = ''): DeliveryOutcome {
  const base = { delivered: false, httpStatus: status, retryAfter: null as Date | null, ref, detail: detail.slice(0, 200) }
  if (status >= 200 && status < 300) return { ...base, delivered: true, category: 'none' }
  if (status === 429) return { ...base, category: 'rate_limited', retryAfter: retryAfterToDate(retryAfterHeader, now) }
  if (status === 408) return { ...base, category: 'timeout' }
  //  401/403/404 and the rest of 4xx: they understood us and refused. Retrying
  //  a wrong channel id or a revoked token only burns the budget.
  if (status >= 400 && status < 500) return { ...base, category: 'rejected' }
  return { ...base, category: 'provider_error' }
}

/**
 * THE processor. One job, start to finish.
 *
 * Returns a typed result and THROWS on a scheduled retry, because throwing is
 * what makes BullMQ's configured attempts reachable — returning normally is
 * precisely how a failed delivery used to be marked complete.
 */
export async function processLeadNotification(
  dedupeKey: string,
  deliver: Deliver,
  opts: { now?: Date; reschedule?: (dueAt: Date) => Promise<void> } = {},
): Promise<ProcessResult> {
  const now = opts.now ?? new Date()
  const claim = await inspectClaim(dedupeKey, now)

  //  ── THE JOB ARRIVED EARLY ────────────────────────────────────────────
  //  BullMQ's delay and our `nextAttemptAt` are two clocks, and they disagree.
  //  A job that ran early used to find nothing claimable, return success, and
  //  be removed — stranding a row whose due time had already passed with
  //  nothing scheduled to come back for it. Now it is put back.
  if (!claim.claimed && claim.reason === 'not_due') {
    if (opts.reschedule) await opts.reschedule(claim.dueAt)
    return { action: 'rescheduled_early', dueAt: claim.dueAt }
  }
  if (!claim.claimed) return { action: 'skipped', reason: 'gone_or_taken' }

  const ref = randomUUID()

  //  A lead that no longer exists can never be notified about. Close the event
  //  honestly rather than leaving it to retry forever — and never as 'sent'.
  const lead = await prisma.lead.findUnique({ where: { id: claim.leadId }, select: { id: true } })
  if (!lead) {
    await prisma.leadNotification.update({
      where: { dedupeKey },
      data: { status: NOTIFICATION_STATUS.failedTerminal, nextAttemptAt: null, lastError: 'lead no longer exists' },
    })
    log.warn({ dedupeKey, ref }, 'lead notification cancelled — the lead is gone')
    return { action: 'skipped', reason: 'lead_missing' }
  }

  //  ATTEMPTS COUNT PROVIDER REQUESTS. Everything above this line is free.
  await beginProviderAttempt(dedupeKey)

  let outcome: DeliveryOutcome
  try {
    outcome = await deliver(claim.leadId, ref)
  } catch (err) {
    outcome = categorizeThrown(err, ref)
  }

  if (outcome.delivered) {
    await recordSent(dedupeKey, now)
    log.info({ dedupeKey, ref, status: outcome.httpStatus }, 'lead notification delivered')
    return { action: 'sent', ref }
  }

  //  A configuration failure is OURS, not the provider's. It is terminal for
  //  this attempt and must not masquerade as a provider rejection.
  const res = await recordFailure(
    dedupeKey,
    `${outcome.category}${outcome.httpStatus ? ` ${outcome.httpStatus}` : ''}${outcome.detail ? `: ${outcome.detail}` : ''} [ref ${ref}]`,
    outcome.category === 'configuration' ? 500 : outcome.httpStatus,
    now,
  )

  //  Honour the provider's own instruction when it asked for LONGER than our
  //  backoff would have waited.
  if (res.status === NOTIFICATION_STATUS.retry && outcome.retryAfter) {
    const current = res.nextAttemptAt?.getTime() ?? 0
    if (outcome.retryAfter.getTime() > current) {
      await prisma.leadNotification.update({ where: { dedupeKey }, data: { nextAttemptAt: outcome.retryAfter } })
      res.nextAttemptAt = outcome.retryAfter
    }
  }

  if (res.status === NOTIFICATION_STATUS.failedTerminal) {
    log.error(
      { dedupeKey, ref, category: outcome.category, status: outcome.httpStatus, attempts: MAX_PROVIDER_ATTEMPTS },
      'lead notification PARKED — the owner was never told',
    )
    return { action: 'terminal', ref, category: outcome.category }
  }

  //  THROW so BullMQ actually retries. Returning here is the original bug.
  const err = new Error(`lead notification retry scheduled [ref ${ref}] (${outcome.category})`)
  ;(err as Error & { dueAt?: Date }).dueAt = res.nextAttemptAt ?? undefined
  throw err
}
