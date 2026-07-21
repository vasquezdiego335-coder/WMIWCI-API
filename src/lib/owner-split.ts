// ============================================================================
// owner-split.ts — how distributable profit is divided between the owners.
// Phase 2 (owner spec 2026-07-20). Pure, integer cents, offline-tested.
//
// THE RULES:
//  • A split allocates only DISTRIBUTABLE profit — never billed revenue, never
//    an uncollected balance, never gross profit.
//  • Allocations can never exceed the distributable amount.
//  • Custom percentages must total 100%.
//  • The remainder from integer rounding is reported, never silently dropped.
//  • Calculating a split creates NOTHING. It is a decision-support number until
//    an owner records an actual distribution.
// ============================================================================

export type SplitMethod = 'EQUAL' | 'OWNERSHIP_PERCENT' | 'LABOR_FIRST' | 'CUSTOM'
export type OwnerKey = 'DIEGO' | 'SEBASTIAN'

export interface OwnerShare {
  owner: OwnerKey
  /** Recognized owner labor paid FIRST, before profit is split (LABOR_FIRST). */
  laborFirstCents: number
  /** Share of the remaining distributable profit. */
  profitShareCents: number
  /** laborFirst + profitShare — what this owner is allocated in total. */
  amountCents: number
  percentBp: number
}

export interface SplitInput {
  method: SplitMethod
  distributableProfitCents: number
  /** Ownership percentages in basis points, e.g. { DIEGO: 5000, SEBASTIAN: 5000 }. */
  ownershipBp?: Partial<Record<OwnerKey, number>>
  /** Unpaid owner labor value per owner — recognized first under LABOR_FIRST. */
  ownerLaborCents?: Partial<Record<OwnerKey, number>>
  /** Explicit amounts (CUSTOM). Takes precedence over customPercentBp. */
  customCents?: Partial<Record<OwnerKey, number>>
  /** Explicit percentages in basis points (CUSTOM). Must total 10000. */
  customPercentBp?: Partial<Record<OwnerKey, number>>
}

export interface SplitResult {
  ok: boolean
  error?: string
  method: SplitMethod
  distributableProfitCents: number
  shares: OwnerShare[]
  /** Allocated to nobody — rounding remainder, or profit left on purpose. */
  undistributedCents: number
  totalAllocatedCents: number
}

const OWNERS: OwnerKey[] = ['DIEGO', 'SEBASTIAN']
const nn = (v: number | null | undefined): number => Math.max(0, Math.round(v ?? 0))

const fail = (method: SplitMethod, distributable: number, error: string): SplitResult => ({
  ok: false,
  error,
  method,
  distributableProfitCents: distributable,
  shares: [],
  undistributedCents: distributable,
  totalAllocatedCents: 0,
})

/**
 * Divide distributable profit.
 *
 * Rounding: the LAST owner absorbs nothing — instead any cent left over by
 * integer division is reported as `undistributedCents`. Silently handing a
 * stray cent to one owner is the kind of thing that erodes trust in a ledger.
 */
