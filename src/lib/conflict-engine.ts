// ============================================================================
// conflict-engine.ts — every reason a worker should not be on a job (Stage 5).
//
// PURE and SERVER-SIDE. Every scheduling mutation calls this; the UI never
// decides. It returns a list of coded findings with a severity, in the same
// shape as closeout-blockers.ts, plus a guard that decides whether a set of
// findings permits saving given the overrides already recorded.
//
// THREE SEVERITIES, and the distinction is the whole design:
//   HARD_BLOCK         — physically or contractually impossible; no override.
//   OVERRIDABLE_WARNING — a judgement call an owner may make and DOCUMENT.
//   INFORMATIONAL       — worth showing; never blocks and never needs an override.
//
// TRAVEL TIME IS ESTIMATED. There is no routing provider wired in. The buffer
// check uses a configured minute buffer and an address-equality short-circuit,
// and every finding it raises says "estimated". It never claims a real drive
// time it cannot compute.
// ============================================================================

export type ConflictSeverity = 'HARD_BLOCK' | 'OVERRIDABLE_WARNING' | 'INFORMATIONAL'

export interface Conflict {
  code: string
  severity: ConflictSeverity
  message: string
  /** Structured context stored on an override so the finding is reconstructable. */
  detail?: Record<string, unknown>
}

const C = (code: string, severity: ConflictSeverity, message: string, detail?: Record<string, unknown>): Conflict =>
  ({ code, severity, message, ...(detail ? { detail } : {}) })

const ms = (v: Date | string | number | null | undefined): number | null => {
  if (v == null) return null
  const t = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(v)
  return Number.isFinite(t) ? t : null
}
const minutesBetween = (a: number, b: number): number => Math.round((b - a) / 60000)

export interface ConflictPolicy {
  /** Minimum gap between a worker's previous job ending and the next report
   *  time, when the addresses differ. Estimated — no routing. Default 60. */
  travelBufferMinutes: number
  /** Same buffer when both addresses are identical. Default 15. */
  sameAddressBufferMinutes: number
  /** A planned shift longer than this raises EXCESSIVE_SHIFT. Default 840 (14h). */
  maxShiftMinutes: number
  /** Below this many break-minutes for a shift over 6h raises INSUFFICIENT_BREAK. */
  minBreakMinutes: number
  /** Assigned workers beyond required + this raises OVERSTAFFING. Default 1. */
  overstaffTolerance: number
}

export const DEFAULT_CONFLICT_POLICY: ConflictPolicy = {
  travelBufferMinutes: 60,
  sameAddressBufferMinutes: 15,
  maxShiftMinutes: 840,
  minBreakMinutes: 30,
  overstaffTolerance: 1,
}

// ── Per-assignment conflicts ────────────────────────────────────────────────

export interface WorkerSnapshotForConflict {
  active: boolean
  workerStatus: string // WorkerStatus
  isDriverEligible: boolean // canDrive
  isLeadEligible: boolean // canLeadCrew
  licenseExpiresAt?: Date | string | null
  skills: string[]
  /** True when a pay rate can actually be resolved for this assignment. */
  rateResolvable: boolean
}

export interface AssignmentUnderTest {
  jobId: string
  startAt?: Date | string | null
  endAt?: Date | string | null
  reportTime?: Date | string | null
  breakMinutes?: number | null
  isDriver: boolean
  isLead: boolean
  originAddress?: string | null
  destAddress?: string | null
}

export interface OtherShift {
  jobId: string
  startAt?: Date | string | null
  endAt?: Date | string | null
  reportTime?: Date | string | null
  originAddress?: string | null
}

export interface AckState {
  acknowledgedAt?: Date | string | null
  /** The material fields changed since the worker acknowledged. */
  scheduleChangedSinceAck?: boolean
  requirementsChangedSinceAck?: boolean
}

export interface AssignmentConflictContext {
  worker: WorkerSnapshotForConflict
  assignment: AssignmentUnderTest
  jobStatus: string // JobStatus
  jobWindowStartAt?: Date | string | null
  jobWindowEndAt?: Date | string | null
  /** Availability decision from availability-engine, or null when not evaluated. */
  availability?: { available: boolean; tier: string; reason: string; hardBlock: boolean } | null
  otherShifts: OtherShift[]
  ack?: AckState | null
  /** True when this worker already has a LIVE assignment on this job. */
  alreadyAssigned?: boolean
  policy?: Partial<ConflictPolicy>
}

