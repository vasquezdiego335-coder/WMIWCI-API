import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { apiLogger } from '@/lib/logger'
import { can, type Role } from '@/lib/permissions'
import { buildCloseoutView, ensureCloseout, writeSnapshot } from '@/lib/closeout-service'
import { canFinalizeCloseout, canReopenCloseout, canOverrideBlocker, canEditCloseoutInputs, canSetOverhead, canSetReserves, canSetOwnerSplit, isConcurrentFinalize } from '@/lib/closeout-guards'
import { computeOwnerSplit, type SplitMethod } from '@/lib/owner-split'
import { z } from 'zod'

// ════════════════════════════════════════════════════════════════════════════
//  Financial closeout for ONE move. [id] is the BOOKING id.
//  Phase 2 (owner spec 2026-07-20).
//
//  GET   the full closeout picture (numbers + blockers + snapshots)
//  POST  every workflow action, each behind a pure guard so a forged request
//        cannot skip a blocker:
//          START · CONFIRM_TRUCK · WRITE_OFF_BALANCE · ACK_DISPUTE
//          SET_OVERHEAD · SET_TAX_RESERVE · ADD_RESERVE · SET_SPLIT
//          OVERRIDE · SUBMIT · FINALIZE · REOPEN
// ════════════════════════════════════════════════════════════════════════════

