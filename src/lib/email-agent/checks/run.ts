// ════════════════════════════════════════════════════════════════════════
//  CAMPAIGN-RUN CHECKS (owner spec 2026-07-27)
//  ---------------------------------------------------------------------
//  A run is one immutable EXECUTION of a campaign. Everything here is about
//  telling three states apart that look identical in a database snapshot:
//
//     working   — a bounded batch is in flight; counters legitimately lag
//     recovering— a worker died and the sweep will re-open the claim shortly
//     stuck     — nothing is coming, and only a human or a repair will move it
//
//  COUNTER SEMANTICS, VERIFIED AGAINST PRODUCTION ROWS BEFORE THIS WAS WRITTEN,
//  because getting them wrong would make the loudest check in the system a
//  permanent false positive:
//
//     totalRecipients = how many ELIGIBLE people were claimed at dispatch.
//                       It is FROZEN at dispatch and is NOT the number of
//                       recipient rows — excluded people also get rows.
//     skippedCount    = the excluded rows (SKIPPED/SUPPRESSED/UNSUBSCRIBED/
//                       INELIGIBLE/CONTEXT_INVALID).
//     sent/failed/cancelled = recomputed from rows by finalizeRunIfDone.
//
//  Live example that must read as HEALTHY: total=1, sent=1, skipped=5, with
//  rows {SENT:1, SKIPPED:5}. One person was eligible and received it; five were
//  correctly excluded and each carries its reason. That is a good campaign, not
//  a broken one — so `totalRecipients` is never compared against a row count,
//  and the derived counters are only compared on TERMINAL runs, where the
//  finalizer has already had its turn.
// ════════════════════════════════════════════════════════════════════════

import { prisma } from '../../db'
import { RUN_TERMINAL_STATES, type RecipientState, type RunState } from '../../email-campaign-run'
import { maskEmail } from '../redact'
import type { AgentFinding } from '../types'
import {
  EVIDENCE_ROW_CAP,
  RECIPIENT_CLAIM_STALE_MS,
  RUN_MIDFLIGHT_GRACE_MS,
  RUN_PREPARING_STUCK_MS,
  RUN_STUCK_CRITICAL_MS,
  RUN_STUCK_WARN_MS,
  STRUCTURAL_WINDOW_DAYS,
  ageMs,
  countInspected,
  hours,
  makeFinding,
  minutes,
  plural,
  since,
  type CheckContext,
  type CheckDefinition,
} from './shared'

const TRANSITIONAL: RunState[] = ['PREPARING', 'QUEUED', 'SENDING', 'CANCELLING']
const TERMINAL: RunState[] = Array.from(RUN_TERMINAL_STATES)

/** Recipient states that count as "excluded before we tried" — the skip family. */
const SKIP_FAMILY: RecipientState[] = ['SKIPPED', 'SUPPRESSED', 'UNSUBSCRIBED', 'INELIGIBLE', 'CONTEXT_INVALID']

const structuralSince = (ctx: CheckContext) => since(ctx, STRUCTURAL_WINDOW_DAYS * 24 * 3600_000)

async function recipientCounts(runId: string): Promise<Record<string, number>> {
  const grouped = await prisma.emailCampaignRecipient.groupBy({
    by: ['status'],
    where: { runId },
    _count: { _all: true },
  })
  const out: Record<string, number> = {}
  for (const g of grouped) out[g.status] = g._count._all
  return out
}

// ── 1. Transitional runs: mid-flight vs stuck ───────────────────────────

