// ============================================================================
// closeout-guards.ts — the pure decisions the Phase 2 routes enforce.
// Same pattern as worker-pay-guard.ts and labor-guards.ts: the rule lives here
// so the route and the test call the SAME predicate and cannot drift.
// ============================================================================

import { can, type Role } from './permissions'
import { evaluateFinalize, isOverridable, type Blocker, type OverrideRecord } from './closeout-blockers'

export type GuardDecision =
  | { allow: true; overrideUsed?: boolean }
  | { allow: false; status: 403 | 409 | 422; error: string }

const ok: GuardDecision = { allow: true }

// ── Finalization ────────────────────────────────────────────────────────────

export interface FinalizeContext {
  role: Role | null
  alreadyFinalized: boolean
  blockers: Blocker[]
  overrides: OverrideRecord[]
}

/**
 * Finalizing writes an immutable snapshot. It is owner-only, it re-checks every
 * blocker server-side, and HARD blockers cannot be overridden by anyone.
 */
export function canFinalizeCloseout(ctx: FinalizeContext): GuardDecision {
  if (!can(ctx.role, 'closeout.finalize')) {
    return { allow: false, status: 403, error: 'Only an owner can finalize a move.' }
  }
  if (ctx.alreadyFinalized) {
    return { allow: false, status: 409, error: 'This move is already finalized. Reopen it to make changes.' }
  }
  const decision = evaluateFinalize(ctx.blockers, ctx.overrides)
  if (decision.hard.length > 0) {
    return {
      allow: false,
      status: 422,
      error: `This move cannot be finalized: ${decision.hard.map((b) => b.message).join(' ')}`,
    }
  }
  if (decision.unresolved.length > 0) {
    return {
      allow: false,
      status: 422,
      error: `Resolve or override first: ${decision.unresolved.map((b) => b.message).join(' ')}`,
    }
  }
  return { allow: true, overrideUsed: ctx.overrides.length > 0 }
}

// ── Overrides ───────────────────────────────────────────────────────────────

export interface OverrideContext {
  role: Role | null
  code: string
  reason?: string
  blockers: Blocker[]
}

/**
 * An owner may document away a judgement call. They may NEVER override data
 * that is wrong — a refund larger than its payment is not a policy decision.
 */
export function canOverrideBlocker(ctx: OverrideContext): GuardDecision {
  if (!can(ctx.role, 'closeout.override_blocker')) {
    return { allow: false, status: 403, error: 'Only an owner can override a closeout blocker.' }
  }
  if (!ctx.reason?.trim()) {
    return { allow: false, status: 422, error: 'A written reason is required to override a blocker.' }
  }
  const exists = ctx.blockers.some((b) => b.code === ctx.code)
  if (!exists) {
    return { allow: false, status: 422, error: 'That blocker is not currently active on this move.' }
  }
  if (!isOverridable(ctx.code, ctx.blockers)) {
    return {
      allow: false,
      status: 422,
      error: 'This problem cannot be overridden — the underlying data is wrong and must be corrected.',
    }
  }
  return { allow: true, overrideUsed: true }
}

// ── Reopening ───────────────────────────────────────────────────────────────

export function canReopenCloseout(ctx: { role: Role | null; isFinalized: boolean; reason?: string }): GuardDecision {
  if (!can(ctx.role, 'closeout.reopen')) {
    return { allow: false, status: 403, error: 'Only an owner can reopen a finalized move.' }
  }
  if (!ctx.isFinalized) {
    return { allow: false, status: 422, error: 'This move is not finalized, so there is nothing to reopen.' }
  }
  if (!ctx.reason?.trim()) {
    return { allow: false, status: 422, error: 'A reason is required to reopen a finalized move.' }
  }
  return ok
}

// ── Editing a finalized move ────────────────────────────────────────────────

/**
 * A finalized move is locked. Correcting it means reopening it — that is what
 * preserves the snapshot and produces a before/after history instead of a
 * silent edit.
 */
export function canEditCloseoutInputs(ctx: { role: Role | null; isFinalized: boolean }): GuardDecision {
  if (!can(ctx.role, 'closeout.edit')) {
    return { allow: false, status: 403, error: 'You do not have permission to edit this closeout.' }
  }
  if (ctx.isFinalized) {
    return {
      allow: false,
      status: 409,
      error: 'This move is financially finalized. Reopen it with a reason before making changes.',
    }
  }
  return ok
}

// ── Reserves + overhead + split ─────────────────────────────────────────────

export function canSetReserves(ctx: {
  role: Role | null
  isFinalized: boolean
  companyNetProfitCents: number
  totalReserveCents: number
}): GuardDecision {
  if (!can(ctx.role, 'closeout.set_reserves')) {
    return { allow: false, status: 403, error: 'Only an owner can set reserves.' }
  }
  if (ctx.isFinalized) {
    return { allow: false, status: 409, error: 'This move is finalized. Reopen it to change reserves.' }
  }
  if (ctx.totalReserveCents < 0) {
    return { allow: false, status: 422, error: 'A reserve cannot be negative.' }
  }
  if (ctx.totalReserveCents > Math.max(0, ctx.companyNetProfitCents)) {
    return {
      allow: false,
      status: 422,
      error: `Reserves of $${(ctx.totalReserveCents / 100).toFixed(2)} exceed the $${(Math.max(0, ctx.companyNetProfitCents) / 100).toFixed(2)} company net profit on this move.`,
    }
  }
  return ok
}

