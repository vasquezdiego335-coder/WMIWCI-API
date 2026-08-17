// ════════════════════════════════════════════════════════════════════════
//  CHECKOUT SESSION DURABILITY (release blocker B9, 2026-08-14)
//  ---------------------------------------------------------------------
//  Two defects live on the public checkout path, and this module holds the
//  parts that must be identical wherever a $49 authorization session is made.
//
//  1. THE ORPHAN (app/api/bookings/route.ts). The Stripe session was created,
//     then a single UNGUARDED `booking.update` flipped DRAFT -> PENDING_PAYMENT
//     and recorded the session id. A failure in that one statement threw out of
//     the route, so the customer — who had already typed their name as a
//     signature on the Moving Service Agreement and burned a WMIC reference —
//     got an opaque network error, the owner alert never fired, and the row sat
//     in DRAFT where NOTHING can recover it (resume, the abandoned-checkout
//     worker and the recovery journey all key on PENDING_PAYMENT).
//
//  2. THE UNRECORDED SESSION (app/api/stripe/checkout/resume/route.ts). Every
//     click of a recovery link created a FRESH payable session, never expired
//     the previous one and never persisted the new id. Two live $49
//     authorizations could coexist; if both were completed, the second one is
//     claimed by nobody (fulfillment's atomic claim matches 0 rows), so it is
//     neither captured nor released and no human is told. That is the genuinely
//     money-shaped half of B9.
//
//  THE RULE THIS MODULE ENFORCES: at most ONE payable checkout session exists
//  per booking, and a session that exists is either recorded on the booking or
//  reported to a human. Nothing here claims a session was expired, paid or
//  released unless a Stripe call proved it.
//
//  Everything is dependency-injected so the whole flow runs offline in tests
//  (src/lib/__tests__/checkout-durability.test.ts). Nothing here captures,
//  refunds or releases money — session lifecycle only.
// ════════════════════════════════════════════════════════════════════════

import { prisma } from './db'
import { stripe } from './stripe'
import { apiLogger } from './logger'
import { postOpsAlert } from './ops-alert'

/** The fields of a Stripe Checkout Session this module reasons about. */
export type CheckoutSessionSnapshot = {
  id: string
  /** 'open' | 'complete' | 'expired' */
  status?: string | null
  /** 'paid' | 'unpaid' | 'no_payment_required' */
  payment_status?: string | null
}

export type AlertLine = { message: string; action?: string }

export type CheckoutLogger = {
  info(fields: Record<string, unknown>, message: string): void
  warn(fields: Record<string, unknown>, message: string): void
  error(fields: Record<string, unknown>, message: string): void
}

export type CheckoutSessionDeps = {
  /** Null when Stripe has no such session. THROWS on a transport failure — the
   *  difference matters: "no session" is safe, "cannot tell" is not. */
  retrieveSession(sessionId: string): Promise<CheckoutSessionSnapshot | null>
  expireSession(sessionId: string): Promise<void>
  recordSessionId(bookingId: string, sessionId: string): Promise<void>
  alert(title: string, lines: AlertLine[]): Promise<{ delivered: boolean }>
  log: CheckoutLogger
  now(): number
}

export function defaultCheckoutSessionDeps(): CheckoutSessionDeps {
  return {
    async retrieveSession(sessionId) {
      const s = await stripe.checkout.sessions.retrieve(sessionId)
      if (!s) return null
      return { id: s.id, status: s.status ?? null, payment_status: s.payment_status ?? null }
    },
    async expireSession(sessionId) {
      await stripe.checkout.sessions.expire(sessionId)
    },
    async recordSessionId(bookingId, sessionId) {
      // `select` on a write whose result is discarded — the same P0-E rule the
      // rest of the codebase follows, so this statement can never be the one to
      // discover a column the database does not have yet.
      await prisma.booking.update({
        where: { id: bookingId },
        data: { stripeCheckoutId: sessionId },
        select: { id: true },
      })
    },
    async alert(title, lines) {
      return postOpsAlert(title, lines)
    },
    log: apiLogger,
    now: () => Date.now(),
  }
}

// ── Idempotency ─────────────────────────────────────────────────────────────
//
// WHY NOT A BARE BOOKING ID. Stripe replays an idempotent request for 24 HOURS,
// while createBookingCheckout sets `expires_at` 30 MINUTES out. A key that is
// only the booking id would therefore hand a customer back a session that died
// hours ago — a checkout page that cannot be paid. The key carries two more
// components instead:
//
//   • the session it REPLACES, so a resume click that retires session A and a
//     concurrent click that saw the same A collapse into ONE new session, while
//     a later click (which sees the newly recorded id) gets a genuinely new one;
//   • a coarse time window, SHORTER than the session lifetime, so a replay can
//     only ever return a session with most of its life left.
//
// Anything longer than the session TTL would resurrect dead checkouts; anything
// shorter than a request's own retry budget would stop deduplicating.

