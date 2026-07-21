// ============================================================================
// scheduling-service.ts — the Prisma bridge for staffing and conflicts.
//
// Composes the pure engines (conflict-engine, staffing-health, availability-
// service, assignment-lifecycle) over real rows. This is where JobCrew — the
// canonical assignment record — is read for scheduling, so Stage 4 keeps seeing
// exactly the same labor it always did.
// ============================================================================

import { prisma } from './db'
import { isLiveStatus, isAcknowledged } from './assignment-lifecycle'
import {
  detectAssignmentConflicts, detectJobStaffingConflicts,
  type Conflict, type AssignmentConflictContext,
} from './conflict-engine'
import { computeStaffingHealth, type StaffingHealthResult } from './staffing-health'
import { evaluateWorkerForWindow } from './availability-service'

/** Statuses excluded from "live" for staffing + labor. */
const DEAD = ['CANCELLED', 'DECLINED', 'NO_SHOW']

/** Can a pay rate be resolved for this assignment row? Mirrors the closeout's
 *  MISSING_RATE logic so scheduling warns about what will later hard-block. */
export function rateResolvableOf(row: {
  workerType: string
  payModel: string
  hourlyRateCentsSnapshot: number | null
  flatPayCentsSnapshot: number | null
  dayRateCentsSnapshot: number | null
  economicRateCentsSnapshot: number | null
  user?: { payRate: number | null } | null
}): boolean {
  if (['UNPAID_OWNER', 'ZERO_CONFIRMED', 'CUSTOM'].includes(row.payModel)) return true
  if (row.workerType === 'OWNER') return row.economicRateCentsSnapshot != null
  return (
    row.hourlyRateCentsSnapshot != null ||
    row.flatPayCentsSnapshot != null ||
    row.dayRateCentsSnapshot != null ||
    row.user?.payRate != null
  )
}

const CREW_SELECT = {
  id: true, userId: true, workerType: true, role: true, assignmentStatus: true,
  crewLeader: true, isDriver: true, reportTime: true, acknowledgedAt: true,
  acknowledgmentStaleAt: true, scheduledStartAt: true, scheduledEndAt: true,
  payModel: true, hourlyRateCentsSnapshot: true, flatPayCentsSnapshot: true,
  dayRateCentsSnapshot: true, economicRateCentsSnapshot: true, workedMinutes: true,
  paidMinutes: true, approvalStatus: true,
  user: { select: { id: true, name: true, skills: true, canDrive: true, canLeadCrew: true, workerStatus: true, active: true, payRate: true } },
} as const

export interface StaffingContext {
  jobId: string
  bookingId: string
  jobStatus: string
  requirement: {
    minWorkers: number; requiredWorkers: number; preferredWorkers: number | null
    requiredDrivers: number; requiresLead: boolean; requiredSkills: string[]
    estimatedStartAt: Date | null; estimatedEndAt: Date | null; reportTime: Date | null
    loadingLocation: string | null; unloadingLocation: string | null
    workerInstructions: string | null; privateNotes: string | null
    hasStairs: boolean; hasElevator: boolean; longCarry: boolean; heavyItems: boolean
    packing: boolean; assembly: boolean; drivingRequired: boolean; outOfState: boolean
    customerProvidedTruck: boolean; rentalTruckPickup: boolean; additionalStops: number
    expectedBreakMinutes: number | null
  } | null
  assignments: {
    id: string; userId: string; name: string; workerType: string; role: string
    status: string; isDriver: boolean; isLead: boolean; acknowledged: boolean
    reportTime: Date | null; scheduledStartAt: Date | null; scheduledEndAt: Date | null
    rateResolvable: boolean; workedMinutes: number | null; approvalStatus: string
    skills: string[]
  }[]
  conflicts: Conflict[]
  health: StaffingHealthResult
}

