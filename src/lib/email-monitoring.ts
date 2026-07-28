// ════════════════════════════════════════════════════════════════════════
//  EMAIL SYSTEM MONITORING (audit E-02 / E-04 / E-08, owner spec 2026-07-26)
//  ---------------------------------------------------------------------
//  THE GAP THIS CLOSES: every safety mechanism in the email system was built
//  to FAIL CLOSED, and they do. What was missing was any way to NOTICE that
//  one had fired. At a volume of one, the owner found every problem by
//  clicking. At a volume of five hundred, nobody will — and the failure that
//  matters most is the silent one:
//
//    • a bounce whose suppression write failed stays sendable FOREVER
//      (`retryPendingSideEffects` existed but was never scheduled);
//    • a complaint spike is invisible until the sending domain is blocked;
//    • a run stranded in a terminal state keeps recipients PENDING with no
//      trace (bug #7 — happened, in production, silently);
//    • a SCHEDULED campaign refused every 5 minutes shows a healthy badge.
//
//  DESIGN RULES
//   1. READ-ONLY. Nothing here mutates campaign, run, recipient or send state.
//      A monitor that repairs things hides the problem it is meant to reveal.
//   2. Every check returns a SEVERITY and a HUMAN SENTENCE. "queue_depth=1240"
//      is not an alert; "the send queue has 1240 waiting jobs and is not
//      draining" is.
//   3. Thresholds are named constants with the reasoning attached, because the
//      numbers that matter here (complaint rate above all) are industry limits,
//      not preferences.
//   4. A check that THROWS is itself an alert — a monitor that silently returns
//      "healthy" when its query failed is worse than no monitor.
// ════════════════════════════════════════════════════════════════════════

import { prisma } from './db'
import { queueLogger } from './logger'
import { postOpsAlert } from './ops-alert'
import { shouldSendOpsAlert } from './ops-alert-dedupe'

const log = queueLogger.child({ mod: 'email-monitoring' })

export type Severity = 'ok' | 'warn' | 'critical'

export type Check = {
  id: string
  severity: Severity
  /** One sentence an owner can act on, with the number embedded. */
  message: string
  value: number
  threshold?: number
  /** What to do about it. Empty when severity is 'ok'. */
  action?: string
}

// ── Thresholds ──────────────────────────────────────────────────────────
// Mailbox providers, not us, decide what these mean. A complaint rate above
// ~0.3% gets a sending domain throttled or blocked at Gmail/Microsoft, and the
// damage takes weeks to undo — so the alert fires far below the danger line.
export const COMPLAINT_RATE_WARN = 0.001 // 0.1%
export const COMPLAINT_RATE_CRITICAL = 0.003 // 0.3%
// Hard bounces measure list quality. Above 5% providers treat the sender as
// someone mailing purchased lists.
export const BOUNCE_RATE_WARN = 0.02 // 2%
export const BOUNCE_RATE_CRITICAL = 0.05 // 5%
export const QUEUE_DEPTH_WARN = 500
export const QUEUE_DEPTH_CRITICAL = 2000
export const FAILED_JOBS_WARN = 10
/** A run older than this with no terminal state is stuck, not slow. */
export const RUN_STUCK_MS = 2 * 60 * 60 * 1000
/** How late a scheduled campaign may be before it counts as missed. */
export const SCHEDULE_MISSED_MS = 15 * 60 * 1000
/** Window for rate calculations. */
export const RATE_WINDOW_HOURS = 24

const ok = (id: string, message: string, value = 0): Check => ({ id, severity: 'ok', message, value })

const rate = (numerator: number, denominator: number): number => (denominator === 0 ? 0 : numerator / denominator)

const pct = (r: number): string => `${(r * 100).toFixed(2)}%`

// ── Individual checks ───────────────────────────────────────────────────

/**
 * COMPLAINT RATE — the single most damaging number in email.
 *
 * Counted from EmailEvent rather than EmailSend because `EmailSend.status`
 * records provider ACCEPTANCE, not what happened afterwards.
 */
