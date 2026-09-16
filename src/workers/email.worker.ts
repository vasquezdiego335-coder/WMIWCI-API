import { Worker, Job, UnrecoverableError } from 'bullmq'
import { randomUUID } from 'node:crypto'
import { render } from '@react-email/render'
import { getLazyBullConnection } from '../lib/redis'
import { prisma } from '../lib/db'
import { queueLogger } from '../lib/logger'
import { guardedSend, classifyTemplate, ProviderRejectedError } from '../lib/email-guard'
import { DEFERRAL_BUFFER_MS, deferralDueAt, deferredJobId } from '../lib/email-deferral'
import { validateEmailJobData } from '../lib/email-job-validation'
import { buildMarketingContext, applyMarketingContext } from '../lib/marketing-context'
import { emailQueue } from '../lib/queues'
import { bookingEligibility } from '../lib/email-eligibility'
import { leadEligibility, sequenceKindForTemplate } from '../lib/journeys'
import { recordQuoteConfirmationOutcome } from '../lib/quote-capture'
import type { EmailJobData } from '../lib/queues'

// ── Email template imports ─────────────────────────────────────
// Each template is a React component
import PreApprovalEmail from '../emails/pre-approval'
import FinalConfirmationEmail from '../emails/final-confirmation'
import BookingDeclinedEmail from '../emails/booking-declined'
import PaymentReceiptEmail from '../emails/payment-receipt'
import BookingUpdatedEmail from '../emails/booking-updated'
import BookingCancellationEmail from '../emails/booking-cancellation'
import JobReminderEmail from '../emails/job-reminder'
import JobCompletionEmail from '../emails/job-completion'
import ReviewRequestEmail from '../emails/review-request'
import AbandonedCheckoutEmail from '../emails/abandoned-checkout'
import ReferralEmail from '../emails/referral'
import PaymentFailedEmail from '../emails/payment-failed'
import InformationRequiredEmail from '../emails/information-required'
import OperationalAlertEmail from '../emails/operational-alert'
import FinalInvoiceEmail from '../emails/final-invoice'
import ReferralRewardEmail from '../emails/referral-reward'
import QuoteFollowupEmail from '../emails/quote-followup'
import QuoteRequestReceivedEmail from '../emails/quote-request-received'
import LeadNurtureEmail from '../emails/lead-nurture'
import { localizedSubject } from '../lib/i18n'
import { isSequenceKind } from '../lib/consent/notice-registry'

/** The templates this worker can dispatch: the queue's own list. */
type WorkerTemplate = EmailJobData['template']

// ════════════════════════════════════════════════════════════════════════
//  MESSAGING POLICY — the 11 React (_ui-kit) customer emails. Each is tied to a
//  real booking lifecycle event (the marketing lead drip lives in Leadtracking):
//    • 'pre-approval'         → payment step (premium render via outbox when ON)
//    • 'final-confirmation'   → owner approval (premium render via outbox when ON)
//    • 'booking-declined'     → owner denies a request (hold released)
//    • 'payment-receipt'      → admin "resend receipt"
//    • 'booking-updated'      → date/time/address/service change confirmed
//    • 'booking-cancellation' → a captured booking is cancelled
//    • 'job-reminder'         → 72h / 24h before the move (scheduler — fast-follow)
//    • 'job-completion'       → move complete / thank-you (COMPLETED transition)
//    • 'review-request'       → after completion (also fired by followups)
//    • 'abandoned-checkout'   → started a booking, no deposit (scheduler — fast-follow)
//    • 'referral'             → post-move referral ask (also fired by followups)
//  ALLOWED_TEMPLATES is the single choke point: any template NOT listed here is
//  DROPPED with a clear log, so a stray/legacy enqueue can never send an
//  unintended email. Add a template here only when its design + trigger are
//  intentionally part of the customer journey.
// ════════════════════════════════════════════════════════════════════════
const ALLOWED_TEMPLATES = new Set<WorkerTemplate>([
  'pre-approval',
  'final-confirmation',
  'booking-declined',
  'payment-receipt',
  'booking-updated',
  'booking-cancellation',
  'job-reminder',
  'job-completion',
  'review-request',
  'abandoned-checkout',
  'referral',
  'payment-failed',
  'information-required',
  'operational-alert',
  'final-invoice',
  'referral-reward',
  // ── Lifecycle journeys (src/lib/journeys.ts) ──
  'abandoned-checkout-2',
  'abandoned-checkout-3',
  'quote-followup-1',
  'quote-followup-2',
  'quote-followup-final',
  // ── Non-quote lead nurture (owner spec 2026-08-06) ──
  'lead-nurture-1',
  'lead-nurture-2',
  'lead-nurture-final',
  // ── Quick-quote capture (owner spec 2026-08-03) ──
  'quote-request-received',
])