/** The full staffing picture for one job — powers the job staffing panel. */
export async function buildStaffingContext(jobId: string): Promise<StaffingContext | null> {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: {
      id: true, bookingId: true, status: true,
      staffingReq: true,
      crew: { select: CREW_SELECT, orderBy: { assignedAt: 'asc' } },
    },
  })
  if (!job) return null

  const assignments = job.crew.map((c) => ({
    id: c.id,
    userId: c.userId,
    name: c.user?.name ?? 'Unknown',
    workerType: String(c.workerType),
    role: String(c.role),
    status: String(c.assignmentStatus),
    isDriver: c.isDriver,
    isLead: c.crewLeader,
    acknowledged: isAcknowledged(String(c.assignmentStatus), c.acknowledgedAt, c.acknowledgmentStaleAt),
    reportTime: c.reportTime,
    scheduledStartAt: c.scheduledStartAt,
    scheduledEndAt: c.scheduledEndAt,
    rateResolvable: rateResolvableOf(c),
    workedMinutes: c.workedMinutes,
    approvalStatus: String(c.approvalStatus),
    skills: (c.user?.skills ?? []).map(String),
  }))

  const req = job.staffingReq
  const requirement = req
    ? {
        minWorkers: req.minWorkers, requiredWorkers: req.requiredWorkers, preferredWorkers: req.preferredWorkers,
        requiredDrivers: req.requiredDrivers, requiresLead: req.requiresLead, requiredSkills: req.requiredSkills.map(String),
        estimatedStartAt: req.estimatedStartAt, estimatedEndAt: req.estimatedEndAt, reportTime: req.reportTime,
        loadingLocation: req.loadingLocation, unloadingLocation: req.unloadingLocation,
        workerInstructions: req.workerInstructions, privateNotes: req.privateNotes,
        hasStairs: req.hasStairs, hasElevator: req.hasElevator, longCarry: req.longCarry, heavyItems: req.heavyItems,
        packing: req.packing, assembly: req.assembly, drivingRequired: req.drivingRequired, outOfState: req.outOfState,
        customerProvidedTruck: req.customerProvidedTruck, rentalTruckPickup: req.rentalTruckPickup,
        additionalStops: req.additionalStops, expectedBreakMinutes: req.expectedBreakMinutes,
      }
    : null

  const conflicts = detectJobStaffingConflicts({
    requirement: requirement
      ? { minWorkers: requirement.minWorkers, requiredWorkers: requirement.requiredWorkers, requiredDrivers: requirement.requiredDrivers, requiresLead: requirement.requiresLead, requiredSkills: requirement.requiredSkills }
      : null,
    assigned: assignments.map((a) => ({ isDriver: a.isDriver, isLead: a.isLead, skills: a.skills, live: isLiveStatus(a.status), acknowledged: a.acknowledged })),
    jobStatus: String(job.status),
  })

  const health = computeStaffingHealth({
    requirement: requirement
      ? { minWorkers: requirement.minWorkers, requiredWorkers: requirement.requiredWorkers, requiredDrivers: requirement.requiredDrivers, requiresLead: requirement.requiresLead, requiredSkills: requirement.requiredSkills }
      : null,
    assigned: assignments.map((a) => ({ isDriver: a.isDriver, isLead: a.isLead, skills: a.skills, live: isLiveStatus(a.status), acknowledged: a.acknowledged })),
    conflicts,
  })

  return {
    jobId: job.id, bookingId: job.bookingId, jobStatus: String(job.status),
    requirement, assignments, conflicts, health,
  }
}

export interface BoardJob {
  jobId: string
  bookingId: string
  bookingReference: string | null
  customerName: string
  status: string
  scheduledStart: Date | null
  scheduledEnd: Date | null
  originCity: string | null
  destCity: string | null
  requiredWorkers: number
  liveCount: number
  driverCount: number
  requiredDrivers: number
  leadCount: number
  requiresLead: boolean
  unacknowledged: number
  health: string
  healthTone: string
}

/**
 * The scheduling board for a date range. One query for the jobs + their staffing
 * requirement + live crew, summarized per job for the board views. Excludes
 * internal-test bookings — the board is real operations.
 */
export async function loadSchedulingBoard(i: { start: Date; end: Date }): Promise<{ jobs: BoardJob[] }> {
  const { computeStaffingHealth } = await import('./staffing-health')
  const { staffingHealthTone, STAFFING_HEALTH_LABEL } = await import('./staffing-health')
  const bookings = await prisma.booking.findMany({
    where: {
      isInternalTest: false,
      status: { in: ['CONFIRMED', 'IN_PROGRESS', 'COMPLETED'] as never },
      OR: [
        { scheduledStart: { gte: i.start, lte: i.end } },
        { confirmedDate: { gte: i.start, lte: i.end } },
      ],
      job: { isNot: null },
    },
    select: {
      id: true, bookingReference: true, status: true, scheduledStart: true, scheduledEnd: true,
      originCity: true, destCity: true, customer: { select: { name: true } },
      job: {
        select: {
          id: true, status: true, staffingReq: true,
          crew: { select: { assignmentStatus: true, isDriver: true, crewLeader: true, acknowledgedAt: true, acknowledgmentStaleAt: true, user: { select: { skills: true } } } },
        },
      },
    },
    orderBy: { scheduledStart: 'asc' },
    take: 500,
  })

  const jobs: BoardJob[] = []
  for (const b of bookings) {
    if (!b.job) continue
    const req = b.job.staffingReq
    const assigned = b.job.crew.map((c) => ({
      isDriver: c.isDriver, isLead: c.crewLeader, skills: (c.user?.skills ?? []).map(String),
      live: isLiveStatus(String(c.assignmentStatus)),
      acknowledged: isAcknowledged(String(c.assignmentStatus), c.acknowledgedAt, c.acknowledgmentStaleAt),
    }))
    const live = assigned.filter((a) => a.live)
    const conflicts = detectJobStaffingConflicts({
      requirement: req ? { minWorkers: req.minWorkers, requiredWorkers: req.requiredWorkers, requiredDrivers: req.requiredDrivers, requiresLead: req.requiresLead, requiredSkills: req.requiredSkills.map(String) } : null,
      assigned, jobStatus: String(b.job.status),
    })
    const health = computeStaffingHealth({
      requirement: req ? { minWorkers: req.minWorkers, requiredWorkers: req.requiredWorkers, requiredDrivers: req.requiredDrivers, requiresLead: req.requiresLead, requiredSkills: req.requiredSkills.map(String) } : null,
      assigned, conflicts,
    })
    jobs.push({
      jobId: b.job.id, bookingId: b.id, bookingReference: b.bookingReference, customerName: b.customer.name,
      status: String(b.job.status), scheduledStart: b.scheduledStart, scheduledEnd: b.scheduledEnd,
      originCity: b.originCity, destCity: b.destCity,
      requiredWorkers: req?.requiredWorkers ?? 0, liveCount: live.length,
      driverCount: live.filter((a) => a.isDriver).length, requiredDrivers: req?.requiredDrivers ?? 0,
      leadCount: live.filter((a) => a.isLead).length, requiresLead: req?.requiresLead ?? false,
      unacknowledged: live.filter((a) => !a.acknowledged).length,
      health: STAFFING_HEALTH_LABEL[health.status], healthTone: staffingHealthTone(health.status),
    })
  }
  return { jobs }
}

