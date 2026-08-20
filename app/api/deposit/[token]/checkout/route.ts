import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { createDepositCheckout } from '@/lib/stripe'
import { apiLogger } from '@/lib/logger'
import { rateLimit, tooManyRequests, clientIp, LIMITS } from '@/lib/rate-limit'
import { isValidPublicToken, depositBaseUrl } from '@/lib/deposit-links'
import { isSameOrigin, depositReturnBase } from '@/lib/deposit-origin'
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

// The origin rules live in src/lib/deposit-origin.ts so they can be tested
// directly. A Next route file may not export helpers, and a guard this route
// depends on for a 403 is not something to verify by grepping the source.
//
// This route is PUBLIC (no session, no CSRF cookie -- the middleware matcher
// does not cover /api/deposit), so `isSameOrigin` is the only origin check
// there is. It compares the browser Origin against the FORWARDED host: the
// customer reaches this app through a Vercel rewrite, so the proxied Host is
// not the host the browser believes it is on, and comparing the two 403d the
// Pay button for every browser that omits Sec-Fetch-Site.

/**
 * 'en' | 'es' from the QUERY STRING. Anything else is English.
 *
 * Deliberately NOT from the request body. This route's standing guarantee is
 * that it never reads a body at all — that is what makes "no field a tampered
 * client could change" checkable in one line rather than argued about. A
 * two-value enum in the query string carries the language without reopening
 * that door, and it cannot reach the amount: the charge is built from
 * `row.amountCents` and nothing else.
 */
function readLang(req: NextRequest): 'en' | 'es' {
  return req.nextUrl.searchParams.get('lang') === 'es' ? 'es' : 'en'
}

export async function POST(req: NextRequest, { params }: { params: { token: string } }): Promise<NextResponse> {
  const token = params.token

  // Shape-check before touching the database — a malformed token is never a
  // query, so this route is not a way to probe the table.
  if (!isValidPublicToken(token)) {
    return NextResponse.json({ error: 'This payment link is not valid.', code: 'not_valid' }, { status: 404 })
  }

  if (!isSameOrigin(req.headers)) {
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
  if (!row) return NextResponse.json({ error: 'This payment link is not valid.', code: 'not_valid' }, { status: 404 })

  // Refused BEFORE any Stripe call. `code` is what the page localizes.
  const refusal = payableOrReason(row)
  if (refusal) return NextResponse.json({ error: refusal.message, code: refusal.code }, { status: 409 })

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
    return NextResponse.json({ error: 'Please try again in a moment.', code: 'busy' }, { status: 409 })
  }

  // Same host the customer is actually on (validated), not a bare env var.
  const base = `${depositReturnBase(req.headers, depositBaseUrl())}/deposit/${row.publicToken}`
  // The language they were reading in, so Stripe speaks it and the return URL
  // comes back in it. Read from the body ONLY — there is no money in the body,
  // and an unrecognised value simply falls back to English.
  const lang = readLang(req)
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
      successUrl: `${base}?return=1&lang=${lang}`,
      cancelUrl: `${base}?canceled=1&lang=${lang}`,
      locale: lang,
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
