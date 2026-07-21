import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { apiLogger } from '@/lib/logger'
import { can, type Role } from '@/lib/permissions'
import { PaymentMethod } from '@prisma/client'
import { canRecordDistribution } from '@/lib/closeout-guards'
import { buildCloseoutView } from '@/lib/closeout-service'
import { z } from 'zod'

// ════════════════════════════════════════════════════════════════════════════
//  Owner profit distributions (Phase 2).
//
//  A distribution is NOT an expense, NOT labor pay, and NOT a reimbursement —
//  it is a share of profit the business already made and collected. It can
//  never exceed the distributable profit that was actually snapshotted, and
//  calculating a split never creates one: an owner has to authorize it.
//
//  This system records decisions and cash movements. It does not move money.
// ════════════════════════════════════════════════════════════════════════════

const Schema = z.object({
  action: z.enum(['PLAN', 'APPROVE', 'PAY', 'VOID']),
  distributionId: z.string().optional(),
  bookingId: z.string().optional(),
  owner: z.enum(['DIEGO', 'SEBASTIAN']).optional(),
  amountCents: z.number().int().min(0).max(1_000_000_00).optional(),
  percentBp: z.number().int().min(0).max(10_000).optional(),
  method: z.nativeEnum(PaymentMethod).optional(),
  paidOn: z.string().optional(),
  reference: z.string().trim().max(200).optional(),
  notes: z.string().trim().max(1000).optional(),
  reason: z.string().trim().max(500).optional(),
})

