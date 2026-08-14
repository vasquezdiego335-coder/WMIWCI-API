// ════════════════════════════════════════════════════════════════════════
//  approval-guards.ts — THE checklist that runs before "Confirm Booking".
//
//  THE BUG (owner spec, booking WMIC-1019): Confirm Booking captured $49 and
//  scheduled a crew against a booking with four unresolved questions on it.
//  Nothing stood between the button and the money. The warnings existed on the
//  page; the button did not read them.
//
//  THE RULE, in the owner's own order:
//     1. inventory matches the selected move size
//     2. the final price is arithmetically correct
//     3. discounts are not duplicated
//     4. the deposit is applied, not added
//     5. assembly/disassembly scope is known
//     6. the COI requirement has been reviewed
//     7. addresses and units are valid
//     8. the truck provider is confirmed
//
//  TWO SEVERITIES, AND THE DIFFERENCE MATTERS:
//    • BLOCKED — approving would take money against a booking we cannot
//      honestly price or dispatch. The button refuses.
//    • NEEDS ACKNOWLEDGEMENT — the owner may well be right to proceed, but
//      not by accident. The button asks first, and records that they were
//      asked.
//  Anything genuinely fine is a silent pass and adds no noise.
//
//  A GUARD NEVER EDITS THE BOOKING. It does not re-size the move, re-price
//  the job, or drop a discount — it reports, and an owner acts. Silently
//  changing what a customer will pay is the failure this file exists to make
//  impossible.
//
//  Pure — shared by the admin Confirm button, the API status route and the
//  Discord approve action, so all three refuse the same bookings.
// ════════════════════════════════════════════════════════════════════════

import { assessAddress } from './address'
import { resolveBookingScope, type BookingScope, type ScopeInput } from './booking-scope'

export type GuardStatus = 'pass' | 'acknowledge' | 'blocked'

export type GuardCheck = {
  id: string
  /** The owner's own words for this check. */
  label: string
  status: GuardStatus
  /** What is wrong, and what to do about it. Empty on a pass. */
  message: string
}

export type ApprovalVerdict = {
  checks: GuardCheck[]
  /** True when nothing blocks. Acknowledgements do not block; they prompt. */
  canApprove: boolean
  /** Checks the owner must be shown and must accept before confirming. */
  mustAcknowledge: GuardCheck[]
  blocked: GuardCheck[]
  /** The confirmation-dialog text. Null when the booking is genuinely clean. */
  confirmationPrompt: string | null
  scope: BookingScope
}

export type ApprovalGuardInput = ScopeInput & {
  /** The owner ticked "I have reviewed these" on this exact set of warnings. */
  acknowledged?: boolean | null
  /** An owner explicitly approved the current price. */
  priceChangeApprovedAt?: Date | string | null
  /** True when the price differs from what the customer last agreed to. */
  priceChangedSinceCustomerAgreed?: boolean | null
}

/**
 * THE pre-approval checklist. Runs the eight checks in the owner's order and
 * returns what each one found.
 */
