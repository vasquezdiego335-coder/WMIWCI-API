import Stripe from 'stripe'

// $49 booking authorization — HELD (not captured) until an admin approves.
// Override via STRIPE_BOOKING_FEE_CENTS, but never below the $49 floor: a stray
// low value (e.g. a leftover test "100" = $1) must never reach a real customer.
const BOOKING_FEE_FLOOR_CENTS = 4900
export const BOOKING_FEE_CENTS = Math.max(
  BOOKING_FEE_FLOOR_CENTS,
  Number(process.env.STRIPE_BOOKING_FEE_CENTS) || BOOKING_FEE_FLOOR_CENTS
)

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function stripeSecretKey(): string {
  const key = requiredEnv('STRIPE_SECRET_KEY')
  // Guard against shipping a test key to real production by accident. For a
  // deliberate TEST-MODE launch on prod infra, set STRIPE_ALLOW_TEST=true
  // (Vercel forces NODE_ENV=production, so test mode needs this opt-in). Remove
  // the flag and switch to an sk_live_ key when you go live.
  if (
    process.env.NODE_ENV === 'production' &&
    key.startsWith('sk_test_') &&
    process.env.STRIPE_ALLOW_TEST !== 'true'
  ) {
    throw new Error(
      'STRIPE_SECRET_KEY is a test key under NODE_ENV=production. ' +
        'Set STRIPE_ALLOW_TEST=true for a deliberate test-mode launch, or use an sk_live_ key.'
    )
  }
  return key
}

let stripeClient: Stripe | null = null

function getStripeClient(): Stripe {
  if (!stripeClient) {
    stripeClient = new Stripe(stripeSecretKey(), {
      apiVersion: '2024-06-20',
      typescript: true,
    })
  }
  return stripeClient
}

// Lazy proxy keeps build/type checks from requiring secrets at import time.
export const stripe = new Proxy({} as Stripe, {
  get(_target, prop, receiver) {
    return Reflect.get(getStripeClient() as any, prop, receiver)
  },
})

export async function createBookingCheckout(params: {
  bookingId: string
  customerEmail: string
  customerName: string
  description: string
  successUrl: string
  cancelUrl: string
  agreementAccepted?: boolean
  agreementVersion?: string
  agreementName?: string
  /** Extra string metadata mirrored onto BOTH the Checkout Session and the
   *  PaymentIntent (e.g. bookingReference, the server-computed estimate). */
  extraMetadata?: Record<string, string>
  /** CONTROLLED-TEST ONLY. When set, this exact cent amount is authorized instead
   *  of BOOKING_FEE_CENTS — deliberately bypassing the $49 floor. This is passed
   *  ONLY by the owner-only, env-gated /api/admin/test-booking endpoint; the
   *  public booking flow never sets it, so a real customer is always the $49 floor. */
  amountCentsOverride?: number
}): Promise<Stripe.Checkout.Session> {
  const extra = params.extraMetadata ?? {}
  const unitAmount = params.amountCentsOverride && params.amountCentsOverride > 0 ? params.amountCentsOverride : BOOKING_FEE_CENTS
  const isTest = !!params.amountCentsOverride
  const amountLabel = `$${(unitAmount / 100).toFixed(2)}`
  return getStripeClient().checkout.sessions.create({
    mode: 'payment',
    customer_email: params.customerEmail,
    payment_intent_data: {
      // Authorize only — funds are HELD, not captured, until an admin approves.
      // (Card authorizations typically expire after ~7 days if not captured.)
      capture_method: 'manual',
      description: `Booking hold - ${params.description}`,
      metadata: {
        bookingId: params.bookingId,
        customerName: params.customerName,
        ...extra,
      },
    },
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: unitAmount,
          product_data: {
            name: isTest ? 'CONTROLLED TEST — Booking Hold' : 'Moving Service Booking Hold',
            description: `${amountLabel} authorized today — held, not charged until we approve - ${params.description}`,
          },
        },
      },
    ],
    metadata: {
      bookingId: params.bookingId,
      amountType: isTest ? 'controlled_test' : 'booking_fee',
      // ── Moving Service Agreement (legal traceability on the payment) ──
      agreementAccepted: params.agreementAccepted ? 'true' : 'false',
      agreementVersion: params.agreementVersion ?? '',
      agreementName: (params.agreementName ?? '').slice(0, 200),
      ...extra,
    },
    expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
    allow_promotion_codes: false,
    billing_address_collection: 'auto',
    phone_number_collection: { enabled: false },
  })
}

