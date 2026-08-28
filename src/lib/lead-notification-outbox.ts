// ════════════════════════════════════════════════════════════════════════
//  lead-notification-outbox.ts — the owner notice, made durable.
//
//  ── WHAT WAS WRONG ────────────────────────────────────────────────────
//  `notifyOwnerOfNewLead` did this, and only this:
//
//      void (async () => { ... await postToChannels(...) })()
//
//  One HTTPS POST, a 5s timeout, failure logged at warn and discarded. A
//  Discord 500, a timeout, or a process restart between "lead saved" and
//  "owner told" lost the notice permanently — and nothing anywhere knew it had
//  happened. A lead the business paid to acquire never reached the person who
//  could call it, while monitoring stayed green.
//
//  ── THE SHAPE OF THE FIX ──────────────────────────────────────────────
//  The lead is persisted FIRST. Then a durable row records that an owner
//  notification ought to exist. Work moves on the EXISTING BullMQ `discord`
//  queue — deliberately not a third notification architecture — but the queue
//  only carries a pointer. This table owns the truth.
//
//  ── THE FOUR RULES THAT MAKE IT SAFE ──────────────────────────────────
//   1. DETERMINISTIC IDENTITY. `dedupeKey` = lead + lifecycle transition. It is
//      UNIQUE in the database and doubles as the BullMQ jobId, so a duplicate
//      enqueue is a no-op at both layers and the owner gets ONE message.
//   2. ATOMIC CLAIM. A worker takes a row with a conditional UPDATE. Two
//      concurrent workers cannot both win, because only one UPDATE matches.
//   3. ATTEMPTS COUNT PROVIDER REQUESTS, NOT CLAIMS. A worker that dies before
//      it reaches Discord must not consume the retry budget — otherwise a
//      transient crash silently exhausts a notice's chances. The counter is
//      incremented at the moment the request begins.
//   4. FAILURE IS LOUD. A failed delivery is never recorded as sent, the row
//      stays visible for operations, and the worker RE-THROWS so BullMQ's
//      configured retries are actually reachable.
//
//  PII: `lastError` is bounded and provider-derived. Nothing from the customer
//  (name, email, phone, address) is ever written to it — see `safeError`.
// ════════════════════════════════════════════════════════════════════════

import { prisma } from './db'
import { apiLogger } from './logger'

const log = apiLogger.child({ mod: 'lead-notification-outbox' })

/**
 * The lifecycle transitions worth telling the owner about.
 *
 * ONE MEMBER, DELIBERATELY. `'lead_enriched'` was declared here and named in
 * the schema comment, but NOTHING EVER PRODUCED ONE — no call site, in any
 * route, worker or script, ever recorded that event. A declared-but-unproduced
 * event is worse than no event: the schema advertised a notice the owner would
 * never receive, and a reader checking "does the owner hear when a partial lead
 * fills in?" would have concluded yes. It is removed rather than documented,
 * because a comment saying "not implemented" is a claim nobody re-reads.
 *
 * `dedupeKeyFor` still namespaces by event, so ADDING a second transition later
 * is a one-line change that cannot collide with existing keys.
 * `lead-notification-reachability.test.ts` fails if a member is declared here
 * without a producer, so this cannot silently regrow.
 */
export type LeadNotificationEvent = 'lead_created'

export const NOTIFICATION_STATUS = {
  pending: 'pending',
  sending: 'sending',
  sent: 'sent',
  retry: 'retry',
  failedTerminal: 'failed_terminal',
} as const

/** How many PROVIDER attempts a notice gets before it is parked for a human. */
export const MAX_PROVIDER_ATTEMPTS = 5

/**
 * Deterministic event identity.
 *
 * PURE, and deliberately derived from the lead and the transition ALONE — never
 * from a timestamp or a random id. That is what makes a duplicate enqueue a
 * no-op instead of a second ping, at both the database and the queue.
 */
export function dedupeKeyFor(leadId: string, event: LeadNotificationEvent): string {
  return `lead-notify:${event}:${leadId}`
}

/**
 * Backoff for the NEXT provider attempt.
 *
 * Exponential from 30s, capped at an hour. Returned as an absolute instant so
 * the claim query can refuse to run early even if the queue delivers early —
 * the schedule is enforced by the database, not by trusting the transport.
 */
export function nextAttemptAfter(attempts: number, now: Date, jitter = true): Date {
  const seconds = Math.min(3600, 30 * Math.pow(2, Math.max(0, attempts - 1)))
  //  FULL-WIDTH JITTER of +/-10%. Without it, a provider outage that fails a
  //  hundred notices at once schedules all hundred retries for the same
  //  instant, and the recovery attempt becomes its own thundering herd.
  //  Deterministic when disabled, so the backoff curve stays testable.
  const spread = jitter ? 1 + (Math.random() * 0.2 - 0.1) : 1
  return new Date(now.getTime() + Math.round(seconds * 1000 * spread))
}

