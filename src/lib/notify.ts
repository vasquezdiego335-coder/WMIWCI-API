// ════════════════════════════════════════════════════════════════════════
//  notify.ts — owner + customer notifications for NEW leads and bookings.
//  ----------------------------------------------------------------------
//  Self-contained on purpose. New messages are sent from HERE so the existing
//  customer-email allowlist (src/workers/email.worker.ts), the React email
//  templates, and the BullMQ EmailJobData union all stay UNTOUCHED:
//    • SMS  → enqueued on the existing `sms` queue (free-form; the SMS worker
//             still honors TWILIO_ENABLED, so an un-flagged deploy is a dry run).
//    • Email→ sent via a DIRECT Resend call (no template/allowlist needed for an
//             internal alert or a simple bilingual auto-reply).
//
//  MESSAGING POLICY NOTE: the codebase limits CUSTOMER messages to the four
//  pre-approval/final-confirmation pairs. The customer auto-reply below is a
//  deliberate, owner-approved addition and is gated by CUSTOMER_AUTOREPLY_ENABLED
//  (default ON) so it can be turned off with one env var. Owner alerts are
//  internal and never counted against that customer-message policy.
//
//  Every send is wrapped so a Redis stall or Resend hiccup is a logged, non-fatal
//  skip — notifications must never break a lead/booking request.
// ════════════════════════════════════════════════════════════════════════
import { smsQueue } from './queues'
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from './resend'
import { guardedSend } from './email-guard'
import { apiLogger } from './logger'
import { normalizeLocale, t, BIZ_NAME, type Locale } from './i18n'

const log = apiLogger.child({ mod: 'notify' })

// Owner alerts are delivered via DISCORD (the actionable approval card, posted
// when payment completes) plus a lightweight email trail below. There is
// intentionally NO owner SMS — Diego & Sebastian are notified on Discord, so
// OWNER_PHONE is unused and NOT required (a missing value is not a defect).
const OWNER_EMAIL = process.env.OWNER_EMAIL?.trim() || ''
// Customer auto-reply is ON unless explicitly disabled.
const CUSTOMER_AUTOREPLY = process.env.CUSTOMER_AUTOREPLY_ENABLED !== 'false'

export type LeadInput = {
  name?: string
  phone?: string
  email?: string
  source?: string // QR src / utm
  foundUs?: string // "Where did you find us?" dropdown (Phase 2)
  message?: string
  locale?: string
}

export type BookingInput = {
  name?: string
  phone?: string
  email?: string
  source?: string
  foundUs?: string
  serviceType?: string
  displayId?: string
  locale?: string
  // ── Service area (travel fee) ──
  serviceAreaZone?: string
  travelFee?: number | null // dollars; null = pending manual review
  manualReviewRequired?: boolean
  originAddress?: string
  destAddress?: string
}

// ── guards ────────────────────────────────────────────────────────────
function withTimeout<T>(p: Promise<T>, ms = 5000): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
    ),
  ])
}

// Run a side-effect, swallow + log any failure. Never throws.
async function safe(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await withTimeout(fn())
    log.debug({ label }, 'notification sent')
  } catch (err) {
    log.warn(
      { label, err: err instanceof Error ? err.message : String(err) },
      'notification failed (non-fatal)'
    )
  }
}

// ── tiny formatting helpers (pure) ────────────────────────────────────
const dash = (s?: string): string => (s && s.trim() ? s.trim() : '—')
const esc = (s?: string): string =>
  (s ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] as string))

function attribution(source?: string, foundUs?: string): string {
  return [source, foundUs].map((v) => v?.trim()).filter(Boolean).join(' / ') || 'direct'
}

function table(rows: Array<[string, string | undefined]>): string {
  const trs = rows
    .map(([k, v]) => `<tr><td style="padding:4px 10px"><b>${esc(k)}</b></td><td style="padding:4px 10px">${esc(dash(v))}</td></tr>`)
    .join('')
  return `<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;font-family:system-ui,Arial,sans-serif;font-size:14px">${trs}</table>`
}

// ── message builders (pure — exported for unit tests) ─────────────────
export function ownerLeadEmailHtml(l: LeadInput): string {
  return (
    `<h2 style="font-family:system-ui,Arial,sans-serif">New lead</h2>` +
    table([
      ['Name', l.name],
      ['Phone', l.phone],
      ['Email', l.email],
      ['Source', l.source],
      ['Found us', l.foundUs],
      ['Message', l.message],
    ])
  )
}

export function customerLeadEmailHtml(l: LeadInput, locale: Locale): string {
  const name = esc(l.name || (locale === 'es' ? 'allí' : 'there'))
  const body =
    locale === 'es'
      ? `<p>¡Gracias ${name}!</p><p>Recibimos tu solicitud de mudanza y te llamaremos muy pronto. Si es urgente, llámanos o escríbenos.</p>`
      : `<p>Thanks ${name}!</p><p>We got your moving request and will call you shortly. If it's urgent, call or text us.</p>`
  return `<div style="font-family:system-ui,Arial,sans-serif;font-size:15px;line-height:1.5">${body}<p>— ${esc(BIZ_NAME)}</p></div>`
}

function zoneLabel(zone?: string): string {
  switch (zone) {
    case 'primary': return 'Primary (no fee)'
    case 'extended_nj': return 'Extended NJ (+$50)'
    case 'new_york': return 'New York (review)'
    case 'unsupported': return 'Out of area (review)'
    case 'manual_review': return 'Manual review'
    default: return '—'
  }
}

function travelFeeText(b: BookingInput): string {
  if (b.travelFee == null) return 'pending review'
  return b.travelFee > 0 ? `$${b.travelFee} (due on move day)` : 'none'
}