// ════════════════════════════════════════════════════════════════════════
//  ADMIN DEPOSIT LINK checkout (owner spec 2026-08-15)
//  ----------------------------------------------------------------------
//  Deliberately NOT createBookingCheckout with different arguments. The two
//  are different products and conflating them would be a money bug:
//
//    createBookingCheckout  → capture_method 'manual'. An AUTHORIZATION. The
//                             $49 is held and only captured if an owner
//                             approves the booking.
//    createDepositCheckout  → automatic capture. A CHARGE. The customer paid a
//                             deposit the owner already agreed with them, and
//                             it is applied to the balance immediately.
//
//  The amount comes from the DepositRequest row and nowhere else. There is no
//  amount parameter reachable from a browser, and no processing fee is added —
//  the customer is charged the deposit and nothing but the deposit.
// ════════════════════════════════════════════════════════════════════════
/** The Stripe line item, in the customer's language. */
function depositLineItem(serviceSummary: string | null | undefined, locale?: 'en' | 'es') {
  const es = locale === 'es'
  const name = es ? 'Move It Clear It — Depósito de mudanza' : 'Move It Clear It — Move Deposit'
  const base = es
    ? 'Depósito aplicado al saldo de su mudanza'
    : 'Deposit applied toward your moving balance'
  return {
    name,
    description: serviceSummary ? `${base} — ${serviceSummary}`.slice(0, 200) : base,
  }
}

export async function createDepositCheckout(params: {
  depositRequestId: string
  /** THE authoritative amount, read from the database by the caller. */
  amountCents: number
  publicToken: string
  customerEmail?: string | null
  customerName?: string | null
  bookingId?: string | null
  bookingReference?: string | null
  serviceSummary?: string | null
  successUrl: string
  cancelUrl: string
  /** The customer's language. Stripe renders its own Checkout page in it. */
  locale?: 'en' | 'es'
  /** Collapses retries of the SAME attempt into one session at Stripe's end. */
  idempotencyKey?: string
}): Promise<Stripe.Checkout.Session> {
  if (!Number.isInteger(params.amountCents) || params.amountCents < 100) {
    // A non-integer or sub-$1 amount reaching Stripe means a caller bypassed
    // parseAmountToCents. Fail loudly rather than charge something odd.
    throw new Error('createDepositCheckout: amountCents must be an integer of at least 100')
  }

  // Mirrored onto BOTH the Session and the PaymentIntent: the webhook reads the
  // session, but a human in the Stripe dashboard usually opens the payment.
  const metadata: Record<string, string> = {
    depositRequestId: params.depositRequestId,
    depositToken: params.publicToken,
    paymentKind: 'move_deposit',
    ...(params.bookingId ? { bookingId: params.bookingId } : {}),
    ...(params.bookingReference ? { bookingReference: params.bookingReference } : {}),
  }

  return getStripeClient().checkout.sessions.create(
    {
      mode: 'payment',
      // STRIPE'S OWN PAGE, IN THE CUSTOMER'S LANGUAGE. Our page is fully
      // bilingual and then handed a Spanish speaker an English card form —
      // the one screen where "CVC" and "postal code" have to be understood.
      // Omitted (Stripe's own auto-detect) when we were not told.
      ...(params.locale ? { locale: params.locale } : {}),
      // The internal deposit-request id, so a Stripe-side reconciliation can
      // always name the row this session belongs to without parsing metadata.
      client_reference_id: params.depositRequestId,
      // Prefill only when we actually know it; an empty string is a Stripe error.
      ...(params.customerEmail ? { customer_email: params.customerEmail } : {}),
      payment_intent_data: {
        description: `Move deposit${params.bookingReference ? ` — ${params.bookingReference}` : ''}`,
        metadata,
      },
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'usd',
            unit_amount: params.amountCents,
            // Inline price data — no Product/Price object is created per deposit,
            // so the Stripe product catalogue does not fill up with one-offs.
            // The line item the customer reads on Stripe's page and on the
            // emailed receipt, in their language. `serviceSummary` is the
            // CUSTOMER-FACING summary — never the internal note, which is a
            // different column and is not selected on this path at all.
            product_data: depositLineItem(params.serviceSummary, params.locale),
          },
        },
      ],
      metadata,
      // A day is long enough for someone to read a text and pay; a session that
      // never expires is a payable page loose on the internet forever.
      //
      // QUANTIZED TO THE HOUR, and that is not cosmetic. Stripe only honours an
      // idempotency key when EVERY parameter matches the first use. A raw
      // `Date.now()` differs by milliseconds between two calls, so the retry
      // this key exists to collapse was instead rejected with
      // StripeIdempotencyError — which the checkout route turns into "We could
      // not start the payment" for a customer who should simply have been handed
      // the session that already existed. Found by a real test-mode call, not by
      // reading the code. Rounding the base to the hour makes two calls in the
      // same hour byte-identical, so the key does what its name says; expiry
      // lands 24-25h out, which is the same promise as before.
      expires_at: Math.floor(Date.now() / (60 * 60 * 1000)) * (60 * 60) + 24 * 60 * 60,
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
      allow_promotion_codes: false,
      billing_address_collection: 'auto',
      phone_number_collection: { enabled: false },
    },
    params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : undefined
  )
}

