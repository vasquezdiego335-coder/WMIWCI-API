// ════════════════════════════════════════════════════════════════════════
//  discount-rules.ts — ONE discount, chosen on purpose, with the rejections
//  written down.
//
//  THE BUG (owner spec, booking WMIC-1019): the booking already carried
//  FIRST_TIME_AUTO at 10%, applied automatically because the customer was
//  new. The customer then asked to use MOVE10 — which is the same 10%
//  welcome offer wearing a coupon code. Nothing in the system knew the two
//  were the same promotion, so honouring the request would have handed out
//  20% for one offer.
//
//  THE RULE: discounts do not stack (DISCOUNT_POLICY.allowStacking === false,
//  which was policy nobody enforced). Exactly one discount applies — the best
//  one the customer is entitled to — and every code that loses says so in a
//  sentence the owner can read to the customer:
//
//      MOVE10 not applied — equivalent 10% first-time discount already active.
//
//  A rejection is INFORMATION, not an error. The customer keeps their 10%;
//  they simply do not get it twice.
//
//  Pure and offline-testable.
// ════════════════════════════════════════════════════════════════════════

import { DISCOUNT_POLICY } from './pricing-config'

/**
 * A promotion FAMILY. Two offers in the same family are the same promotion in
 * different clothes, so claiming both is claiming one twice.
 *
 * `welcome_10` is the whole first-move offer: the automatic first-time
 * discount and every coupon code that markets it.
 */
export type PromoFamily = 'welcome_10' | 'manual' | 'unknown'

export type Promo = {
  code: string
  percent: number
  family: PromoFamily
  label: string
}

/**
 * THE public coupon book. A code that is not here is not automatically
 * honoured — it is recorded on the booking and left for an owner, which is
 * the only safe default for a string a customer typed.
 */
export const PROMO_CODES: Record<string, Promo> = {
  MOVE10: { code: 'MOVE10', percent: 10, family: 'welcome_10', label: '10% first move' },
  WELCOME10: { code: 'WELCOME10', percent: 10, family: 'welcome_10', label: '10% first move' },
  FIRST10: { code: 'FIRST10', percent: 10, family: 'welcome_10', label: '10% first move' },
  NEW10: { code: 'NEW10', percent: 10, family: 'welcome_10', label: '10% first move' },
}

/** The automatic first-time discount, as a promo so one comparison covers
 *  both paths. Its family is what makes MOVE10 a duplicate of it. */
export const FIRST_TIME_PROMO: Promo = {
  code: 'FIRST_TIME_AUTO',
  percent: DISCOUNT_POLICY.maxPublicPercent,
  family: 'welcome_10',
  label: 'First-time customer discount',
}

export const normalizeCode = (code?: string | null): string =>
  (code ?? '').trim().toUpperCase().replace(/\s+/g, '')

/** Look a customer-typed code up in the coupon book. */
export function lookupPromo(code?: string | null): Promo | null {
  const key = normalizeCode(code)
  return key ? PROMO_CODES[key] ?? null : null
}

export type RejectedDiscount = {
  code: string
  /** Machine reason, for the audit record. */
  reason: 'duplicate_promotion' | 'not_better' | 'unknown_code' | 'stacking_not_allowed'
  /** The sentence shown to the owner and readable to the customer. */
  message: string
}

export type DiscountResolution = {
  /** The ONE percent that applies. 0 when nothing does. */
  percent: number
  /** The winning discount's code, or null. */
  appliedCode: string | null
  /** DiscountType for the Booking column. */
  appliedType: 'FIRST_TIME_AUTO' | 'MANUAL' | null
  appliedLabel: string | null
  /** Every discount that did NOT apply, and why. Never silently dropped. */
  rejected: RejectedDiscount[]
  /** A code we do not recognise — recorded, never auto-honoured. */
  needsOwnerDecision: string | null
}

export type DiscountRequest = {
  /** True when this customer has never booked before. */
  isFirstTimeCustomer?: boolean | null
  /** A discount already sitting on the booking (percent), if any. */
  existingPercent?: number | null
  /** Its type, so an already-applied FIRST_TIME_AUTO is recognised. */
  existingType?: string | null
  /** The code the customer is asking to use now. */
  requestedCode?: string | null
}