const stuckRuns: CheckDefinition = {
  id: 'run.stuck_in_transition',
  category: 'run',
  intent: 'A run that has been in a non-terminal state long enough that nothing is going to move it.',
  emits: ['run.stuck_in_transition', 'run.preparation_abandoned'],
  run: async (ctx) => {
    const runs = await prisma.emailCampaignRun.findMany({
      where: { status: { in: TRANSITIONAL } },
      select: { id: true, campaignId: true, status: true, startedAt: true, updatedAt: true, totalRecipients: true },
      take: 100,
    })
    countInspected(ctx, 'runs_transitional', runs.length)
    const findings: AgentFinding[] = []

    for (const r of runs) {
      // Age is measured from the LAST ACTIVITY, not from the start. A large
      // audience legitimately takes a long time; a run whose rows moved a
      // minute ago is working, however long it has been going.
      const idle = ageMs(ctx, r.updatedAt)
      const total = ageMs(ctx, r.startedAt)

      // PREPARING is seconds of work. It gets its own, much shorter clock,
      // because a killed process leaves it PREPARING forever and every later
      // dispatch then returns "already running" for a run that will never
      // progress — the campaign becomes permanently undispatchable.
      if (r.status === 'PREPARING') {
        if (total < RUN_PREPARING_STUCK_MS) continue
        findings.push(
          makeFinding(ctx, {
            checkId: 'run.preparation_abandoned',
            severity: 'critical',
            category: 'run',
            campaignId: r.campaignId,
            runRefId: r.id,
            title: 'A campaign run never finished preparing',
            description:
              `Run ${r.id} has been PREPARING for ${minutes(total)} minutes. Preparation takes seconds, so the process that started it did not survive. ` +
              `While this run exists in a non-terminal state the campaign cannot be dispatched again — every attempt returns "already running".`,
            evidence: { status: r.status, minutesInState: minutes(total), startedAt: r.startedAt.toISOString() },
            suggestedActions: ['inspectCampaignRun', 'releaseExpiredLock', 'finalizeSettledRun'],
          })
        )
        continue
      }

      // MID-FLIGHT: within the grace window this is a normal snapshot, and
      // saying otherwise would make the agent cry wolf on every healthy send.
      if (idle < RUN_MIDFLIGHT_GRACE_MS) continue
      if (idle < RUN_STUCK_WARN_MS) continue

      const counts = await recipientCounts(r.id)
      const openRows = (counts.PENDING ?? 0) + (counts.SENDING ?? 0) + (counts.DEFERRED ?? 0)

      // DEFERRED-only is not stuck: quiet hours and frequency caps are the
      // system deliberately waiting, and the sweep will pick them up.
      if (openRows > 0 && (counts.PENDING ?? 0) === 0 && (counts.SENDING ?? 0) === 0) continue

      const critical = idle >= RUN_STUCK_CRITICAL_MS
      findings.push(
        makeFinding(ctx, {
          checkId: 'run.stuck_in_transition',
          severity: critical ? 'critical' : 'warning',
          category: 'run',
          campaignId: r.campaignId,
          runRefId: r.id,
          title: `A campaign run has been ${r.status} with no progress for ${hours(idle)} hours`,
          description:
            `Run ${r.id} is ${r.status} and nothing in it has changed for ${minutes(idle)} minutes (started ${minutes(total)} minutes ago). ` +
            `${openRows} ${plural(openRows, 'recipient is', 'recipients are')} still open. ` +
            (critical
              ? 'The sweep re-opens stale claims every five minutes, so at this age the run is not recovering on its own.'
              : 'This is past the point where the recovery sweep should have moved it.'),
          evidence: { status: r.status, minutesIdle: minutes(idle), minutesSinceStart: minutes(total), recipientCounts: counts, totalRecipients: r.totalRecipients },
          suggestedActions: ['inspectCampaignRun', 'reconcileRunCounters', 'finalizeSettledRun', 'releaseExpiredLock'],
        })
      )
    }
    return findings
  },
}

// ── 2. Terminal run with no completion timestamp ────────────────────────

const terminalWithoutTimestamp: CheckDefinition = {
  id: 'run.terminal_without_completed_at',
  category: 'run',
  intent: 'A finished run that carries no completion time — the signature of a run that died mid-repair.',
  run: async (ctx) => {
    const runs = await prisma.emailCampaignRun.findMany({
      where: { status: { in: TERMINAL }, completedAt: null },
      select: { id: true, campaignId: true, status: true, startedAt: true, error: true },
      take: EVIDENCE_ROW_CAP,
    })
    countInspected(ctx, 'runs_terminal_no_timestamp', runs.length)
    return runs.map((r) =>
      makeFinding(ctx, {
        checkId: 'run.terminal_without_completed_at',
        severity: 'warning',
        category: 'run',
        campaignId: r.campaignId,
        runRefId: r.id,
        title: 'A finished run has no completion time',
        description:
          `Run ${r.id} is ${r.status} but has no completedAt. Every terminal run is supposed to carry one; its absence means the run reached its final state ` +
          `without going through the finaliser, so its counters were never recomputed either.`,
        evidence: { status: r.status, startedAt: r.startedAt.toISOString(), error: r.error },
        suggestedActions: ['inspectCampaignRun', 'reconcileRunCounters', 'finalizeSettledRun'],
      })
    )
  },
}

