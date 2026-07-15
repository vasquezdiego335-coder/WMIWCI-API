// ════════════════════════════════════════════════════════════════════════
//  test-payments.ts — controlled $1 (or configured) payment-test gate.
//
//  SAFETY CONTRACT (owner spec 2026-07-15):
//    • DISABLED BY DEFAULT — the feature does not exist unless ALLOW_TEST_PAYMENTS
//      is exactly 'true'. Unset / anything else → off.
//    • It can ONLY be reached through the owner-only, env-gated
//      /api/admin/test-booking route (admin auth + OWNER permission). A normal
//      customer has no admin session, and the public booking flow never uses it.
//    • The test amount is CLAMPED to a small range so it can never be zero,
//      negative, or above the real $49 deposit.
//    • Public pricing (BOOKING_FEE_CENTS, with its $49 floor) is untouched.
//  Pure + unit-tested; the route layer enforces auth + writes the audit trail.
// ════════════════════════════════════════════════════════════════════════

export const TEST_AMOUNT_DEFAULT_CENTS = 100 // $1.00
export const TEST_AMOUNT_MIN_CENTS = 50 // Stripe's minimum chargeable USD
export const TEST_AMOUNT_MAX_CENTS = 4900 // never exceed the real deposit

type EnvLike = Record<string, string | undefined>

/** True only when controlled test payments are explicitly enabled. */
export function testPaymentsEnabled(env: EnvLike = process.env): boolean {
  return env.ALLOW_TEST_PAYMENTS === 'true'
}

/** The controlled test amount in cents. Defaults to $1; clamped to
 *  [50, 4900] so it is always a safe, small, sub-deposit amount. */
export function resolveTestAmountCents(env: EnvLike = process.env): number {
  const raw = Number(env.TEST_PAYMENT_AMOUNT_CENTS)
  const v = Number.isFinite(raw) && raw > 0 ? Math.round(raw) : TEST_AMOUNT_DEFAULT_CENTS
  return Math.min(TEST_AMOUNT_MAX_CENTS, Math.max(TEST_AMOUNT_MIN_CENTS, v))
}
