import {
  PaymentCompletedPayload,
  ApprovedPayload,
  RescheduleRequestedPayload,
  NewDatePickedPayload,
} from '../domain/events'
import { renderPreApproval, renderFinalConfirmation, renderBookingUpdated } from './premiumEmails'
import { guardedSend } from '../../lib/email-guard'

// ════════════════════════════════════════════════════════════════════════
//  Real email provider — now via the SHARED SEND GUARD (src/lib/email-guard).
//
//  BEFORE (gap audit 2026-07-17, G4): this path called `resend.emails.send()`
//  directly and had NO validation gate, NO suppression check, and NO idempotency
//  record. `assertEmailPayload` was wired only into src/workers/email.worker.ts,
//  so the outbox — which is the path production actually runs when
//  OUTBOX_ENABLED=true — was completely ungated.
//
//  NOW every outbox send goes through guardedSend, which owns suppression, the
//  idempotency claim (an EmailSend row written BEFORE the provider call), and
//  payload validation. Throwing still makes the worker retry with backoff.
//  OUTBOX_EMAIL_DRYRUN=true logs instead of sending.
//
//  KNOWN LIMITATION (unchanged, now recorded rather than silent): the installed
//  Resend SDK (3.x) exposes no idempotency-key parameter. A provider-accepted
//  send whose DB mark fails leaves a 'claimed' row — which BLOCKS a resend
//  rather than allowing one. See email-guard.staleClaims().
// ════════════════════════════════════════════════════════════════════════
async function deliverEmail(message: {
  to: string
  subject: string
  html: string
  template: string
  bookingId?: string
}): Promise<{ id: string }> {
  if (process.env.OUTBOX_EMAIL_DRYRUN === 'true') {
    console.log(`[outbox/email DRYRUN] → ${message.to} | ${message.subject}`)
    return { id: 'dryrun' }
  }

  const outcome = await guardedSend({
    to: message.to,
    subject: message.subject,
    html: message.html,
    template: message.template,
    // These are booking-lifecycle messages, not marketing.
    emailClass: 'transactional',
    journey: 'booking-transactional',
    eventId: message.bookingId,
    bookingId: message.bookingId,
  })

  if (!outcome.sent) {
    // A policy refusal (suppressed address, duplicate claim) is TERMINAL — a
    // throw would make the outbox worker retry something already decided.
    // 'duplicate' in particular means the message was already delivered.
    console.log(`[outbox/email] not sent → ${message.template}: ${outcome.reason}`)
    return { id: `blocked:${outcome.reason}` }
  }
  return { id: outcome.providerId }
}

/** PAYMENT_COMPLETED → the premium "we've received your booking request" email
 *  (pre-confirmation). Renders the shared _ui React template from live booking
 *  data; the event payload is the fallback if the row can't be loaded. */
export async function sendPreApprovalEmail(p: PaymentCompletedPayload): Promise<{ id: string }> {
  const { to, subject, html } = await renderPreApproval(p.bookingId, {
    amountPaid: p.amountPaid,
    customerEmail: p.customerEmail,
    customerName: p.customerName,
    requestedDate: p.requestedDate,
  })
  return deliverEmail({ to: to || p.customerEmail, subject, html, template: 'pre-approval', bookingId: p.bookingId })
}

/** APPROVED → the premium "your booking is approved" confirmation email. */
export async function sendFinalConfirmationEmail(p: ApprovedPayload): Promise<{ id: string }> {
  const { to, subject, html } = await renderFinalConfirmation(p.bookingId, {
    customerEmail: p.customerEmail,
    customerName: p.customerName,
    requestedDate: p.requestedDate,
  })
  return deliverEmail({ to: to || p.customerEmail, subject, html, template: 'final-confirmation', bookingId: p.bookingId })
}

/** RESCHEDULE_REQUESTED → here are alternate dates. */
export async function sendRescheduleRequestEmail(
  p: RescheduleRequestedPayload
): Promise<{ id: string }> {
  const list = p.offeredDates.map((d) => `<li>${d}</li>`).join('')
  return deliverEmail({
    to: p.customerEmail,
    subject: 'Pick a new date for your move',
    html: `<p>Hi ${p.customerName},</p>
           <p>That date wasn't available. Choose one of these:</p>
           <ul>${list}</ul>
           <p><a href="${p.rescheduleUrl}">Pick your date</a></p>`,
    template: 'reschedule-request',
    bookingId: p.bookingId,
  })
}

/** NEW_DATE_PICKED (reschedule confirmed) → the premium "booking updated" email.
 *  OPTIONAL — enable via OUTBOX_SEND_DATE_PICKED in the worker. */
export async function sendDatePickedEmail(p: NewDatePickedPayload): Promise<{ id: string }> {
  const { to, subject, html } = await renderBookingUpdated(p.bookingId, {
    newDate: p.newDate,
    customerEmail: p.customerEmail,
    customerName: p.customerName,
  })
  return deliverEmail({ to: to || p.customerEmail, subject, html, template: 'booking-updated', bookingId: p.bookingId })
}