// ── 3. Counters that disagree with the recipient rows ───────────────────

const counterMismatch: CheckDefinition = {
  id: 'run.counters_mismatch',
  category: 'run',
  intent: 'A finished run whose stored progress counters disagree with its own recipient rows.',
  run: async (ctx) => {
    // TERMINAL ONLY. On a live run the counters lag by design — the finaliser
    // recomputes them, and comparing before it has run would flag every healthy
    // send in progress.
    const runs = await prisma.emailCampaignRun.findMany({
      where: { status: { in: TERMINAL }, startedAt: { gte: structuralSince(ctx) } },
      select: { id: true, campaignId: true, status: true, sentCount: true, skippedCount: true, failedCount: true, cancelledCount: true, totalRecipients: true },
      orderBy: { startedAt: 'desc' },
      take: 200,
    })
    countInspected(ctx, 'runs_terminal', runs.length)

    const findings: AgentFinding[] = []
    for (const r of runs) {
      const counts = await recipientCounts(r.id)
      const actualSent = counts.SENT ?? 0
      const actualFailed = counts.FAILED ?? 0
      const actualCancelled = counts.CANCELLED ?? 0
      const actualSkipped = SKIP_FAMILY.reduce((sum, s) => sum + (counts[s] ?? 0), 0)

      const diffs: Array<{ counter: string; stored: number; actual: number }> = []
      if (r.sentCount !== actualSent) diffs.push({ counter: 'sentCount', stored: r.sentCount, actual: actualSent })
      if (r.failedCount !== actualFailed) diffs.push({ counter: 'failedCount', stored: r.failedCount, actual: actualFailed })
      if (r.cancelledCount !== actualCancelled) diffs.push({ counter: 'cancelledCount', stored: r.cancelledCount, actual: actualCancelled })
      if (r.skippedCount !== actualSkipped) diffs.push({ counter: 'skippedCount', stored: r.skippedCount, actual: actualSkipped })
      if (diffs.length === 0) continue

      // A counter that OVERSTATES sends is the dangerous direction: it is the
      // number the owner reads as "people we contacted".
      const overstatesSends = r.sentCount > actualSent
      findings.push(
        makeFinding(ctx, {
          checkId: 'run.counters_mismatch',
          severity: overstatesSends ? 'critical' : 'warning',
          category: 'run',
          campaignId: r.campaignId,
          runRefId: r.id,
          title: 'A finished run reports different numbers than its own recipients',
          description:
            `Run ${r.id} (${r.status}) reports ${diffs.map((d) => `${d.counter}=${d.stored} but the recipient rows say ${d.actual}`).join('; ')}. ` +
            (overstatesSends
              ? 'The stored figure claims MORE sends than actually happened, so the campaign report overstates how many people were reached.'
              : 'The recipient rows are the canonical record; the summary counters drifted and can be recomputed from them safely.'),
          evidence: { status: r.status, totalRecipients: r.totalRecipients, differences: diffs, recipientCounts: counts },
          suggestedActions: ['inspectCampaignRun', 'reconcileRunCounters'],
        })
      )
    }
    return findings
  },
}

// ── 4. Duplicate active runs for one campaign ───────────────────────────

