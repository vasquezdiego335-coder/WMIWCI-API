import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { createBookingCheckout } from '@/lib/stripe'
import { apiLogger } from '@/lib/logger'
import { rateLimit, tooManyRequests, LIMITS, clientIp } from '@/lib/rate-limit'
import { AGREEMENT_VERSION } from '@/lib/agreement'
import {
  abandonCheckoutSession,
  authorizedSessionAlert,
  checkoutIdempotencyKey,
  defaultCheckoutSessionDeps,
  recordCheckoutSession,
  retirePreviousCheckoutSession,
  unrecordedSessionAlert,
} from '@/lib/checkout-session'

// ════════════════════════════════════════════════════════════════════════
//  GET /api/stripe/checkout/resume?booking=<id>
//
//  THE MISSING DESTINATION (link audit 2026-07-25). All three
//  abandoned-checkout recovery emails linked to
//  `${APP_URL}/api/stripe/checkout?resume=<id>` — a route that never existed
//  (app/api/stripe/checkout has only cancel/ and success/, and nothing handled
//  a `resume` param). Every "finish your booking" button in that journey was a
//  404. The journey is flag-gated off, so no customer has hit it yet.
//
//  What this does: for a booking that is genuinely still awaiting its deposit,
//  create a FRESH Stripe Checkout session — the same $49 manual-capture
//  authorization the public booking flow creates — and redirect the customer
//  into it. Stripe sessions expire 30 MINUTES after creation (the `expires_at`
//  in createBookingCheckout — this comment used to say ~24h, which is Stripe's
//  idempotency-replay window, not the session lifetime), so a stale one cannot
//  simply be re-opened; a new session is the only correct way to resume.
//
//  DELIBERATE GUARDS (each one prevents a way a customer could be wronged):
//    • PRE-PAYMENT statuses only (RESUMABLE_STATUSES below). A booking that
//      already advanced (approved, confirmed, cancelled, completed) redirects
//      to its portal instead of being sent to pay again.
//    • depositPaid ⇒ never a new session. This is the double-charge guard: a
//      paid customer can never be walked into a second authorization.
//    • ONE PAYABLE SESSION PER BOOKING (release blocker B9). The recorded
//      session is inspected and expired BEFORE a replacement is created, and
//      the new id is persisted before the customer is sent to it. This route
//      used to mint a fresh payable session on every click, persist nothing,
//      and expire nothing — so two live $49 authorizations could exist at
//      once. If both had been completed, the second one is claimed by nobody
//      (fulfillment's atomic claim matches zero rows), so it would have been
//      neither captured nor released and nobody would have been told.
//    • If Stripe says the recorded session is already COMPLETE, no second
//      session is created and the owner is alerted — a manual-capture session
//      stays `payment_status: unpaid` after the customer authorizes, so
//      `status: complete` is the signal that a card was already charged-in-
//      waiting for this booking.
//    • Internal test bookings are refused outright.
//    • Rate-limited by IP, and the id is an opaque cuid, so this is not a
//      usable enumeration surface.
//    • No payment is CAPTURED here. capture_method stays 'manual' (inherited
//      from createBookingCheckout) — funds are held until an owner approves,
//      exactly like the normal flow.
//
//  A GET is correct: it is the target of a link in an email client.
// ════════════════════════════════════════════════════════════════════════

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** THE statuses that are genuinely still awaiting a deposit.
 *
 *  PENDING_PAYMENT is the normal one. DRAFT is here for the bookings STRANDED
 *  BY B9: before the public form was fixed to create its row PENDING_PAYMENT,
 *  a failure in the single statement that promoted DRAFT -> PENDING_PAYMENT
 *  left a fully-completed booking — signed agreement, WMIC reference and all —
 *  in a status that this route, the abandoned-checkout worker and the recovery
 *  journey all refused. Those rows are pre-payment by definition (a paid
 *  checkout moves the booking to PENDING_APPROVAL), so letting the owner hand
 *  their customer a resume link is a repair, not a new way to charge anyone:
 *  every guard below still runs first, and the only DRAFT rows this system
 *  creates on purpose are internal test bookings, which are refused above it.
 *
 *  A booking that has ADVANCED (confirmed, cancelled, completed) is never here.
 */
const RESUMABLE_STATUSES: readonly string[] = ['PENDING_PAYMENT', 'DRAFT']

