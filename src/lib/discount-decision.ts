// ════════════════════════════════════════════════════════════════════════
//  discount-decision.ts — the PURE state machine for door-hanger discount
//  approval / denial. No prisma, no discord.js, no network — so the exact
//  idempotency + "already handled" semantics are unit-testable offline and
//  shared by the HTTP interactions endpoint.
//
//  Business rules (match the Discord card the owner clicks + the DiscountType
//  enum docs in schema.prisma):
//    • Approve → DOOR_HANGER_APPROVED, 30% off the move.
//    • Deny    → DOOR_HANGER_DENIED, customer keeps the 10% first-time rate.
//  Neither touches Stripe: the door-hanger discount applies to the MOVE total
//  (collected on move day), never to the $49 booking hold.
//
//  NOTE: the admin web route app/api/admin/discounts/[id]/route.ts currently
//  sets `discountPercent: approve ? 10 : null`, which disagrees with the card
//  label ("Approve 30%") and the enum doc. This module follows the card + enum
//  (30 / 10); the admin-route discrepancy is flagged for the owner to reconcile
//  and is intentionally NOT changed here.
// ════════════════════════════════════════════════════════════════════════

export type DiscountAction = 'approve' | 'deny'

export type DiscountDecisionReason = 'ok' | 'already_approved' | 'already_denied' | 'not_pending'

export type DiscountDecision = {
  /** True only when a PENDING discount can transition. */
  ok: boolean
  reason: DiscountDecisionReason
  nextType?: 'DOOR_HANGER_APPROVED' | 'DOOR_HANGER_DENIED'
  nextPercent?: number
}

// Door-hanger approved = 30% off the move (matches the "✅ Approve 30%" button
// and the DOOR_HANGER_APPROVED enum doc). Deny leaves the customer on the 10%
// first-time fallback ("❌ Deny → 10%").
export const DOOR_HANGER_APPROVED_PERCENT = 30
export const DOOR_HANGER_DENIED_FALLBACK_PERCENT = 10

/**
 * Decide what a click should do given the booking's CURRENT discountType.
 * The caller still performs the transition atomically (an UPDATE guarded on
 * discountType = DOOR_HANGER_PENDING) so two simultaneous owners can't both
 * apply it — this function only decides the intended outcome + the honest
 * "already handled" messaging for a duplicate / losing click.
 */
export function decideDiscount(
  currentType: string | null | undefined,
  action: DiscountAction
): DiscountDecision {
  if (currentType === 'DOOR_HANGER_APPROVED') return { ok: false, reason: 'already_approved' }
  if (currentType === 'DOOR_HANGER_DENIED') return { ok: false, reason: 'already_denied' }
  if (currentType !== 'DOOR_HANGER_PENDING') return { ok: false, reason: 'not_pending' }

  return action === 'approve'
    ? { ok: true, reason: 'ok', nextType: 'DOOR_HANGER_APPROVED', nextPercent: DOOR_HANGER_APPROVED_PERCENT }
    : { ok: true, reason: 'ok', nextType: 'DOOR_HANGER_DENIED', nextPercent: DOOR_HANGER_DENIED_FALLBACK_PERCENT }
}