const duplicateActiveRun: CheckDefinition = {
  id: 'run.duplicate_active',
  category: 'run',
  intent: 'Two live runs for the same campaign — the duplicate-send risk.',
  run: async (ctx) => {
    const grouped = await prisma.emailCampaignRun.groupBy({
      by: ['campaignId'],
      where: { status: { in: ['PREPARING', 'QUEUED', 'SENDING', 'PAUSED', 'CANCELLING'] } },
      _count: { _all: true },
      having: { campaignId: { _count: { gt: 1 } } },
    })
    if (grouped.length === 0) return []

    const findings: AgentFinding[] = []
    for (const g of grouped) {
      const runs = await prisma.emailCampaignRun.findMany({
        where: { campaignId: g.campaignId, status: { in: ['PREPARING', 'QUEUED', 'SENDING', 'PAUSED', 'CANCELLING'] } },
        select: { id: true, status: true, startedAt: true, totalRecipients: true },
        orderBy: { startedAt: 'asc' },
      })
      findings.push(
        makeFinding(ctx, {
          checkId: 'run.duplicate_active',
          severity: 'critical',
          category: 'run',
          campaignId: g.campaignId,
          runRefId: runs[0]?.id,
          fingerprintParts: [g.campaignId],
          title: 'One campaign has two live runs at once',
          description:
            `Campaign ${g.campaignId} has ${g._count._all} runs in a non-terminal state simultaneously. Only one execution of a campaign may be live at a time; ` +
            `two means the same recipients can be claimed twice, and a duplicate email to a real customer is the failure this system is built to make impossible.`,
          evidence: { activeRuns: runs.map((r) => ({ id: r.id, status: r.status, startedAt: r.startedAt.toISOString(), totalRecipients: r.totalRecipients })) },
          suggestedActions: ['pauseMarketingDispatch', 'inspectCampaignRun', 'createApprovalRequest'],
        })
      )
    }
    return findings
  },
}

// ── 5. A live run with nothing in it ────────────────────────────────────

const emptyRun: CheckDefinition = {
  id: 'run.no_recipients',
  category: 'run',
  intent: 'A run that is queued or sending but has no recipient rows at all.',
  run: async (ctx) => {
    const runs = await prisma.emailCampaignRun.findMany({
      where: { status: { in: ['QUEUED', 'SENDING'] }, startedAt: { lt: since(ctx, RUN_MIDFLIGHT_GRACE_MS) } },
      select: { id: true, campaignId: true, status: true, startedAt: true, totalRecipients: true, _count: { select: { recipients: true } } },
      take: 50,
    })
    return runs
      .filter((r) => r._count.recipients === 0)
      .map((r) =>
        makeFinding(ctx, {
          checkId: 'run.no_recipients',
          severity: 'warning',
          category: 'run',
          campaignId: r.campaignId,
          runRefId: r.id,
          title: 'A live run has no recipients',
          description:
            `Run ${r.id} is ${r.status} but contains no recipient rows, ${minutes(ageMs(ctx, r.startedAt))} minutes after it started. ` +
            `It will never complete on its own because there is nothing in it to settle.`,
          evidence: { status: r.status, totalRecipients: r.totalRecipients, recipientRows: 0, startedAt: r.startedAt.toISOString() },
          suggestedActions: ['inspectCampaignRun', 'finalizeSettledRun'],
        })
      )
  },
}

// ── 6. Recipients stranded inside a finished run ────────────────────────

const strandedRecipients: CheckDefinition = {
  id: 'run.stranded_recipients',
  category: 'run',
  intent: 'Recipients left PENDING or SENDING inside a run that has already finished.',
  run: async (ctx) => {
    const grouped = await prisma.emailCampaignRecipient.groupBy({
      by: ['runId'],
      where: { status: { in: ['PENDING', 'SENDING'] }, run: { status: { in: TERMINAL } } },
      _count: { _all: true },
    })
    if (grouped.length === 0) return []

    const findings: AgentFinding[] = []
    for (const g of grouped.slice(0, EVIDENCE_ROW_CAP)) {
      const run = await prisma.emailCampaignRun.findUnique({
        where: { id: g.runId },
        select: { id: true, campaignId: true, status: true, error: true },
      })
      if (!run) continue
      // The emailSendId is what decides whether a stranded row is safe to
      // cancel or must be looked at by a human, so it is on the finding.
      const rows = await prisma.emailCampaignRecipient.findMany({
        where: { runId: g.runId, status: { in: ['PENDING', 'SENDING'] } },
        select: { id: true, email: true, status: true, emailSendId: true },
        take: EVIDENCE_ROW_CAP,
      })
      const neverSubmitted = rows.filter((r) => r.emailSendId === null).length
      findings.push(
        makeFinding(ctx, {
          checkId: 'run.stranded_recipients',
          severity: 'critical',
          category: 'run',
          campaignId: run.campaignId,
          runRefId: run.id,
          title: 'Recipients are stranded inside a finished run',
          description:
            `${g._count._all} ${plural(g._count._all, 'recipient is', 'recipients are')} still PENDING or SENDING inside run ${run.id}, which is already ${run.status}. ` +
            `They will never be sent and no reason is recorded against them, so nobody can tell from the data whether those customers were contacted.`,
          evidence: {
            runStatus: run.status,
            runError: run.error,
            strandedTotal: g._count._all,
            neverSubmittedToProvider: neverSubmitted,
            examples: rows.map((r) => ({ recipientId: r.id, email: maskEmail(r.email), status: r.status, hasSendRecord: r.emailSendId !== null })),
          },
          suggestedActions: ['inspectCampaignRun', 'finalizeSettledRun', 'createApprovalRequest'],
        })
      )
    }
    return findings
  },
}

