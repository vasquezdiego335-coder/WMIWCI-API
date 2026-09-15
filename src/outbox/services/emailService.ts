import {
  PaymentCompletedPayload,
  ApprovedPayload,
  RescheduleRequestedPayload,
  NewDatePickedPayload,
} from '../domain/events'
import { renderPreApproval, renderFinalConfirmation, renderBookingUpdated, type RenderedEmail } from './premiumEmails'
import { guardedSend, SENDING_STALE_MS, type SendOutcome } from '../../lib/email-guard'
import { classifyTemplate } from '../../lib/email-guard'
import { bookingEligibility } from '../../lib/email-eligibility'
import { deferralDueAt, isTransientRefusal } from '../../lib/email-deferral'

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
//  TRUTHFUL OUTCOMES (2026-09-15). Every refusal used to come back as
//  `{ id: 'blocked:<reason>' }`, and the worker then marked the email_jobs row
//  'sent' — including kill-switch holds, DB-read failures and ambiguous provider
//  outcomes. `email_jobs.status = 'sent'` now means an email was actually
//  accepted by the provider (or already had been, for this idempotency key).
//  The result is one of:
//    sent       → the provider accepted it (or an earlier attempt already did)
//    skipped    → a TERMINAL policy refusal (suppressed, ineligible…)
//    ambiguous  → the provider may have accepted it; never auto-resent
//  and a TEMPORARY refusal THROWS an OutboxRetryLater so the row stays pending.
//
//  OUTBOX_EMAIL_DRYRUN=true HOLDS the row (pending, retried later, no attempt
//  consumed). It is never recorded as sent and never counts as a delivery test.
// ════════════════════════════════════════════════════════════════════════

export type OutboxDelivery =
  | { status: 'sent'; providerId: string | null; note?: string }
  | { status: 'skipped'; reason: string }
  | { status: 'ambiguous'; reason: string }
  | { status: 'failed'; reason: string }

/**
 * A temporary refusal: the outbox row must stay retryable.
 * `consumeAttempt: false` is a HOLD (kill switch, dry run) — waiting on an
 * operator must not exhaust the row's retry budget.
 */
export class OutboxRetryLater extends Error {
  constructor(
    readonly reason: string,
    readonly retryAt: Date | null,
    readonly consumeAttempt: boolean
  ) {
    super(`retry later: ${reason}`)
    this.name = 'OutboxRetryLater'
  }
}

/** How long a dry-run hold waits before the row is looked at again. */
const DRYRUN_HOLD_MS = 15 * 60_000

/** Reasons that are a HOLD, not a failed attempt. */
const HOLD_REASONS: ReadonlySet<string> = new Set(['email_sending_disabled'])

/** PURE: map a guard outcome to the outbox's truthful result (or a retry). */
export function outboxDeliveryFor(outcome: SendOutcome): OutboxDelivery {
  if (outcome.sent) return { status: 'sent', providerId: outcome.providerId }
  if (outcome.reason === 'ambiguous' || outcome.outcomeClass === 'ambiguous' || outcome.reason === 'terminal:ambiguous') {
    return { status: 'ambiguous', reason: outcome.reason }
  }
  // The logical send used its whole attempt budget: a real failure, not a skip.
  if (outcome.reason === 'attempts_exhausted' || outcome.reason === 'terminal:failed_terminal') {
    return { status: 'failed', reason: outcome.reason }
  }
  // An earlier attempt already delivered THIS logical send (same key).
  if (outcome.reason === 'duplicate') {
    return { status: 'sent', providerId: null, note: 'already delivered under this idempotency key' }
  }
  // Another worker holds a LIVE claim on this key. Look again only once that
  // claim must have resolved: by then the guard answers 'duplicate' (it was
  // delivered) or closes a dead claim as 'ambiguous' — never a second send. A
  // few-second backoff here only burned the row's attempts while it waited.
  // A HOLD (no attempt used): on the final attempt a consumed one closed the row
  // 'failed' while the other claim went on to deliver. Bounded — the guard turns
  // a claim older than SENDING_STALE_MS into 'ambiguous'.
  if (outcome.reason === 'in_flight') {
    throw new OutboxRetryLater('in_flight', new Date(Date.now() + SENDING_STALE_MS + 60_000), false)
  }
  if (isTransientRefusal(outcome)) {
    const due = deferralDueAt(outcome)
    throw new OutboxRetryLater(
      outcome.reason,
      due === null ? null : new Date(due),
      !HOLD_REASONS.has(outcome.reason)
    )
  }
  return { status: 'skipped', reason: outcome.reason }
}

/**
 * Deliver an already-rendered email through the shared guard.
 * `rendered` carries template + payload + html + text, so nothing is
 * reconstructed or approximated here.
 */
async function deliverRendered(
  rendered: RenderedEmail,
  opts: { to: string; bookingId?: string }
): Promise<OutboxDelivery> {
  if (process.env.OUTBOX_EMAIL_DRYRUN === 'true') {
    // Never logs the recipient. Never marks anything sent.
    console.error(
      `[outbox/email DRYRUN] HOLDING ${rendered.template} booking=${opts.bookingId ?? '-'} — OUTBOX_EMAIL_DRYRUN=true, nothing sent, row stays pending`
    )
    throw new OutboxRetryLater('held_outbox_dryrun', new Date(Date.now() + DRYRUN_HOLD_MS), false)
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
    console.log(`[outbox/email] not sent → ${rendered.template}: ${outcome.reason}`)
  }
  return outboxDeliveryFor(outcome)
}

/** PAYMENT_COMPLETED → the premium "we've received your booking request" email. */
export async function sendPreApprovalEmail(p: PaymentCompletedPayload): Promise<OutboxDelivery> {
  const rendered = await renderPreApproval(p.bookingId, {
    amountPaid: p.amountPaid,
    customerEmail: p.customerEmail,
    customerName: p.customerName,
    requestedDate: p.requestedDate,
  })
  return deliverRendered(rendered, { to: rendered.to || p.customerEmail, bookingId: p.bookingId })
}

/** APPROVED → the premium "your booking is approved" confirmation email. */
export async function sendFinalConfirmationEmail(p: ApprovedPayload): Promise<OutboxDelivery> {
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
export async function sendRescheduleRequestEmail(p: RescheduleRequestedPayload): Promise<OutboxDelivery> {
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
export async function sendDatePickedEmail(p: NewDatePickedPayload): Promise<OutboxDelivery> {
  const rendered = await renderBookingUpdated(p.bookingId, {
    newDate: p.newDate,
    customerEmail: p.customerEmail,
    customerName: p.customerName,
  })
  return deliverRendered(rendered, { to: rendered.to || p.customerEmail, bookingId: p.bookingId })
}