export async function checkComplaintRate(windowHours = RATE_WINDOW_HOURS): Promise<Check> {
  const since = new Date(Date.now() - windowHours * 3600_000)
  const [complaints, accepted] = await Promise.all([
    prisma.emailEvent.count({ where: { type: 'complained', occurredAt: { gte: since } } }),
    prisma.emailSend.count({ where: { status: 'delivered', isTest: false, sentAt: { gte: since } } }),
  ])
  const r = rate(complaints, accepted)
  if (accepted === 0) return ok('complaint_rate', 'No email sent in the window — no complaint rate to report.')
  if (r >= COMPLAINT_RATE_CRITICAL) {
    return {
      id: 'complaint_rate',
      severity: 'critical',
      value: r,
      threshold: COMPLAINT_RATE_CRITICAL,
      message: `Complaint rate is ${pct(r)} (${complaints} of ${accepted} in ${windowHours}h) — at or above the level where Gmail and Microsoft throttle or block a sending domain.`,
      action: 'STOP sending now: set EMAIL_PROMOTIONS_ENABLED=false and restart. Identify the campaign, then review its audience and consent source before re-enabling.',
    }
  }
  if (r >= COMPLAINT_RATE_WARN) {
    return {
      id: 'complaint_rate',
      severity: 'warn',
      value: r,
      threshold: COMPLAINT_RATE_WARN,
      message: `Complaint rate is ${pct(r)} (${complaints} of ${accepted} in ${windowHours}h) — three times this level gets the domain blocked.`,
      action: 'Review the most recent campaign audience and pause further sends until the cause is understood.',
    }
  }
  return ok('complaint_rate', `Complaint rate ${pct(r)} (${complaints} of ${accepted} in ${windowHours}h).`, r)
}

/** HARD BOUNCE RATE — list quality. Soft bounces are deliberately excluded. */
export async function checkBounceRate(windowHours = RATE_WINDOW_HOURS): Promise<Check> {
  const since = new Date(Date.now() - windowHours * 3600_000)
  const [bounces, accepted] = await Promise.all([
    prisma.emailSend.count({ where: { bouncedAt: { gte: since }, isTest: false } }),
    prisma.emailSend.count({ where: { status: 'delivered', isTest: false, sentAt: { gte: since } } }),
  ])
  const r = rate(bounces, accepted)
  if (accepted === 0) return ok('bounce_rate', 'No email sent in the window — no bounce rate to report.')
  if (r >= BOUNCE_RATE_CRITICAL) {
    return {
      id: 'bounce_rate',
      severity: 'critical',
      value: r,
      threshold: BOUNCE_RATE_CRITICAL,
      message: `Hard-bounce rate is ${pct(r)} (${bounces} of ${accepted} in ${windowHours}h) — providers treat this as mailing an unverified list.`,
      action: 'Pause campaigns. The audience contains addresses that were never validated; check where they came from.',
    }
  }
  if (r >= BOUNCE_RATE_WARN) {
    return { id: 'bounce_rate', severity: 'warn', value: r, threshold: BOUNCE_RATE_WARN, message: `Hard-bounce rate is ${pct(r)} (${bounces} of ${accepted} in ${windowHours}h).`, action: 'Review the audience source before the next campaign.' }
  }
  return ok('bounce_rate', `Hard-bounce rate ${pct(r)} (${bounces} of ${accepted} in ${windowHours}h).`, r)
}

/**
 * UNSETTLED SIDE EFFECTS — detects audit E-02 directly.
 *
 * An event in `side_effect_failed` means a bounce or complaint was received but
 * the suppression WAS NOT WRITTEN. That address is still sendable. A
 * `dead_letter` means the retries are exhausted and only a human can fix it.
 */
export async function checkUnsettledSideEffects(): Promise<Check> {
  const [pendingOrFailed, deadLetter] = await Promise.all([
    prisma.emailEvent.count({ where: { processingStatus: { in: ['side_effect_pending', 'side_effect_failed'] } } }),
    prisma.emailEvent.count({ where: { processingStatus: 'dead_letter' } }),
  ])
  if (deadLetter > 0) {
    return {
      id: 'side_effects_dead_letter',
      severity: 'critical',
      value: deadLetter,
      threshold: 0,
      message: `${deadLetter} bounce/complaint event${deadLetter === 1 ? '' : 's'} exhausted every suppression retry — ${deadLetter === 1 ? 'that address is' : 'those addresses are'} STILL SENDABLE.`,
      action: 'Suppress the affected addresses by hand in Suppressions, then investigate why the write failed.',
    }
  }
  if (pendingOrFailed > 0) {
    return {
      id: 'side_effects_unsettled',
      severity: 'warn',
      value: pendingOrFailed,
      threshold: 0,
      message: `${pendingOrFailed} bounce/complaint event${pendingOrFailed === 1 ? ' has' : 's have'} an unfinished suppression — the address is sendable until it completes.`,
      action: 'The retry sweep runs every 10 minutes. If the count is not falling, check database connectivity.',
    }
  }
  return ok('side_effects', 'Every bounce and complaint has been applied to the suppression list.')
}

