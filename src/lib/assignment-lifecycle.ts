// ============================================================================
// assignment-lifecycle.ts — the valid states of a JobCrew assignment (Stage 5).
//
// PURE. Uses the EXISTING CrewAssignmentStatus enum — Stage 5 does not add a
// competing lifecycle. It defines which transitions are legal and detects when a
// material schedule change must invalidate a worker's acknowledgment.
//
// The brief's suggested DRAFT/OFFERED/CONFIRMED/DECLINED/CANCELLED/COMPLETED/
// NO_SHOW maps onto the repository's vocabulary: ASSIGNED is "confirmed",
// ACCEPTED is "acknowledged after an offer", INVITED/OFFERED are the two
// pre-acknowledgment states.
// ============================================================================

export type AssignmentStatus =
  | 'INVITED' | 'OFFERED' | 'ACCEPTED' | 'DECLINED' | 'ASSIGNED'
  | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED' | 'NO_SHOW'

/** Legal next states. A terminal state has an empty set. */
const TRANSITIONS: Record<AssignmentStatus, AssignmentStatus[]> = {
  INVITED: ['OFFERED', 'ASSIGNED', 'CANCELLED', 'DECLINED'],
  OFFERED: ['ACCEPTED', 'DECLINED', 'ASSIGNED', 'CANCELLED'],
  ACCEPTED: ['ASSIGNED', 'IN_PROGRESS', 'CANCELLED', 'NO_SHOW', 'DECLINED'],
  ASSIGNED: ['IN_PROGRESS', 'CANCELLED', 'NO_SHOW', 'COMPLETED'],
  IN_PROGRESS: ['COMPLETED', 'CANCELLED', 'NO_SHOW'],
  COMPLETED: [], // terminal
  DECLINED: ['OFFERED', 'ASSIGNED'], // may be re-offered / directly re-assigned
  CANCELLED: ['OFFERED', 'ASSIGNED'], // may be re-opened onto the same worker
  NO_SHOW: [], // terminal — a no-show is a record, corrected only by an owner edit
}

export function canTransition(from: AssignmentStatus, to: AssignmentStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false
}

export interface TransitionDecision {
  allow: boolean
  error?: string
}

export function evaluateTransition(from: AssignmentStatus, to: AssignmentStatus): TransitionDecision {
  if (from === to) return { allow: false, error: `The assignment is already ${to.toLowerCase().replace(/_/g, ' ')}.` }
  if (!canTransition(from, to)) {
    return { allow: false, error: `An assignment cannot move from ${from} to ${to}.` }
  }
  return { allow: true }
}

/** Statuses that count as a LIVE assignment for staffing + conflict + labor. */
export const LIVE_STATUSES: AssignmentStatus[] = ['INVITED', 'OFFERED', 'ACCEPTED', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED']
export const isLiveStatus = (s: string): boolean => (LIVE_STATUSES as string[]).includes(s)

/** Statuses in which the worker has acknowledged (accepted the work). */
export const isAcknowledged = (s: string, acknowledgedAt?: Date | null, staleAt?: Date | null): boolean => {
  if (staleAt) return false // a material change reset it
  return s === 'ACCEPTED' || (!!acknowledgedAt && (s === 'ASSIGNED' || s === 'IN_PROGRESS' || s === 'COMPLETED'))
}

// ── Material-change detection ────────────────────────────────────────────────

export interface ScheduleShape {
  startAt?: Date | string | null
  endAt?: Date | string | null
  reportTime?: Date | string | null
  originAddress?: string | null
  destAddress?: string | null
  role?: string | null
  isDriver?: boolean
  isLead?: boolean
}

const val = (v: Date | string | null | undefined): string => {
  if (v == null) return ''
  const t = v instanceof Date ? v.getTime() : Date.parse(String(v))
  return Number.isFinite(t) ? String(t) : String(v)
}

/**
 * Did a change to an assignment materially alter what the worker acknowledged?
 *
 * Time, report time, either address, the role and the driver/lead designation
 * are material — a worker who accepted an 8am two-person load did not accept a
 * 6am solo drive. Notes and private fields are not material.
 */
export function isMaterialChange(before: ScheduleShape, after: ScheduleShape): boolean {
  return (
    val(before.startAt) !== val(after.startAt) ||
    val(before.endAt) !== val(after.endAt) ||
    val(before.reportTime) !== val(after.reportTime) ||
    (before.originAddress ?? '') !== (after.originAddress ?? '') ||
    (before.destAddress ?? '') !== (after.destAddress ?? '') ||
    (before.role ?? '') !== (after.role ?? '') ||
    !!before.isDriver !== !!after.isDriver ||
    !!before.isLead !== !!after.isLead
  )
}

/** What changed, for the audit entry and the re-acknowledgment message. */
export function describeChanges(before: ScheduleShape, after: ScheduleShape): string[] {
  const out: string[] = []
  if (val(before.startAt) !== val(after.startAt)) out.push('start time')
  if (val(before.endAt) !== val(after.endAt)) out.push('end time')
  if (val(before.reportTime) !== val(after.reportTime)) out.push('report time')
  if ((before.originAddress ?? '') !== (after.originAddress ?? '')) out.push('pickup location')
  if ((before.destAddress ?? '') !== (after.destAddress ?? '')) out.push('drop-off location')
  if ((before.role ?? '') !== (after.role ?? '')) out.push('role')
  if (!!before.isDriver !== !!after.isDriver) out.push('driver designation')
  if (!!before.isLead !== !!after.isLead) out.push('lead designation')
  return out
}