// Capture the held $49 (used when a booking is APPROVED).
//
// The optional idempotencyKey is a second line of defense against a
// double-capture: even if two approvals race past the DB claim, Stripe collapses
// two captures that share a key into a single charge. Callers pass a key derived
// from the payment intent so retries of the SAME capture dedupe, while a genuine
// re-auth (new PI) is unaffected.
export async function captureDeposit(
  paymentIntentId: string,
  idempotencyKey?: string
): Promise<Stripe.PaymentIntent> {
  return getStripeClient().paymentIntents.capture(
    paymentIntentId,
    undefined,
    idempotencyKey ? { idempotencyKey } : undefined
  )
}

// After a capture, pull the resulting Charge so callers can persist + display
// the charge id, the hosted receipt URL, and the payment-method type (none of
// which live on the PaymentIntent itself). Best-effort: returns null when the
// PI has no charge yet or the retrieve fails, so it can never break approval.
export async function retrieveChargeForIntent(
  pi: Stripe.PaymentIntent
): Promise<Stripe.Charge | null> {
  const chargeId = typeof pi.latest_charge === 'string' ? pi.latest_charge : pi.latest_charge?.id
  if (!chargeId) return null
  try {
    return await getStripeClient().charges.retrieve(chargeId)
  } catch {
    return null
  }
}

// Cancel the authorization to RELEASE the hold (used when a booking is DENIED
// before capture — no money ever moves, nothing to refund).
export async function cancelDeposit(paymentIntentId: string): Promise<Stripe.PaymentIntent> {
  return getStripeClient().paymentIntents.cancel(paymentIntentId)
}

// Refund a deposit that was already CAPTURED (fallback for denials after capture).
export async function refundDeposit(paymentIntentId: string): Promise<Stripe.Refund> {
  return getStripeClient().refunds.create({
    payment_intent: paymentIntentId,
    reason: 'requested_by_customer',
    metadata: { reason: 'booking_denied' },
  })
}

export function constructWebhookEvent(
  payload: string | Buffer,
  signature: string
): Stripe.Event {
  return getStripeClient().webhooks.constructEvent(
    payload,
    signature,
    requiredEnv('STRIPE_WEBHOOK_SECRET')
  )
}

export function applyDiscount(baseAmount: number, percentOff: number): {
  discountAmount: number
  finalAmount: number
} {
  const discountAmount = Math.round(baseAmount * (percentOff / 100) * 100) / 100
  return {
    discountAmount,
    finalAmount: Math.max(0, baseAmount - discountAmount),
  }
}