/** STUCK RUNS — non-terminal and old, or terminal without completedAt (bug #7). */
export async function checkStuckRuns(): Promise<Check> {
  const cutoff = new Date(Date.now() - RUN_STUCK_MS)
  const [stalled, terminalNoTimestamp] = await Promise.all([
    prisma.emailCampaignRun.count({
      where: { status: { in: ['PREPARING', 'QUEUED', 'SENDING', 'CANCELLING'] }, startedAt: { lt: cutoff } },
    }),
    // THE BUG #7 INVARIANT, checked rather than assumed: a terminal run must
    // carry a terminal timestamp. This lives only in application code, so it
    // is monitored instead of constrained.
    prisma.emailCampaignRun.count({
      where: { status: { in: ['CANCELLED', 'COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED'] }, completedAt: null },
    }),
  ])
  const total = stalled + terminalNoTimestamp
  if (total === 0) return ok('stuck_runs', 'No stuck runs; every finished run carries a completion time.')
  const parts: string[] = []
  if (stalled > 0) parts.push(`${stalled} run${stalled === 1 ? ' has' : 's have'} been in flight for over ${RUN_STUCK_MS / 3600_000}h`)
  if (terminalNoTimestamp > 0) parts.push(`${terminalNoTimestamp} finished run${terminalNoTimestamp === 1 ? ' has' : 's have'} no completion time (the bug #7 signature)`)
  return {
    id: 'stuck_runs',
    severity: 'warn',
    value: total,
    threshold: 0,
    message: `${parts.join('; ')}.`,
    action: 'Run reconcileTerminalRun(runId) on the affected runs; they will not settle on their own.',
  }
}

/** STRANDED RECIPIENTS — actionable rows inside a run that will never move. */
export async function checkStrandedRecipients(): Promise<Check> {
  const stranded = await prisma.emailCampaignRecipient.count({
    where: {
      status: { in: ['PENDING', 'SENDING'] },
      run: { status: { in: ['CANCELLED', 'COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED'] } },
    },
  })
  if (stranded === 0) return ok('stranded_recipients', 'No recipients are stranded in a finished run.')
  return {
    id: 'stranded_recipients',
    severity: 'critical',
    value: stranded,
    threshold: 0,
    message: `${stranded} recipient${stranded === 1 ? ' is' : 's are'} still PENDING or SENDING inside a run that has already finished — ${stranded === 1 ? 'it' : 'they'} will never be sent and no reason is recorded.`,
    action: 'Run repairStrandedRuns(); never-submitted rows are cancelled and ambiguous ones are marked for review.',
  }
}

/** AMBIGUOUS SENDS — outcomes only a human can resolve. */
export async function checkAmbiguousSends(): Promise<Check> {
  const count = await prisma.emailSend.count({ where: { OR: [{ status: 'ambiguous' }, { status: 'delivered', providerId: null }] } })
  if (count === 0) return ok('ambiguous_sends', 'No sends with an unknown provider outcome.')
  return {
    id: 'ambiguous_sends',
    severity: 'warn',
    value: count,
    threshold: 0,
    message: `${count} send${count === 1 ? ' has' : 's have'} an unknown provider outcome — we cannot tell whether the customer received ${count === 1 ? 'it' : 'them'}.`,
    action: 'Reconcile against the Resend dashboard. These are excluded from future runs of the same campaign until resolved; never resend blindly.',
  }
}