export function canSetOverhead(ctx: { role: Role | null; isFinalized: boolean; method: string; manualCents?: number | null; reason?: string }): GuardDecision {
  if (!can(ctx.role, 'closeout.set_overhead')) {
    return { allow: false, status: 403, error: 'Only an owner can set overhead allocation.' }
  }
  if (ctx.isFinalized) {
    return { allow: false, status: 409, error: 'This move is finalized. Reopen it to change overhead.' }
  }
  if (ctx.method === 'MANUAL') {
    if ((ctx.manualCents ?? 0) < 0) return { allow: false, status: 422, error: 'A manual overhead amount cannot be negative.' }
    if (!ctx.reason?.trim()) return { allow: false, status: 422, error: 'A reason is required for a manual overhead allocation.' }
  }
  return ok
}

export function canSetOwnerSplit(ctx: { role: Role | null; isFinalized: boolean; splitOk: boolean; splitError?: string }): GuardDecision {
  if (!can(ctx.role, 'closeout.set_owner_split')) {
    return { allow: false, status: 403, error: 'Only an owner can set the owner split.' }
  }
  if (ctx.isFinalized) {
    return { allow: false, status: 409, error: 'This move is finalized. Reopen it to change the owner split.' }
  }
  if (!ctx.splitOk) {
    return { allow: false, status: 422, error: ctx.splitError ?? 'That split is not valid.' }
  }
  return ok
}

// ── Distributions ───────────────────────────────────────────────────────────

export interface DistributionContext {
  role: Role | null
  action: 'PLAN' | 'APPROVE' | 'PAY' | 'VOID'
  amountCents: number
  distributableProfitCents: number
  alreadyAllocatedCents: number
  approvedCents?: number
  alreadyPaidCents?: number
  status?: string
  reason?: string
}

/**
 * A distribution can never exceed the distributable profit that was actually
 * snapshotted. Not billed revenue, not gross profit — distributable.
 */
export function canRecordDistribution(ctx: DistributionContext): GuardDecision {
  const action = ctx.action
  const permission =
    action === 'PLAN' ? 'distribution.plan'
      : action === 'APPROVE' ? 'distribution.approve'
        : action === 'PAY' ? 'distribution.record_payment'
          : 'distribution.void'
  if (!can(ctx.role, permission)) {
    return { allow: false, status: 403, error: 'Only an owner can manage profit distributions.' }
  }

  if (action === 'VOID') {
    if (!ctx.reason?.trim()) return { allow: false, status: 422, error: 'A reason is required to void a distribution.' }
    if (ctx.status === 'VOIDED') return { allow: false, status: 409, error: 'This distribution is already voided.' }
    return ok
  }

  if (action === 'PAY') {
    const approved = ctx.approvedCents ?? 0
    const paid = ctx.alreadyPaidCents ?? 0
    if (ctx.status !== 'APPROVED' && ctx.status !== 'PARTIALLY_PAID') {
      return { allow: false, status: 422, error: 'Approve this distribution before recording a payment against it.' }
    }
    if (ctx.amountCents <= 0) return { allow: false, status: 422, error: 'A payment must be greater than zero.' }
    const remaining = Math.max(0, approved - paid)
    if (ctx.amountCents > remaining) {
      return { allow: false, status: 422, error: `That is more than the $${(remaining / 100).toFixed(2)} still owed on this distribution.` }
    }
    return ok
  }

  // PLAN / APPROVE
  if (ctx.amountCents <= 0) return { allow: false, status: 422, error: 'A distribution must be greater than zero.' }
  const remaining = Math.max(0, ctx.distributableProfitCents - ctx.alreadyAllocatedCents)
  if (ctx.amountCents > remaining) {
    return {
      allow: false,
      status: 422,
      error: `That exceeds the $${(remaining / 100).toFixed(2)} still distributable. Distributions can only come from profit that was actually collected.`,
    }
  }
  return ok
}

/**
 * Did this write lose a concurrent-finalization race?
 *
 * writeSnapshot reads the current max version and inserts version + 1. Two
 * simultaneous finalizations therefore race — but FinancialSnapshot carries
 * @@unique([closeoutId, version]), so the loser's INSERT is rejected by the
 * database rather than producing a duplicate snapshot. That is the correct
 * outcome; the constraint is doing exactly its job.
 *
 * What was wrong was the REPORTING: the loser saw a raw Prisma P2002 dump
 * mentioning `closeoutId_version`, which reads like corruption. The move is in
 * fact perfectly finalized — by the other person, moments earlier.
 */
export function isConcurrentFinalize(err: unknown): boolean {
  const e = err as { code?: string; meta?: { target?: unknown } } | null
  if (!e || e.code !== 'P2002') return false
  const target = e.meta?.target
  const fields = Array.isArray(target) ? target.map(String) : typeof target === 'string' ? [target] : []
  const joined = fields.join(',').toLowerCase()
  return joined.includes('version') || joined.includes('closeout')
}