export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  if (!can(session.role as Role, 'distribution.view')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const bookingId = req.nextUrl.searchParams.get('bookingId') ?? undefined
  const distributions = await prisma.ownerDistribution.findMany({
    where: bookingId ? { bookingId } : {},
    orderBy: { createdAt: 'desc' },
    take: 200,
  })
  return NextResponse.json({ distributions })
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  const role = session.role as Role

  const parsed = Schema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request', issues: parsed.error.flatten() }, { status: 422 })
  const d = parsed.data

  const audit = async (action: string, details: Record<string, unknown>, bookingId: string | null, tx: typeof prisma) => {
    await tx.auditLog.create({
      data: { action: action as never, userId: session.userId, bookingId, details: { ...details, by: session.name } as never },
    })
  }

  // ── PLAN / APPROVE: allocate against SNAPSHOTTED distributable profit ──
  if (d.action === 'PLAN' || d.action === 'APPROVE') {
    if (!d.bookingId || !d.owner || d.amountCents == null) {
      return NextResponse.json({ error: 'A move, an owner and an amount are required.' }, { status: 422 })
    }
    const view = await buildCloseoutView(d.bookingId)
    if (!view) return NextResponse.json({ error: 'Booking not found' }, { status: 404 })

    // Authorize against the FINALIZED snapshot when one exists. Distributing
    // from live, still-moving numbers is exactly how a business pays itself
    // money it has not made.
    const finalSnapshot = await prisma.financialSnapshot.findFirst({
      where: { bookingId: d.bookingId, supersededAt: null },
      orderBy: { version: 'desc' },
    })
    if (!finalSnapshot) {
      return NextResponse.json(
        { error: 'This move has not been financially finalized. Finalize it before distributing profit.' },
        { status: 422 },
      )
    }

    const existing = await prisma.ownerDistribution.findMany({ where: { bookingId: d.bookingId, voided: false } })
    const alreadyAllocated = existing.reduce((s, x) => s + x.approvedCents, 0)

    const gate = canRecordDistribution({
      role,
      action: d.action,
      amountCents: d.amountCents,
      distributableProfitCents: finalSnapshot.distributableProfitCents,
      alreadyAllocatedCents: alreadyAllocated,
    })
    if (!gate.allow) return NextResponse.json({ error: gate.error }, { status: gate.status })

    const created = await prisma.$transaction(async (tx) => {
      const row = await tx.ownerDistribution.create({
        data: {
          owner: d.owner as never,
          bookingId: d.bookingId!,
          snapshotId: finalSnapshot.id,
          status: d.action === 'APPROVE' ? 'APPROVED' : 'PLANNED',
          approvedCents: d.amountCents!,
          percentBp: d.percentBp ?? null,
          notes: d.notes ?? null,
          approvedById: d.action === 'APPROVE' ? session.userId : null,
          approvedByName: d.action === 'APPROVE' ? session.name : null,
          approvedAt: d.action === 'APPROVE' ? new Date() : null,
          recordedById: session.userId,
        },
      })
      await audit(d.action === 'APPROVE' ? 'DISTRIBUTION_APPROVED' : 'DISTRIBUTION_PLANNED', {
        distributionId: row.id, owner: d.owner, amountCents: d.amountCents,
        snapshotVersion: finalSnapshot.version,
        distributableProfitCents: finalSnapshot.distributableProfitCents,
        previouslyAllocatedCents: alreadyAllocated,
        remainingAfterCents: finalSnapshot.distributableProfitCents - alreadyAllocated - d.amountCents!,
      }, d.bookingId!, tx as never)
      return row
    })
    apiLogger.info({ distributionId: created.id, owner: d.owner, amount: d.amountCents }, 'Owner distribution recorded')
    return NextResponse.json({ distribution: created }, { status: 201 })
  }

  // ── PAY / VOID: act on an existing distribution ──
  if (!d.distributionId) return NextResponse.json({ error: 'A distribution is required.' }, { status: 422 })
  const dist = await prisma.ownerDistribution.findUnique({ where: { id: d.distributionId } })
  if (!dist) return NextResponse.json({ error: 'Distribution not found' }, { status: 404 })

  if (d.action === 'PAY') {
    const gate = canRecordDistribution({
      role, action: 'PAY', amountCents: d.amountCents ?? 0,
      distributableProfitCents: 0, alreadyAllocatedCents: 0,
      approvedCents: dist.approvedCents, alreadyPaidCents: dist.paidCents, status: dist.status,
    })
    if (!gate.allow) return NextResponse.json({ error: gate.error }, { status: gate.status })

    const paidOn = d.paidOn ? new Date(d.paidOn) : new Date()
    if (Number.isNaN(paidOn.getTime())) return NextResponse.json({ error: 'Invalid payment date' }, { status: 422 })
    const nextPaid = dist.paidCents + (d.amountCents ?? 0)

    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.ownerDistribution.update({
        where: { id: dist.id },
        data: {
          paidCents: nextPaid,
          status: nextPaid >= dist.approvedCents ? 'PAID' : 'PARTIALLY_PAID',
          method: d.method ?? dist.method,
          paidOn,
          reference: d.reference ?? dist.reference,
        },
      })
      await audit('DISTRIBUTION_PAID', {
        distributionId: row.id, owner: String(row.owner),
        amountCents: d.amountCents, previousPaidCents: dist.paidCents, nextPaidCents: nextPaid,
        approvedCents: dist.approvedCents, remainingCents: Math.max(0, dist.approvedCents - nextPaid),
        method: d.method ?? null,
      }, dist.bookingId, tx as never)
      return row
    })
    return NextResponse.json({ distribution: updated })
  }

  // VOID — never delete; the record stays, flagged, forever.
  const gate = canRecordDistribution({
    role, action: 'VOID', amountCents: 0, distributableProfitCents: 0, alreadyAllocatedCents: 0,
    status: dist.voided ? 'VOIDED' : dist.status, reason: d.reason,
  })
  if (!gate.allow) return NextResponse.json({ error: gate.error }, { status: gate.status })

  const voided = await prisma.$transaction(async (tx) => {
    const row = await tx.ownerDistribution.update({
      where: { id: dist.id },
      data: { voided: true, status: 'VOIDED', voidedById: session.userId, voidedAt: new Date(), voidReason: d.reason },
    })
    await audit('DISTRIBUTION_VOIDED', {
      distributionId: row.id, owner: String(row.owner),
      approvedCents: row.approvedCents, paidCents: row.paidCents, reason: d.reason,
    }, dist.bookingId, tx as never)
    return row
  })
  return NextResponse.json({ distribution: voided })
}