/** SCHEDULE MISSED — a campaign whose send time passed with no run. */
export async function checkMissedSchedules(): Promise<Check> {
  const cutoff = new Date(Date.now() - SCHEDULE_MISSED_MS)
  const due = await prisma.marketingCampaign.findMany({
    where: { channel: 'EMAIL', status: 'SCHEDULED', emailConfig: { is: { scheduledAt: { lt: cutoff }, approvedAt: { not: null } } } },
    select: { id: true, name: true, emailConfig: { select: { statusNote: true, scheduledAt: true } } },
    take: 20,
  })
  const missed = due.filter((c) => c.emailConfig?.scheduledAt)
  if (missed.length === 0) return ok('schedule_missed', 'No campaign has missed its send time.')
  const first = missed[0]
  return {
    id: 'schedule_missed',
    severity: 'critical',
    value: missed.length,
    threshold: 0,
    message: `${missed.length} campaign${missed.length === 1 ? '' : 's'} passed ${missed.length === 1 ? 'its' : 'their'} send time over ${SCHEDULE_MISSED_MS / 60_000} minutes ago and still shows SCHEDULED — e.g. "${first.name}".`,
    action: first.emailConfig?.statusNote
      ? `The sweep recorded why: ${first.emailConfig.statusNote}`
      : 'Check the campaign card and worker logs — the dispatch sweep may not be running at all.',
  }
}

/** TRUNCATED RUNS — an audience that was silently cut off (audit E-05). */
export async function checkTruncatedRuns(windowHours = RATE_WINDOW_HOURS): Promise<Check> {
  const since = new Date(Date.now() - windowHours * 3600_000)
  const count = await prisma.emailCampaignRun.count({ where: { startedAt: { gte: since }, error: { startsWith: 'TRUNCATED:' } } })
  if (count === 0) return ok('truncated_runs', 'No run was cut off by the audience cap.')
  return {
    id: 'truncated_runs',
    severity: 'warn',
    value: count,
    threshold: 0,
    message: `${count} run${count === 1 ? '' : 's'} hit the audience cap — recipients beyond the cap received nothing and have no record explaining why.`,
    action: 'Split the audience into smaller segments and send the remainder deliberately.',
  }
}

// ── Aggregate ───────────────────────────────────────────────────────────

export type HealthReport = {
  severity: Severity
  checkedAt: string
  checks: Check[]
  /** Checks that could not run — themselves a failure, never a silent pass. */
  errors: { id: string; error: string }[]
}

const worst = (severities: Severity[]): Severity =>
  severities.includes('critical') ? 'critical' : severities.includes('warn') ? 'warn' : 'ok'

/**
 * Run every database-backed check. Queue-depth and failed-job checks live in
 * `queueHealth()` because they need Redis, which must not be able to fail this.
 */
export async function emailHealthReport(): Promise<HealthReport> {
  const runners: [string, () => Promise<Check>][] = [
    ['complaint_rate', checkComplaintRate],
    ['bounce_rate', checkBounceRate],
    ['side_effects', checkUnsettledSideEffects],
    ['stuck_runs', checkStuckRuns],
    ['stranded_recipients', checkStrandedRecipients],
    ['ambiguous_sends', checkAmbiguousSends],
    ['schedule_missed', checkMissedSchedules],
    ['truncated_runs', checkTruncatedRuns],
  ]
  const checks: Check[] = []
  const errors: { id: string; error: string }[] = []
  for (const [id, run] of runners) {
    try {
      checks.push(await run())
    } catch (err) {
      // A check that cannot run is an alert in itself. Reporting 'ok' here
      // would be the exact silent failure this module exists to prevent.
      errors.push({ id, error: err instanceof Error ? err.message : String(err) })
    }
  }
  const severity = errors.length > 0 ? 'critical' : worst(checks.map((c) => c.severity))
  return { severity, checkedAt: new Date().toISOString(), checks, errors }
}