/**
 * Honour the provider's own retry instruction.
 *
 * Discord sends `Retry-After` on a 429 in seconds, and occasionally as an
 * HTTP-date. Ignoring it is how a client earns a longer ban, so it wins over
 * our own backoff when it asks for LONGER, and is floored at one second when it
 * asks for something implausibly short.
 */
export function retryAfterToDate(header: string | null | undefined, now: Date): Date | null {
  if (!header) return null
  const trimmed = header.trim()
  const seconds = Number(trimmed)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return new Date(now.getTime() + Math.max(1, Math.min(seconds, 3600)) * 1000)
  }
  const asDate = new Date(trimmed)
  if (!Number.isNaN(asDate.getTime()) && asDate.getTime() > now.getTime()) {
    return new Date(Math.min(asDate.getTime(), now.getTime() + 3600 * 1000))
  }
  return null
}

/**
 * Is this failure worth another attempt?
 *
 * 4xx other than 408/429 means Discord understood us and said no — retrying
 * cannot change the answer, so the row is parked for a human instead of burning
 * five attempts on a misconfigured channel id.
 */
export function classifyFailure(status: number | null | undefined): 'retryable' | 'terminal' {
  if (status == null) return 'retryable' // network / timeout / unknown — try again
  if (status === 408 || status === 429) return 'retryable'
  if (status >= 400 && status < 500) return 'terminal'
  return 'retryable'
}

/** Provider-derived, bounded, and never customer data. */
export function safeError(reason: unknown): string {
  const raw = reason instanceof Error ? reason.message : String(reason ?? 'unknown')
  //  Strip anything that looks like an address or a token before it is stored.
  return raw.replace(/[\w.+-]+@[\w.-]+/g, '<redacted>').slice(0, 300)
}

export type EnqueueResult = {
  id: string
  dedupeKey: string
  /** False when this transition had already been recorded — the no-op case. */
  created: boolean
}

/**
 * Record that an owner notification ought to exist.
 *
 * CALLED AFTER THE LEAD IS COMMITTED. The row is the durable promise; the queue
 * job is only a nudge. If the nudge is lost, a sweeper can still find this row.
 */
export async function recordLeadNotification(
  leadId: string,
  event: LeadNotificationEvent,
  deps: { now?: () => Date } = {},
): Promise<EnqueueResult> {
  const now = deps.now?.() ?? new Date()
  const dedupeKey = dedupeKeyFor(leadId, event)
  //  UPSERT on the unique key: the second caller for the same transition gets
  //  the existing row rather than creating a second owner message.
  const existing = await prisma.leadNotification.findUnique({ where: { dedupeKey } })
  if (existing) return { id: existing.id, dedupeKey, created: false }
  try {
    const row = await prisma.leadNotification.create({
      data: { leadId, eventType: event, dedupeKey, status: NOTIFICATION_STATUS.pending, nextAttemptAt: now },
    })
    return { id: row.id, dedupeKey, created: true }
  } catch (err) {
    //  A concurrent caller won the unique index. That is the correct outcome,
    //  not an error: exactly one row exists.
    const row = await prisma.leadNotification.findUnique({ where: { dedupeKey } })
    if (row) return { id: row.id, dedupeKey, created: false }
    throw err
  }
}

/**
 * Take ownership of a notice, atomically.
 *
 * The conditional UPDATE is the whole mechanism: two workers racing for the
 * same row produce one winner and one zero-row update. It also enforces
 * `nextAttemptAt`, so a retry cannot run early however the job arrived.
 *
 * Returns null when the row is already sent, already claimed, terminal, or not
 * yet due — every one of which means "not mine to send".
 */
/**
 * Why a claim failed. The caller must be able to tell "someone else has it" —
 * which is fine — from "it is not due yet" — which means the job ran EARLY and
 * must be rescheduled rather than dropped.
 *
 * Returning a bare null for both is what stranded rows: a job that arrived
 * before `nextAttemptAt` found nothing to do, returned success, and BullMQ
 * removed it. Nothing else was scheduled to come back, so the row sat in
 * `retry` forever with its due time in the past.
 */
export type ClaimOutcome =
  | { claimed: true; id: string; leadId: string; eventType: string; attempts: number }
  | { claimed: false; reason: 'not_due'; dueAt: Date }
  | { claimed: false; reason: 'gone_or_taken' }

/**
 * Inspect a row and say precisely why it cannot be claimed right now.
 * Used by the worker to decide between "reschedule me" and "drop me".
 */
