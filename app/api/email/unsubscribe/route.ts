import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { verifyToken, verifyPurposeToken, purposeTokenUseId, resubscribeActionPath } from '@/lib/email-tokens'
import { unsubscribeEmail, resubscribe } from '@/lib/email-suppression'
import { readMarketingStatus, recordConsentEvent } from '@/lib/consent/consent-events'
import { prisma } from '@/lib/db'
import { NOTICE_BASIS_DAYS } from '@/lib/consent/marketing-eligibility'
import { stopEnrollmentsForPerson } from '@/lib/consent/sequence-enrollment'
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
//
//  THE CONSENT RECORD (email consent release 2026-09-16, DESIGN-v2 §8):
//
//  3. AN UNSUBSCRIBE IS A WITHDRAWAL ON RECORD. Besides the suppression row, a
//     POST writes an 'unsubscribed' consent event. That moves the person's
//     opted_out_at forward and stops their active scenario enrollments in the
//     same transaction, so an older consent column or notice can never become
//     live again if the suppression row is later removed.
//
//  4. THE UNSUBSCRIBE TOKEN NO LONGER RESUBSCRIBES. It is valid ~13 months and
//     travels in every forwarded promotional email, and it used to authorise
//     "keep me subscribed" too — so anyone holding a forwarded email could
//     re-subscribe its owner. Resubscribe now needs a separate 'resubscribe'
//     purpose token that is minted ONLY on the page this route returns after it
//     has just recorded a NEW unsubscribe, lives ~1 hour, is accepted ONLY by
//     POST, and is single use (its use id is the consent event request id). It
//     writes a 'resubscribed' and an 'express_opt_in' event and lifts only a
//     promotional UNSUBSCRIBED row.
// ════════════════════════════════════════════════════════════════════════

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const BRAND = { navy: '#0D1A2D', bone: '#F7F7F2', ember: '#FF6A00', gold: '#C9A961' }
const SUPPORT = 'hello@moveitclearit.com'

/** Route-derived consent event surfaces (never from the request). */
const UNSUBSCRIBE_SURFACE = 'unsubscribe_link'
const RESUBSCRIBE_SURFACE = 'resubscribe_page'

const escapeAttr = (s: string): string => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

