import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { apiLogger } from '@/lib/logger'
import { can, type Role } from '@/lib/permissions'
import { buildRateSnapshot, type PayModel, type WorkerType } from '@/lib/labor-calc'
import { ensureJobForBooking, recalcAssignment, loadLaborPolicy } from '@/lib/labor-service'
import { canAssignCrew } from '@/lib/labor-guards'
import { resolveOwnerEconomicRateCents } from '@/lib/labor-rates'
import { canSaveAssignment } from '@/lib/scheduling-guards'
import { previewAssignmentConflicts } from '@/lib/scheduling-service'
import { scheduleAssignmentNotification } from '@/lib/crew-notifications'
import { z } from 'zod'

// ════════════════════════════════════════════════════════════════════════════
//  Crew assignment for one MOVE (Phase 1, owner spec 2026-07-20).
//  [id] is the BOOKING id — the admin works in bookings; the Job row is created
//  on demand so crew can be assigned before the move starts.
//
//  THE RATE SNAPSHOT IS TAKEN HERE, once. After this the worker's profile rate
//  is irrelevant to this move: raising someone's rate tomorrow must not rewrite
//  what this move cost. See docs/admin/time-tracking.md.
// ════════════════════════════════════════════════════════════════════════════

const CreateSchema = z.object({
  userId: z.string().min(1),
  workerType: z.enum(['OWNER', 'EMPLOYEE', 'CONTRACTOR', 'TEMP_HELPER']).optional(),
  role: z.enum(['CREW_MEMBER', 'CREW_LEADER', 'DRIVER', 'HELPER', 'OWNER_OPERATOR', 'OTHER']).optional(),
  payModel: z.enum(['HOURLY', 'FLAT', 'DAY_RATE', 'UNPAID_OWNER', 'ZERO_CONFIRMED', 'CUSTOM']).default('HOURLY'),
  hourlyRateCents: z.number().int().min(0).max(100_000_00).nullable().optional(),
  flatPayCents: z.number().int().min(0).max(100_000_00).nullable().optional(),
  dayRateCents: z.number().int().min(0).max(100_000_00).nullable().optional(),
  travelRateCents: z.number().int().min(0).max(100_000_00).nullable().optional(),
  travelPayPolicy: z.enum(['UNPAID', 'REGULAR', 'SEPARATE_RATE']).optional(),
  scheduledStartAt: z.string().datetime().nullable().optional(),
  scheduledEndAt: z.string().datetime().nullable().optional(),
  scheduledBreakMinutes: z.number().int().min(0).max(24 * 60).nullable().optional(),
  driverBonusCents: z.number().int().min(0).max(100_000_00).nullable().optional(),
  crewLeaderBonusCents: z.number().int().min(0).max(100_000_00).nullable().optional(),
  assignmentNotes: z.string().trim().max(1000).optional(),
  // ── Stage 5 scheduling fields (additive; the rate freeze below is unchanged) ──
  isDriver: z.boolean().optional(),
  reportTime: z.string().datetime().nullable().optional(),
  workerVisibleNotes: z.string().trim().max(2000).nullable().optional(),
  privateAdminNotes: z.string().trim().max(2000).nullable().optional(),
  // Overriding a scheduling warning at creation: owner-only, reason required
  // (enforced by canSaveAssignment — the same guard the schedule route uses).
  overrideCodes: z.array(z.string().max(80)).optional(),
  overrideReason: z.string().trim().max(1000).optional(),
})