const TEMPLATES: Record<
  WorkerTemplate,
  (payload: Record<string, unknown>) => React.ReactElement
> = {
  'pre-approval': (p) => PreApprovalEmail(p as any),
  'final-confirmation': (p) => FinalConfirmationEmail(p as any),
  'booking-declined': (p) => BookingDeclinedEmail(p as any),
  'payment-receipt': (p) => PaymentReceiptEmail(p as any),
  'booking-updated': (p) => BookingUpdatedEmail(p as any),
  'booking-cancellation': (p) => BookingCancellationEmail(p as any),
  'job-reminder': (p) => JobReminderEmail(p as any),
  'job-completion': (p) => JobCompletionEmail(p as any),
  'review-request': (p) => ReviewRequestEmail(p as any),
  'abandoned-checkout': (p) => AbandonedCheckoutEmail(p as any),
  'referral': (p) => ReferralEmail(p as any),
  'payment-failed': (p) => PaymentFailedEmail(p as any),
  'information-required': (p) => InformationRequiredEmail(p as any),
  'operational-alert': (p) => OperationalAlertEmail(p as any),
  'final-invoice': (p) => FinalInvoiceEmail(p as any),
  'referral-reward': (p) => ReferralRewardEmail(p as any),
  // Recovery stages 2/3 reuse ONE template; `stage` in the payload varies
  // the copy (same pattern as the 72h/24h reminder).
  'abandoned-checkout-2': (p) => AbandonedCheckoutEmail({ ...(p as any), stage: 2 }),
  'abandoned-checkout-3': (p) => AbandonedCheckoutEmail({ ...(p as any), stage: 3 }),
  'quote-followup-1': (p) => QuoteFollowupEmail({ ...(p as any), stage: 1 }),
  'quote-followup-2': (p) => QuoteFollowupEmail({ ...(p as any), stage: 2 }),
  'quote-followup-final': (p) => QuoteFollowupEmail({ ...(p as any), stage: 3 }),
  'quote-request-received': (p) => QuoteRequestReceivedEmail(p as any),
  // Three send times, ONE template — the same pattern as the recovery and
  // quote families. `stage` varies the copy; it is never inferred from a date.
  'lead-nurture-1': (p) => LeadNurtureEmail({ ...(p as any), stage: 1 }),
  'lead-nurture-2': (p) => LeadNurtureEmail({ ...(p as any), stage: 2 }),
  'lead-nurture-final': (p) => LeadNurtureEmail({ ...(p as any), stage: 3 }),
}

// English fallbacks. Bilingual subjects come from emailSubject(template, locale)
// when the job payload carries a `locale`.
export const SUBJECTS: Record<WorkerTemplate, string> = {
  'pre-approval': "We've received your booking request",
  'final-confirmation': 'Your booking is approved',
  'booking-declined': 'About your booking request',
  'payment-receipt': 'Payment received — receipt enclosed',
  'booking-updated': 'Your booking has been updated',
  'booking-cancellation': 'Your booking has been cancelled',
  'job-reminder': 'Your move is almost here',
  'job-completion': 'Your move is complete — thank you',
  'review-request': 'How did we do? Leave us a review',
  'abandoned-checkout': 'Your date is still available',
  'referral': 'Give 15%. Get 15%.',
  'payment-failed': 'Action required — update your payment method',
  'information-required': 'We need a few details to schedule your move',
  'operational-alert': 'An update about your move',
  'final-invoice': 'Your final invoice',
  'referral-reward': 'Your referral reward is here',
  'abandoned-checkout-2': "What's included in a labor-only move",
  'abandoned-checkout-3': 'Did your moving plans change?',
  'quote-followup-1': 'Did your quote come through?',
  'quote-followup-2': 'What "labor-only" actually means',
  'quote-followup-final': 'Are you still planning your move?',
  'quote-request-received': 'We received your moving estimate request',
  'lead-nurture-1': 'To price your move, we need a few things',
  'lead-nurture-2': 'What "labor-only" actually means',
  'lead-nurture-final': 'Do you still need an estimate?',
}