export function computeOwnerSplit(input: SplitInput): SplitResult {
  const distributable = nn(input.distributableProfitCents)

  // A loss distributes nothing. This is not an error — it is the answer.
  if (distributable <= 0) {
    return {
      ok: true,
      method: input.method,
      distributableProfitCents: 0,
      shares: OWNERS.map((owner) => ({ owner, laborFirstCents: 0, profitShareCents: 0, amountCents: 0, percentBp: 0 })),
      undistributedCents: 0,
      totalAllocatedCents: 0,
    }
  }

  let shares: OwnerShare[] = []

  if (input.method === 'EQUAL') {
    const each = Math.floor(distributable / OWNERS.length)
    shares = OWNERS.map((owner) => ({ owner, laborFirstCents: 0, profitShareCents: each, amountCents: each, percentBp: Math.round(10_000 / OWNERS.length) }))
  }

  if (input.method === 'OWNERSHIP_PERCENT') {
    const bp = input.ownershipBp ?? {}
    const total = OWNERS.reduce((s, o) => s + nn(bp[o]), 0)
    if (total !== 10_000) {
      return fail(input.method, distributable, `Ownership percentages total ${(total / 100).toFixed(2)}%, not 100%.`)
    }
    shares = OWNERS.map((owner) => {
      const amount = applyBpFloor(distributable, nn(bp[owner]))
      return { owner, laborFirstCents: 0, profitShareCents: amount, amountCents: amount, percentBp: nn(bp[owner]) }
    })
  }

  if (input.method === 'LABOR_FIRST') {
    // Recognize each owner's unpaid labor first, then split what remains by
    // ownership. If labor alone exceeds the distributable amount, labor is
    // paid PRO RATA and nothing is left to split — labor comes first.
    const labor = input.ownerLaborCents ?? {}
    const laborTotal = OWNERS.reduce((s, o) => s + nn(labor[o]), 0)
    const bp = input.ownershipBp ?? {}
    const bpTotal = OWNERS.reduce((s, o) => s + nn(bp[o]), 0)
    if (bpTotal !== 10_000 && bpTotal !== 0) {
      return fail(input.method, distributable, `Ownership percentages total ${(bpTotal / 100).toFixed(2)}%, not 100%.`)
    }

    if (laborTotal >= distributable) {
      shares = OWNERS.map((owner) => {
        const amount = laborTotal === 0 ? 0 : Math.floor((nn(labor[owner]) / laborTotal) * distributable)
        return { owner, laborFirstCents: amount, profitShareCents: 0, amountCents: amount, percentBp: distributable > 0 ? Math.round((amount / distributable) * 10_000) : 0 }
      })
    } else {
      const remaining = distributable - laborTotal
      const evenBp = Math.round(10_000 / OWNERS.length)
      shares = OWNERS.map((owner) => {
        const laborFirst = nn(labor[owner])
        const share = applyBpFloor(remaining, bpTotal === 10_000 ? nn(bp[owner]) : evenBp)
        const amount = laborFirst + share
        return { owner, laborFirstCents: laborFirst, profitShareCents: share, amountCents: amount, percentBp: Math.round((amount / distributable) * 10_000) }
      })
    }
  }

  if (input.method === 'CUSTOM') {
    if (input.customCents && Object.keys(input.customCents).length > 0) {
      const total = OWNERS.reduce((s, o) => s + nn(input.customCents?.[o]), 0)
      if (total > distributable) {
        return fail(input.method, distributable, `Allocations total $${(total / 100).toFixed(2)} but only $${(distributable / 100).toFixed(2)} is distributable.`)
      }
      shares = OWNERS.map((owner) => {
        const amount = nn(input.customCents?.[owner])
        return { owner, laborFirstCents: 0, profitShareCents: amount, amountCents: amount, percentBp: Math.round((amount / distributable) * 10_000) }
      })
    } else {
      const bp = input.customPercentBp ?? {}
      const total = OWNERS.reduce((s, o) => s + nn(bp[o]), 0)
      if (total !== 10_000) {
        return fail(input.method, distributable, `Custom percentages total ${(total / 100).toFixed(2)}%, not 100%.`)
      }
      shares = OWNERS.map((owner) => {
        const amount = applyBpFloor(distributable, nn(bp[owner]))
        return { owner, laborFirstCents: 0, profitShareCents: amount, amountCents: amount, percentBp: nn(bp[owner]) }
      })
    }
  }

  const totalAllocatedCents = shares.reduce((s, x) => s + x.amountCents, 0)

  // Belt and braces: no path may allocate more than exists.
  if (totalAllocatedCents > distributable) {
    return fail(input.method, distributable, 'Allocations exceed the distributable profit.')
  }

  return {
    ok: true,
    method: input.method,
    distributableProfitCents: distributable,
    shares,
    totalAllocatedCents,
    undistributedCents: distributable - totalAllocatedCents,
  }
}

/** Floor rather than round, so the parts can never sum above the whole. */
function applyBpFloor(baseCents: number, bp: number): number {
  if (baseCents <= 0 || bp <= 0) return 0
  return Math.floor((baseCents * bp) / 10_000)
}

/** Validate a proposed distribution against what was actually authorized. */
export function validateDistribution(i: {
  approvedCents: number
  distributableProfitCents: number
  alreadyAllocatedCents: number
}): { ok: true } | { ok: false; error: string } {
  if (i.approvedCents <= 0) return { ok: false, error: 'A distribution must be greater than zero.' }
  const remaining = Math.max(0, i.distributableProfitCents - i.alreadyAllocatedCents)
  if (i.approvedCents > remaining) {
    return {
      ok: false,
      error: `That exceeds the $${(remaining / 100).toFixed(2)} still distributable on this move.`,
    }
  }
  return { ok: true }
}
