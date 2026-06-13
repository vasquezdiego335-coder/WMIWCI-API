import Stripe from 'stripe'

// $49 booking authorization — HELD (not captured) until an admin approves.
// Override via STRIPE_BOOKING_FEE_CENTS.
export const BOOKING_FEE_CENTS = Number(process.env.STRIPE_BOOKING_FEE_CENTS ?? 4900)

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
}): Promise<Stripe.Checkout.Session> {
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
      },
    },
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: BOOKING_FEE_CENTS,
          product_data: {
            name: 'Moving Service Booking Hold',
            description: `$49 authorized today — held, not charged until we approve - ${params.description}`,
          },
        },
      },
    ],
    metadata: {
      bookingId: params.bookingId,
      amountType: 'booking_fee',
      // ── Moving Service Agreement (legal traceability on the payment) ──
      agreementAccepted: params.agreementAccepted ? 'true' : 'false',
      agreementVersion: params.agreementVersion ?? '',
      agreementName: (params.agreementName ?? '').slice(0, 200),
    },
    expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
    allow_promotion_codes: false,
    billing_address_collection: 'auto',
    phone_number_collection: { enabled: false },
  })
}

// Capture the held $49 (used when a booking is APPROVED).
export async function captureDeposit(paymentIntentId: string): Promise<Stripe.PaymentIntent> {
  return getStripeClient().paymentIntents.capture(paymentIntentId)
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
