import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/email-tokens'
import { unsubscribeEmail, resubscribe } from '@/lib/email-suppression'
import { apiLogger } from '@/lib/logger'

// ════════════════════════════════════════════════════════════════════════
//  UNSUBSCRIBE  —  /api/email/unsubscribe?token=SIGNED_TOKEN
//  ----------------------------------------------------------------------
//  THE GAP THIS CLOSED ORIGINALLY: every promotional template referenced an
//  unsubscribe link and the worker was ready to emit RFC 8058 headers, but the
//  ROUTE DID NOT EXIST. Promotional mail with no working unsubscribe is a
//  CAN-SPAM violation.
//
//  TWO CORRECTIONS SINCE (audit findings EMAIL-P1-07, EMAIL-P1-08):
//
//  1. GET NO LONGER MUTATES.
//     A browser GET used to unsubscribe immediately. Corporate link scanners,
//     spam filters, and mail-client link prefetchers follow every URL in an
//     email — so a security appliance could silently unsubscribe a customer who
//     never clicked anything, and the customer would never know why the mail
//     stopped. GET now only RENDERS a confirmation; the button POSTs.
//     RFC 8058 one-click still works, because that is a POST by specification.
//
//  2. THE PAGE TELLS THE TRUTH.
//     `unsubscribeEmail()` used to return a bare boolean where `false` meant
//     both "already unsubscribed" and "the database write failed" — and this
//     route showed a success page either way. A customer could be told their
//     preferences were saved when nothing had been written. Every outcome now
//     has its own page, and a failed write says so and asks them to try again.
//
//  Authorization is the signed HMAC token (src/lib/email-tokens): no login, not
//  enumerable, and the address never appears in the URL, so it cannot leak via
//  referrer headers or server logs.
//
//  A hard suppression (bounce/complaint) is NEVER lifted here — see
//  src/lib/email-suppression.resubscribe().
// ════════════════════════════════════════════════════════════════════════

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const BRAND = { navy: '#0D1A2D', bone: '#F7F7F2', ember: '#FF6A00', gold: '#C9A961' }
const SUPPORT = 'hello@moveitclearit.com'

type PageOpts = {
  title: string
  body: string
  token?: string
  /** Renders the primary "confirm unsubscribe" button (GET confirmation view). */
  confirm?: boolean
  /** Renders the secondary "keep me subscribed" action (post-unsubscribe view). */
  resubscribe?: boolean
  /** Renders a "try again" button (write-failure view). */
  retry?: boolean
  status?: number
}

