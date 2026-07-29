// ════════════════════════════════════════════════════════════════════════
//  SCHEDULER CHECKS (owner spec 2026-07-27)
//  ---------------------------------------------------------------------
//  The dispatch sweep, the retry sweeps and the agent's own cycle all live in
//  BullMQ cron jobs inside the worker process. When that process is not
//  running, NOTHING in the email system reports an error: campaigns stay
//  SCHEDULED, retries stay pending, and every badge in the admin stays green.
//  It is the most consequential failure in the system and the least visible.
//
//  This file therefore checks for ABSENCE, which is harder than checking for
//  errors. Three independent signals, so no single one has to be trusted:
//    • the agent's own heartbeat (it cannot report its own absence, so a
//      GAP between runs is what gets recorded next time it does run);
//    • the queue itself, when Redis can be reached;
//    • work that is due and untouched, which is absence made visible through
//      its consequences.
// ════════════════════════════════════════════════════════════════════════

import { prisma } from '../../db'
import { safeErrorMessage } from '../redact'
import type { AgentFinding } from '../types'
import {
  CLOCK_SKEW_CRITICAL_MS,
  CLOCK_SKEW_WARN_MS,
  SCHEDULE_GRACE_MS,
  countInspected,
  makeFinding,
  minutes,
  plural,
  since,
  type CheckContext,
  type CheckDefinition,
} from './shared'

// ── 1. The agent's own heartbeat ────────────────────────────────────────

const agentHeartbeat: CheckDefinition = {
  id: 'scheduler.agent_gap',
  category: 'scheduler',
  intent: 'The agent cycle stopped running for a while — this run is reporting the gap it just noticed.',
  run: async (ctx) => {
    let previous: { id: string; startedAt: Date; status: string } | null
    try {
      previous = await prisma.emailAgentRun.findFirst({
        where: { status: { in: ['completed', 'failed'] }, trigger: { not: 'dry_run' } },
        orderBy: { startedAt: 'desc' },
        select: { id: true, startedAt: true, status: true },
      })
    } catch (err) {
      // BEFORE THE MIGRATION IS APPLIED the agent's own tables do not exist.
      // That is already reported, loudly and specifically, by
      // `infrastructure.migrations_pending`. Rethrowing here would add a second
      // critical saying the same thing in worse words. Any OTHER database error
      // is a real failure and must still surface as an unrunnable check.
      const message = err instanceof Error ? err.message : String(err)
      if (/does not exist/i.test(message)) return []
      throw err
    }
    if (!previous) return [] // first ever run; there is no gap to report

    const gapMs = ctx.now.getTime() - previous.startedAt.getTime()
    const expected = ctx.settings.intervalMinutes * 60_000
    // Three missed cycles. One late cycle is a slow query or a deploy; three
    // in a row means the schedule itself stopped.
    if (gapMs < expected * 3.5) return []

    return [
      makeFinding(ctx, {
        checkId: 'scheduler.agent_gap',
        severity: gapMs > expected * 12 ? 'critical' : 'warning',
        category: 'scheduler',
        fingerprintParts: ['agent_gap', previous.id],
        title: 'The operations agent stopped running for a while',
        description:
          `The previous agent cycle ran ${minutes(gapMs)} minutes ago, but the agent is scheduled every ${ctx.settings.intervalMinutes} minutes. ` +
          `Nothing was being checked during that gap — any problem that started and resolved inside it left no record at all.`,
        evidence: {
          previousRunAt: previous.startedAt.toISOString(),
          previousRunStatus: previous.status,
          gapMinutes: minutes(gapMs),
          expectedIntervalMinutes: ctx.settings.intervalMinutes,
          missedCycles: Math.floor(gapMs / expected) - 1,
        },
        suggestedActions: ['sendDiscordIncidentAlert'],
      }),
    ]
  },
}

// ── 2. Work that is due and untouched ───────────────────────────────────