type PageOpts = {
  title: string
  body: string
  token?: string
  /** Renders the primary "confirm unsubscribe" button (GET confirmation view). */
  confirm?: boolean
  /**
   * Renders the secondary "keep me subscribed" action (post-unsubscribe view).
   * The form action carries a short-lived 'resubscribe' purpose token — never
   * the unsubscribe token.
   */
  resubscribeAction?: string | null
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
  const resubscribeBtn = opts.resubscribeAction
    ? `<form method="POST" action="${escapeAttr(opts.resubscribeAction)}"><button type="submit" class="link">Actually, keep me subscribed</button></form>`
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

/** A resubscribe link that expired, was altered, or is not a resubscribe token. */
const invalidResubscribePage = () =>
  page({
    status: 400,
    title: 'This link has expired',
    body: `<p>The "keep me subscribed" link only works for a short time after you unsubscribe,
             and only once. You are still unsubscribed, and nothing was changed.</p>
           <p class="muted">If you would like our emails again, write to
             <a href="mailto:${SUPPORT}">${SUPPORT}</a> and we will help.</p>`,
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
 * A GET never resubscribes, whatever `action` says.
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
 * Record the withdrawal on the consent record. Best effort: the suppression row
 * is the authoritative block and is already written, so a failure here is
 * logged, never shown to the customer as a failed unsubscribe. The event stops
 * active enrollments in its own transaction; if the event cannot be written the
 * enrollments are stopped directly.
 */
async function recordUnsubscribe(email: string): Promise<void> {
  const recorded = await recordConsentEvent({
    email,
    kind: 'unsubscribed',
    surface: UNSUBSCRIBE_SURFACE,
    requestId: `unsubscribe:${randomUUID()}`,
  })
  if (recorded.ok) return
  apiLogger.error({ reason: recorded.reason, detail: recorded.detail }, 'unsubscribe consent event NOT recorded — stopping enrollments directly')
  const stopped = await stopEnrollmentsForPerson(email, 'unsubscribed')
  if (!stopped.ok) apiLogger.error({ detail: stopped.detail }, 'could not stop enrollments after unsubscribe — the send-time gate still blocks')
}

/**
 * Was this address ON A MARKETING PATH when it unsubscribed? Only then is
 * "keep me subscribed" an UNDO:
 *   • an express opt-in (an earlier resubscribe) or a ticked opt-in box on an
 *     older form, or
 *   • a form submission whose notice is still inside the notice window — since
 *     the owner direction of 2026-09-16 every form submission may lead to
 *     promotional email, so such a person was receiving it.
 *
 * Everyone else — an old contact with no basis, someone who had already opted
 * out — was not on a path, so the same click would CREATE a subscription from a
 * page anyone holding a forwarded email can reach. It is not offered to them.
 * A read failure offers nothing.
 */
async function hadMarketingPath(email: string): Promise<boolean> {
  try {
    const status = await readMarketingStatus(email)
    //  ALREADY OPTED OUT: a ticked opt-out box or a decline that no later token
    //  resubscribe outranks, or a customer-level opt-out. Their choice was made
    //  without this link; a click here must never reverse it.
    const expressAt = status?.expressOptInAt ? status.expressOptInAt.getTime() : null
    if (status?.optedOutAt && (expressAt === null || status.optedOutAt.getTime() >= expressAt)) return false
    if (status?.declinedAt && (expressAt === null || status.declinedAt.getTime() >= expressAt)) return false
    const optedOutCustomers = await prisma.customer.findMany({
      where: { email: { equals: email, mode: 'insensitive' }, marketingOptOut: true },
      select: { id: true },
      take: 1,
    })
    if (optedOutCustomers.length > 0) return false
    if (status?.expressOptInAt) return true
    if (status?.lastNoticeAt && Date.now() - status.lastNoticeAt.getTime() <= NOTICE_BASIS_DAYS * 24 * 60 * 60 * 1000) return true
    const where = { email: { equals: email, mode: 'insensitive' as const }, emailMarketingConsent: true }
    const [leads, customers] = await Promise.all([
      prisma.lead.findMany({ where, select: { id: true }, take: 1 }),
      prisma.customer.findMany({ where, select: { id: true }, take: 1 }),
    ])
    return leads.length > 0 || customers.length > 0
  } catch (err) {
    apiLogger.warn({ err: err instanceof Error ? err.message : String(err) }, 'prior permission unreadable — no undo offered')
    return false
  }
}

/**
 * POST with ?action=resubscribe — the "keep me subscribed" form.
 *
 * ONLY a verified 'resubscribe' purpose token (~1 hour, minted on the page
 * returned right after a new unsubscribe) is accepted. The unsubscribe token
 * is refused here. Single use: the token's use id is the request id of both
 * consent events, and a replay is refused before anything is lifted.
 */
async function handleResubscribe(token: string | undefined): Promise<Response> {
  const verified = verifyPurposeToken(token, 'resubscribe')
  const useId = verified ? purposeTokenUseId(token, 'resubscribe') : null
  if (!verified || !useId) return invalidResubscribePage()

  //  A withdrawal recorded AFTER this token was minted (a second unsubscribe,
  //  an opt-out box, a decline) is the person's latest word: the older undo
  //  link is dead. The unsubscribe that mints a token records its own opt-out
  //  first, so a genuine undo still passes. A read failure lifts nothing.
  try {
    const status = await readMarketingStatus(verified.email)
    const withdrawnAt = Math.max(status?.optedOutAt?.getTime() ?? 0, status?.declinedAt?.getTime() ?? 0)
    if (withdrawnAt > verified.issuedAt) return invalidResubscribePage()
  } catch (err) {
    apiLogger.warn({ err: err instanceof Error ? err.message : String(err) }, 'resubscribe: status unreadable — nothing lifted')
    return invalidResubscribePage()
  }

  // 1. Spend the token. A replay (created:false) changes nothing.
  const spent = await recordConsentEvent({
    email: verified.email,
    kind: 'resubscribed',
    surface: RESUBSCRIBE_SURFACE,
    requestId: useId,
  })
  if (!spent.ok) {
    apiLogger.error({ reason: spent.reason, detail: spent.detail }, 'resubscribe event write FAILED — nothing lifted')
    return page({
      status: 500,
      title: "That didn't save",
      body: `<p>Something went wrong on our end and you were <strong>not</strong> added
               back. You are still unsubscribed.</p>
             <p class="muted">Please email <a href="mailto:${SUPPORT}">${SUPPORT}</a> and we
               will help.</p>`,
    })
  }
  if (!spent.created) return invalidResubscribePage()

  // 2. Lift ONLY a promotional UNSUBSCRIBED row.
  const result = await resubscribe(verified.email)
  if (result.status === 'hard_suppression_refused') {
    return page({
      title: "We can't re-add this address",
      body: `<p>This address was removed because mail to it bounced permanently or was
               reported as spam. Re-adding it automatically would put our delivery to
               every other customer at risk.</p>
             <p class="muted">If that was a mistake, email
               <a href="mailto:${SUPPORT}">${SUPPORT}</a> and we will sort it out with
               you directly.</p>`,
    })
  }
  if (result.status === 'write_failed') {
    apiLogger.error({ err: String(result.error) }, 'resubscribe write FAILED — customer told the truth')
    return page({
      status: 500,
      title: "That didn't save",
      body: `<p>Something went wrong on our end and you were <strong>not</strong> added
               back. You are still unsubscribed.</p>
             <p class="muted">Please email <a href="mailto:${SUPPORT}">${SUPPORT}</a> and we
               will add you back by hand.</p>`,
    })
  }

  // 3. The confirmed opt-in: the only thing that outranks the earlier
  //    unsubscribe on the consent record.
  const optIn = await recordConsentEvent({
    email: verified.email,
    kind: 'express_opt_in',
    surface: RESUBSCRIBE_SURFACE,
    requestId: useId,
  })
  if (!optIn.ok) {
    apiLogger.error({ reason: optIn.reason, detail: optIn.detail }, 'resubscribe lifted the suppression but the opt-in event did NOT record')
    return page({
      title: "You're mostly back",
      body: `<p>We have taken this address off our unsubscribe list, but your preference did not
               fully save, so our emails may still be held.</p>
             <p class="muted">Email <a href="mailto:${SUPPORT}">${SUPPORT}</a> and we
               will finish it by hand — that always works.</p>`,
    })
  }

  if (result.status === 'removed' && !result.mirrored) {
    // TRUTHFULNESS. The suppression IS gone, but the older
    // Customer.marketingOptOut flag still blocks post-move follow-ups,
    // so "you are back on the list" would be only half true. Say what is
    // actually the case and give them a path that works.
    apiLogger.error('resubscribe removed the suppression but the Customer mirror did NOT clear')
    return page({
      title: "You're mostly back",
      body: `<p>We have taken this address off our unsubscribe list, but one older
               preference did not update, so some messages may still be held.</p>
             <p class="muted">Email <a href="mailto:${SUPPORT}">${SUPPORT}</a> and we
               will finish it by hand — that always works.</p>`,
    })
  }

  return page({
    title: 'You are back on the list',
    body: `<p>We will send you occasional moving tips and offers again. You can change
             your mind at any time — every email has an unsubscribe link.</p>`,
  })
}

/**
 * POST — the mutating path.
 *  • RFC 8058 one-click: Gmail/Yahoo POST here with no user interaction, so it
 *    must unsubscribe immediately, with no confirmation step, and answer fast.
 *  • The human confirmation form on the GET page posts here too.
 *  • `?action=resubscribe` is the "keep me subscribed" form, and it requires a
 *    'resubscribe' purpose token (see handleResubscribe).
 */
export async function POST(req: NextRequest): Promise<Response> {
  const token = req.nextUrl.searchParams.get('token')?.trim()
  const action = req.nextUrl.searchParams.get('action')?.trim()

  // ── Resubscribe ───────────────────────────────────────────────────────
  if (action === 'resubscribe') return handleResubscribe(token)

  const verified = verifyToken(token, 'unsubscribe')
  const wantsHtml = (req.headers.get('accept') ?? '').includes('text/html')

  if (!verified) {
    return wantsHtml ? invalidPage() : NextResponse.json({ ok: false, error: 'invalid_token' }, { status: 400 })
  }

  // ── Unsubscribe ───────────────────────────────────────────────────────
  //  Read BEFORE the withdrawal is written: whether "keep me subscribed" would
  //  be an undo or a brand-new opt-in. Only the human (HTML) page offers it, so
  //  a one-click RFC 8058 caller pays for no extra read.
  const undoable = wantsHtml ? await hadMarketingPath(verified.email) : false
  const result = await unsubscribeEmail(verified.email, 'unsubscribe-link')

  if (result.status === 'write_failed') {
    apiLogger.error({ err: String(result.error) }, 'unsubscribe write FAILED — customer told the truth')
    // One-click callers get a real failure code so the mail client can surface it.
    return wantsHtml
      ? failurePage(token ?? undefined)
      : NextResponse.json({ ok: false, error: 'write_failed' }, { status: 500 })
  }

  await recordUnsubscribe(verified.email)

  if (!result.mirrored) {
    // The authoritative suppression IS written, so the customer is genuinely
    // unsubscribed; only the legacy Customer flag lagged. Worth an alert, not a
    // scary page — telling them it failed would itself be untrue.
    apiLogger.warn(
      'unsubscribe suppression written but Customer.marketingOptOut mirror failed — sends are still blocked'
    )
  }

  if (!wantsHtml) return NextResponse.json({ ok: true, status: result.status }, { status: 200 })

  // The undo is offered ONLY when this request recorded a NEW unsubscribe. A
  // repeat POST of an old or forwarded link must not become a way to mint a
  // resubscribe token for somebody who unsubscribed earlier. And only to an
  // address that was on a marketing path (hadMarketingPath): for anyone else
  // the "undo" would be a new subscription nobody asked for.
  const isNew = result.status === 'unsubscribed'
  return page({
    title: isNew ? "You're unsubscribed" : 'You were already unsubscribed',
    body: isNew
      ? UNSUBSCRIBED_BODY
      : `${UNSUBSCRIBED_BODY}
   <p class="muted">Changed your mind? Email <a href="mailto:${SUPPORT}">${SUPPORT}</a>.</p>`,
    token: token ?? undefined,
    resubscribeAction: isNew && undoable ? resubscribeActionPath(verified.email) : null,
  })
}