export function evaluateApproval(b: ApprovalGuardInput): ApprovalVerdict {
  const scope = resolveBookingScope(b)
  const checks: GuardCheck[] = []

  // 1 ── Inventory matches the selected move size ─────────────────────────
  if (scope.inventory.exceedsSelected && !b.inventoryReviewCleared) {
    checks.push({
      id: 'inventory_size',
      label: 'Inventory matches selected move size',
      status: 'acknowledge',
      message:
        `${scope.inventory.reasons.join(' ')} ` +
        `Either change the size to ${scope.inventory.suggestedLabel ?? 'the right package'} (the customer does not need to rebook) ` +
        `or confirm that ${scope.inventory.selectedLabel ?? 'the selection'} is genuinely correct.`,
    })
  } else {
    checks.push({ id: 'inventory_size', label: 'Inventory matches selected move size', status: 'pass', message: '' })
  }

  // 2 ── The final price is arithmetically correct ─────────────────────────
  const q = scope.quote
  const expected = Math.max(0, q.quotedCents + q.additionalCents - q.discountCents)
  if (q.quoteMissing && q.finalTotalCents === 0) {
    checks.push({
      id: 'price_correct',
      label: 'Final price is correct',
      status: 'blocked',
      message: 'No price is stored on this booking. Approving would capture a deposit against an amount nobody has set.',
    })
  } else if (expected !== q.finalTotalCents) {
    // Unreachable through computeQuote by construction; kept because a future
    // caller could hand in pre-computed parts, and a silent mismatch here is
    // exactly the class of bug this whole change is about.
    checks.push({
      id: 'price_correct',
      label: 'Final price is correct',
      status: 'blocked',
      message: `Final total ${usd(q.finalTotalCents)} does not equal quote ${usd(q.quotedCents)} + add-ons ${usd(q.additionalCents)} − discount ${usd(q.discountCents)}.`,
    })
  } else {
    checks.push({
      id: 'price_correct',
      label: 'Final price is correct',
      status: 'pass',
      message: `${usd(q.quotedCents)}${q.additionalCents ? ` + ${usd(q.additionalCents)}` : ''}${q.discountCents ? ` − ${usd(q.discountCents)}` : ''} = ${usd(q.finalTotalCents)}`,
    })
  }

  // 3 ── Discounts are not duplicated ──────────────────────────────────────
  if (scope.discountRejected.length) {
    checks.push({
      id: 'discount_single',
      label: 'Discounts are not duplicated',
      status: 'acknowledge',
      message: scope.discountRejected.map((r) => r.message).join(' ') + ' Tell the customer before they arrive expecting it.',
    })
  } else if ((b.discountPercent ?? 0) > 10) {
    checks.push({
      id: 'discount_single',
      label: 'Discounts are not duplicated',
      status: 'blocked',
      message: `A ${b.discountPercent}% discount is above the 10% public cap — two promotions have almost certainly been combined.`,
    })
  } else {
    checks.push({ id: 'discount_single', label: 'Discounts are not duplicated', status: 'pass', message: '' })
  }

  // 4 ── The deposit is applied toward the total, never added on top ───────
  if (q.depositCents > 0 && q.finalTotalCents > 0 && q.depositCents > q.finalTotalCents) {
    checks.push({
      id: 'deposit_math',
      label: 'Deposit calculation is correct',
      status: 'blocked',
      message: `The ${usd(q.depositCents)} deposit is larger than the ${usd(q.finalTotalCents)} total.`,
    })
  } else {
    checks.push({
      id: 'deposit_math',
      label: 'Deposit calculation is correct',
      status: 'pass',
      message: q.depositCaptured
        ? `${usd(q.finalTotalCents)} total − ${usd(q.depositAppliedCents)} paid = ${usd(q.remainingCents)} remaining.`
        : `${usd(q.finalTotalCents)} total − ${usd(q.depositCents)} deposit on capture = ${usd(q.remainingAfterDepositCents)} remaining.`,
    })
  }

  // 5 ── Assembly / disassembly scope is known ─────────────────────────────
  if (scope.assembly.required && !scope.assembly.scopeKnown) {
    checks.push({
      id: 'assembly_scope',
      label: 'Assembly/disassembly scope is known',
      status: 'acknowledge',
      message: 'The customer asked for assembly or disassembly but named no furniture. Ask what needs to be worked on before finalizing the quote.',
    })
  } else if (scope.assembly.approvalRequired && scope.assembly.feeCents > 0) {
    checks.push({
      id: 'assembly_scope',
      label: 'Assembly/disassembly scope is known',
      status: 'acknowledge',
      message: `An assembly fee of ${usd(scope.assembly.feeCents)} is set and still needs your approval.`,
    })
  } else {
    checks.push({ id: 'assembly_scope', label: 'Assembly/disassembly scope is known', status: 'pass', message: '' })
  }

  // 6 ── COI requirement reviewed ──────────────────────────────────────────
  if (scope.coi.required) {
    checks.push({
      id: 'coi_reviewed',
      label: 'COI requirement reviewed',
      status: 'acknowledge',
      message: 'A certificate of insurance is required. Confirm it has been issued to the building before move day.',
    })
  } else if (scope.coi.unknown) {
    checks.push({
      id: 'coi_reviewed',
      label: 'COI requirement reviewed',
      status: 'acknowledge',
      message: 'Neither building has confirmed whether a COI is required. A dock can refuse the crew over this.',
    })
  } else {
    checks.push({ id: 'coi_reviewed', label: 'COI requirement reviewed', status: 'pass', message: '' })
  }

  // 7 ── Addresses and units are valid ─────────────────────────────────────
  const originA = assessAddress(scope.addresses.origin.address)
  const destA = assessAddress(scope.addresses.dest.address)
  if (originA.isVague || destA.isVague) {
    checks.push({
      id: 'addresses_valid',
      label: 'Addresses/units are valid',
      status: 'blocked',
      message: `${originA.isVague ? 'Pickup' : 'Drop-off'} address is missing. A crew cannot be dispatched to it.`,
    })
  } else {
    const gaps: string[] = []
    if (!originA.hasStreetNumber) gaps.push('the pickup address has no street number')
    if (!destA.hasStreetNumber) gaps.push('the drop-off address has no street number')
    if (scope.addresses.origin.embeddedUnitFound || scope.addresses.dest.embeddedUnitFound) {
      gaps.push('a unit was typed inside a street address and has been split out for review')
    }
    checks.push({
      id: 'addresses_valid',
      label: 'Addresses/units are valid',
      status: gaps.length ? 'acknowledge' : 'pass',
      message: gaps.length ? `${cap(gaps.join('; '))}.` : '',
    })
  }

  // 8 ── The truck provider is confirmed ───────────────────────────────────
  if (scope.truckCostViolations.length) {
    checks.push({
      id: 'truck_provider',
      label: 'Truck provider is confirmed',
      status: 'blocked',
      message: `This labor-only job carries ${scope.truckCostViolations.map((v) => `${v.label} (${usd(v.cents)})`).join(', ')}. We supply no truck on this job — remove the charge.`,
    })
  } else if (scope.shape.truckProvider === 'unknown') {
    checks.push({
      id: 'truck_provider',
      label: 'Truck provider is confirmed',
      status: 'acknowledge',
      message: 'Nobody has recorded whose truck this move runs on. Confirm before dispatch.',
    })
  } else if (scope.shape.serviceType === 'labor_only' && !scope.shape.explicit) {
    checks.push({
      id: 'truck_provider',
      label: 'Truck provider is confirmed',
      status: 'acknowledge',
      message: `${scope.shape.reason} Confirm this is labor only so it is never dispatched as a truck job.`,
    })
  } else {
    checks.push({
      id: 'truck_provider',
      label: 'Truck provider is confirmed',
      status: 'pass',
      message: `${scope.shape.serviceTypeLabel} · truck: ${scope.shape.truckProviderLabel}`,
    })
  }

  // ── A price change the customer has not been re-quoted ───────────────────
  if (b.priceChangedSinceCustomerAgreed && !b.priceChangeApprovedAt) {
    checks.push({
      id: 'price_change_approved',
      label: 'Price change approved by an owner',
      status: 'blocked',
      message: `The price no longer matches what the customer agreed to. Approve the new amount explicitly — ${usd(q.finalTotalCents)} — before confirming.`,
    })
  }

  const blocked = checks.filter((c) => c.status === 'blocked')
  const needAck = checks.filter((c) => c.status === 'acknowledge')
  const mustAcknowledge = b.acknowledged ? [] : needAck

  return {
    checks,
    canApprove: blocked.length === 0,
    mustAcknowledge,
    blocked,
    confirmationPrompt: buildPrompt(blocked, needAck),
    scope,
  }
}

