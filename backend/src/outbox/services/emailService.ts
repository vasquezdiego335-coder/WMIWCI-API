import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from '../../lib/resend'
import {
  PaymentCompletedPayload,
  ApprovedPayload,
  RescheduleRequestedPayload,
  NewDatePickedPayload,
} from '../domain/events'

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

const itemsBlock = (items?: string): string =>
  items
    ? `<p style="font-size:12px;color:#6b7280;font-weight:700;text-transform:uppercase;margin:16px 0 4px">Job Details</p>
       <p style="font-size:13px;color:#0a1628;line-height:1.7;white-space:pre-line;margin:0">${items}</p>`
    : ''

const fmtDate = (iso: string | null): string =>
  iso
    ? new Date(iso).toLocaleString('en-US', {
        timeZone: 'America/New_York',
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : 'your requested date'

/** PAYMENT_COMPLETED → "we have your payment, pending approval". */
export async function sendPreApprovalEmail(p: PaymentCompletedPayload): Promise<{ id: string }> {
  return deliverEmail({
    to: p.customerEmail,
    subject: 'Your booking is pending approval',
    html: `<p>Hi ${p.customerName},</p>
           <p>We received your $${p.amountPaid} hold for ${fmtDate(p.requestedDate)}.
           Your booking is now pending final approval — we'll confirm shortly.</p>
           ${itemsBlock(p.items)}`,
  })
}

/** APPROVED → final confirmation. */
export async function sendFinalConfirmationEmail(p: ApprovedPayload): Promise<{ id: string }> {
  return deliverEmail({
    to: p.customerEmail,
    subject: 'Booking confirmed ✅',
    html: `<p>Hi ${p.customerName},</p>
           <p>Your booking for ${fmtDate(p.requestedDate)} is confirmed. See you then!</p>
           ${itemsBlock(p.items)}`,
  })
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

/** OPTIONAL — NEW_DATE_PICKED → "got your new date" (enable via env in the worker). */
export async function sendDatePickedEmail(p: NewDatePickedPayload): Promise<{ id: string }> {
  return deliverEmail({
    to: p.customerEmail,
    subject: 'New date received',
    html: `<p>Hi ${p.customerName},</p>
           <p>We got your new date (${fmtDate(p.newDate)}) and are reviewing it now.</p>`,
  })
}