export function ownerBookingEmailHtml(b: BookingInput): string {
  return (
    `<h2 style="font-family:system-ui,Arial,sans-serif">New booking started</h2>` +
    table([
      ['Name', b.name],
      ['Phone', b.phone],
      ['Email', b.email],
      ['Service', b.serviceType],
      ['Booking #', b.displayId],
      ['Pickup', b.originAddress],
      ['Destination', b.destAddress],
      ['Service area', b.serviceAreaZone ? zoneLabel(b.serviceAreaZone) : undefined],
      ['Travel fee', travelFeeText(b)],
      ['Manual review', b.manualReviewRequired ? 'YES — do not confirm a final travel price' : 'No'],
      ['Source', b.source],
      ['Found us', b.foundUs],
    ])
  )
}

// ════════════════════════════════════════════════════════════════════════
//  SENDERS — owner alerts vs CUSTOMER mail (the fourth send path)
//  ---------------------------------------------------------------------
//  This file was a FOURTH direct caller of `resend.emails.send()`, missed by
//  the audit and by the first remediation pass, which only ever named three.
//  It was found by the send-path conformance test rather than by reading.
//
//  It matters because line ~198 sends a CUSTOMER-facing lead acknowledgement.
//  Going direct meant that email skipped suppression entirely: a person who had
//  unsubscribed, hard-bounced, or filed a spam complaint would still be written
//  to the moment they touched the quote form.
//
//  The two cases are now separated deliberately:
//    • sendCustomerEmail() — routed through guardedSend, so it inherits
//      suppression, address validation, idempotency and reporting.
//    • sendInternalEmail() — owner/ops alerts to OWNER_EMAIL, the business's own
//      inbox. These stay direct ON PURPOSE: they are not customer mail, they
//      must fire even when the marketing system is disabled, and routing an
//      internal alert through a customer-consent gate would be the wrong model.
//      They are explicitly whitelisted in the conformance test.
// ════════════════════════════════════════════════════════════════════════

/** INTERNAL alerts to the business's own inbox. Never customer-facing. */
async function sendInternalEmail(to: string, subject: string, html: string, replyTo?: string): Promise<void> {
  const { error } = await resend.emails.send({
    from: EMAIL_FROM,
    to,
    reply_to: replyTo || EMAIL_REPLY_TO,
    subject,
    html,
  })
  if (error) throw new Error(`resend: ${error.message ?? JSON.stringify(error)}`)
}

/**
 * CUSTOMER-facing mail from this module. Goes through the shared guard, so a
 * suppressed address is not written to and the send is recorded like any other.
 *
 * Classified TRANSACTIONAL: it acknowledges an enquiry the person just made. It
 * is not an offer, so it does not require the promotional compliance block —
 * but it DOES require suppression, which is what was missing.
 */
async function sendCustomerEmail(opts: {
  to: string
  subject: string
  html: string
  /** Stable business-event id so a double-submit cannot double-send. */
  eventId: string
}): Promise<void> {
  const outcome = await guardedSend({
    to: opts.to,
    subject: opts.subject,
    html: opts.html,
    template: 'lead-acknowledgement',
    emailClass: 'transactional',
    journey: 'lead-intake',
    eventId: opts.eventId,
  })
  if (!outcome.sent) {
    log.info({ reason: outcome.reason }, 'lead acknowledgement not sent')
  }
}

async function ownerEmail(subject: string, html: string, label: string, replyTo?: string): Promise<void> {
  if (!OWNER_EMAIL) return void log.warn({ label }, 'OWNER_EMAIL not set — skipping owner email')
  await safe(`email:${label}`, () => sendInternalEmail(OWNER_EMAIL, subject, html, replyTo))
}

// ── public API ────────────────────────────────────────────────────────
/** New lead (from the marketing-tracker quote form / site). Owner alert + an
 *  optional customer auto-reply. Resolves once all sends settle (each guarded). */
export async function notifyLead(input: LeadInput): Promise<void> {
  const locale = normalizeLocale(input.locale)

  // Owner alert — email trail only (owners act on Discord; no owner SMS).
  // reply-to is the lead's email so you can reply straight back.
  await ownerEmail(`New lead: ${dash(input.name)}`, ownerLeadEmailHtml(input), 'owner-lead-alert', input.email)

  // Customer auto-reply (flag-gated; only when we have contact info).
  if (CUSTOMER_AUTOREPLY) {
    if (input.phone) {
      await safe('sms:lead-ack', () =>
        smsQueue.add('lead-ack-sms', { to: input.phone!, message: t(locale, 'leadAck', { name: input.name || '' }) })
      )
    }
    if (input.email) {
      const subject = locale === 'es' ? 'Recibimos tu solicitud' : 'We got your request'
      // Stable per-address, per-day identity: a repeated form submission on the
      // same day is the same business event, so it cannot double-send.
      const ackEvent = `lead-ack:${input.email!.toLowerCase()}:${new Date().toISOString().slice(0, 10)}`
      await safe('email:lead-ack', () =>
        sendCustomerEmail({
          to: input.email!,
          subject,
          html: customerLeadEmailHtml(input, locale),
          eventId: ackEvent,
        })
      )
    }
  }
}

/** New booking started (pre-payment). Owner alert only — the customer receives
 *  the existing FINAL CONFIRMATION when payment completes, so we don't text
 *  people who are still mid-checkout. */
export async function notifyBookingCreated(input: BookingInput): Promise<void> {
  // Owner alert = email trail only. The actionable owner notification is the
  // Discord approval card posted when payment completes (fulfillment.ts). There
  // is no owner SMS — OWNER_PHONE is unused.
  await ownerEmail(
    `New booking: ${dash(input.name)} (${dash(input.displayId)})`,
    ownerBookingEmailHtml(input),
    'owner-booking-alert',
    input.email
  )
}