/**
 * Preview every conflict for putting ONE worker on ONE job, without saving.
 * Runs availability + the assignment conflict engine over live data.
 */
export async function previewAssignmentConflicts(i: {
  jobId: string
  userId: string
  startAt?: Date | null
  endAt?: Date | null
  reportTime?: Date | null
  isDriver: boolean
  isLead: boolean
  breakMinutes?: number | null
  excludeJobCrewId?: string | null
}): Promise<Conflict[]> {
  const [job, worker] = await Promise.all([
    prisma.job.findUnique({
      where: { id: i.jobId },
      select: {
        status: true,
        booking: { select: { originAddress: true, destAddress: true, scheduledStart: true, scheduledEnd: true } },
      },
    }),
    prisma.user.findUnique({
      where: { id: i.userId },
      select: { active: true, workerStatus: true, canDrive: true, canLeadCrew: true, licenseExpiresAt: true, skills: true, payRate: true },
    }),
  ])
  if (!job || !worker) return []

  const start = i.startAt ?? job.booking?.scheduledStart ?? null
  const end = i.endAt ?? job.booking?.scheduledEnd ?? null

  // Availability (only when we have a real window to check).
  let availability: AssignmentConflictContext['availability'] = null
  if (start && end) {
    const a = await evaluateWorkerForWindow(i.userId, start, end)
    availability = { available: a.available, tier: a.tier, reason: a.reason, hardBlock: a.hardBlock }
  }

  // Other live shifts for this worker (overlap + travel).
  const others = await prisma.jobCrew.findMany({
    where: {
      userId: i.userId,
      id: i.excludeJobCrewId ? { not: i.excludeJobCrewId } : undefined,
      assignmentStatus: { notIn: DEAD as never },
      job: { bookingId: { not: undefined } },
    },
    select: {
      job: { select: { id: true, booking: { select: { originAddress: true, scheduledStart: true, scheduledEnd: true } } } },
      scheduledStartAt: true, scheduledEndAt: true,
    },
    take: 50,
  })

  // Already assigned to THIS job (live)?
  const existing = await prisma.jobCrew.count({
    where: { jobId: i.jobId, userId: i.userId, id: i.excludeJobCrewId ? { not: i.excludeJobCrewId } : undefined, assignmentStatus: { notIn: DEAD as never } },
  })

  return detectAssignmentConflicts({
    worker: {
      active: worker.active,
      workerStatus: String(worker.workerStatus),
      isDriverEligible: worker.canDrive,
      isLeadEligible: worker.canLeadCrew,
      licenseExpiresAt: worker.licenseExpiresAt,
      skills: (worker.skills ?? []).map(String),
      rateResolvable: worker.payRate != null || worker.workerStatus === 'ACTIVE', // resolved precisely at assignment; preview is lenient
    },
    assignment: {
      jobId: i.jobId, startAt: start, endAt: end, reportTime: i.reportTime, breakMinutes: i.breakMinutes,
      isDriver: i.isDriver, isLead: i.isLead,
      originAddress: job.booking?.originAddress, destAddress: job.booking?.destAddress,
    },
    jobStatus: String(job.status),
    jobWindowStartAt: job.booking?.scheduledStart,
    jobWindowEndAt: job.booking?.scheduledEnd,
    availability,
    otherShifts: others.map((o) => ({
      jobId: o.job?.id ?? '',
      startAt: o.scheduledStartAt ?? o.job?.booking?.scheduledStart,
      endAt: o.scheduledEndAt ?? o.job?.booking?.scheduledEnd,
      originAddress: o.job?.booking?.originAddress,
    })),
    alreadyAssigned: existing > 0,
  })
}