/**
 * THE discount decision.
 *
 * Collects every discount in play (the automatic first-time offer, anything
 * already on the booking, the code being requested), keeps the single best
 * one, and explains each loser. Never returns more than `maxPublicPercent`.
 */
export function resolveDiscount(req: DiscountRequest): DiscountResolution {
  const candidates: Promo[] = []
  const rejected: RejectedDiscount[] = []

  // 1. Whatever is already on the booking.
  const existingPct = req.existingPercent ?? 0
  if (existingPct > 0) {
    const isFirstTime = req.existingType === 'FIRST_TIME_AUTO'
    candidates.push({
      code: isFirstTime ? FIRST_TIME_PROMO.code : (req.existingType ?? 'EXISTING'),
      percent: existingPct,
      family: isFirstTime ? 'welcome_10' : 'manual',
      label: isFirstTime ? FIRST_TIME_PROMO.label : 'Discount already applied',
    })
  } else if (req.isFirstTimeCustomer) {
    // 2. The automatic first-time offer, for a booking being created now.
    candidates.push(FIRST_TIME_PROMO)
  }

  // 3. The code the customer typed.
  const requested = normalizeCode(req.requestedCode)
  let needsOwnerDecision: string | null = null
  if (requested) {
    const promo = lookupPromo(requested)
    if (promo) {
      candidates.push(promo)
    } else {
      // An unknown code is not refused and not honoured — it is escalated.
      // Silently ignoring it is how a customer arrives on move day certain
      // they were promised a discount nobody recorded.
      needsOwnerDecision = requested
      rejected.push({
        code: requested,
        reason: 'unknown_code',
        message: `${requested} is not a recognised code — owner review required before it is honoured.`,
      })
    }
  }

  if (candidates.length === 0) {
    return { percent: 0, appliedCode: null, appliedType: null, appliedLabel: null, rejected, needsOwnerDecision }
  }

  // Best single discount wins. Ties go to the FIRST candidate, which is the
  // one already on the booking — an existing entitlement is never displaced
  // by an equivalent new code, so the recorded history stays stable.
  let winner = candidates[0]
  for (const c of candidates.slice(1)) if (c.percent > winner.percent) winner = c

  for (const c of candidates) {
    if (c === winner) continue
    if (c.family === winner.family && c.family !== 'unknown') {
      rejected.push({
        code: c.code,
        reason: 'duplicate_promotion',
        message: `${c.code} not applied — equivalent ${winner.percent}% ${describeWinner(winner)} already active.`,
      })
    } else if (!DISCOUNT_POLICY.allowStacking) {
      rejected.push({
        code: c.code,
        reason: c.percent < winner.percent ? 'not_better' : 'stacking_not_allowed',
        message: `${c.code} (${c.percent}%) not applied — discounts do not stack and ${winner.code} at ${winner.percent}% is already active.`,
      })
    }
  }

  const percent = Math.min(winner.percent, DISCOUNT_POLICY.maxPublicPercent)
  return {
    percent,
    appliedCode: winner.code,
    appliedType: winner.family === 'welcome_10' && winner.code === FIRST_TIME_PROMO.code ? 'FIRST_TIME_AUTO' : 'MANUAL',
    appliedLabel: winner.label,
    rejected,
    needsOwnerDecision,
  }
}

function describeWinner(w: Promo): string {
  return w.code === FIRST_TIME_PROMO.code ? 'first-time discount' : `${w.code} discount`
}

/**
 * True when a code the customer is asking about is already covered by the
 * discount on the booking. The question the admin actually asks — "can I add
 * MOVE10 to this?" — answered without recomputing the whole resolution.
 */
export function isDuplicatePromotion(existingType: string | null | undefined, existingPercent: number | null | undefined, code: string): boolean {
  const promo = lookupPromo(code)
  if (!promo) return false
  const existingFamily: PromoFamily = existingType === 'FIRST_TIME_AUTO' ? 'welcome_10' : 'manual'
  if ((existingPercent ?? 0) <= 0) return false
  return promo.family === existingFamily
}