function buildPrompt(blocked: GuardCheck[], needAck: GuardCheck[]): string | null {
  if (blocked.length) {
    return `This booking cannot be confirmed yet:\n\n${blocked.map((c) => `⛔ ${c.label} — ${c.message}`).join('\n\n')}`
  }
  if (needAck.length) {
    return `Confirm anyway? These are unresolved:\n\n${needAck.map((c) => `⚠️ ${c.label} — ${c.message}`).join('\n\n')}`
  }
  return null
}

const usd = (cents: number): string =>
  `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const cap = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s)

/**
 * Does moving to `nextTotalCents` change what the customer will pay?
 *
 * Called before any admin edit that touches money — a move-size correction is
 * the obvious one. A change of zero is not a change; anything else needs an
 * owner to say so out loud.
 */
export function isPriceChange(currentTotalCents: number, nextTotalCents: number): boolean {
  return Math.abs(currentTotalCents - nextTotalCents) >= 1
}

/** The sentence an owner must agree to before a customer's price moves. */
export function describePriceChange(currentTotalCents: number, nextTotalCents: number): string {
  const delta = nextTotalCents - currentTotalCents
  const direction = delta > 0 ? 'increase' : 'decrease'
  return `This will ${direction} the customer's total from ${usd(currentTotalCents)} to ${usd(nextTotalCents)} (${delta > 0 ? '+' : '−'}${usd(Math.abs(delta))}). The customer must be told before move day.`
}
