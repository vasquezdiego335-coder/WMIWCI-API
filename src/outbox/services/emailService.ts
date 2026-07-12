import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from '../../lib/resend'
import {
  PaymentCompletedPayload,
  ApprovedPayload,
  RescheduleRequestedPayload,
  NewDatePickedPayload,
} from '../domain/events'
import { renderPreApproval, renderFinalConfirmation, renderBookingUpdated } from './premiumEmails'

// ════════════════════════════════════════════════════════════════════════
//  Real email provider (Resend). Reuses the app's configured client.
//  Throwing makes the worker retry the job with backoff. Set
//  OUTBOX_EMAIL_DRYRUN=true to log instead of sending (for testing the
//  pipeline without real mail).
//
//  NOTE on duplicates: the installed Resend SDK (3.x) has no idempotency-key
//  param, so dedup is at the job level (unique key + SKIP LOCKED claim). If the
//  provider send succeeds but the DB mark fails, the retry can resend — upgrade
//  Resend and pass an idempotency key here for true near-exactly-once.
// ════════════════════════════════════════════════════════════════════════
async function deliverEmail(message: {
  to: string
  subject: string
  html: string
}): Promise<{ id: string }> {
  if (process.env.OUTBOX_EMAIL_DRYRUN === 'true') {
    console.log(`[outbox/email DRYRUN] → ${message.to} | ${message.subject}`)
    return { id: 'dryrun' }
  }
  const { data, error } = await resend.emails.send({
    from: EMAIL_FROM,
    to: message.to,
    reply_to: EMAIL_REPLY_TO,
    subject: message.subject,
    html: message.html,
  })
  if (error) throw new Error(`Resend error: ${error.message ?? JSON.stringify(error)}`)
  return { id: data?.id ?? 'unknown' }
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
  return deliverEmail({ to: to || p.customerEmail, subject, html })
}

/** APPROVED → the premium "your booking is approved" confirmation email. */
export async function sendFinalConfirmationEmail(p: ApprovedPayload): Promise<{ id: string }> {
  const { to, subject, html } = await renderFinalConfirmation(p.bookingId, {
    customerEmail: p.customerEmail,
    customerName: p.customerName,
    requestedDate: p.requestedDate,
  })
  return deliverEmail({ to: to || p.customerEmail, subject, html })
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
  return deliverEmail({ to: to || p.customerEmail, subject, html })
}
