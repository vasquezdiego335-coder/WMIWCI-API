// ============================================================================
// Action Center sync (increment 2, hardened in 2.1). Loads live operational
// data, pre-computes money via src/lib/job-money.ts (single-source math), runs
// the pure rule engine (reminder-rules.ts), then applies the pure diff.
// Deterministic, no AI. Every write is keyed by dedupeKey so re-runs are no-ops.
//
// 2.1 hardening: runScan() wraps the sync in a ScanRun row + a Postgres advisory
// lock so two scans can never overlap (web + worker + Railway restarts), with a
// cooldown and crash-safe stale detection. The Action Center page READS
// reminders and never depends on a scan succeeding to render.
// ============================================================================

import { prisma } from './db'
import { moveDayDueCents, jobProfit } from './job-money'
import {
  evaluateAll,
  computeSyncActions,
  type RuleBooking,
  type RuleInput,
  type ExistingReminder,
} from './reminder-rules'
import {
  SCAN_LOCK_KEY, SCAN_STALE_MS, decideClaim, isScanLive, sanitizeScanError,
  type ClaimTrigger,
} from './scan-lock'
import { queueLogger } from './logger'

const DAY = 86_400_000

export interface SyncResult {
  created: number
  updated: number
  autoResolved: number
  reopened: number
  woken: number
  candidates: number
  entitiesEvaluated: number
}

/** The core sync body — pure DB effect, no locking. Exported for the scheduled
 *  worker / scripts that manage their own ScanRun. Prefer runScan() elsewhere. */