/** Where to send someone whose booking cannot be resumed. Never a dead end. */
function fallbackUrl(token?: string | null): string {
  const app = (process.env.APP_URL ?? '').replace(/\/+$/, '')
  const site = (process.env.MARKETING_SITE_URL?.trim() || 'https://www.moveitclearit.com').replace(/\/+$/, '')
  if (token && app) return `${app}/my-booking/${token}`
  return `${site}/booking-form.html?src=resume_unavailable`
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  // Accept `booking` (canonical) and `resume` (what the shipped emails used, so
  // any already-queued recovery email still works once this deploys).
  const id = (req.nextUrl.searchParams.get('booking') ?? req.nextUrl.searchParams.get('resume') ?? '').trim()
  if (!id || id.length > 60) {
    return NextResponse.redirect(fallbackUrl(), { status: 302 })
  }

  const rl = await rateLimit(LIMITS.booking, [clientIp(req)])
  if (!rl.ok) return tooManyRequests(rl)

  try {
    const booking = await prisma.booking.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        depositPaid: true,
        isInternalTest: true,
        customerToken: true,
        bookingReference: true,
        displayId: true,
        // The session this booking already has. Without it the route cannot
        // tell whether it is about to create a SECOND payable authorization.
        stripeCheckoutId: true,
        requestedDate: true,
        itemsDescription: true,
        customer: { select: { email: true, name: true } },
      },
    })

    if (!booking) {
      apiLogger.info({ id }, 'checkout resume: booking not found')
      return NextResponse.redirect(fallbackUrl(), { status: 302 })
    }
    if (booking.isInternalTest) {
      return NextResponse.redirect(fallbackUrl(booking.customerToken), { status: 302 })
    }
    // DOUBLE-CHARGE GUARD: already paid, or moved past payment → portal, not Stripe.
    if (booking.depositPaid || !RESUMABLE_STATUSES.includes(booking.status)) {
      apiLogger.info(
        { bookingId: booking.id, status: booking.status, depositPaid: booking.depositPaid },
        'checkout resume refused — booking is not awaiting a deposit'
      )
      return NextResponse.redirect(fallbackUrl(booking.customerToken), { status: 302 })
    }

    const appUrl = (process.env.APP_URL ?? '').replace(/\/+$/, '')
    const marketingUrl = (process.env.MARKETING_SITE_URL?.trim() || 'https://www.moveitclearit.com').replace(/\/+$/, '')
    const svcLabel = booking.itemsDescription?.split('\n')[0]?.replace('Service: ', '') ?? 'Moving service'
    const dateLabel = booking.requestedDate ? booking.requestedDate.toISOString().slice(0, 10) : 'date TBD'

    const deps = defaultCheckoutSessionDeps()

    // ── RETIRE FIRST, CREATE SECOND (B9) ──────────────────────────────────
    // The old session must be provably dead before a new payable one exists.
    // Anything short of proof — an already-completed session, or a Stripe call
    // that could not answer — refuses the click instead of risking two live
    // authorizations. Refusing costs the customer one retry; the alternative
    // costs somebody $49 that nothing in this system would ever capture,
    // release or even notice.
    const retired = await retirePreviousCheckoutSession(deps, {
      bookingId: booking.id,
      sessionId: booking.stripeCheckoutId,
    })
    if (!retired.ok) {
      if (retired.verdict === 'authorized') {
        const alert = authorizedSessionAlert({
          bookingId: booking.id,
          displayId: booking.displayId,
          sessionId: retired.sessionId,
        })
        await deps.alert(alert.title, alert.lines)
      }
      return NextResponse.redirect(fallbackUrl(booking.customerToken), { status: 302 })
    }

    const session = await createBookingCheckout({
      bookingId: booking.id,
      customerEmail: booking.customer.email,
      customerName: booking.customer.name,
      description: `${svcLabel} move - ${dateLabel}`,
      successUrl: `${appUrl}/api/stripe/checkout/success?session_id={CHECKOUT_SESSION_ID}&booking=${booking.id}`,
      cancelUrl: `${marketingUrl}/contact.html?cancelled=1`,
      agreementAccepted: true,
      agreementVersion: AGREEMENT_VERSION,
      // Two clicks of the same recovery email (or a retried request) inside the
      // idempotency window collapse into ONE session instead of two payable
      // ones. The key includes the session this one replaces, so the NEXT
      // genuine resume still gets a genuinely new session.
      idempotencyKey: checkoutIdempotencyKey({
        bookingId: booking.id,
        previousSessionId: booking.stripeCheckoutId,
      }),
      extraMetadata: {
        bookingReference: booking.bookingReference ?? '',
        resumed: 'true', // finance traceability: this session came from recovery
      },
    })

    if (!session.url) {
      apiLogger.error({ bookingId: booking.id }, 'checkout resume: Stripe returned no session url')
      // A session with no URL is unusable to the customer but still payable in
      // principle, and it is not on the booking — tear it down rather than
      // leave it behind.
      await abandonCheckoutSession(deps, { bookingId: booking.id, sessionId: session.id })
      return NextResponse.redirect(fallbackUrl(booking.customerToken), { status: 302 })
    }

    // ── RECORD BEFORE REDIRECT (B9) ───────────────────────────────────────
    // A session the booking does not carry is a session the next click cannot
    // expire, the owner cannot see and reconciliation cannot reach. If it
    // cannot be recorded it must not stay payable, so it is expired and the
    // customer is sent somewhere honest instead. The owner is told either way,
    // and the alert only claims the expiry Stripe actually confirmed.
    const recorded = await recordCheckoutSession(deps, { bookingId: booking.id, sessionId: session.id })
    if (!recorded) {
      const expired = await abandonCheckoutSession(deps, { bookingId: booking.id, sessionId: session.id })
      const alert = unrecordedSessionAlert({
        context: 'resume',
        bookingId: booking.id,
        displayId: booking.displayId,
        sessionId: session.id,
        expired,
        handedToCustomer: false,
      })
      await deps.alert(alert.title, alert.lines)
      return NextResponse.redirect(fallbackUrl(booking.customerToken), { status: 302 })
    }

    apiLogger.info(
      { bookingId: booking.id, sessionId: session.id, replaced: retired.verdict },
      'checkout resume: new session created'
    )
    return NextResponse.redirect(session.url, { status: 302 })
  } catch (err) {
    // Never show a Stripe/DB error to a customer who clicked a link in an email.
    apiLogger.error({ err: err instanceof Error ? err.message : String(err), id }, 'checkout resume failed')
    return NextResponse.redirect(fallbackUrl(), { status: 302 })
  }
}