const sweepNotRunning: CheckDefinition = {
  id: 'scheduler.dispatch_sweep_silent',
  category: 'scheduler',
  intent: 'Campaigns are due and the dispatch sweep has left no trace of trying — the worker is likely down.',
  run: async (ctx) => {
    const cutoff = since(ctx, SCHEDULE_GRACE_MS)
    const due = await prisma.marketingCampaign.findMany({
      where: {
        channel: 'EMAIL',
        status: 'SCHEDULED',
        emailConfig: { is: { scheduledAt: { lt: cutoff }, approvedAt: { not: null } } },
      },
      select: { id: true, name: true, emailConfig: { select: { scheduledAt: true, statusNote: true, updatedAt: true } } },
      take: 20,
    })
    countInspected(ctx, 'campaigns_due', due.length)
    if (due.length === 0) return []

    // THE DISCRIMINATOR. A running sweep that refuses a campaign WRITES THE
    // REASON onto the row. So: due, overdue, and no refusal note recorded since
    // it became due means nothing even looked at it.
    const untouched = due.filter((c) => {
      const cfg = c.emailConfig
      if (!cfg?.scheduledAt) return false
      const noted = cfg.statusNote && /Scheduled dispatch was refused/.test(cfg.statusNote)
      if (!noted) return true
      // A note exists — was it written since this campaign became due?
      return cfg.updatedAt < cfg.scheduledAt
    })
    if (untouched.length === 0) return []

    return [
      makeFinding(ctx, {
        checkId: 'scheduler.dispatch_sweep_silent',
        severity: 'critical',
        category: 'scheduler',
        campaignId: untouched[0].id,
        fingerprintParts: ['dispatch_sweep_silent'],
        title: 'Campaigns are due and nothing is attempting them',
        description:
          `${untouched.length} approved ${plural(untouched.length, 'campaign is', 'campaigns are')} past ${plural(untouched.length, 'its', 'their')} send time with no record of the dispatch sweep even trying. ` +
          `A running sweep records its refusal reason on the campaign; the absence of one means the worker process is not running, so no campaign, retry or suppression sweep is running either.`,
        evidence: {
          dueCampaigns: due.length,
          untouched: untouched.length,
          examples: untouched.slice(0, 5).map((c) => ({
            campaignId: c.id,
            name: c.name,
            scheduledAt: c.emailConfig?.scheduledAt?.toISOString() ?? null,
            minutesOverdue: c.emailConfig?.scheduledAt ? minutes(ctx.now.getTime() - c.emailConfig.scheduledAt.getTime()) : null,
            hasRefusalNote: !!c.emailConfig?.statusNote,
          })),
        },
        suggestedActions: ['sendDiscordIncidentAlert', 'createApprovalRequest'],
      }),
    ]
  },
}

// ── 3. Application clock vs database clock ──────────────────────────────

