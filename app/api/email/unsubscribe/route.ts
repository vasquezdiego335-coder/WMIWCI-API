import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/email-tokens'
import { unsubscribeEmail, resubscribe } from '@/lib/email-suppression'

// ════════════════════════════════════════════════════════════════════════
//  UNSUBSCRIBE  —  GET/POST /api/email/unsubscribe?token=SIGNED_TOKEN
//  ----------------------------------------------------------------------
//  THE GAP THIS CLOSES: every promotional template referenced an unsubscribe
//  link, and src/workers/email.worker.ts was ready to emit the RFC 8058
//  List-Unsubscribe headers — but the ROUTE DID NOT EXIST. Templates fell back
//  to `'#'`, which the URL-safety gate then blocked. Promotional mail with no
//  working unsubscribe is a CAN-SPAM violation, so this was a release blocker.
//
//  DESIGN
//   • No login. The signed token IS the authorization (src/lib/email-tokens).
//   • Not enumerable. The token binds an HMAC to the ADDRESS — you cannot
//     unsubscribe someone else by guessing an id, and the address never appears
//     in the URL, so it does not leak into referrer headers or server logs.
//   • Idempotent. Unsubscribing twice is a success, not an error.
//   • POST = RFC 8058 one-click (what Gmail/Yahoo call when the user hits the
//     mail client's own "unsubscribe" button). It must succeed WITHOUT the user
//     ever seeing a page and without a confirmation step.
//   • GET  = the human page: confirms the result and offers a resubscribe.
//
//  A hard suppression (bounce/complaint) is NEVER lifted here — see
//  src/lib/email-suppression.resubscribe().
// ════════════════════════════════════════════════════════════════════════

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const BRAND = {
  navy: '#0D1A2D',
  bone: '#F7F7F2',
  ember: '#FF6A00',
  gold: '#D4A24C',
}

function page(opts: { title: string; body: string; token?: string; showResubscribe?: boolean }): Response {
  const resubscribeForm =
    opts.showResubscribe && opts.token
      ? `<form method="POST" action="/api/email/unsubscribe?token=${encodeURIComponent(opts.token)}&action=resubscribe">
           <button type="submit" class="link">Actually, keep me subscribed</button>
         </form>`
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
  .link { background:none; border:0; padding:0; font:inherit; font-size:15px;
          color:${BRAND.ember}; text-decoration:underline; cursor:pointer; }
  a { color:${BRAND.ember}; }
  .gold { color:${BRAND.gold}; }
</style></head>
<body><div class="card">
  <div class="rule"></div>
  <h1>${opts.title}</h1>
  ${opts.body}
  ${resubscribeForm}
  <div class="brand"><strong class="gold">Move It Clear It</strong> &middot; Labor-only moving help &middot;
    <a href="https://www.moveitclearit.com">moveitclearit.com</a></div>
</div></body></html>`

  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

const invalidPage = () =>
  page({
    title: 'This link is no longer valid',
    body: `<p>We could not verify this unsubscribe link. It may have been altered in transit,
             or it may be very old.</p>
           <p class="muted">You can still stop all marketing email by replying
             <strong>STOP</strong> to any message from us, or emailing
             <a href="mailto:hello@moveitclearit.com">hello@moveitclearit.com</a>.
             We handle those by hand, every time.</p>`,
  })

/**
 * RFC 8058 one-click. Gmail/Yahoo POST here with no user interaction, so it must
 * unsubscribe immediately and answer 200 quickly. `?action=resubscribe` is the
 * human form on the GET page posting back.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const token = req.nextUrl.searchParams.get('token')?.trim()
  const action = req.nextUrl.searchParams.get('action')?.trim()
  const verified = verifyToken(token, 'unsubscribe')

  if (!verified) {
    // One-click callers want a status code, not a page.
    const wantsHtml = (req.headers.get('accept') ?? '').includes('text/html')
    return wantsHtml ? invalidPage() : NextResponse.json({ ok: false, error: 'invalid_token' }, { status: 400 })
  }

  if (action === 'resubscribe') {
    const result = await resubscribe(verified.email)
    if (result === 'refused_hard_suppression') {
      return page({
        title: "We can't re-add this address",
        body: `<p>This address was removed because mail to it bounced permanently or was
                 reported as spam. Re-adding it automatically would put our delivery to
                 every other customer at risk.</p>
               <p class="muted">If that was a mistake, email
                 <a href="mailto:hello@moveitclearit.com">hello@moveitclearit.com</a>
                 and we will sort it out with you directly.</p>`,
      })
    }
    return page({
      title: 'You are back on the list',
      body: `<p>We will send you occasional moving tips and offers again. You can change
               your mind at any time — every email has an unsubscribe link.</p>`,
    })
  }

  await unsubscribeEmail(verified.email, 'unsubscribe-link')

  const wantsHtml = (req.headers.get('accept') ?? '').includes('text/html')
  if (!wantsHtml) return NextResponse.json({ ok: true }, { status: 200 })

  return page({
    title: "You're unsubscribed",
    body: `<p>We have stopped all marketing email to this address. It can take a few
             minutes to take effect everywhere.</p>
           <p class="muted">You will still get messages about a move you have actually
             booked — receipts, schedule changes, and move-day details. Those are not
             marketing, and most people want them.</p>`,
    token: token ?? undefined,
    showResubscribe: true,
  })
}

/** The human-facing link in the email footer. Same effect, plus a page. */
export async function GET(req: NextRequest): Promise<Response> {
  const token = req.nextUrl.searchParams.get('token')?.trim()
  const verified = verifyToken(token, 'unsubscribe')
  if (!verified) return invalidPage()

  await unsubscribeEmail(verified.email, 'unsubscribe-link')

  return page({
    title: "You're unsubscribed",
    body: `<p>We have stopped all marketing email to this address. It can take a few
             minutes to take effect everywhere.</p>
           <p class="muted">You will still get messages about a move you have actually
             booked — receipts, schedule changes, and move-day details. Those are not
             marketing, and most people want them.</p>`,
    token: token ?? undefined,
    showResubscribe: true,
  })
}