// ════════════════════════════════════════════════════════════════════════
//  SEND-TIME STOP RULES — delegated to the CANONICAL predicate.
//  ---------------------------------------------------------------------
//  This used to be a hand-written switch that, for 'final-confirmation',
//  blocked only 'CANCELLED' — while src/emails/status.ts said the template is
//  truthful ONLY in CONFIRMED/SCHEDULED/IN_PROGRESS/COMPLETED. Two tables, two
//  answers, and the weaker one was the one that ran (finding EMAIL-P0-02).
//
//  There is now exactly one answer: src/lib/email-eligibility.bookingEligibility,
//  which reloads the booking and applies the status table from status.ts PLUS
//  the workflow condition the template actually asserts. See that module for why
//  a status match alone is not sufficient.
// ════════════════════════════════════════════════════════════════════════

/** Insert a 1x1 open-tracking pixel just before </body> (or append if none). */
function injectOpenPixel(html: string, src: string): string {
  const pixel = `<img src="${src}" width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px;max-height:1px;overflow:hidden;opacity:0;" />`
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${pixel}</body>`) : html + pixel
}

export async function processEmailJob(job: Job<EmailJobData>): Promise<void> {
  // ── MALFORMED JOB DATA ──────────────────────────────────────────────────
  // A job whose data cannot describe a send (no template, no recipient, a
  // non-object payload) is UNRECOVERABLE: retrying it three times cannot fix
  // it. UnrecoverableError moves it straight to BullMQ's failed set, where it
  // is visible, without burning retries — and without touching any other job,
  // because each job is processed independently.
  const invalid = validateEmailJobData(job.data)
  if (invalid) {
    queueLogger.error({ jobId: job.id, name: job.name, problem: invalid }, 'malformed email job — moved to failed without retry')
    throw new UnrecoverableError(`malformed email job: ${invalid}`)
  }
  const { template, to, bookingId, leadId, businessEventKey, notificationId } = job.data
  const payload: Record<string, unknown> = job.data.payload ?? {}
  // Never log the recipient address itself.
  const log = queueLogger.child({ jobId: job.id, template, bookingId, leadId })

  log.info('📧 Email job received')

  // ── MESSAGING POLICY GUARD ──────────────────────────────────────────────
  // Only templates in ALLOWED_TEMPLATES are ever sent. Anything else is dropped
  // here (not an error — a deliberate, logged skip) so retries don't pile up.
  if (!ALLOWED_TEMPLATES.has(template)) {
    log.warn(
      { template, allowed: Array.from(ALLOWED_TEMPLATES) },
      '🚫 Email template not in allowlist — skipping'
    )
    if (notificationId) {
      await prisma.notification
        .update({ where: { id: notificationId }, data: { status: 'FAILED', error: 'template not in allowlist' } })
        .catch(() => undefined)
    }
    return
  }

  // Mark notification as in-progress
  if (notificationId) {
    await prisma.notification.update({
      where: { id: notificationId },
      data: { status: 'QUEUED', retries: { increment: 1 } },
    })
  }

  const component = TEMPLATES[template]
  if (!component) {
    throw new Error(`Unknown email template: ${template}`)
  }

  // COMPLIANCE CONTEXT (finding EMAIL-P1-06). Derived from the RECIPIENT, never
  // trusted from the payload — a queued job cannot smuggle in someone else's
  // unsubscribe link, and a promotional template gets the full block (link +
  // postal address + reason) even when the enqueuer supplied none of it.
  // An incomplete context does NOT silently degrade: guardedSend blocks the send.
  const emailClass = classifyTemplate(template)
  let renderPayload: Record<string, unknown> = payload
  if (emailClass === 'promotional') {
    const ctx = buildMarketingContext(to, template, (payload.locale as string) ?? 'en')
    renderPayload = ctx.ok ? applyMarketingContext(payload, ctx.context) : payload
  }

  let html = render(component(renderPayload))
  // Plain-text multipart part — deliverability (spam score) + accessibility.
  const text = render(component(renderPayload), { plainText: true })
  // Embed the open-tracking pixel. Requires a Notification row to attribute the
  // open to + APP_URL to build the public pixel URL. The token is persisted
  // BEFORE the send, so an open landing the instant the email arrives resolves.
  if (notificationId && process.env.APP_URL) {
    const openToken = randomUUID()
    await prisma.notification
      .update({ where: { id: notificationId }, data: { openToken } })
      .catch(() => undefined)
    const base = process.env.APP_URL.replace(/\/+$/, '')
    html = injectOpenPixel(html, `${base}/api/email/open?token=${openToken}`)
  }
  // Subject precedence: explicit payload.subject → bilingual catalog (if the
  // payload carries a locale) → English fallback.
  // A template the bilingual catalog does not know falls back to its own
  // English subject — never to the bare business name.
  const subject =
    (payload.subject as string) ||
    (payload.locale ? localizedSubject(template, payload.locale as string) : null) ||
    SUBJECTS[template]

  // ── THE SEND GATE ───────────────────────────────────────────────────────
  // guardedSend owns suppression, the live state recheck, frequency caps, quiet
  // hours, payload validation, and the idempotency claim. This worker no longer
  // talks to Resend directly, so the guard cannot be bypassed here.
  //
  // `eventId` anchors the idempotency key. A booking-scoped email is
  // exactly-once PER BOOKING; without a bookingId we fall back to the queue job
  // id, which still stops a BullMQ retry from double-sending.
  log.info({ subject }, '📤 Handing to the send guard…')
  // SCENARIO SEQUENCES (2026-09-16). A lead-scoped journey stage is sent in
  // the 'scenario_flow' context, for the sequence kind the stage planner put
  // on the job (or the one its template belongs to). The same request goes to
  // the guard's own eligibility step, so the guard never falls back to a
  // narrower journey-label guess that would refuse a valid notice basis — and
  // never to a wider one either: this is the exact question the recheck asks.
  const jobKind = typeof payload.sequenceKind === 'string' && isSequenceKind(payload.sequenceKind) ? payload.sequenceKind : null
  const leadScoped = !bookingId && !!leadId
  const outcome = await guardedSend({
    to,
    subject,
    html,
    text,
    template,
    emailClass,
    journey: (payload.journey as string) ?? undefined,
    // IDENTITY PRECEDENCE (finding EMAIL-P1-12): an explicit business-event key
    // wins, then the booking, then the lead. The queue job id is the LAST
    // resort — it changes on every scheduler retry, so keying on it lets the
    // same logical send happen twice.
    eventId: businessEventKey ?? bookingId ?? leadId ?? job.id ?? undefined,
    bookingId: bookingId ?? undefined,
    leadId: leadId ?? undefined,
    payload: renderPayload,
    // Live state reload for whichever subject this email is about.
    recheck: bookingId
      ? () => bookingEligibility(template, bookingId)
      : leadId
      ? () =>
          leadEligibility(leadId, template, {
            context: 'scenario_flow',
            sequenceKind: jobKind,
            // The address this job would reach must still be the lead's own.
            recipient: to,
          })
      : undefined,
    ...(leadScoped && emailClass === 'promotional'
      ? {
          eligibilityRequest: {
            context: 'scenario_flow' as const,
            subject: { type: 'lead' as const, id: leadId as string, sequenceKind: jobKind ?? sequenceKindForTemplate(template) },
          },
        }
      : {}),
  }).catch(async (err: unknown) => {
    // A DEFINITIVE provider rejection normally rides BullMQ's retry into the
    // guard's not_due re-queue below. On the job's LAST attempt there is no
    // retry left, and nothing else polls email_sends — the email would be lost
    // with the row sitting in provider_rejected. Re-queue at the ledger's due
    // time instead. Same idempotency key, so the hop cannot double-send; if the
    // add itself fails, the original error still reaches BullMQ.
    const lastAttempt = job.attemptsMade + 1 >= (job.opts?.attempts ?? 1)
    if (err instanceof ProviderRejectedError && err.retryAt && lastAttempt) {
      // The SAME due time and job id the not_due branch below computes for this
      // row, so a stalled re-run of this job adds nothing BullMQ has not seen.
      const dueAt = Math.max(err.retryAt.getTime(), Date.now()) + DEFERRAL_BUFFER_MS
      try {
        await emailQueue.add(template, job.data, {
          delay: Math.max(0, dueAt - Date.now()),
          jobId: deferredJobId(job.id, 'not_due', dueAt),
        })
      } catch (addErr) {
        log.error(
          { emailSendId: err.emailSendId, dueAt: new Date(dueAt).toISOString(), addErr: String(addErr) },
          'could not re-queue a provider rejection on the last attempt — the row stays provider_rejected with no re-drive'
        )
        throw err
      }
      if (notificationId) {
        await prisma.notification
          .update({ where: { id: notificationId }, data: { status: 'DEFERRED', error: `provider_rejected: ${err.providerMessage}`.slice(0, 500) } })
          .catch(() => undefined)
      }
      log.warn({ emailSendId: err.emailSendId, dueAt: new Date(dueAt).toISOString() }, 'provider rejected on the last queue attempt — re-queued at the ledger due time')
      return null
    }
    throw err
  })
  if (outcome === null) return

  // ── LEAD-SCOPED DELIVERY STATE ────────────────────────────────────────
  //  The API records only that a job was QUEUED. This is the one place that
  //  knows whether the provider accepted the message, so it is the only place
  //  allowed to write 'delivered'. A DEFERRAL IS NOT A FAILURE: quiet hours and
  //  caps mean "later", and marking that failed would send the admin chasing a
  //  delivery problem that does not exist.
  // A due time from EITHER a policy deferral (retryAt) or a send that already
  // has a scheduled attempt (not_due after a provider rejection). null = do not
  // re-drive automatically. See src/lib/email-deferral.ts.
  const dueAt = deferralDueAt(outcome)

  if (template === 'quote-request-received' && leadId) {
    const isDeferral = !outcome.sent && dueAt !== null
    // 'in_flight' / 'duplicate': ANOTHER attempt owns (or already delivered)
    // this send. Its outcome is the truth; writing 'failed' from here could
    // downgrade a confirmation that was delivered.
    const ownedElsewhere = !outcome.sent && (outcome.reason === 'in_flight' || outcome.reason === 'duplicate')
    if (!isDeferral && !ownedElsewhere) {
      await recordQuoteConfirmationOutcome(leadId, {
        delivered: outcome.sent,
        error: outcome.sent ? undefined : outcome.reason,
      })
    }
  }

  if (!outcome.sent) {
    // ── TRUTHFUL OUTCOME REPORTING (finding EMAIL-P2-16) ──────────────────
    // This used to mark EVERY refusal as notification status FAILED, including
    // quiet-hours and frequency-cap deferrals — so reporting showed a delivery
    // problem where policy had simply said "later". It also swallowed requeue
    // errors, meaning a Redis hiccup silently DROPPED a deferred email while
    // the job reported success.
    if (dueAt !== null) {
      const delay = Math.max(0, dueAt - Date.now())
      log.info({ reason: outcome.reason, delay }, '⏸️ Deferred — re-queueing at the exact due time')

      if (notificationId) {
        await prisma.notification
          .update({
            where: { id: notificationId },
            data: { status: 'DEFERRED', error: outcome.reason.slice(0, 500) },
          })
          .catch(() => undefined)
      }

      // Colon-free id rooted at the ORIGINAL job and unique per hop (it carries
      // the due time). The old `${job.id}:deferred:${reason}` shape was rejected
      // by BullMQ on the SECOND deferral ("Custom Id cannot contain :"), which
      // exhausted the job and dropped the email. The idempotency key is
      // unchanged, so a duplicate hop can never become a duplicate send.
      // NOT caught: if we cannot re-queue, the email would be lost silently.
      // Throwing hands it back to BullMQ's own retry, which is durable.
      await emailQueue.add(template, job.data, {
        delay,
        jobId: deferredJobId(job.id, outcome.reason, dueAt),
      })
      return
    }

    // A refusal the guard could not WRITE to the ledger is invisible to every
    // ledger-based check. Hand it back to BullMQ (bounded by the queue's
    // attempts) instead of completing as if it had been recorded.
    if (outcome.recorded === false) {
      throw new Error(`send refused (${outcome.reason}) but the refusal could not be recorded — retrying`)
    }

    log.warn({ reason: outcome.reason, outcomeClass: outcome.outcomeClass }, '🚫 Send refused by the guard')
    if (notificationId) {
      await prisma.notification
        .update({
          where: { id: notificationId },
          // A retryable block is not a terminal failure either — the guard has
          // left the logical send resumable, so do not report it as dead.
          data: {
            status: outcome.outcomeClass === 'retryable' ? 'QUEUED' : 'FAILED',
            error: outcome.reason.slice(0, 500),
          },
        })
        .catch(() => undefined)
    }
    return
  }

  // Mark notification sent
  if (notificationId) {
    await prisma.notification.update({
      where: { id: notificationId },
      data: { status: 'SENT', sentAt: new Date() },
    })
  }

  log.info({ resendId: outcome.providerId }, '✅ Email sent successfully')
}

// ── Start the worker ──────────────────────────────────────────
export function startEmailWorker() {
  const worker = new Worker<EmailJobData>('email', processEmailJob, {
    connection: getLazyBullConnection(),
    concurrency: 5,
  })

  worker.on('failed', (job, err) => {
    queueLogger.error({ jobId: job?.id, err: err.message }, 'Email job failed')
  })

  worker.on('completed', (job) => {
    queueLogger.info({ jobId: job.id }, 'Email job completed')
  })

  return worker
}