/** Queue depth + failed jobs. Separated so a Redis outage cannot break the DB checks. */
export async function queueHealth(): Promise<Check[]> {
  const checks: Check[] = []
  try {
    const { scheduledQueue, emailQueue } = await import('./queues')
    for (const [name, queue] of [
      ['scheduled', scheduledQueue],
      ['email', emailQueue],
    ] as const) {
      const [waiting, failed] = await Promise.all([queue.getWaitingCount(), queue.getFailedCount()])
      checks.push(
        waiting >= QUEUE_DEPTH_CRITICAL
          ? { id: `queue_depth_${name}`, severity: 'critical', value: waiting, threshold: QUEUE_DEPTH_CRITICAL, message: `The ${name} queue has ${waiting} waiting jobs and is not draining.`, action: 'Check that the worker process is running and connected to Redis.' }
          : waiting >= QUEUE_DEPTH_WARN
            ? { id: `queue_depth_${name}`, severity: 'warn', value: waiting, threshold: QUEUE_DEPTH_WARN, message: `The ${name} queue has ${waiting} waiting jobs.`, action: 'Normal during a large send; investigate if it does not fall.' }
            : ok(`queue_depth_${name}`, `The ${name} queue has ${waiting} waiting jobs.`, waiting)
      )
      checks.push(
        failed >= FAILED_JOBS_WARN
          ? { id: `failed_jobs_${name}`, severity: 'warn', value: failed, threshold: FAILED_JOBS_WARN, message: `The ${name} queue has ${failed} failed jobs retained.`, action: 'Inspect the failure reasons; repeated failures mean a broken code path, not bad luck.' }
          : ok(`failed_jobs_${name}`, `The ${name} queue has ${failed} failed jobs.`, failed)
      )
    }
  } catch (err) {
    checks.push({
      id: 'queue_unreachable',
      severity: 'critical',
      value: 1,
      message: `Redis/BullMQ could not be reached: ${err instanceof Error ? err.message : String(err)} — no email is being sent right now.`,
      action: 'Check REDIS_URL and the Redis service. Queued work resumes on reconnect; nothing is lost.',
    })
  }
  return checks
}

/**
 * The alerting entry point, called by the monitoring cron.
 *
 * Logs at a level matching severity so any log-based alerting picks it up
 * without extra plumbing, and returns the report for the admin UI.
 */
export async function runEmailMonitoring(): Promise<HealthReport> {
  const report = await emailHealthReport()
  const queue = await queueHealth()
  report.checks.push(...queue)
  if (queue.some((c) => c.severity === 'critical')) report.severity = 'critical'
  else if (report.severity === 'ok' && queue.some((c) => c.severity === 'warn')) report.severity = 'warn'

  for (const c of report.checks) {
    if (c.severity === 'critical') log.error({ check: c.id, value: c.value, action: c.action }, `EMAIL ALERT (critical): ${c.message}`)
    else if (c.severity === 'warn') log.warn({ check: c.id, value: c.value, action: c.action }, `EMAIL ALERT (warning): ${c.message}`)
  }
  for (const e of report.errors) log.error({ check: e.id, err: e.error }, 'email monitoring check FAILED to run')

  // ROUTE CRITICALS SOMEWHERE VISIBLE. A log line is only an alert if someone
  // is reading the logs. postOpsAlert is a bare HTTPS POST with no SDK — an
  // earlier version imported the Discord client here and dragged discord.js
  // into the Next.js bundle for the health route, which broke the build.
  const criticals = report.checks.filter((c) => c.severity === 'critical')
  if (criticals.length > 0) {
    const title = 'EMAIL SYSTEM - CRITICAL'
    const lines = criticals.map((c) => ({ message: c.message, action: c.action }))

    // DEDUPLICATED (owner report 2026-07-28). This cron runs every ten minutes
    // and used to post EVERY critical EVERY run: one stuck test campaign
    // produced fifty identical Discord messages in eight hours. An owner who
    // mutes the channel because of that never sees the alert that matters.
    // Unchanged criticals now repeat at most once per cooldown; a CHANGED one
    // still goes out immediately.
    const gate = await shouldSendOpsAlert('email-monitoring', title, lines)
    if (!gate.send) {
      log.info({ criticals: criticals.length, reason: gate.reason }, 'critical email alerts suppressed as duplicates')
    } else {
      const result = await postOpsAlert(title, lines)
      if (result.delivered) log.info({ criticals: criticals.length, reason: gate.reason }, 'critical email alerts delivered to the ops channel')
      else log.error({ criticals: criticals.length, reason: result.reason }, 'CRITICAL EMAIL ALERTS COULD NOT BE DELIVERED — the log lines above are the only record')
    }
  }

  if (report.severity === 'ok') log.info({ checks: report.checks.length }, 'email monitoring: all checks healthy')
  return report
}