export async function GET(_req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  if (!can(session.role as Role, 'labor.view_all_labor')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const crew = await prisma.jobCrew.findMany({
    where: { job: { bookingId: params.id } },
    include: { user: { select: { id: true, name: true, role: true, payRate: true } }, laborPayments: true },
    orderBy: { assignedAt: 'asc' },
  })
  return NextResponse.json({ crew })
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  if (!can(session.role as Role, 'labor.assign_crew')) {
    return NextResponse.json({ error: 'Only an owner or manager can assign crew.' }, { status: 403 })
  }

  const parsed = CreateSchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', issues: parsed.error.flatten() }, { status: 422 })
  }
  const d = parsed.data

  const booking = await prisma.booking.findUnique({ where: { id: params.id }, select: { id: true } })
  if (!booking) return NextResponse.json({ error: 'Booking not found' }, { status: 404 })

  const worker = await prisma.user.findUnique({
    where: { id: d.userId },
    select: { id: true, name: true, active: true, role: true, payRate: true, defaultFlatRateCents: true, workerType: true, ownerEconomicRateCents: true },
  })
  if (!worker) return NextResponse.json({ error: 'Worker not found' }, { status: 404 })
  if (!worker.active) {
    return NextResponse.json({ error: `${worker.name} is deactivated and cannot be assigned.` }, { status: 422 })
  }

  const jobId = await ensureJobForBooking(booking.id)

  // One ACTIVE assignment per worker per move. The DB unique index is the real
  // guard; this returns a readable message instead of a constraint error.
  const existing = await prisma.jobCrew.findUnique({
    where: { jobId_userId: { jobId, userId: worker.id } },
    select: { id: true, assignmentStatus: true },
  })
  if (existing && !['CANCELLED', 'DECLINED'].includes(existing.assignmentStatus)) {
    return NextResponse.json({ error: `${worker.name} is already assigned to this move.` }, { status: 409 })
  }

  const { ownerEconomicRateCents: businessOwnerRate, overtimeMultiplierPct } = await loadLaborPolicy()
  // Stage 4: this owner's OWN configured rate wins over the business-wide one.
  // Resolution never invents a number — an unconfigured owner rate stays null
  // and surfaces as LABOR_MISSING_RATE at the closeout.
  const ownerEconomicRateCents = resolveOwnerEconomicRateCents({
    profileRateCents: worker.ownerEconomicRateCents,
    businessDefaultCents: businessOwnerRate,
  })
  const workerType = (d.workerType ?? worker.workerType ?? 'EMPLOYEE') as WorkerType

  // Guard the one combination that silently produces free labor: an hourly
  // worker with no rate anywhere. Owners may be unpaid — that is a real model.
  if (d.payModel === 'HOURLY' && (d.hourlyRateCents ?? worker.payRate) == null) {
    return NextResponse.json(
      { error: `${worker.name} has no pay rate. Enter an hourly rate for this move, or set one on their staff profile.` },
      { status: 422 },
    )
  }

  const snapshot = buildRateSnapshot({
    payModel: d.payModel as PayModel,
    userProfilePayRateCents: worker.payRate,
    userDefaultFlatRateCents: worker.defaultFlatRateCents,
    hourlyRateCents: d.hourlyRateCents ?? null,
    flatPayCents: d.flatPayCents ?? null,
    dayRateCents: d.dayRateCents ?? null,
    travelRateCents: d.travelRateCents ?? null,
    overtimeMultiplierPct,
    ownerEconomicRateCents,
    workerType,
  })

  const scheduledStartAt = d.scheduledStartAt ? new Date(d.scheduledStartAt) : null
  const scheduledEndAt = d.scheduledEndAt ? new Date(d.scheduledEndAt) : null
  if (scheduledStartAt && scheduledEndAt && scheduledEndAt < scheduledStartAt) {
    return NextResponse.json({ error: 'The scheduled end is before the scheduled start.' }, { status: 422 })
  }

  // ── Stage 5: the conflict engine gates CREATION too, server-side. Creation
  //    previously ran no conflict checks at all — a direct POST could put a
  //    suspended worker, an unavailable worker or an overlapping shift on a job
  //    with no record. Same guard as the schedule route: a HARD_BLOCK is
  //    refused outright; an OVERRIDABLE_WARNING needs an owner override + a
  //    written reason, which is stored as a ConflictOverride and audited.
  const conflicts = await previewAssignmentConflicts({
    jobId,
    userId: worker.id,
    startAt: scheduledStartAt,
    endAt: scheduledEndAt,
    reportTime: d.reportTime ? new Date(d.reportTime) : null,
    isDriver: d.isDriver ?? (d.role === 'DRIVER'),
    isLead: d.role === 'CREW_LEADER',
    breakMinutes: d.scheduledBreakMinutes ?? null,
  })
  const conflictGate = canSaveAssignment({
    role: session.role as Role,
    conflicts,
    overriddenCodes: d.overrideCodes ?? [],
    overrideReason: d.overrideReason,
  })
  if (!conflictGate.allow) {
    return NextResponse.json({ error: conflictGate.error, conflicts }, { status: conflictGate.status })
  }

  const created = await prisma.$transaction(async (tx) => {
    const data = {
      jobId,
      userId: worker.id,
      workerType: workerType as never,
      role: (d.role ?? (workerType === 'OWNER' ? 'OWNER_OPERATOR' : 'CREW_MEMBER')) as never,
      assignmentStatus: 'ASSIGNED' as never,
      crewLeader: d.role === 'CREW_LEADER',
      payModel: snapshot.payModel as never,
      hourlyRateCentsSnapshot: snapshot.hourlyRateCentsSnapshot,
      overtimeRateCentsSnapshot: snapshot.overtimeRateCentsSnapshot,
      flatPayCentsSnapshot: snapshot.flatPayCentsSnapshot,
      dayRateCentsSnapshot: snapshot.dayRateCentsSnapshot,
      travelRateCentsSnapshot: snapshot.travelRateCentsSnapshot,
      economicRateCentsSnapshot: snapshot.economicRateCentsSnapshot,
      rateSnapshotAt: new Date(),
      rateSnapshotSource: snapshot.rateSnapshotSource,
      travelPayPolicy: (d.travelPayPolicy ?? 'REGULAR') as never,
      scheduledStartAt,
      scheduledEndAt,
      scheduledBreakMinutes: d.scheduledBreakMinutes ?? null,
      scheduledMinutes:
        scheduledStartAt && scheduledEndAt
          ? Math.max(0, Math.round((scheduledEndAt.getTime() - scheduledStartAt.getTime()) / 60_000) - (d.scheduledBreakMinutes ?? 0))
          : null,
      driverBonusCentsSnapshot: d.driverBonusCents ?? null,
      crewLeaderBonusCentsSnapshot: d.crewLeaderBonusCents ?? null,
      assignmentNotes: d.assignmentNotes || null,
      // Stage 5: explicit driver designation + report time + worker-visible note.
      isDriver: d.isDriver ?? (d.role === 'DRIVER'),
      reportTime: d.reportTime ? new Date(d.reportTime) : null,
      workerVisibleNotes: d.workerVisibleNotes ?? null,
      privateAdminNotes: d.privateAdminNotes ?? null,
      approvalStatus: 'DRAFT' as never,
      paymentStatus: 'UNPAID' as never,
      createdById: session.userId,
      createdByName: session.name,
      sourceSystem: 'admin',
    }

    // A previously cancelled/declined row is REVIVED rather than duplicated —
    // the unique (jobId,userId) index means there can only ever be one.
    const row = existing
      ? await tx.jobCrew.update({ where: { id: existing.id }, data: { ...data, cancelledAt: null, cancelReason: null, declinedAt: null } })
      : await tx.jobCrew.create({ data })

    // Record every override the owner supplied, tied to the finding it waived.
    for (const code of d.overrideCodes ?? []) {
      const found = conflicts.find((c) => c.code === code)
      if (!found) continue // an override for a conflict that was not raised is ignored, not stored
      await tx.conflictOverride.create({
        data: { jobId, jobCrewId: row.id, userId: worker.id, code, details: (found.detail ?? {}) as never, reason: d.overrideReason ?? '', overriddenById: session.userId },
      })
      await tx.auditLog.create({
        data: { action: 'CONFLICT_OVERRIDDEN', userId: session.userId, bookingId: booking.id, details: { jobCrewId: row.id, code, reason: d.overrideReason ?? null, by: session.name } as never },
      })
    }

    await tx.auditLog.create({
      data: {
        action: 'CREW_ASSIGNED',
        userId: session.userId,
        bookingId: booking.id,
        details: {
          jobCrewId: row.id,
          worker: worker.name,
          workerType,
          role: data.role,
          payModel: snapshot.payModel,
          rateSnapshot: {
            hourlyCents: snapshot.hourlyRateCentsSnapshot,
            flatCents: snapshot.flatPayCentsSnapshot,
            dayRateCents: snapshot.dayRateCentsSnapshot,
            economicCents: snapshot.economicRateCentsSnapshot,
            source: snapshot.rateSnapshotSource,
          },
          revivedFrom: existing?.assignmentStatus ?? null,
          by: session.name,
        },
      },
    })
    return row
  })

  await recalcAssignment(created.id)
  // The worker is told about a NEW assignment exactly once (idempotent ledger;
  // a revive of the same row reuses the same dedupe key and stays silent).
  await scheduleAssignmentNotification({ jobCrewId: created.id, type: 'ASSIGNED' }).catch(() => {})
  apiLogger.info({ jobCrewId: created.id, bookingId: booking.id, worker: worker.name }, 'Crew assigned')
  return NextResponse.json(created, { status: 201 })
}
