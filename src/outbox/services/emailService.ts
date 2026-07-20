import {
  PaymentCompletedPayload,
  ApprovedPayload,
  RescheduleRequestedPayload,
  NewDatePickedPayload,
} from '../domain/events'
import { renderPreApproval, renderFinalConfirmation, renderBookingUpdated, type RenderedEmail } from './premiumEmails'
import { guardedSend } from '../../lib/email-guard'
import { classifyTemplate } from '../../lib/email-guard'
import { bookingEligibility } from '../../lib/email-eligibility'

// ════════════════════════════════════════════════════════════════════════
//  OUTBOX SEND PATH — now conforming to the canonical sender contract.
//
//  WHAT WAS WRONG (findings EMAIL-P0-02, EMAIL-P1-05):
//  This is the path production actually runs (OUTBOX_ENABLED=true), and it was
//  the least protected of the three. It called `resend.emails.send()` directly,
//  and after the first remediation it called `guardedSend()` but still passed:
//    • NO payload  → `assertEmailPayload` never ran, so required-field and
//                    URL-safety checks were silently skipped, AND the typed
//                    status gate in status.ts (which keys off payload.bookingStatus)
//                    could never fire;
//    • NO recheck  → the booking was never reloaded, so a booking that was
//                    cancelled between render and send still got a
//                    "your booking is approved" email;
//    • NO text     → HTML-only, hurting spam score and accessibility while the
//                    queue path sent multipart;
//    • a HARD-CODED emailClass, which would misclassify any template added later.
//
//  WHAT IT DOES NOW: the renderers return the exact props they rendered from,
//  plus a plain-text part. Those props are handed to the guard for validation,
//  the class is derived from the shared classification table, and every
//  booking-scoped send carries `bookingEligibility` as its live recheck — the
//  same predicate the queue worker uses. No behavioural difference remains
//  between the two paths.
//
//  Throwing still makes the outbox worker retry with backoff.
//  OUTBOX_EMAIL_DRYRUN=true logs instead of sending.
// ════════════════════════════════════════════════════════════════════════

/**
 * Deliver an already-rendered email through the shared guard.
 * `rendered` carries template + payload + html + text, so nothing is
 * reconstructed or approximated here.
 */
async function deliverRendered(
  rendered: RenderedEmail,
  opts: { to: string; bookingId?: string }
): Promise<{ id: string }> {
  if (process.env.OUTBOX_EMAIL_DRYRUN === 'true') {
    console.log(`[outbox/email DRYRUN] → ${opts.to} | ${rendered.subject}`)
    return { id: 'dryrun' }
  }

  const outcome = await guardedSend({
    to: opts.to,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    template: rendered.template,
    // Derived, not asserted — a template added later cannot be silently
    // misclassified as transactional and thereby skip suppression/caps.
    emailClass: classifyTemplate(rendered.template),
    journey: 'booking-transactional',
    eventId: opts.bookingId,
    bookingId: opts.bookingId,
    // The EXACT props that produced this HTML.
    payload: rendered.payload,
    // LIVE state reload immediately before the idempotency claim.
    recheck: opts.bookingId ? () => bookingEligibility(rendered.template, opts.bookingId as string) : undefined,
  })

  if (!outcome.sent) {
    // A policy refusal (suppressed, ineligible, duplicate) is TERMINAL — a throw
    // would make the outbox worker retry something already decided.
    console.log(`[outbox/email] not sent → ${rendered.template}: ${outcome.reason}`)
    return { id: `blocked:${outcome.reason}` }
  }
  return { id: outcome.providerId }
}

/** PAYMENT_COMPLETED → the premium "we've received your booking request" email. */
export async function sendPreApprovalEmail(p: PaymentCompletedPayload): Promise<{ id: string }> {
  const rendered = await renderPreApproval(p.bookingId, {
    amountPaid: p.amountPaid,
    customerEmail: p.customerEmail,
    customerName: p.customerName,
    requestedDate: p.requestedDate,
  })
  return deliverRendered(rendered, { to: rendered.to || p.customerEmail, bookingId: p.bookingId })
}

/** APPROVED → the premium "your booking is approved" confirmation email. */
export async function sendFinalConfirmationEmail(p: ApprovedPayload): Promise<{ id: string }> {
  const rendered = await renderFinalConfirmation(p.bookingId, {
    customerEmail: p.customerEmail,
    customerName: p.customerName,
    requestedDate: p.requestedDate,
  })
  return deliverRendered(rendered, { to: rendered.to || p.customerEmail, bookingId: p.bookingId })
}

/**
 * RESCHEDULE_REQUESTED → here are alternate dates.
 *
 * SAFETY (finding EMAIL-P1-13): this used to build raw HTML by interpolating
 * `p.customerName`, each offered date, and `p.rescheduleUrl` directly into a
 * template string. Any HTML in a customer-supplied name was injected verbatim,
 * and the URL was never validated — a `javascript:` or `data:` URL would have
 * been emitted as a live link. It now renders through the shared React template,
 * which escapes text by construction, and the URL passes the send guard's
 * `assertEmailPayload` URL-safety check like every other action link.
 */
export async function sendRescheduleRequestEmail(p: RescheduleRequestedPayload): Promise<{ id: string }> {
  const { renderRescheduleRequest } = await import('./premiumEmails')
  const rendered = await renderRescheduleRequest(p.bookingId, {
    customerEmail: p.customerEmail,
    customerName: p.customerName,
    offeredDates: p.offeredDates,
    rescheduleUrl: p.rescheduleUrl,
  })
  return deliverRendered(rendered, { to: rendered.to || p.customerEmail, bookingId: p.bookingId })
}

/** NEW_DATE_PICKED (reschedule confirmed) → the premium "booking updated" email.
 *  OPTIONAL — enable via OUTBOX_SEND_DATE_PICKED in the worker. */
export async function sendDatePickedEmail(p: NewDatePickedPayload): Promise<{ id: string }> {
  const rendered = await renderBookingUpdated(p.bookingId, {
    newDate: p.newDate,
    customerEmail: p.customerEmail,
    customerName: p.customerName,
  })
  return deliverRendered(rendered, { to: rendered.to || p.customerEmail, bookingId: p.bookingId })
}
