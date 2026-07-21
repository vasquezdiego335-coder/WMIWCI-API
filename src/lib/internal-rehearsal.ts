// ============================================================================
// internal-rehearsal.ts — the ONE gate on rehearsing a closeout (Stage 4, D3).
//
// WHY THIS EXISTS. Two rules that are individually correct combined into a
// deadlock: test payments are excluded from revenue (money-rules), and a move
// with no captured payment cannot be finalized (NO_PAYMENT_DATA is HARD). So
// the closeout workflow could never be exercised end to end without either
// weakening a real safety rule or charging a real card.
//
// The rehearsal pathway is deliberately NARROW. It is not a "test mode" and it
// does not relax anything for real customers. Every condition below must hold:
//
//   1. the booking is flagged `isInternalTest`
//   2. the actor is an OWNER
//   3. a written reason is supplied
//   4. the rehearsal is not disabled by configuration
//
// And these consequences are guaranteed rather than hoped for:
//
//   • NO Stripe operation — the closeout path calls no payment API at all
//   • NO customer email, NO customer SMS — it sends nothing
//   • synthetic revenue never reaches company reporting (money-rules excludes
//     internal-test payments; reports exclude internal-test bookings)
//   • the rehearsal is audited as CLOSEOUT_REHEARSAL with its reason
//
// Pure — no Prisma, no network. Offline-tested (internal-rehearsal.test.ts).
// ============================================================================

import { can, type Role } from './permissions'

/** The blocker that, and ONLY that, a rehearsal may clear. */
export const REHEARSABLE_BLOCKER = 'NO_PAYMENT_DATA'

/**
 * Side effects a rehearsal is permitted to cause. All false, asserted in tests,
 * and read by the closeout route so the guarantee is enforced by code rather
 * than by a comment.
 */
export const REHEARSAL_SIDE_EFFECTS = Object.freeze({
  stripe: false,
  customerEmail: false,
  customerSms: false,
  discordCustomerMessage: false,
})

export interface RehearsalRequest {
  role: Role | null | undefined
  /** Booking.isInternalTest. Absent/false = a real customer booking. */
  isInternalTest?: boolean | null
  /** The written reason the owner typed. */
  reason?: string | null
  /** Which blocker the rehearsal is being used against. */
  blockerCode?: string
  /**
   * Configuration kill switch. Reading it is the CALLER's job (see
   * `rehearsalEnabled`) so this module stays pure.
   */
  enabled?: boolean
}

export type RehearsalDecision =
  | { allow: true; reason: string }
  | { allow: false; status: 403 | 422 | 503; error: string }

/**
 * Is this a legitimate internal rehearsal?
 *
 * ORDER MATTERS. The internal-test check comes FIRST so a real booking gets the
 * "this is a real customer" answer regardless of who is asking — an owner with
 * a perfect reason must still be refused on a real move, and the error must say
 * why rather than blaming their role.
 */
export function evaluateRehearsal(i: RehearsalRequest): RehearsalDecision {
  if (i.enabled === false) {
    return {
      allow: false, status: 503,
      error: 'Closeout rehearsal is switched off in this environment.',
    }
  }

  if (i.blockerCode != null && i.blockerCode !== REHEARSABLE_BLOCKER) {
    return {
      allow: false, status: 422,
      error: `A rehearsal only covers ${REHEARSABLE_BLOCKER}. Every other blocker applies to an internal-test move exactly as it does to a real one.`,
    }
  }

  if (!i.isInternalTest) {
    return {
      allow: false, status: 422,
      error: 'This is a real customer booking. Missing payment data cannot be overridden on a real move — its revenue would be untrustworthy.',
    }
  }

  // OWNER-only. `closeout.override_blocker` is already owner-only in the
  // permission matrix; asking through `can` keeps the two from drifting.
  if (!can(i.role, 'closeout.override_blocker')) {
    return {
      allow: false, status: 403,
      error: 'Only an owner can rehearse a closeout.',
    }
  }

  const reason = (i.reason ?? '').trim()
  if (!reason) {
    return {
      allow: false, status: 422,
      error: 'Write down why this rehearsal is being run. It is recorded in the audit log.',
    }
  }

  return { allow: true, reason }
}

/**
 * Read the configuration kill switch.
 *
 * ON by default: the rehearsal is already gated by an internal-test flag, an
 * owner and a written reason, and the deployment plan runs one against
 * production to prove the workflow. The switch exists so it can be turned OFF
 * deliberately — never so that forgetting to set a variable silently unlocks
 * something.
 */
export function rehearsalEnabled(envValue: string | undefined): boolean {
  return String(envValue ?? '').toLowerCase() !== 'true'
}

/** The audit payload. Explicitly records the side effects that did NOT happen —
 *  the absence of a charge is the point of the whole pathway. */
export function buildRehearsalAudit(i: {
  bookingId: string
  reason: string
  byName: string
  blockerCode?: string
}): Record<string, unknown> {
  return {
    bookingId: i.bookingId,
    blockerCode: i.blockerCode ?? REHEARSABLE_BLOCKER,
    reason: i.reason,
    internalTest: true,
    sideEffects: { ...REHEARSAL_SIDE_EFFECTS },
    excludedFromReporting: true,
    by: i.byName,
  }
}

// ── Reporting exclusion ─────────────────────────────────────────────────────

/**
 * Does this record reach company reporting?
 *
 * The single predicate every report and total should ask. It is deliberately
 * pessimistic: anything flagged internal-test is out, and so is anything whose
 * flag is unreadable — an unknown provenance is not evidence of a real sale.
 */
export function countsTowardCompanyReporting(row: { isInternalTest?: boolean | null } | null | undefined): boolean {
  if (!row) return false
  return row.isInternalTest !== true
}

/** Split a set of rows into what reporting may use and what it must not. */
export function partitionSynthetic<T extends { isInternalTest?: boolean | null }>(rows: T[]): { real: T[]; synthetic: T[] } {
  const real: T[] = []
  const synthetic: T[] = []
  for (const r of rows) (countsTowardCompanyReporting(r) ? real : synthetic).push(r)
  return { real, synthetic }
}