/** Mirrors the `expires_at` in createBookingCheckout (src/lib/stripe.ts). The
 *  parity test in checkout-durability.test.ts fails if the two drift. */
export const CHECKOUT_SESSION_TTL_MINUTES = 30

/** Retries inside this window reuse the SAME Stripe session. Must stay well
 *  under CHECKOUT_SESSION_TTL_MINUTES (see above). */
export const CHECKOUT_IDEMPOTENCY_WINDOW_MS = 5 * 60 * 1000

export function checkoutIdempotencyKey(input: {
  bookingId: string
  /** The session id currently recorded on the booking, if any. */
  previousSessionId?: string | null
  now?: number
}): string {
  const previous = input.previousSessionId?.trim() || 'first'
  const window = Math.floor((input.now ?? Date.now()) / CHECKOUT_IDEMPOTENCY_WINDOW_MS)
  return `checkout:${input.bookingId}:${previous}:${window}`
}

// ── The previous session ────────────────────────────────────────────────────

export type PreviousSessionVerdict = 'none' | 'authorized' | 'open' | 'gone'

/**
 * What the recorded session IS, from Stripe's own answer.
 *
 * MANUAL CAPTURE GOTCHA: these sessions are `capture_method: 'manual'`, so a
 * customer who completed checkout leaves `payment_status: 'unpaid'` — the money
 * is authorized, not captured. `status === 'complete'` is therefore THE signal
 * that a card was already authorized; keying on payment_status alone would let
 * a second $49 authorization be created on top of a live one.
 */
export function previousSessionVerdict(
  session: CheckoutSessionSnapshot | null | undefined
): PreviousSessionVerdict {
  if (!session) return 'none'
  if (session.status === 'complete') return 'authorized'
  if (session.payment_status === 'paid' || session.payment_status === 'no_payment_required') return 'authorized'
  if (session.status === 'expired') return 'gone'
  // 'open' — and anything Stripe might add later — is treated as LIVE, because
  // the safe assumption about a session we cannot classify is that it is payable.
  return 'open'
}

export type RetireOutcome =
  /** Safe to create a new session. */
  | { ok: true; verdict: 'none' | 'gone' | 'retired' }
  /** The card was already authorized on the recorded session — never create a second. */
  | { ok: false; verdict: 'authorized'; sessionId: string }
  /** Stripe could not confirm the old session is dead — refuse rather than risk two. */
  | { ok: false; verdict: 'unverified'; sessionId: string; reason: string }

/**
 * Make sure the session recorded on a booking can no longer be paid, so the
 * caller may create exactly one replacement.
 *
 * Never expires a COMPLETED session (nothing to expire, and the caller must
 * stop anyway) and never reports a session retired unless Stripe accepted the
 * expire call.
 */
export async function retirePreviousCheckoutSession(
  deps: CheckoutSessionDeps,
  input: { bookingId: string; sessionId?: string | null }
): Promise<RetireOutcome> {
  const sessionId = input.sessionId?.trim()
  if (!sessionId) return { ok: true, verdict: 'none' }

  let snapshot: CheckoutSessionSnapshot | null
  try {
    snapshot = await deps.retrieveSession(sessionId)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    deps.log.error(
      { bookingId: input.bookingId, sessionId },
      'checkout: could not read the recorded Stripe session — refusing to create a second one'
    )
    return { ok: false, verdict: 'unverified', sessionId, reason }
  }

  const verdict = previousSessionVerdict(snapshot)
  if (verdict === 'authorized') {
    deps.log.error(
      { bookingId: input.bookingId, sessionId },
      'checkout: the recorded Stripe session is already completed — no second session will be created'
    )
    return { ok: false, verdict: 'authorized', sessionId }
  }
  if (verdict !== 'open') {
    return { ok: true, verdict: verdict === 'none' ? 'none' : 'gone' }
  }

  try {
    await deps.expireSession(sessionId)
    deps.log.info({ bookingId: input.bookingId, sessionId }, 'checkout: previous session expired')
    return { ok: true, verdict: 'retired' }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    deps.log.error(
      { bookingId: input.bookingId, sessionId },
      'checkout: could not expire the previous Stripe session — refusing to create a second one'
    )
    return { ok: false, verdict: 'unverified', sessionId, reason }
  }
}

// ── Recording ───────────────────────────────────────────────────────────────

