// ============================================================================
// Action Center sync (increment 2). Loads live operational data, pre-computes
// money via src/lib/job-money.ts (single-source math), runs the pure rule
// engine (reminder-rules.ts), then applies the pure diff to the reminders
// table. Deterministic, no AI, safe to run on every Action Center page load —
// the data volumes here are small (hundreds of bookings) and every write is
// keyed by dedupeKey so re-runs are no-ops.
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

const DAY = 86_400_000

export interface SyncResult {
  created: number
  updated: number
  autoResolved: number
  reopened: number
  woken: number
  candidates: number
}

export async function syncReminders(now = new Date()): Promise<SyncResult> {
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
    select: { id: true, dedupeKey: true, status: true, createdBy: true, snoozedUntil: true, title: true, description: true, severity: true, dueAt: true },
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
        createdBy: 'system',
      })),
      skipDuplicates: true, // dedupeKey unique — concurrent scans can never double-insert
    })
  }

  for (const u of actions.update) {
    await prisma.reminder.update({
      where: { id: u.id },
      data: { title: u.candidate.title, description: u.candidate.description, severity: u.candidate.severity, dueAt: u.candidate.dueAt },
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
        resolutionNote: 'Reopened: the condition came back after being resolved.',
        title: r.candidate.title,
        description: r.candidate.description,
        severity: r.candidate.severity,
        dueAt: r.candidate.dueAt,
      },
    })
  }

  for (const r of actions.wake) {
    await prisma.reminder.update({
      where: { id: r.id },
      data: { status: 'OPEN', snoozedUntil: null, title: r.candidate.title, description: r.candidate.description, severity: r.candidate.severity, dueAt: r.candidate.dueAt },
    })
  }

  return {
    created: actions.create.length,
    updated: actions.update.length,
    autoResolved: actions.autoResolve.length,
    reopened: actions.reopen.length,
    woken: actions.wake.length,
    candidates: candidates.length,
  }
}