function page(opts: PageOpts): Response {
  const t = opts.token ? encodeURIComponent(opts.token) : ''
  const action = `/api/email/unsubscribe?token=${t}`

  const confirmBtn = opts.confirm
    ? `<form method="POST" action="${action}"><button type="submit" class="btn">Yes, unsubscribe me</button></form>`
    : ''
  const retryBtn = opts.retry
    ? `<form method="POST" action="${action}"><button type="submit" class="btn">Try again</button></form>`
    : ''
  const resubscribeBtn = opts.resubscribe
    ? `<form method="POST" action="${action}&amp;action=resubscribe"><button type="submit" class="link">Actually, keep me subscribed</button></form>`
    : ''

  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${opts.title} — Move It Clear It</title>
<style>
  :root { color-scheme: light; }
  body { margin:0; padding:32px 20px; background:${BRAND.bone}; color:${BRAND.navy};
         font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;
         line-height:1.55; }
  .card { max-width:520px; margin:0 auto; background:#fff; border-radius:14px;
          padding:32px 28px; border:1px solid rgba(13,26,45,.08); }
  h1 { margin:0 0 14px; font-size:22px; letter-spacing:-.01em; }
  p { margin:0 0 14px; font-size:16px; }
  .rule { height:3px; width:52px; background:${BRAND.ember}; border-radius:2px; margin:0 0 22px; }
  .muted { color:rgba(13,26,45,.62); font-size:14px; }
  .brand { margin-top:26px; padding-top:18px; border-top:1px solid rgba(13,26,45,.08);
           font-size:13px; color:rgba(13,26,45,.55); }
  .btn { display:inline-block; background:${BRAND.ember}; color:#fff; border:0;
         padding:12px 22px; border-radius:8px; font:inherit; font-weight:700;
         font-size:15px; cursor:pointer; margin:4px 0 12px; }
  .link { background:none; border:0; padding:0; font:inherit; font-size:15px;
          color:${BRAND.ember}; text-decoration:underline; cursor:pointer; }
  a { color:${BRAND.ember}; }
  .gold { color:${BRAND.gold}; }
</style></head>
<body><div class="card">
  <div class="rule"></div>
  <h1>${opts.title}</h1>
  ${opts.body}
  ${confirmBtn}${retryBtn}${resubscribeBtn}
  <div class="brand"><strong class="gold">Move It Clear It</strong> &middot; Labor-only moving help &middot;
    <a href="https://www.moveitclearit.com">moveitclearit.com</a></div>
</div></body></html>`

  return new Response(html, {
    status: opts.status ?? 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

const invalidPage = () =>
  page({
    status: 400,
    title: 'This link is no longer valid',
    body: `<p>We could not verify this unsubscribe link. It may have been altered in transit,
             or it may be very old.</p>
           <p class="muted">You can still stop all marketing email by replying
             <strong>STOP</strong> to any message from us, or emailing
             <a href="mailto:${SUPPORT}">${SUPPORT}</a>. We handle those by hand, every time.</p>`,
  })

const UNSUBSCRIBED_BODY = `<p>We have stopped all marketing email to this address. It can take a few
     minutes to take effect everywhere.</p>
   <p class="muted">You will still get messages about a move you have actually booked —
     receipts, schedule changes, and move-day details. Those are not marketing, and most
     people want them.</p>`

/** The write failed. Say so — never claim a preference change that did not happen. */
const failurePage = (token?: string) =>
  page({
    status: 500,
    title: "That didn't save",
    body: `<p>Something went wrong on our end and your preference was <strong>not</strong>
             saved. You may still receive marketing email.</p>
           <p class="muted">Please try again. If it keeps failing, email
             <a href="mailto:${SUPPORT}">${SUPPORT}</a> and we will remove you by hand —
             that always works.</p>`,
    token,
    retry: true,
  })

/**
 * GET — CONFIRMATION ONLY. Never mutates (finding EMAIL-P1-08).
 * Safe for link scanners, spam filters and client prefetchers to follow.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const token = req.nextUrl.searchParams.get('token')?.trim()
  const verified = verifyToken(token, 'unsubscribe')
  if (!verified) return invalidPage()

  return page({
    title: 'Unsubscribe from marketing email?',
    body: `<p>Confirm and we will stop sending you moving tips and offers.</p>
           <p class="muted">You will still get messages about a move you have actually
             booked — receipts, schedule changes, and move-day details.</p>`,
    token: token ?? undefined,
    confirm: true,
  })
}

/**
 * POST — the mutating path.
 *  • RFC 8058 one-click: Gmail/Yahoo POST here with no user interaction, so it
 *    must unsubscribe immediately, with no confirmation step, and answer fast.
 *  • The human confirmation form on the GET page posts here too.
 *  • `?action=resubscribe` is the "keep me subscribed" form.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const token = req.nextUrl.searchParams.get('token')?.trim()
  const action = req.nextUrl.searchParams.get('action')?.trim()
  const verified = verifyToken(token, 'unsubscribe')
  const wantsHtml = (req.headers.get('accept') ?? '').includes('text/html')

  if (!verified) {
    return wantsHtml ? invalidPage() : NextResponse.json({ ok: false, error: 'invalid_token' }, { status: 400 })
  }

  // ── Resubscribe ───────────────────────────────────────────────────────
  if (action === 'resubscribe') {
    const result = await resubscribe(verified.email)

    switch (result.status) {
      case 'hard_suppression_refused':
        return page({
          title: "We can't re-add this address",
          body: `<p>This address was removed because mail to it bounced permanently or was
                   reported as spam. Re-adding it automatically would put our delivery to
                   every other customer at risk.</p>
                 <p class="muted">If that was a mistake, email
                   <a href="mailto:${SUPPORT}">${SUPPORT}</a> and we will sort it out with
                   you directly.</p>`,
        })
      case 'write_failed':
        apiLogger.error({ err: String(result.error) }, 'resubscribe write FAILED — customer told the truth')
        return page({
          status: 500,
          title: "That didn't save",
          body: `<p>Something went wrong on our end and you were <strong>not</strong> added
                   back. You are still unsubscribed.</p>
                 <p class="muted">Please try again, or email
                   <a href="mailto:${SUPPORT}">${SUPPORT}</a>.</p>`,
          token: token ?? undefined,
        })
      case 'not_suppressed':
        return page({
          title: "You're already subscribed",
          body: `<p>This address was not on our unsubscribe list, so nothing needed to
                   change. You will keep receiving occasional moving tips and offers.</p>`,
        })
      case 'removed':
        return page({
          title: 'You are back on the list',
          body: `<p>We will send you occasional moving tips and offers again. You can change
                   your mind at any time — every email has an unsubscribe link.</p>`,
        })
    }
  }

  // ── Unsubscribe ───────────────────────────────────────────────────────
  const result = await unsubscribeEmail(verified.email, 'unsubscribe-link')

  if (result.status === 'write_failed') {
    apiLogger.error({ err: String(result.error) }, 'unsubscribe write FAILED — customer told the truth')
    // One-click callers get a real failure code so the mail client can surface it.
    return wantsHtml
      ? failurePage(token ?? undefined)
      : NextResponse.json({ ok: false, error: 'write_failed' }, { status: 500 })
  }

  if (!result.mirrored) {
    // The authoritative suppression IS written, so the customer is genuinely
    // unsubscribed; only the legacy Customer flag lagged. Worth an alert, not a
    // scary page — telling them it failed would itself be untrue.
    apiLogger.warn(
      'unsubscribe suppression written but Customer.marketingOptOut mirror failed — sends are still blocked'
    )
  }

  if (!wantsHtml) return NextResponse.json({ ok: true, status: result.status }, { status: 200 })

  return page({
    title: result.status === 'already_unsubscribed' ? 'You were already unsubscribed' : "You're unsubscribed",
    body: UNSUBSCRIBED_BODY,
    token: token ?? undefined,
    resubscribe: true,
  })
}
