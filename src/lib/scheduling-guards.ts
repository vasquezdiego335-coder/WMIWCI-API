// ============================================================================
// scheduling-guards.ts — pure permission + state guards for Stage 5 mutations.
//
// Same shape as closeout-guards / labor-guards: a guard returns null-or-error as
// { allow, status, error }. Every scheduling route calls one, so a forged
// request cannot skip a check, and the rules are unit-testable without Prisma.
// ============================================================================

import { can, type Role } from './permissions'
import { evaluateTransition, type AssignmentStatus } from './assignment-lifecycle'
import { evaluateConflicts, type Conflict } from './conflict-engine'

export type GuardDecision = { allow: true } | { allow: false; status: 401 | 403 | 409 | 422; error: string }

/** May this role manage the schedule at all? */
export function canManageSchedule(role: Role | null | undefined): GuardDecision {
  if (!role) return { allow: false, status: 401, error: 'Authentication required.' }
  if (!can(role, 'schedule.manage')) return { allow: false, status: 403, error: 'You do not have permission to manage the schedule.' }
  return { allow: true }
}

/**
 * May this assignment be saved, given its conflicts and the overrides supplied?
 * A HARD_BLOCK is refused outright. An unresolved OVERRIDABLE_WARNING is refused
 * unless the caller both overrode it (with a reason) AND holds
 * schedule.override_conflicts.
 */
export function canSaveAssignment(ctx: {
  role: Role | null | undefined
  conflicts: Conflict[]
  overriddenCodes: string[]
  overrideReason?: string | null
}): GuardDecision {
  const base = canManageSchedule(ctx.role)
  if (!base.allow) return base

  const decision = evaluateConflicts(ctx.conflicts, ctx.overriddenCodes)
  if (decision.hard.length > 0) {
    return { allow: false, status: 422, error: `This cannot be scheduled: ${decision.hard.map((c) => c.message).join(' ')}` }
  }
  if (decision.unresolvedWarnings.length > 0) {
    return { allow: false, status: 422, error: `Resolve or override first: ${decision.unresolvedWarnings.map((c) => c.message).join(' ')}` }
  }
  // If anything was overridden, the actor must have the authority and a reason.
  if (ctx.overriddenCodes.length > 0) {
    if (!can(ctx.role, 'schedule.override_conflicts')) {
      return { allow: false, status: 403, error: 'Only an owner can override a scheduling warning.' }
    }
    if (!ctx.overrideReason?.trim()) {
      return { allow: false, status: 422, error: 'A written reason is required to override a scheduling warning.' }
    }
  }
  return { allow: true }
}

/** Validate a lifecycle transition initiated by staff. */
export function canChangeAssignmentStatus(ctx: {
  role: Role | null | undefined
  from: AssignmentStatus
  to: AssignmentStatus
}): GuardDecision {
  const base = canManageSchedule(ctx.role)
  if (!base.allow) return base
  const t = evaluateTransition(ctx.from, ctx.to)
  if (!t.allow) return { allow: false, status: 409, error: t.error! }
  return { allow: true }
}

/** A worker acknowledging or declining their OWN assignment. */
export function canActOnOwnAssignment(ctx: {
  role: Role | null | undefined
  isOwner: boolean // is this the worker's own row?
  action: 'acknowledge' | 'decline'
  reason?: string | null
}): GuardDecision {
  if (!ctx.role) return { allow: false, status: 401, error: 'Authentication required.' }
  if (!ctx.isOwner) return { allow: false, status: 403, error: 'You can only respond to your own assignments.' }
  if (!can(ctx.role, 'assignment.acknowledge_own')) return { allow: false, status: 403, error: 'You do not have permission to respond to assignments.' }
  if (ctx.action === 'decline' && !ctx.reason?.trim()) {
    return { allow: false, status: 422, error: 'Please give a reason for declining.' }
  }
  return { allow: true }
}

/** Deactivating a worker: owner authority + a reason + no unresolved future work. */
export function canDeactivateWorker(ctx: {
  role: Role | null | undefined
  reason?: string | null
  futureLiveAssignments: number
  resolveFutureWork: boolean
}): GuardDecision {
  if (!ctx.role) return { allow: false, status: 401, error: 'Authentication required.' }
  if (!can(ctx.role, 'staff.deactivate')) return { allow: false, status: 403, error: 'Only an owner can deactivate a worker.' }
  if (!ctx.reason?.trim()) return { allow: false, status: 422, error: 'A reason is required to deactivate a worker.' }
  if (ctx.futureLiveAssignments > 0 && !ctx.resolveFutureWork) {
    return {
      allow: false, status: 409,
      error: `This worker has ${ctx.futureLiveAssignments} upcoming assignment${ctx.futureLiveAssignments === 1 ? '' : 's'}. Cancel or reassign them first, or confirm resolving them now.`,
    }
  }
  return { allow: true }
}

/** Inviting a new crew member: owner authority; never grants OWNER by default. */
export function canInviteCrew(ctx: { role: Role | null | undefined; targetRole: string }): GuardDecision {
  if (!ctx.role) return { allow: false, status: 401, error: 'Authentication required.' }
  if (!can(ctx.role, 'staff.invite')) return { allow: false, status: 403, error: 'Only an owner can invite crew.' }
  if (ctx.targetRole === 'OWNER') {
    return { allow: false, status: 422, error: 'Crew cannot be invited as an owner. Change ownership through a deliberate account action.' }
  }
  return { allow: true }
}