/**
 * Persist the session id on the booking. NEVER throws: the caller decides what
 * an unrecorded session costs, and that decision differs by path (the public
 * form must still hand the customer their checkout; the resume link must not
 * leave a payable session nobody can see).
 */
export async function recordCheckoutSession(
  deps: CheckoutSessionDeps,
  input: { bookingId: string; sessionId: string }
): Promise<boolean> {
  try {
    await deps.recordSessionId(input.bookingId, input.sessionId)
    return true
  } catch (err) {
    deps.log.error(
      { bookingId: input.bookingId, sessionId: input.sessionId, err: err instanceof Error ? err.message : String(err) },
      'checkout: could not record the Stripe session id on the booking'
    )
    return false
  }
}

/** Did we manage to make an unrecorded session unpayable?
 *   • 'yes'     — Stripe accepted the expire call (provable).
 *   • 'unknown' — we tried and Stripe did not confirm.
 *   • 'kept'    — we deliberately did not try, because the customer is holding
 *                 that checkout page (the public form's rule).
 *  Alerts are only ever allowed to say what this value proves. */
export type ExpiredOutcome = 'yes' | 'unknown' | 'kept'

/**
 * Best-effort teardown of a session we created but could not record. Returns
 * what we can PROVE, so no message has to guess.
 */
export async function abandonCheckoutSession(
  deps: CheckoutSessionDeps,
  input: { bookingId: string; sessionId: string }
): Promise<ExpiredOutcome> {
  try {
    await deps.expireSession(input.sessionId)
    deps.log.warn(
      { bookingId: input.bookingId, sessionId: input.sessionId },
      'checkout: expired an unrecorded session so it cannot be paid'
    )
    return 'yes'
  } catch (err) {
    deps.log.error(
      { bookingId: input.bookingId, sessionId: input.sessionId, err: err instanceof Error ? err.message : String(err) },
      'checkout: could not expire an unrecorded session'
    )
    return 'unknown'
  }
}

// ── Owner alerts ────────────────────────────────────────────────────────────
//
// House rule: no message may claim money was captured, released, refunded,
// charged or scheduled unless the code can prove it. These builders are pure so
// the wording is testable — an alert about a payment problem must not invent a
// payment fact while reporting one.

export type OpsAlertDraft = { title: string; lines: AlertLine[] }

/** The recorded session is already COMPLETE while the booking still reads
 *  unpaid — an authorization exists that this database does not know about. */
export function authorizedSessionAlert(input: {
  bookingId: string
  displayId?: string | null
  sessionId: string
}): OpsAlertDraft {
  const ref = input.displayId?.trim() || input.bookingId
  return {
    title: 'Checkout already completed — booking still reads awaiting payment',
    lines: [
      {
        message: `Booking ${ref} has a COMPLETED Stripe checkout session (${input.sessionId}) but the booking record still says the deposit is not paid.`,
        action: 'Open this session in Stripe and check whether a $49 authorization exists before anyone asks the customer to pay again.',
      },
      {
        message: 'No new checkout session was created, so the customer cannot be authorized twice by this link.',
      },
    ],
  }
}

/** A session was created that the booking does not carry. */
export function unrecordedSessionAlert(input: {
  context: 'public_create' | 'resume'
  bookingId: string
  displayId?: string | null
  sessionId: string
  expired: ExpiredOutcome
  /** True when the customer was handed this session's URL anyway. */
  handedToCustomer: boolean
}): OpsAlertDraft {
  const ref = input.displayId?.trim() || input.bookingId
  const where = input.context === 'public_create' ? 'the public booking form' : 'a checkout resume link'
  const lines: AlertLine[] = [
    {
      message: `A Stripe checkout session (${input.sessionId}) was created for booking ${ref} from ${where}, but the id could not be saved on the booking.`,
      action: 'Open the booking in Stripe and confirm how many sessions exist for it.',
    },
  ]
  if (input.expired === 'yes') {
    lines.push({ message: 'Stripe accepted a request to expire that session, so it can no longer be paid.' })
  } else if (input.expired === 'unknown') {
    lines.push({
      message: 'It is NOT known whether that session is still payable — Stripe did not confirm the expiry.',
      action: 'Expire it by hand in the Stripe dashboard if it is still open.',
    })
  } else {
    lines.push({
      message: 'That session was deliberately left open so the customer keeps their checkout page.',
    })
  }
  if (input.handedToCustomer) {
    lines.push({
      message: 'The customer was sent to this checkout page, so they may still complete it.',
    })
  }
  return { title: 'Checkout session not recorded on its booking', lines }
}