export async function GET(_req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  if (!can(session.role as Role, 'closeout.view')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const view = await buildCloseoutView(params.id)
  if (!view) return NextResponse.json({ error: 'Booking not found' }, { status: 404 })
  return NextResponse.json({
    ...view,
    canFinalize: view.decision.canFinalize,
  })
}

const Schema = z.object({
  action: z.enum([
    'START', 'CONFIRM_TRUCK', 'WRITE_OFF_BALANCE', 'ACK_DISPUTE',
    'SET_OVERHEAD', 'SET_TAX_RESERVE', 'ADD_RESERVE', 'SET_SPLIT',
    'OVERRIDE', 'SUBMIT', 'FINALIZE', 'REOPEN',
  ]),
  reason: z.string().trim().max(1000).optional(),
  // CONFIRM_TRUCK
  truckSource: z.enum(['CUSTOMER_PROVIDED', 'COMPANY_OWNED', 'RENTAL', 'THIRD_PARTY', 'NOT_REQUIRED']).optional(),
  // WRITE_OFF_BALANCE
  writeOffCents: z.number().int().min(0).max(1_000_000_00).optional(),
  // SET_OVERHEAD
  overheadMethod: z.enum(['NONE', 'PER_MOVE', 'PCT_REVENUE', 'PER_LABOR_HOUR', 'MONTHLY_POOL', 'MANUAL']).optional(),
  overheadAmountCents: z.number().int().min(0).max(1_000_000_00).optional(),
  // SET_TAX_RESERVE
  taxReserveBp: z.number().int().min(0).max(10_000).optional(),
  taxReserveCents: z.number().int().min(0).max(1_000_000_00).optional(),
  // ADD_RESERVE
  reserveKind: z.enum(['GENERAL', 'EMERGENCY', 'TRUCK_FUND', 'EQUIPMENT_FUND', 'LICENSING_FUND', 'INSURANCE_FUND', 'MARKETING_FUND', 'GROWTH_FUND', 'RETAINED_EARNINGS', 'OTHER']).optional(),
  reserveAmountCents: z.number().int().min(0).max(1_000_000_00).optional(),
  // SET_SPLIT
  splitMethod: z.enum(['EQUAL', 'OWNERSHIP_PERCENT', 'LABOR_FIRST', 'CUSTOM']).optional(),
  customCents: z.record(z.number().int().min(0)).optional(),
  customPercentBp: z.record(z.number().int().min(0).max(10_000)).optional(),
  // OVERRIDE
  blockerCode: z.string().trim().max(80).optional(),
})

export async function POST(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  const role = session.role as Role

  const parsed = Schema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request', issues: parsed.error.flatten() }, { status: 422 })
  const d = parsed.data

  const view = await buildCloseoutView(params.id)
  if (!view) return NextResponse.json({ error: 'Booking not found' }, { status: 404 })

  // Everything except FINALIZE / REOPEN / a read requires an editable closeout.
  const mutatesInputs = !['FINALIZE', 'REOPEN', 'START'].includes(d.action)
  if (mutatesInputs) {
    const gate = canEditCloseoutInputs({ role, isFinalized: view.isFinalized })
    if (!gate.allow) return NextResponse.json({ error: gate.error }, { status: gate.status })
  }

  const { id: closeoutId } = await ensureCloseout(params.id, session.userId)
  const audit = async (action: string, details: Record<string, unknown>, tx = prisma) => {
    await tx.auditLog.create({
      data: { action: action as never, userId: session.userId, bookingId: params.id, details: { ...details, by: session.name } as never },
    })
  }

  switch (d.action) {
    case 'START': {
      if (!can(role, 'closeout.edit')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      await audit('CLOSEOUT_STARTED', { closeoutId })
      break
    }

    case 'CONFIRM_TRUCK': {
      if (!d.truckSource) return NextResponse.json({ error: 'Choose a truck source.' }, { status: 422 })
      await prisma.$transaction(async (tx) => {
        await tx.moveCloseout.update({
          where: { id: closeoutId },
          data: { truckSource: d.truckSource as never, truckSourceConfirmedAt: new Date(), truckSourceConfirmedById: session.userId },
        })
        await audit('CLOSEOUT_TRUCK_SOURCE_CONFIRMED', { previous: view.blockers.some((b) => b.code === 'TRUCK_SOURCE_MISSING') ? null : 'set', next: d.truckSource }, tx as never)
      })
      break
    }

    case 'WRITE_OFF_BALANCE': {
      // Deciding not to collect money is a financial assertion, so it needs a
      // reason and it is recorded — never a silent zeroing of a receivable.
      if (!can(role, 'closeout.override_blocker')) return NextResponse.json({ error: 'Only an owner can write off a balance.' }, { status: 403 })
      if (!d.reason?.trim()) return NextResponse.json({ error: 'A reason is required to write off a customer balance.' }, { status: 422 })
      const amount = d.writeOffCents ?? view.financials.outstandingBalanceCents
      await prisma.$transaction(async (tx) => {
        await tx.moveCloseout.update({ where: { id: closeoutId }, data: { balanceWriteOffCents: amount, balanceWriteOffReason: d.reason } })
        await audit('CLOSEOUT_BALANCE_WRITTEN_OFF', { previousOutstandingCents: view.financials.outstandingBalanceCents, writeOffCents: amount, reason: d.reason }, tx as never)
      })
      break
    }

    case 'ACK_DISPUTE': {
      await prisma.$transaction(async (tx) => {
        await tx.moveCloseout.update({ where: { id: closeoutId }, data: { disputeAcknowledgedAt: new Date() } })
        await audit('CLOSEOUT_DISPUTE_ACKNOWLEDGED', { disputedCents: view.financials.disputedOpenCents }, tx as never)
      })
      break
    }

    case 'SET_OVERHEAD': {
      const gate = canSetOverhead({ role, isFinalized: view.isFinalized, method: d.overheadMethod ?? 'NONE', manualCents: d.overheadAmountCents, reason: d.reason })
      if (!gate.allow) return NextResponse.json({ error: gate.error }, { status: gate.status })
      await prisma.$transaction(async (tx) => {
        await tx.moveCloseout.update({
          where: { id: closeoutId },
          data: { overheadMethod: (d.overheadMethod ?? 'NONE') as never, overheadAmountCents: d.overheadAmountCents ?? null, overheadReason: d.reason ?? null },
        })
        await audit('OVERHEAD_METHOD_SELECTED', { previous: view.financials.overhead.method, next: d.overheadMethod, amountCents: d.overheadAmountCents ?? null, reason: d.reason ?? null }, tx as never)
      })
      break
    }

    case 'SET_TAX_RESERVE': {
      const proposed = d.taxReserveCents ?? Math.round((Math.max(0, view.financials.profit.companyNetProfitCents) * (d.taxReserveBp ?? 0)) / 10_000)
      const otherReserves = view.financials.reserves.businessReserveCents + view.financials.reserves.retainedEarningsCents
      const gate = canSetReserves({ role, isFinalized: view.isFinalized, companyNetProfitCents: view.financials.profit.companyNetProfitCents, totalReserveCents: proposed + otherReserves })
      if (!gate.allow) return NextResponse.json({ error: gate.error }, { status: gate.status })
      await prisma.$transaction(async (tx) => {
        await tx.moveCloseout.update({
          where: { id: closeoutId },
          data: { taxReserveBp: d.taxReserveBp ?? null, taxReserveCents: d.taxReserveCents ?? null, taxReserveReason: d.reason ?? null },
        })
        await audit('TAX_RESERVE_CHANGED', { previousCents: view.financials.reserves.taxReserveCents, nextCents: proposed, bp: d.taxReserveBp ?? null, reason: d.reason ?? null }, tx as never)
      })
      break
    }

    case 'ADD_RESERVE': {
      if (!d.reserveKind || d.reserveAmountCents == null) return NextResponse.json({ error: 'Choose a reserve and an amount.' }, { status: 422 })
      const total = view.financials.reserves.businessReserveCents + view.financials.reserves.retainedEarningsCents + view.financials.reserves.taxReserveCents + d.reserveAmountCents
      const gate = canSetReserves({ role, isFinalized: view.isFinalized, companyNetProfitCents: view.financials.profit.companyNetProfitCents, totalReserveCents: total })
      if (!gate.allow) return NextResponse.json({ error: gate.error }, { status: gate.status })
      await prisma.$transaction(async (tx) => {
        await tx.reserveAllocation.create({
          data: {
            closeoutId, bookingId: params.id, kind: d.reserveKind as never, amountCents: d.reserveAmountCents!,
            reason: d.reason ?? null, createdById: session.userId, createdByName: session.name,
          },
        })
        await audit('BUSINESS_RESERVE_CHANGED', { kind: d.reserveKind, amountCents: d.reserveAmountCents, reason: d.reason ?? null, planned: true }, tx as never)
      })
      break
    }

    case 'SET_SPLIT': {
      const preview = computeOwnerSplit({
        method: (d.splitMethod ?? 'OWNERSHIP_PERCENT') as SplitMethod,
        distributableProfitCents: view.financials.reserves.distributableProfitCents,
        ownershipBp: { DIEGO: 5000, SEBASTIAN: 5000 },
        customCents: d.customCents as never,
        customPercentBp: d.customPercentBp as never,
      })
      const gate = canSetOwnerSplit({ role, isFinalized: view.isFinalized, splitOk: preview.ok, splitError: preview.error })
      if (!gate.allow) return NextResponse.json({ error: gate.error }, { status: gate.status })
      if (d.splitMethod === 'CUSTOM' && !d.reason?.trim()) {
        return NextResponse.json({ error: 'A reason is required for a custom owner split.' }, { status: 422 })
      }
      await prisma.$transaction(async (tx) => {
        await tx.moveCloseout.update({ where: { id: closeoutId }, data: { splitMethod: (d.splitMethod ?? 'OWNERSHIP_PERCENT') as never, splitReason: d.reason ?? null } })
        await audit('OWNER_SPLIT_CHANGED', { previous: view.split?.method ?? null, next: d.splitMethod, shares: preview.shares, reason: d.reason ?? null }, tx as never)
      })
      break
    }

    case 'OVERRIDE': {
      const gate = canOverrideBlocker({ role, code: d.blockerCode ?? '', reason: d.reason, blockers: view.blockers })
      if (!gate.allow) return NextResponse.json({ error: gate.error }, { status: gate.status })
      const next = [
        ...view.overrides.filter((o) => o.code !== d.blockerCode),
        { code: d.blockerCode!, reason: d.reason!, byId: session.userId, byName: session.name, at: new Date().toISOString() },
      ]
      await prisma.$transaction(async (tx) => {
        await tx.moveCloseout.update({ where: { id: closeoutId }, data: { overrides: next as never } })
        await audit('CLOSEOUT_OVERRIDE_USED', { code: d.blockerCode, reason: d.reason, previousOverrides: view.overrides.map((o) => o.code) }, tx as never)
      })
      break
    }

    case 'SUBMIT': {
      if (!can(role, 'closeout.submit')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      await prisma.$transaction(async (tx) => {
        await tx.moveCloseout.update({ where: { id: closeoutId }, data: { status: 'READY_FOR_REVIEW', submittedAt: new Date(), submittedById: session.userId } })
        await audit('CLOSEOUT_SUBMITTED', { closeoutId, blockers: view.blockers.map((b) => b.code) }, tx as never)
      })
      break
    }

    case 'FINALIZE': {
      // Re-check EVERYTHING server-side against a freshly built view — the
      // client's opinion of readiness is never trusted.
      const fresh = await buildCloseoutView(params.id)
      if (!fresh) return NextResponse.json({ error: 'Booking not found' }, { status: 404 })
      const gate = canFinalizeCloseout({ role, alreadyFinalized: fresh.isFinalized, blockers: fresh.blockers, overrides: fresh.overrides })
      if (!gate.allow) {
        return NextResponse.json({ error: gate.error, canFinalize: false, blockers: fresh.blockers }, { status: gate.status })
      }
      const allocations = (fresh.split?.shares ?? []).map((s) => ({ owner: s.owner, amountCents: s.amountCents, percentBp: s.percentBp }))
      let snap: { id: string; version: number }
      try {
        snap = await prisma.$transaction(async (tx) => {
        const written = await writeSnapshot(tx as never, {
          closeoutId, bookingId: params.id, view: fresh, userId: session.userId, userName: session.name, allocations,
        })
        await tx.moveCloseout.update({
          where: { id: closeoutId },
          data: { status: 'FINALIZED', finalizedAt: new Date(), finalizedById: session.userId },
        })
        await tx.auditLog.create({
          data: {
            action: 'CLOSEOUT_FINALIZED',
            userId: session.userId,
            bookingId: params.id,
            details: {
              snapshotId: written.id, version: written.version,
              companyNetProfitCents: fresh.financials.profit.companyNetProfitCents,
              distributableProfitCents: fresh.financials.reserves.distributableProfitCents,
              overridesUsed: fresh.overrides.map((o) => ({ code: o.code, reason: o.reason })),
              by: session.name,
            } as never,
          },
        })
          return written
        })
      } catch (err) {
        // P1-4 — the loser of a concurrent finalize. The unique index on
        // (closeoutId, version) already prevented the duplicate snapshot; only
        // the message was wrong. The move IS finalized, by the other person.
        if (isConcurrentFinalize(err)) {
          apiLogger.warn({ bookingId: params.id, userId: session.userId }, 'Concurrent finalize rejected by version unique index')
          return NextResponse.json(
            { error: 'This move was finalized by someone else a moment ago. Reload to see the final numbers — nothing was lost or double-counted.', concurrent: true },
            { status: 409 },
          )
        }
        throw err
      }
      apiLogger.info({ bookingId: params.id, snapshotId: snap.id, version: snap.version }, 'Move financially finalized')
      break
    }

    case 'REOPEN': {
      const gate = canReopenCloseout({ role, isFinalized: view.isFinalized, reason: d.reason })
      if (!gate.allow) return NextResponse.json({ error: gate.error }, { status: gate.status })
      await prisma.$transaction(async (tx) => {
        await tx.moveCloseout.update({
          where: { id: closeoutId },
          data: { status: 'REOPENED', reopenedAt: new Date(), reopenedById: session.userId, reopenReason: d.reason, finalizedAt: null, finalizedById: null },
        })
        await audit('CLOSEOUT_REOPENED', {
          reason: d.reason,
          supersededSnapshotVersion: view.snapshots[0]?.version ?? null,
          previousCompanyNetProfitCents: view.snapshots[0]?.companyNetProfitCents ?? null,
        }, tx as never)
      })
      break
    }
  }

  const updated = await buildCloseoutView(params.id)
  return NextResponse.json({ ...updated, canFinalize: updated?.decision.canFinalize ?? false })
}