export async function performSync(now = new Date()): Promise<SyncResult> {
  // ── Load operational data (active + recently completed, never internal tests) ──
  const [bookings, generalExpenses, ownerTxs, leads, customers] = await Promise.all([
    prisma.booking.findMany({
      where: {
        isInternalTest: false,
        OR: [
          { status: { in: ['PENDING_APPROVAL', 'CONFIRMED', 'SCHEDULED', 'IN_PROGRESS'] } },
          { status: 'COMPLETED', updatedAt: { gte: new Date(now.getTime() - 30 * DAY) } },
        ],
      },
      include: {
        customer: { select: { name: true, phone: true, email: true } },
        payments: { select: { amount: true, status: true, isInternalTest: true, stripePaymentIntentId: true, stripeChargeId: true } },
        job: { include: { crew: { include: { user: { select: { name: true, payRate: true } } } } } },
        expenses: { select: { id: true, category: true, amount: true, status: true, receiptUrl: true, vendor: true, createdAt: true } },
      },
      take: 500,
    }),
    prisma.expense.findMany({
      where: { bookingId: null },
      select: { id: true, category: true, amount: true, status: true, receiptUrl: true, vendor: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 500,
    }),
    prisma.ownerTransaction.findMany({
      where: { approvalStatus: 'PENDING' },
      select: { id: true, owner: true, type: true, amount: true, approvalStatus: true, createdAt: true },
      take: 200,
    }),
    prisma.lead.findMany({
      select: { id: true, name: true, status: true, lostReason: true, createdAt: true, quotedAt: true, updatedAt: true },
      orderBy: { createdAt: 'desc' },
      take: 500,
    }),
    prisma.customer.findMany({ select: { id: true, name: true, phone: true }, take: 2000 }),
  ])

  // ── Map to pure rule shapes (money pre-computed once, single source) ──
  const ruleBookings: RuleBooking[] = bookings.map((b) => {
    const profit = jobProfit(b)
    return {
      id: b.id,
      displayId: b.displayId,
      status: b.status,
      customerName: b.customer.name,
      customerPhone: b.customer.phone,
      customerEmail: b.customer.email,
      originAddress: b.originAddress,
      destAddress: b.destAddress,
      originVerification: b.originVerification,
      destVerification: b.destVerification,
      manualReviewRequired: b.manualReviewRequired,
      agreementAccepted: b.agreementAccepted,
      totalEstimate: b.totalEstimate,
      scheduledStart: b.scheduledStart,
      scheduledEnd: b.scheduledEnd,
      requestedDate: b.requestedDate,
      completedAt: b.completedAt ?? b.job?.completedAt ?? null,
      truckAddonDueOnMoveDay: b.truckAddonDueOnMoveDay,
      truckProvider: b.truckProvider,
      truckReservationStatus: b.truckReservationStatus,
      truckReservationNumber: b.truckReservationNumber,
      jobStartedAt: b.job?.startedAt ?? null,
      crew: (b.job?.crew ?? []).map((c) => ({
        userId: c.userId,
        userName: c.user.name,
        payStatus: c.payStatus,
        payMethod: c.payMethod,
        flatPay: c.flatPay,
        payRate: c.payRate,
        userPayRate: c.user.payRate,
        actualHours: c.actualHours,
        scheduledHours: c.scheduledHours,
      })),
      hasFailedPayment: b.payments.some((p) => p.status === 'FAILED' && !p.isInternalTest),
      hasWorkerPayExpense: b.expenses.some((e) => e.category === 'WORKER_PAY' && e.status !== 'REJECTED'),
      moveDayDueCents: moveDayDueCents(b),
      grossRevenueCents: profit.grossRevenueCents,
      netProfitCents: profit.netProfitCents,
    }
  })

  const input: RuleInput = {
    bookings: ruleBookings,
    // Booking-linked expenses ride the booking rules; general ones get their own.
    expenses: [...generalExpenses, ...bookings.flatMap((b) => b.expenses)],
    ownerTransactions: ownerTxs,
    leads,
    customers,
  }

  const candidates = evaluateAll(input, now)

  // ── Diff against existing reminders and apply ──
  const existing: ExistingReminder[] = await prisma.reminder.findMany({
    where: {
      OR: [
        { dedupeKey: { in: candidates.map((c) => c.dedupeKey) } },
        { createdBy: 'system', status: { in: ['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS', 'SNOOZED'] } },
      ],
    },
    select: { id: true, dedupeKey: true, status: true, createdBy: true, snoozedUntil: true, title: true, description: true, severity: true, dueAt: true, dismissalScope: true, entityFingerprint: true },
  })

  const actions = computeSyncActions(existing, candidates, now)

  if (actions.create.length > 0) {
    await prisma.reminder.createMany({
      data: actions.create.map((c) => ({
        reminderType: c.reminderType,
        category: c.category,
        title: c.title,
        description: c.description,
        severity: c.severity,
        sourceEntityType: c.sourceEntityType,
        sourceEntityId: c.sourceEntityId,
        sourceUrl: c.sourceUrl,
        dedupeKey: c.dedupeKey,
        dueAt: c.dueAt,
        entityFingerprint: c.fingerprint ?? null,
        createdBy: 'system',
      })),
      skipDuplicates: true, // dedupeKey unique — concurrent scans can never double-insert
    })
  }

  for (const u of actions.update) {
    await prisma.reminder.update({
      where: { id: u.id },
      data: { title: u.candidate.title, description: u.candidate.description, severity: u.candidate.severity, dueAt: u.candidate.dueAt, entityFingerprint: u.candidate.fingerprint ?? null },
    })
  }

  for (const r of actions.autoResolve) {
    await prisma.reminder.update({
      where: { id: r.id },
      data: { status: 'RESOLVED', resolvedAt: now, resolutionNote: 'Auto-resolved: the condition is no longer detected.' },
    })
  }

  for (const r of actions.reopen) {
    await prisma.reminder.update({
      where: { id: r.id },
      data: {
        status: 'OPEN',
        resolvedAt: null,
        dismissedAt: null,
        dismissalScope: null,
        resolutionNote: 'Reopened: the condition returned or the record materially changed.',
        title: r.candidate.title,
        description: r.candidate.description,
        severity: r.candidate.severity,
        dueAt: r.candidate.dueAt,
        entityFingerprint: r.candidate.fingerprint ?? null,
      },
    })
  }

  for (const r of actions.wake) {
    await prisma.reminder.update({
      where: { id: r.id },
      data: { status: 'OPEN', snoozedUntil: null, title: r.candidate.title, description: r.candidate.description, severity: r.candidate.severity, dueAt: r.candidate.dueAt, entityFingerprint: r.candidate.fingerprint ?? null },
    })
  }

  return {
    created: actions.create.length,
    updated: actions.update.length,
    autoResolved: actions.autoResolve.length,
    reopened: actions.reopen.length,
    woken: actions.wake.length,
    candidates: candidates.length,
    entitiesEvaluated: bookings.length + generalExpenses.length + ownerTxs.length + leads.length + customers.length,
  }
}

// ── Scan orchestration (increment 2.1) ───────────────────────────────────────

export type ScanOutcome =
  | { ran: true; scanRunId: string; result: SyncResult }
  | { ran: false; reason: 'already_running' | 'cooldown'; lastScan: ScanStatusSummary }

export interface ScanStatusSummary {
  running: boolean
  runningSince: Date | null
  lastSuccessAt: Date | null
  lastFailureAt: Date | null
  lastError: string | null
}

const WORKER_ID = process.env.RAILWAY_SERVICE_NAME ?? process.env.HOSTNAME ?? 'web'

/**
 * Run a full scan under concurrency + cooldown protection.
 *  1. A Postgres transaction advisory lock makes the claim atomic across
 *     processes; a live RUNNING ScanRun means "already running" (crash-safe via
 *     the stale window). 2. Cooldown blocks automatic re-scans; `force` (owner
 *     manual rescan) bypasses cooldown but never an in-flight scan.
 * The actual sync runs OUTSIDE the lock (batched writes), then finalizes the
 * ScanRun row. Failures are recorded (FAILED) and never thrown to the caller.
 */
export async function runScan(opts: { trigger: ClaimTrigger; userId?: string; userName?: string; force?: boolean } , now = new Date()): Promise<ScanOutcome> {
  // ── Atomic claim inside a short advisory-locked transaction ──
  const claim = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(${SCAN_LOCK_KEY})`
    const running = await tx.scanRun.findFirst({ where: { status: 'RUNNING' }, orderBy: { startedAt: 'desc' } })
    const liveRunningExists = !!running && isScanLive(running.startedAt, now)
    // Supersede a crashed (stale) RUNNING row so it can't wedge the system.
    if (running && !liveRunningExists) {
      await tx.scanRun.update({ where: { id: running.id }, data: { status: 'FAILED', completedAt: now, errorSummary: 'Superseded: scan exceeded the stale timeout (process likely crashed).' } })
    }
    const last = await tx.scanRun.findFirst({ where: { status: 'COMPLETED' }, orderBy: { startedAt: 'desc' } })
    const decision = decideClaim({ liveRunningExists, lastScanStartedAt: last?.startedAt ?? null, trigger: opts.trigger, force: !!opts.force }, now)
    if (!decision.proceed) return { proceed: false as const, reason: decision.reason }
    const run = await tx.scanRun.create({
      data: { status: 'RUNNING', trigger: opts.trigger, triggeredById: opts.userId ?? null, triggeredByName: opts.userName ?? null, worker: WORKER_ID },
    })
    return { proceed: true as const, scanRunId: run.id }
  })

  if (!claim.proceed) {
    return { ran: false, reason: claim.reason, lastScan: await getScanStatus() }
  }

  // ── Run the sync outside the lock; always finalize the ScanRun row ──
  try {
    const result = await performSync(now)
    const done = new Date()
    await prisma.scanRun.update({
      where: { id: claim.scanRunId },
      data: {
        status: 'COMPLETED', completedAt: done, durationMs: done.getTime() - now.getTime(),
        entitiesEvaluated: result.entitiesEvaluated, remindersCreated: result.created,
        remindersUpdated: result.updated, remindersReopened: result.reopened,
        remindersResolved: result.autoResolved, remindersSkipped: result.woken,
      },
    })
    queueLogger.info({ scanRunId: claim.scanRunId, trigger: opts.trigger, ...result }, 'Reminder scan complete')
    return { ran: true, scanRunId: claim.scanRunId, result }
  } catch (err) {
    const summary = sanitizeScanError(err)
    await prisma.scanRun.update({
      where: { id: claim.scanRunId },
      data: { status: 'FAILED', completedAt: new Date(), errorCount: 1, errorSummary: summary },
    }).catch(() => {})
    queueLogger.error({ scanRunId: claim.scanRunId, err: summary }, 'Reminder scan failed')
    throw err
  }
}

/** Read the current scan health for the UI + health endpoint. Never throws. */
export async function getScanStatus(now = new Date()): Promise<ScanStatusSummary> {
  const [running, lastSuccess, lastFailure] = await Promise.all([
    prisma.scanRun.findFirst({ where: { status: 'RUNNING' }, orderBy: { startedAt: 'desc' } }),
    prisma.scanRun.findFirst({ where: { status: 'COMPLETED' }, orderBy: { startedAt: 'desc' } }),
    prisma.scanRun.findFirst({ where: { status: 'FAILED' }, orderBy: { startedAt: 'desc' } }),
  ]).catch(() => [null, null, null] as const)
  const live = running && isScanLive(running.startedAt, now, SCAN_STALE_MS)
  return {
    running: !!live,
    runningSince: live ? running!.startedAt : null,
    lastSuccessAt: lastSuccess?.completedAt ?? null,
    lastFailureAt: lastFailure?.completedAt ?? null,
    lastError: lastFailure?.errorSummary ?? null,
  }
}

/** Backward-compatible entry point. Delegates to runScan; a blocked scan (lock
 *  or cooldown) is NOT an error — callers that need detail should use runScan. */
export async function syncReminders(now = new Date()): Promise<SyncResult> {
  const outcome = await runScan({ trigger: 'API', force: false }, now)
  if (outcome.ran) return outcome.result
  return { created: 0, updated: 0, autoResolved: 0, reopened: 0, woken: 0, candidates: 0, entitiesEvaluated: 0 }
}