// ── 7. A claim that was never released ──────────────────────────────────

const expiredClaims: CheckDefinition = {
  id: 'run.expired_claim',
  category: 'run',
  intent: 'A recipient held in SENDING past the stale window — its worker died and the lock was never released.',
  run: async (ctx) => {
    const cutoff = since(ctx, RECIPIENT_CLAIM_STALE_MS)
    const grouped = await prisma.emailCampaignRecipient.groupBy({
      by: ['runId'],
      where: { status: 'SENDING', updatedAt: { lt: cutoff }, run: { status: { in: ['QUEUED', 'SENDING', 'PAUSED', 'CANCELLING'] } } },
      _count: { _all: true },
    })
    const findings: AgentFinding[] = []
    for (const g of grouped.slice(0, EVIDENCE_ROW_CAP)) {
      const run = await prisma.emailCampaignRun.findUnique({ where: { id: g.runId }, select: { campaignId: true, status: true } })
      findings.push(
        makeFinding(ctx, {
          checkId: 'run.expired_claim',
          severity: 'warning',
          category: 'run',
          campaignId: run?.campaignId,
          runRefId: g.runId,
          title: 'A send claim has been held past its expiry',
          description:
            `${g._count._all} ${plural(g._count._all, 'recipient has', 'recipients have')} been held in SENDING on run ${g.runId} for over ${minutes(RECIPIENT_CLAIM_STALE_MS)} minutes. ` +
            `A claim that old means the worker holding it is gone. Releasing it returns the row to PENDING; the send-level idempotency key still guarantees no duplicate goes out.`,
          evidence: { runStatus: run?.status, expiredClaims: g._count._all, staleAfterMinutes: minutes(RECIPIENT_CLAIM_STALE_MS) },
          suggestedActions: ['releaseExpiredLock', 'inspectCampaignRun'],
        })
      )
    }
    return findings
  },
}

// ── 8. Run status contradicts its own recipients ────────────────────────

const statusConflict: CheckDefinition = {
  id: 'run.status_conflicts_recipients',
  category: 'run',
  intent: 'A run reported as clean COMPLETED that actually contains failed recipients.',
  run: async (ctx) => {
    const runs = await prisma.emailCampaignRun.findMany({
      where: { status: 'COMPLETED', startedAt: { gte: structuralSince(ctx) } },
      select: { id: true, campaignId: true, failedCount: true },
      orderBy: { startedAt: 'desc' },
      take: 200,
    })
    const findings: AgentFinding[] = []
    for (const r of runs) {
      const failed = await prisma.emailCampaignRecipient.count({ where: { runId: r.id, status: 'FAILED' } })
      if (failed === 0) continue
      findings.push(
        makeFinding(ctx, {
          checkId: 'run.status_conflicts_recipients',
          severity: 'warning',
          category: 'run',
          campaignId: r.campaignId,
          runRefId: r.id,
          title: 'A run reported as fully completed contains failed recipients',
          description:
            `Run ${r.id} is COMPLETED — the state that means "finished with no failures" — but ${failed} ${plural(failed, 'recipient', 'recipients')} ended FAILED. ` +
            `It should be COMPLETED_WITH_ERRORS, otherwise the campaign reads as a clean success and the failures are never looked at.`,
          evidence: { storedFailedCount: r.failedCount, actualFailedRows: failed },
          suggestedActions: ['inspectCampaignRun', 'reconcileRunCounters'],
        })
      )
    }
    return findings
  },
}

// ── 9. Failed run holding recipients nobody can safely retry ────────────

