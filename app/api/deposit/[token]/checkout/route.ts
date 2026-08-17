import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { createDepositCheckout } from '@/lib/stripe'
import { apiLogger } from '@/lib/logger'
import { rateLimit, tooManyRequests, clientIp, LIMITS } from '@/lib/rate-limit'
import { isValidPublicToken, depositUrl } from '@/lib/deposit-links'
import { claimCheckoutSession, recordCheckoutSession, payableOrReason } from '@/lib/deposit-service'

// ════════════════════════════════════════════════════════════════════════════
//  POST /api/deposit/[token]/checkout
//  ------------------------------------------------------------------------
//  Creates (or REUSES) the Stripe Checkout Session for one deposit link.
//
//  THE AMOUNT IS NEVER READ FROM THE REQUEST. The body is ignored entirely —
//  there is no field to tamper with. The charge is built from the
//  DepositRequest row, server-side, in integer cents.
//
//  DOUBLE-CLICK SAFETY, in three layers:
//    1. a live session is REUSED, so the second tap opens the same page
//    2. minting is gated by a conditional UPDATE on checkout_attempts, so two
//       simultaneous requests cannot both mint
//    3. the winner passes a Stripe idempotency key derived from that attempt
//       number, so even a retried API call collapses to one session
//
//  PAYING TWICE IS IMPOSSIBLE HERE: `payableOrReason` refuses a link that is
//  already PAID before any Stripe call, and the webhook's `paid_at IS NULL`
//  claim refuses a second credit even if a stale session were somehow completed.
// ════════════════════════════════════════════════════════════════════════════

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const log = apiLogger.child({ mod: 'deposit-checkout' })

/**
 * Cross-site POST guard.
 *
 * This route is public (no session, no CSRF cookie — the middleware matcher
 * does not cover /api/deposit). The worst a forged cross-site POST could do is
 * create an unused Checkout Session, but "harmless today" is not a reason to
 * leave a state-changing endpoint open to any origin. Same-origin requests set
 * either Sec-Fetch-Site or an Origin we can compare; anything else is refused.
 */
function sameOriginOk(req: NextRequest): boolean {
  const fetchSite = req.headers.get('sec-fetch-site')
  if (fetchSite) return fetchSite === 'same-origin' || fetchSite === 'none'
  const origin = req.headers.get('origin')
  if (!origin) return true // non-browser client (curl, health check) — allowed
  try {
    return new URL(origin).host === new URL(req.url).host
  } catch {
    return false
  }
}

export async function POST(req: NextRequest, { params }: { params: { token: string } }): Promise<NextResponse> {
  const token = params.token

  // Shape-check before touching the database — a malformed token is never a
  // query, so this route is not a way to probe the table.
  if (!isValidPublicToken(token)) {
    return NextResponse.json({ error: 'This payment link is not valid.' }, { status: 404 })
  }

  if (!sameOriginOk(req)) {
    return NextResponse.json({ error: 'Invalid request origin' }, { status: 403 })
  }

  // Per-IP and per-token. The token bucket is what stops one link being hammered
  // into hundreds of Stripe sessions; the IP bucket stops broad enumeration.
  const limited = await rateLimit(LIMITS.depositCheckout, [clientIp(req), `token:${token}`])
  if (!limited.ok) return tooManyRequests(limited)

  const row = await prisma.depositRequest.findUnique({
    where: { publicToken: token },
    select: {
      id: true,
      publicToken: true,
      amountCents: true,
      customerEmail: true,
      customerName: true,
      serviceSummary: true,
      status: true,
      expiresAt: true,
      paidAt: true,
      bookingId: true,
      booking: { select: { bookingReference: true, displayId: true } },
    },
  })
  if (!row) return NextResponse.json({ error: 'This payment link is not valid.' }, { status: 404 })

  const refusal = payableOrReason(row)
  if (refusal) return NextResponse.json({ error: refusal }, { status: 409 })

  const claim = await claimCheckoutSession(row.id)
  if (claim.kind === 'reuse') {
    return NextResponse.json({ url: claim.url, reused: true })
  }
  if (claim.kind === 'busy') {
    // Another tap won by milliseconds. Re-read rather than mint a rival session.
    const fresh = await prisma.depositRequest.findUnique({
      where: { id: row.id },
      select: { stripeCheckoutUrl: true },
    })
    if (fresh?.stripeCheckoutUrl) return NextResponse.json({ url: fresh.stripeCheckoutUrl, reused: true })
    return NextResponse.json({ error: 'Please try again in a moment.' }, { status: 409 })
  }

  const base = depositUrl(row.publicToken)
  try {
    const session = await createDepositCheckout({
      depositRequestId: row.id,
      // THE authoritative amount — straight off the row, never off the request.
      amountCents: row.amountCents,
      publicToken: row.publicToken,
      customerEmail: row.customerEmail,
      customerName: row.customerName,
      bookingId: row.bookingId,
      bookingReference: row.booking?.bookingReference ?? row.booking?.displayId ?? null,
      serviceSummary: row.serviceSummary,
      // `return=1` means only "the browser came back". Confirmation is the
      // webhook's job; the page polls the server before it says anything.
      successUrl: `${base}?return=1`,
      cancelUrl: `${base}?canceled=1`,
      idempotencyKey: `deposit_${row.id}_${claim.attempt}`,
    })

    await recordCheckoutSession(row.id, {
      id: session.id,
      url: session.url ?? null,
      expiresAt: session.expires_at ? new Date(session.expires_at * 1000) : null,
    })

    if (!session.url) {
      log.error({ depositRequestId: row.id, sessionId: session.id }, 'Stripe returned a session with no URL')
      return NextResponse.json({ error: 'We could not start the payment. Please text us and we will help.' }, { status: 502 })
    }
    return NextResponse.json({ url: session.url })
  } catch (err) {
    // Never echo a Stripe error to a customer — it can name internal ids.
    log.error(
      { depositRequestId: row.id, err: err instanceof Error ? err.message : String(err) },
      'deposit checkout session creation failed'
    )
    return NextResponse.json({ error: 'We could not start the payment. Please text us and we will help.' }, { status: 502 })
  }
}