const normAddr = (s?: string | null): string => (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ')

/** Every conflict for ONE worker on ONE job, most severe first. */
export function detectAssignmentConflicts(ctx: AssignmentConflictContext): Conflict[] {
  const p = { ...DEFAULT_CONFLICT_POLICY, ...(ctx.policy ?? {}) }
  const out: Conflict[] = []
  const a = ctx.assignment
  const start = ms(a.startAt)
  const end = ms(a.endAt)

  // ── HARD blocks ──
  if (ctx.jobStatus === 'CANCELLED') {
    out.push(C('ASSIGNMENT_ON_CANCELLED_JOB', 'HARD_BLOCK', 'This job is cancelled — no one can be assigned to it.'))
  }
  if (!ctx.worker.active || ctx.worker.workerStatus === 'INACTIVE') {
    out.push(C('INACTIVE_WORKER', 'HARD_BLOCK', 'This worker is deactivated and cannot take new assignments.'))
  }
  if (ctx.worker.workerStatus === 'SUSPENDED') {
    out.push(C('SUSPENDED_WORKER', 'HARD_BLOCK', 'This worker is suspended and cannot be scheduled.'))
  }
  if (ctx.alreadyAssigned) {
    out.push(C('DUPLICATE_ASSIGNMENT', 'HARD_BLOCK', 'This worker is already assigned to this job.'))
  }
  if (start != null && end != null && end <= start) {
    out.push(C('START_AFTER_END', 'HARD_BLOCK', 'The assignment ends before it starts.'))
  }
  if (a.isDriver) {
    if (!ctx.worker.isDriverEligible) {
      out.push(C('INELIGIBLE_DRIVER', 'HARD_BLOCK', 'This worker is not marked as an eligible driver.'))
    }
    const lic = ms(ctx.worker.licenseExpiresAt)
    if (lic != null && start != null && lic < start) {
      out.push(C('EXPIRED_LICENSE', 'HARD_BLOCK', "This driver's license expires before the job.", { licenseExpiresAt: ctx.worker.licenseExpiresAt }))
    }
  }

  // ── Overridable warnings ──
  if (ctx.availability && !ctx.availability.available && !ctx.availability.hardBlock) {
    const code = ctx.availability.tier === 'DATE_UNAVAILABLE' ? 'DATE_UNAVAILABLE'
      : ctx.availability.tier === 'RECURRING' ? 'OUTSIDE_AVAILABILITY'
        : 'OUTSIDE_AVAILABILITY'
    out.push(C(code, 'OVERRIDABLE_WARNING', ctx.availability.reason, { tier: ctx.availability.tier }))
  }
  if (ctx.availability?.hardBlock) {
    out.push(C('ADMIN_UNAVAILABLE', 'HARD_BLOCK', ctx.availability.reason))
  }
  if (!ctx.worker.rateResolvable) {
    out.push(C('MISSING_RATE', 'OVERRIDABLE_WARNING', 'No pay rate can be resolved for this worker — it must be set before the move is closed out.'))
  }
  if (start != null && end != null) {
    const shift = minutesBetween(start, end)
    if (shift > p.maxShiftMinutes) {
      out.push(C('EXCESSIVE_SHIFT', 'OVERRIDABLE_WARNING', `Planned shift of ${(shift / 60).toFixed(1)}h exceeds the ${(p.maxShiftMinutes / 60).toFixed(0)}h limit.`, { shiftMinutes: shift }))
    }
    if (shift > 360 && (a.breakMinutes ?? 0) < p.minBreakMinutes) {
      out.push(C('INSUFFICIENT_BREAK', 'OVERRIDABLE_WARNING', `A ${(shift / 60).toFixed(1)}h shift has less than ${p.minBreakMinutes} min of break planned.`, { breakMinutes: a.breakMinutes ?? 0 }))
    }
  }
  const jw0 = ms(ctx.jobWindowStartAt)
  const jw1 = ms(ctx.jobWindowEndAt)
  if (jw0 != null && jw1 != null && start != null && end != null && (start < jw0 || end > jw1)) {
    out.push(C('ASSIGNMENT_OUTSIDE_JOB_WINDOW', 'OVERRIDABLE_WARNING', 'The assignment falls outside the job window.'))
  }

  // Overlap + travel buffer against the worker's other shifts.
  for (const other of ctx.otherShifts) {
    const os = ms(other.startAt)
    const oe = ms(other.endAt)
    if (start != null && end != null && os != null && oe != null && start < oe && os < end) {
      out.push(C('OVERLAPPING_ASSIGNMENT', 'OVERRIDABLE_WARNING', 'This worker is already assigned to another job that overlaps this one.', { otherJobId: other.jobId }))
      continue
    }
    // Travel buffer — ESTIMATED. Previous job ends, this one starts (report time
    // preferred). No routing: a configured buffer, halved when the addresses match.
    // Only a shift that actually PRECEDES this one can be a "previous job" — a
    // Thursday booking is not a late predecessor of a Monday assignment.
    // (2026-07 staging rehearsal regression: any later-week shift used to spam
    // PREVIOUS_JOB_ENDS_LATE because only end-vs-report-time was compared.)
    const prevEnd = oe
    const nextStart = ms(a.reportTime) ?? start
    const thisStart = start ?? nextStart
    const precedes = os != null && thisStart != null && os < thisStart
    if (precedes && prevEnd != null && nextStart != null && prevEnd <= nextStart) {
      const gap = minutesBetween(prevEnd, nextStart)
      const sameAddr = normAddr(other.originAddress) && normAddr(other.originAddress) === normAddr(a.originAddress)
      const needed = sameAddr ? p.sameAddressBufferMinutes : p.travelBufferMinutes
      if (gap < needed) {
        out.push(C('INSUFFICIENT_TRAVEL_BUFFER', 'OVERRIDABLE_WARNING', `Only ${gap} min between the previous job and this report time (estimated ${needed} min needed). Travel time is estimated — there is no routing provider.`, { gapMinutes: gap, neededMinutes: needed, estimated: true, otherJobId: other.jobId }))
      }
    }
    // Previous job ending after this report time is a stronger phrasing of the same risk.
    if (precedes && prevEnd != null && nextStart != null && prevEnd > nextStart) {
      out.push(C('PREVIOUS_JOB_ENDS_LATE', 'OVERRIDABLE_WARNING', 'A previous job for this worker ends after this report time.', { otherJobId: other.jobId }))
    }
  }

  // ── Informational (acknowledgment drift) ──
  if (ctx.ack?.acknowledgedAt) {
    if (ctx.ack.scheduleChangedSinceAck) {
      out.push(C('TIME_CHANGED_AFTER_ACK', 'OVERRIDABLE_WARNING', 'The schedule changed after the worker acknowledged — re-acknowledgment is required.'))
    }
    if (ctx.ack.requirementsChangedSinceAck) {
      out.push(C('REQUIREMENTS_CHANGED_AFTER_ACK', 'INFORMATIONAL', 'Job requirements changed after the worker acknowledged.'))
    }
  }

  return sortBySeverity(out)
}

// ── Job-level staffing conflicts ────────────────────────────────────────────

export interface StaffingRequirementSnapshot {
  minWorkers: number
  requiredWorkers: number
  requiredDrivers: number
  requiresLead: boolean
  requiredSkills: string[]
}

export interface AssignedWorkerSnapshot {
  isDriver: boolean
  isLead: boolean
  skills: string[]
  live: boolean // not cancelled/declined/removed/no-show
  acknowledged: boolean
}

export function detectJobStaffingConflicts(i: {
  requirement: StaffingRequirementSnapshot | null
  assigned: AssignedWorkerSnapshot[]
  jobStatus: string
  policy?: Partial<ConflictPolicy>
}): Conflict[] {
  const p = { ...DEFAULT_CONFLICT_POLICY, ...(i.policy ?? {}) }
  const out: Conflict[] = []
  if (!i.requirement) {
    out.push(C('NO_STAFFING_REQUIREMENT', 'INFORMATIONAL', 'This job has no staffing requirement defined yet.'))
    return out
  }
  const r = i.requirement
  const live = i.assigned.filter((a) => a.live)
  const drivers = live.filter((a) => a.isDriver).length
  const leads = live.filter((a) => a.isLead).length
  const unacked = live.filter((a) => !a.acknowledged).length
  const coveredSkills = new Set(live.flatMap((a) => a.skills))

  if (live.length < r.requiredWorkers) {
    out.push(C('UNDERSTAFFED', 'OVERRIDABLE_WARNING', `${live.length} of ${r.requiredWorkers} required workers assigned.`, { assigned: live.length, required: r.requiredWorkers }))
  }
  if (r.requiredDrivers > 0 && drivers < r.requiredDrivers) {
    out.push(C('MISSING_DRIVER', 'OVERRIDABLE_WARNING', `${drivers} of ${r.requiredDrivers} required drivers assigned.`, { drivers, required: r.requiredDrivers }))
  }
  if (r.requiresLead && leads === 0) {
    out.push(C('MISSING_LEAD', 'OVERRIDABLE_WARNING', 'No job lead is assigned.'))
  }
  for (const skill of r.requiredSkills) {
    if (!coveredSkills.has(skill)) {
      out.push(C('MISSING_SKILL', 'OVERRIDABLE_WARNING', `No assigned worker has the required skill: ${skill}.`, { skill }))
    }
  }
  if (live.length > r.requiredWorkers + p.overstaffTolerance) {
    out.push(C('OVERSTAFFING', 'OVERRIDABLE_WARNING', `${live.length} workers assigned for ${r.requiredWorkers} required.`, { assigned: live.length, required: r.requiredWorkers }))
  }
  if (unacked > 0) {
    out.push(C('UNACKNOWLEDGED', 'INFORMATIONAL', `${unacked} assigned worker${unacked === 1 ? '' : 's'} ${unacked === 1 ? 'has' : 'have'} not acknowledged.`, { unacked }))
  }
  return sortBySeverity(out)
}

// ── Deactivation gate ───────────────────────────────────────────────────────

/** Conflicts raised by trying to deactivate a worker who still has future work. */
export function detectDeactivationConflicts(i: { futureLiveAssignments: number }): Conflict[] {
  if (i.futureLiveAssignments > 0) {
    return [C('UNRESOLVED_FUTURE_ASSIGNMENT', 'HARD_BLOCK', `This worker has ${i.futureLiveAssignments} upcoming assignment${i.futureLiveAssignments === 1 ? '' : 's'} that must be cancelled or reassigned first.`, { count: i.futureLiveAssignments })]
  }
  return []
}

// ── Severity + override arithmetic ──────────────────────────────────────────

const RANK: Record<ConflictSeverity, number> = { HARD_BLOCK: 0, OVERRIDABLE_WARNING: 1, INFORMATIONAL: 2 }
export const sortBySeverity = (c: Conflict[]): Conflict[] => [...c].sort((a, b) => RANK[a.severity] - RANK[b.severity])

export const hardConflicts = (c: Conflict[]): Conflict[] => c.filter((x) => x.severity === 'HARD_BLOCK')
export const warningConflicts = (c: Conflict[]): Conflict[] => c.filter((x) => x.severity === 'OVERRIDABLE_WARNING')

export interface ConflictDecision {
  /** True when nothing hard blocks AND every warning has a recorded override. */
  canProceed: boolean
  hard: Conflict[]
  unresolvedWarnings: Conflict[]
  conflicts: Conflict[]
}

/**
 * Given the findings and the override codes already recorded, may the save
 * proceed? A HARD_BLOCK is never cleared by an override — that is what makes it
 * hard. An OVERRIDABLE_WARNING clears only when its code is in `overriddenCodes`.
 */
export function evaluateConflicts(conflicts: Conflict[], overriddenCodes: string[] = []): ConflictDecision {
  const overridden = new Set(overriddenCodes)
  const hard = hardConflicts(conflicts)
  const unresolvedWarnings = warningConflicts(conflicts).filter((w) => !overridden.has(w.code))
  return {
    canProceed: hard.length === 0 && unresolvedWarnings.length === 0,
    hard,
    unresolvedWarnings,
    conflicts: sortBySeverity(conflicts),
  }
}

/** Every conflict code, for documentation and tests. */
export const ALL_CONFLICT_CODES = [
  'ASSIGNMENT_ON_CANCELLED_JOB', 'INACTIVE_WORKER', 'SUSPENDED_WORKER', 'DUPLICATE_ASSIGNMENT',
  'START_AFTER_END', 'INELIGIBLE_DRIVER', 'EXPIRED_LICENSE', 'ADMIN_UNAVAILABLE',
  'OUTSIDE_AVAILABILITY', 'DATE_UNAVAILABLE', 'MISSING_RATE', 'EXCESSIVE_SHIFT',
  'INSUFFICIENT_BREAK', 'ASSIGNMENT_OUTSIDE_JOB_WINDOW', 'OVERLAPPING_ASSIGNMENT',
  'INSUFFICIENT_TRAVEL_BUFFER', 'PREVIOUS_JOB_ENDS_LATE', 'TIME_CHANGED_AFTER_ACK',
  'REQUIREMENTS_CHANGED_AFTER_ACK', 'NO_STAFFING_REQUIREMENT', 'UNDERSTAFFED',
  'MISSING_DRIVER', 'MISSING_LEAD', 'MISSING_SKILL', 'OVERSTAFFING', 'UNACKNOWLEDGED',
  'UNRESOLVED_FUTURE_ASSIGNMENT',
] as const