const unretryableFailures: CheckDefinition = {
  id: 'run.unretryable_recipients',
  category: 'run',
  intent: 'A failed run whose open recipients already have a provider attempt of unknown outcome.',
  run: async (ctx) => {
    const rows = await prisma.emailCampaignRecipient.findMany({
      where: {
        status: { in: ['PENDING', 'SENDING', 'FAILED'] },
        emailSendId: { not: null },
        run: { status: { in: ['FAILED', 'CANCELLED'] } },
      },
      select: { id: true, runId: true, email: true, status: true, emailSendId: true },
      take: 100,
    })
    if (rows.length === 0) return []

    const sendIds = rows.map((r) => r.emailSendId).filter((v): v is string => v !== null)
    const sends = await prisma.emailSend.findMany({
      where: { id: { in: sendIds }, status: { in: ['ambiguous', 'sending'] } },
      select: { id: true, status: true },
    })
    const unknown = new Set(sends.map((s) => s.id))
    const affected = rows.filter((r) => r.emailSendId && unknown.has(r.emailSendId))
    if (affected.length === 0) return []

    const byRun = new Map<string, typeof affected>()
    for (const a of affected) byRun.set(a.runId, [...(byRun.get(a.runId) ?? []), a])

    return Array.from(byRun.entries()).map(([runId, list]) =>
      makeFinding(ctx, {
        checkId: 'run.unretryable_recipients',
        severity: 'warning',
        category: 'run',
        runRefId: runId,
        title: 'A failed run holds recipients whose provider outcome is unknown',
        description:
          `${list.length} ${plural(list.length, 'recipient', 'recipients')} on failed run ${runId} already have a send attempt whose real-world outcome we cannot determine. ` +
          `They must never be automatically resent — if the provider did accept the message, a retry delivers a second copy to a real customer.`,
        evidence: { affected: list.length, examples: list.slice(0, EVIDENCE_ROW_CAP).map((l) => ({ recipientId: l.id, email: maskEmail(l.email), recipientStatus: l.status, sendId: l.emailSendId })) },
        suggestedActions: ['inspectCampaignRun', 'inspectEmailSend', 'createApprovalRequest'],
      })
    )
  },
}

// ── 10. Abnormal duration compared with this system's own history ───────

const abnormalDuration: CheckDefinition = {
  id: 'run.abnormal_duration',
  category: 'run',
  intent: 'A run that took far longer than recent comparable runs on this system.',
  run: async (ctx) => {
    const recent = await prisma.emailCampaignRun.findMany({
      where: { status: { in: ['COMPLETED', 'COMPLETED_WITH_ERRORS'] }, completedAt: { not: null }, startedAt: { gte: since(ctx, 30 * 24 * 3600_000) } },
      select: { id: true, campaignId: true, startedAt: true, completedAt: true, totalRecipients: true },
      orderBy: { startedAt: 'desc' },
      take: 50,
    })
    // A baseline needs a baseline. With fewer than four comparable runs, any
    // "abnormal" verdict is a statement about noise.
    if (recent.length < 4) return []

    const durations = recent
      .filter((r) => r.completedAt)
      .map((r) => ({ id: r.id, campaignId: r.campaignId, ms: r.completedAt!.getTime() - r.startedAt.getTime(), recipients: r.totalRecipients }))
    const sorted = durations.map((d) => d.ms).sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]
    if (median <= 0) return []

    return durations
      .filter((d) => d.ms > Math.max(median * 5, 10 * 60_000))
      .slice(0, EVIDENCE_ROW_CAP)
      .map((d) =>
        makeFinding(ctx, {
          checkId: 'run.abnormal_duration',
          severity: 'info',
          category: 'run',
          campaignId: d.campaignId,
          runRefId: d.id,
          title: 'A run took much longer than this system usually takes',
          description:
            `Run ${d.id} took ${minutes(d.ms)} minutes for ${d.recipients} recipients, against a median of ${minutes(median)} minutes across the last ${durations.length} completed runs. ` +
            `It finished, so nothing is broken — but a large jump usually means the queue was backed up or a batch was retried repeatedly.`,
          evidence: { durationMinutes: minutes(d.ms), medianMinutes: minutes(median), sampleSize: durations.length, recipients: d.recipients },
          suggestedActions: ['inspectCampaignRun'],
        })
      )
  },
}

export const runChecks: CheckDefinition[] = [
  stuckRuns,
  terminalWithoutTimestamp,
  counterMismatch,
  duplicateActiveRun,
  emptyRun,
  strandedRecipients,
  expiredClaims,
  statusConflict,
  unretryableFailures,
  abnormalDuration,
]
