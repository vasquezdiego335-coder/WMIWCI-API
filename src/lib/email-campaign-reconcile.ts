// ════════════════════════════════════════════════════════════════════════
//  TERMINAL-RUN RECONCILIATION (bug #7, owner spec 2026-07-26)
//  ---------------------------------------------------------------------
//  A run that died mid-preparation left recipients stranded forever:
//
//      run   status=FAILED  completedAt=NULL
//      rows  PENDING=1  SKIPPED=5
//
//  Neither recovery path would touch it:
//    • retryFailedRecipients refuses any run that is not sendable or
//      COMPLETED_WITH_ERRORS — FAILED is neither;
//    • finalizeRunIfDone returns early for FAILED.
//
//  So the row sat PENDING indefinitely and the run never settled. That breaks
//  the rule that a terminal run must not retain unexplained PENDING recipients,
//  and it leaves the owner with a generic FAILED and no action.
//
//  THE SAFETY QUESTION that decides the behaviour: was this recipient ever
//  handed to the provider? `emailCampaignRecipient.emailSendId` answers it,
//  because it is only set once a send row exists:
//
//    emailSendId IS NULL  → never submitted. Nothing can have been delivered,
//                           so cancelling (or retrying) is safe and cannot
//                           duplicate anything.
//    emailSendId IS SET   → an attempt exists and its outcome may be AMBIGUOUS
//                           (the provider request may have landed). Such a
//                           recipient is NEVER blindly resent — a duplicate to
//                           a real customer is worse than a missing email. It is
//                           marked for human reconciliation instead.
//
//  Every reconciled row gets an explicit `reason`, so nothing is silently
//  skipped, and none of these states count as delivered in reporting
//  (CANCELLED and FAILED are outside SENT).
// ════════════════════════════════════════════════════════════════════════

import { prisma } from './db'
import { queueLogger } from './logger'

const log = queueLogger.child({ mod: 'campaign-reconcile' })

/** Runs that will never process another recipient on their own. */
export const TERMINAL_RUN_STATES: readonly string[] = ['FAILED', 'CANCELLED', 'COMPLETED']

/** Recipient states that still expect work — the ones that strand. */
export const ACTIONABLE_RECIPIENT_STATES: readonly string[] = ['PENDING', 'SENDING']

export type ReconcileResult = {
  ok: boolean
  /** Never submitted to the provider → safely cancelled. */
  cancelled: number
  /** An attempt exists with an unknown outcome → needs a human. */
  needsReview: number
  /** True when the run was given a completedAt by this pass. */
  settled: boolean
  error?: string
}

/**
 * Bring a terminal run's recipients to rest.
 *
 * Idempotent: a second call finds nothing actionable and reports zeroes, so a
 * duplicate retry request cannot double-handle a recipient.
 */
export async function reconcileTerminalRun(runId: string): Promise<ReconcileResult> {
  try {
    const run = await prisma.emailCampaignRun.findUnique({
      where: { id: runId },
      select: { id: true, status: true, completedAt: true },
    })
    if (!run) return { ok: false, cancelled: 0, needsReview: 0, settled: false, error: 'That run does not exist.' }
    if (!TERMINAL_RUN_STATES.includes(run.status)) {
      // A live run settles through its own batch passes; reconciling it here
      // would race the worker.
      return { ok: false, cancelled: 0, needsReview: 0, settled: false, error: `Run ${run.status} is not terminal; nothing to reconcile.` }
    }

    const stranded = await prisma.emailCampaignRecipient.findMany({
      where: { runId, status: { in: [...ACTIONABLE_RECIPIENT_STATES] } },
      select: { id: true, emailSendId: true },
    })

    const neverSubmitted = stranded.filter((r) => r.emailSendId === null).map((r) => r.id)
    const unknownOutcome = stranded.filter((r) => r.emailSendId !== null).map((r) => r.id)

    if (neverSubmitted.length > 0) {
      await prisma.emailCampaignRecipient.updateMany({
        where: { id: { in: neverSubmitted } },
        data: {
          status: 'CANCELLED',
          reason: `run_${run.status.toLowerCase()}_never_submitted`,
        },
      })
    }
    if (unknownOutcome.length > 0) {
      // FAILED (not CANCELLED): an attempt genuinely happened. The reason names
      // it so the admin can surface "unknown provider outcome" and a human can
      // reconcile against the provider dashboard before anything is resent.
      await prisma.emailCampaignRecipient.updateMany({
        where: { id: { in: unknownOutcome } },
        data: {
          status: 'FAILED',
          reason: `run_${run.status.toLowerCase()}_unknown_provider_outcome`,
        },
      })
    }

    // Settle the run once nothing actionable remains. Counters are recomputed
    // from the rows themselves rather than incremented, so a partial earlier
    // pass cannot skew them.
    const remaining = await prisma.emailCampaignRecipient.count({
      where: { runId, status: { in: [...ACTIONABLE_RECIPIENT_STATES] } },
    })
    let settled = false
    if (remaining === 0 && !run.completedAt) {
      const [sent, failed, skipped, cancelled] = await Promise.all([
        prisma.emailCampaignRecipient.count({ where: { runId, status: 'SENT' } }),
        prisma.emailCampaignRecipient.count({ where: { runId, status: 'FAILED' } }),
        prisma.emailCampaignRecipient.count({
          where: { runId, status: { in: ['SKIPPED', 'SUPPRESSED', 'UNSUBSCRIBED', 'INELIGIBLE', 'CONTEXT_INVALID'] } },
        }),
        prisma.emailCampaignRecipient.count({ where: { runId, status: 'CANCELLED' } }),
      ])
      await prisma.emailCampaignRun.updateMany({
        where: { id: runId, completedAt: null },
        data: { completedAt: new Date(), sentCount: sent, failedCount: failed, skippedCount: skipped, cancelledCount: cancelled },
      })
      settled = true
    }

    log.info(
      { runId, status: run.status, cancelled: neverSubmitted.length, needsReview: unknownOutcome.length, settled },
      'terminal run reconciled'
    )
    return { ok: true, cancelled: neverSubmitted.length, needsReview: unknownOutcome.length, settled }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    log.error({ err: error, runId }, 'reconcileTerminalRun failed')
    return { ok: false, cancelled: 0, needsReview: 0, settled: false, error }
  }
}

/**
 * One-time repair for runs already stranded before this code existed.
 * Safe to run repeatedly — reconcileTerminalRun is idempotent.
 */
export async function repairStrandedRuns(limit = 50): Promise<{ runsRepaired: number; cancelled: number; needsReview: number }> {
  const candidates = await prisma.emailCampaignRun.findMany({
    where: {
      status: { in: [...TERMINAL_RUN_STATES] },
      recipients: { some: { status: { in: [...ACTIONABLE_RECIPIENT_STATES] } } },
    },
    select: { id: true },
    take: limit,
  })
  let cancelled = 0
  let needsReview = 0
  for (const c of candidates) {
    const r = await reconcileTerminalRun(c.id)
    cancelled += r.cancelled
    needsReview += r.needsReview
  }
  return { runsRepaired: candidates.length, cancelled, needsReview }
}