const clockSkew: CheckDefinition = {
  id: 'scheduler.clock_skew',
  category: 'scheduler',
  intent: 'The application and the database disagree about the time, so every schedule comparison is wrong.',
  run: async (ctx) => {
    const rows = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT NOW() AS now`
    const dbNow = rows[0]?.now
    if (!dbNow) return []
    const skew = Math.abs(dbNow.getTime() - ctx.now.getTime())
    if (skew < CLOCK_SKEW_WARN_MS) return []
    return [
      makeFinding(ctx, {
        checkId: 'scheduler.clock_skew',
        severity: skew >= CLOCK_SKEW_CRITICAL_MS ? 'critical' : 'warning',
        category: 'scheduler',
        fingerprintParts: ['clock_skew'],
        title: 'The application clock and the database clock disagree',
        description:
          `The application thinks it is ${ctx.now.toISOString()} and the database says ${dbNow.toISOString()} — a difference of ${Math.round(skew / 1000)} seconds. ` +
          `Every "is this campaign due yet" comparison mixes both clocks, so schedules fire early, late, or twice.`,
        evidence: { applicationTime: ctx.now.toISOString(), databaseTime: dbNow.toISOString(), skewSeconds: Math.round(skew / 1000) },
        suggestedActions: ['sendDiscordIncidentAlert'],
      }),
    ]
  },
}

// ── 4. The queue itself ─────────────────────────────────────────────────

const queueHealthCheck: CheckDefinition = {
  id: 'scheduler.queue',
  category: 'scheduler',
  intent: 'Redis/BullMQ is unreachable or the queues are not draining.',
  emits: ['scheduler.queue_depth', 'scheduler.failed_jobs', 'scheduler.queue_unreachable'],
  run: async (ctx) => {
    const QUEUE_DEPTH_WARN = 500
    const QUEUE_DEPTH_CRITICAL = 2000
    const FAILED_JOBS_WARN = 10
    // A failure older than this is history, not a fault. Long enough to catch
    // an overnight breakage the owner slept through; short enough that a
    // problem fixed days ago stops shouting.
    const RECENT_FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000
    const findings: AgentFinding[] = []
    try {
      // Imported lazily so a Redis outage cannot break the database checks, and
      // so the Next.js bundle for the health route never pulls in BullMQ.
      const { scheduledQueue, emailQueue } = await import('../../queues')
      for (const [name, queue] of [
        ['scheduled', scheduledQueue],
        ['email', emailQueue],
      ] as const) {
        const [waiting, failed] = await Promise.all([queue.getWaitingCount(), queue.getFailedCount()])
        countInspected(ctx, `queue_${name}_waiting`, waiting)
        if (waiting >= QUEUE_DEPTH_WARN) {
          findings.push(
            makeFinding(ctx, {
              checkId: 'scheduler.queue_depth',
              severity: waiting >= QUEUE_DEPTH_CRITICAL ? 'critical' : 'warning',
              category: 'scheduler',
              fingerprintParts: ['queue_depth', name],
              title: `The ${name} queue has ${waiting} waiting jobs`,
              description:
                `The ${name} queue is holding ${waiting} jobs. ` +
                (waiting >= QUEUE_DEPTH_CRITICAL
                  ? 'At this depth it is not draining — the worker is either not running or not connected to Redis.'
                  : 'This is normal during a large send and a problem if it does not fall.'),
              evidence: { queue: name, waiting, warnAt: QUEUE_DEPTH_WARN, criticalAt: QUEUE_DEPTH_CRITICAL },
              suggestedActions: [],
            })
          )
        }
        // AGE MATTERS (owner report 2026-07-28). This counted RETAINED
        // failures and concluded "a broken code path, not bad luck" -- wrong
        // for the case that actually happened: on 2026-07-24 the worker
        // deployed ahead of the email-marketing migrations, 100 sweeps failed
        // with "table does not exist", the migrations landed, and every sweep
        // since has succeeded. BullMQ keeps failures, so five days later a
        // fixed problem still read as a live one.
        //
        // An alert that is not true is worse than no alert: it teaches the
        // owner to ignore the ones that are.
        if (failed >= FAILED_JOBS_WARN) {
          // Enough to judge recency; a large backlog need not be read in full
          // to answer "is this still happening?".
          const sample = await queue.getFailed(0, 249)
          const cutoff = Date.now() - RECENT_FAILURE_WINDOW_MS
          const recent = sample.filter((j) => (j.finishedOn ?? j.timestamp ?? 0) >= cutoff)
          const newest = sample.length ? Math.max(...sample.map((j) => j.finishedOn ?? j.timestamp ?? 0)) : 0
          const windowHours = Math.round(RECENT_FAILURE_WINDOW_MS / 3_600_000)
          countInspected(ctx, `queue_${name}_failed_recent`, recent.length)

          if (recent.length >= FAILED_JOBS_WARN) {
            // Distinct first lines: forty copies of one bug is one bug.
            const reasons = Array.from(
              new Set(
                recent
                  .map((j) => String(j.failedReason || '').split('\n').find((l) => l.trim())?.trim() ?? '')
                  .filter(Boolean)
              )
            )
            findings.push(
              makeFinding(ctx, {
                checkId: 'scheduler.failed_jobs',
                severity: 'warning',
                category: 'scheduler',
                fingerprintParts: ['failed_jobs', name],
                title: `The ${name} queue has ${recent.length} failures in the last ${windowHours} hours`,
                description:
                  `${recent.length} jobs on the ${name} queue have failed recently (${failed} retained in total). ` +
                  'Failures this fresh, repeating, mean a broken code path rather than bad luck.' +
                  (reasons.length ? ` Distinct causes: ${reasons.slice(0, 3).map((r) => r.slice(0, 120)).join(' | ')}` : ''),
                evidence: {
                  queue: name,
                  recentFailures: recent.length,
                  retainedTotal: failed,
                  windowHours,
                  newestFailureAt: newest ? new Date(newest).toISOString() : null,
                  distinctReasons: reasons.slice(0, 3).map((r) => r.slice(0, 160)),
                  warnAt: FAILED_JOBS_WARN,
                },
                suggestedActions: [],
              })
            )
          } else {
            // Historical debris. Counted so it stays visible in the run
            // report, deliberately NOT a finding -- nothing is wrong now.
            countInspected(ctx, `queue_${name}_failed_stale`, failed)
          }
        }
      }
    } catch (err) {
      findings.push(
        makeFinding(ctx, {
          checkId: 'scheduler.queue_unreachable',
          severity: 'critical',
          category: 'scheduler',
          fingerprintParts: ['queue_unreachable'],
          title: 'The job queue cannot be reached',
          description:
            `Redis/BullMQ could not be reached: ${safeErrorMessage(err, 160)}. No email is being dispatched, no retry is running and no sweep is executing right now. ` +
            `Queued work resumes on reconnect — nothing is lost, but nothing is moving either.`,
          evidence: { error: safeErrorMessage(err, 240) },
          suggestedActions: ['sendDiscordIncidentAlert'],
        })
      )
    }
    return findings
  },
}

export const schedulerChecks: CheckDefinition[] = [agentHeartbeat, sweepNotRunning, clockSkew, queueHealthCheck]
