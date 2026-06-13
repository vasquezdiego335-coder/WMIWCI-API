import {
  PaymentCompletedPayload,
  ApprovedPayload,
  RescheduleRequestedPayload,
  NewDatePickedPayload,
} from '../domain/events'

// ════════════════════════════════════════════════════════════════════════
//  PLACEHOLDER email provider.
//  Swap the body of deliverEmail() with your real client (Resend/SES/etc.).
//  Throwing here makes the worker retry the job with backoff.
// ════════════════════════════════════════════════════════════════════════
async function deliverEmail(message: {
  to: string
  subject: string
  html: string
}): Promise<{ id: string }> {
  console.log(`[outbox/email] → ${message.to} | ${message.subject}`)
  // e.g. const { data } = await resend.emails.send({ from: EMAIL_FROM, ...message })
  //      return { id: data!.id }
  return { id: `stub_${Math.random().toString(36).slice(2)}` }
}

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
           Your booking is now pending final approval — we'll confirm shortly.</p>`,
  })
}

/** APPROVED → final confirmation. */
export async function sendFinalConfirmationEmail(p: ApprovedPayload): Promise<{ id: string }> {
  return deliverEmail({
    to: p.customerEmail,
    subject: 'Booking confirmed ✅',
    html: `<p>Hi ${p.customerName},</p>
           <p>Your booking for ${fmtDate(p.requestedDate)} is confirmed. See you then!</p>`,
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