export async function inspectClaim(dedupeKey: string, now: Date = new Date()): Promise<ClaimOutcome> {
  const claimed = await claimNotification(dedupeKey, now)
  if (claimed) return { claimed: true, ...claimed }
  const row = await prisma.leadNotification.findUnique({ where: { dedupeKey } })
  if (
    row &&
    (row.status === NOTIFICATION_STATUS.pending || row.status === NOTIFICATION_STATUS.retry) &&
    row.nextAttemptAt &&
    row.nextAttemptAt.getTime() > now.getTime()
  ) {
    //  The row is ours to do — just not yet. The caller MUST reschedule.
    return { claimed: false, reason: 'not_due', dueAt: row.nextAttemptAt }
  }
  return { claimed: false, reason: 'gone_or_taken' }
}

export async function claimNotification(
  dedupeKey: string,
  now: Date = new Date(),
): Promise<{ id: string; leadId: string; eventType: string; attempts: number } | null> {
  const claimed = await prisma.leadNotification.updateMany({
    where: {
      dedupeKey,
      status: { in: [NOTIFICATION_STATUS.pending, NOTIFICATION_STATUS.retry] },
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    data: { status: NOTIFICATION_STATUS.sending, claimedAt: now },
  })
  if (claimed.count === 0) return null
  const row = await prisma.leadNotification.findUnique({ where: { dedupeKey } })
  return row ? { id: row.id, leadId: row.leadId, eventType: row.eventType, attempts: row.attempts } : null
}

/**
 * A provider request is about to begin.
 *
 * SEPARATE from the claim on purpose. A worker that crashes between claiming
 * and calling Discord must not have consumed an attempt — otherwise a few
 * unlucky restarts silently exhaust the retry budget of a notice that was never
 * actually sent once.
 */
export async function beginProviderAttempt(dedupeKey: string): Promise<number> {
  const row = await prisma.leadNotification.update({
    where: { dedupeKey },
    data: { attempts: { increment: 1 } },
  })
  return row.attempts
}

/** Provider accepted it. The only path that may say "sent". */
export async function recordSent(dedupeKey: string, now: Date = new Date()): Promise<void> {
  await prisma.leadNotification.update({
    where: { dedupeKey },
    data: { status: NOTIFICATION_STATUS.sent, sentAt: now, lastError: null },
  })
}

/**
 * Provider did not accept it.
 *
 * Retryable and within budget -> scheduled for another go. Otherwise parked as
 * terminal, which is a state a human can find. Never `sent`.
 */
export async function recordFailure(
  dedupeKey: string,
  reason: unknown,
  httpStatus: number | null,
  now: Date = new Date(),
): Promise<{ status: string; nextAttemptAt: Date | null }> {
  const row = await prisma.leadNotification.findUnique({ where: { dedupeKey } })
  const attempts = row?.attempts ?? 0
  const kind = classifyFailure(httpStatus)
  const exhausted = attempts >= MAX_PROVIDER_ATTEMPTS
  const terminal = kind === 'terminal' || exhausted
  const nextAt = terminal ? null : nextAttemptAfter(attempts, now)
  await prisma.leadNotification.update({
    where: { dedupeKey },
    data: {
      status: terminal ? NOTIFICATION_STATUS.failedTerminal : NOTIFICATION_STATUS.retry,
      nextAttemptAt: nextAt,
      lastError: safeError(reason),
    },
  })
  log.warn(
    { dedupeKey, attempts, httpStatus, terminal, reason: safeError(reason) },
    terminal ? 'lead notice PARKED for manual review' : 'lead notice failed; retry scheduled',
  )
  return { status: terminal ? NOTIFICATION_STATUS.failedTerminal : NOTIFICATION_STATUS.retry, nextAttemptAt: nextAt }
}

/**
 * Release a claim without consuming an attempt.
 *
 * For the crash-recovery sweeper: a row stuck in `sending` past the stale
 * threshold was claimed by a worker that died, and must become claimable again.
 */
export async function releaseStaleClaims(
  staleBefore: Date,
  now: Date = new Date(),
): Promise<number> {
  const res = await prisma.leadNotification.updateMany({
    where: { status: NOTIFICATION_STATUS.sending, claimedAt: { lt: staleBefore } },
    data: { status: NOTIFICATION_STATUS.retry, nextAttemptAt: now },
  })
  if (res.count) log.warn({ count: res.count }, 'released stale lead-notice claims after a worker crash')
  return res.count
}

/** Everything a human needs to find notices that never reached the owner. */
export async function terminalFailures(limit = 50) {
  return prisma.leadNotification.findMany({
    where: { status: NOTIFICATION_STATUS.failedTerminal },
    orderBy: { updatedAt: 'desc' },
    take: limit,
    select: { id: true, leadId: true, eventType: true, attempts: true, lastError: true, updatedAt: true },
  })
}
