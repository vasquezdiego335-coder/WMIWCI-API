// ============================================================================
// staffing-health.ts — the one headline word for a job's staffing (Stage 5).
//
// PURE. Consumes the conflict engine's output plus the assigned roster and
// returns a single status enum for the UI, with the supporting flags. The
// conflict engine owns the codes; this owns the summary, so the two never
// disagree.
// ============================================================================

import type { StaffingRequirementSnapshot, AssignedWorkerSnapshot, Conflict } from './conflict-engine'

export type StaffingHealth =
  | 'UNSTAFFED'
  | 'UNDERSTAFFED'
  | 'MISSING_DRIVER'
  | 'MISSING_LEAD'
  | 'MISSING_SKILL'
  | 'OVERSTAFFED'
  | 'UNACKNOWLEDGED'
  | 'CONFLICTED'
  | 'FULLY_STAFFED'
  | 'READY'

export interface StaffingHealthResult {
  status: StaffingHealth
  /** Every applicable flag, most severe first — the chips the UI shows. */
  flags: StaffingHealth[]
  liveCount: number
  requiredCount: number
  acknowledgedCount: number
  driverCount: number
  leadCount: number
}

/**
 * The single status word, by precedence (worst first). A job is READY only when
 * it is fully staffed, everyone has acknowledged, and nothing hard-blocks.
 */
export function computeStaffingHealth(i: {
  requirement: StaffingRequirementSnapshot | null
  assigned: AssignedWorkerSnapshot[]
  conflicts: Conflict[]
}): StaffingHealthResult {
  const live = i.assigned.filter((a) => a.live)
  const required = i.requirement?.requiredWorkers ?? 0
  const acknowledged = live.filter((a) => a.acknowledged).length
  const drivers = live.filter((a) => a.isDriver).length
  const leads = live.filter((a) => a.isLead).length
  const hasHard = i.conflicts.some((c) => c.severity === 'HARD_BLOCK')
  const codes = new Set(i.conflicts.map((c) => c.code))

  const flags: StaffingHealth[] = []
  if (hasHard) flags.push('CONFLICTED')
  if (live.length === 0) flags.push('UNSTAFFED')
  else if (i.requirement && live.length < required) flags.push('UNDERSTAFFED')
  if (codes.has('MISSING_DRIVER')) flags.push('MISSING_DRIVER')
  if (codes.has('MISSING_LEAD')) flags.push('MISSING_LEAD')
  if (codes.has('MISSING_SKILL')) flags.push('MISSING_SKILL')
  if (codes.has('OVERSTAFFING')) flags.push('OVERSTAFFED')
  if (acknowledged < live.length) flags.push('UNACKNOWLEDGED')

  let status: StaffingHealth
  if (hasHard) status = 'CONFLICTED'
  else if (live.length === 0) status = 'UNSTAFFED'
  else if (i.requirement && live.length < required) status = 'UNDERSTAFFED'
  else if (codes.has('MISSING_DRIVER')) status = 'MISSING_DRIVER'
  else if (codes.has('MISSING_LEAD')) status = 'MISSING_LEAD'
  else if (codes.has('MISSING_SKILL')) status = 'MISSING_SKILL'
  else if (codes.has('OVERSTAFFING')) status = 'OVERSTAFFED'
  else if (acknowledged < live.length) status = 'UNACKNOWLEDGED'
  else if (i.requirement && live.length >= required) status = 'READY'
  else status = 'FULLY_STAFFED'

  if (flags.length === 0) flags.push(status)

  return {
    status,
    flags,
    liveCount: live.length,
    requiredCount: required,
    acknowledgedCount: acknowledged,
    driverCount: drivers,
    leadCount: leads,
  }
}

export const STAFFING_HEALTH_LABEL: Record<StaffingHealth, string> = {
  UNSTAFFED: 'Unstaffed',
  UNDERSTAFFED: 'Understaffed',
  MISSING_DRIVER: 'Missing driver',
  MISSING_LEAD: 'Missing lead',
  MISSING_SKILL: 'Missing skill',
  OVERSTAFFED: 'Overstaffed',
  UNACKNOWLEDGED: 'Unacknowledged',
  CONFLICTED: 'Conflicted',
  FULLY_STAFFED: 'Fully staffed',
  READY: 'Ready',
}

/** The palette tone for a status — navy/gold/amber/red per the brand system. */
export function staffingHealthTone(status: StaffingHealth): string {
  switch (status) {
    case 'READY':
    case 'FULLY_STAFFED':
      return '#10B981'
    case 'OVERSTAFFED':
    case 'UNACKNOWLEDGED':
      return '#C9A961'
    case 'CONFLICTED':
    case 'UNSTAFFED':
      return '#EF4444'
    default:
      return '#F59E0B'
  }
}
