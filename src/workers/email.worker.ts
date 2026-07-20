import { Worker, Job } from 'bullmq'
import { randomUUID } from 'node:crypto'
import { render } from '@react-email/render'
import { bullConnection } from '../lib/redis'
import { prisma } from '../lib/db'
import { queueLogger } from '../lib/logger'
import { guardedSend, classifyTemplate } from '../lib/email-guard'
import { unsubscribeUrl } from '../lib/email-tokens'
import { emailQueue } from '../lib/queues'
import { bookingEligibility } from '../lib/email-eligibility'
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
import { emailSubject } from '../lib/i18n'

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
const ALLOWED_TEMPLATES = new Set<EmailJobData['template']>([
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
])

const TEMPLATES: Record<
  EmailJobData['template'],
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
}

// English fallbacks. Bilingual subjects come from emailSubject(template, locale)
// when the job payload carries a `locale`.
const SUBJECTS: Record<EmailJobData['template'], string> = {
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

async function processEmailJob(job: Job<EmailJobData>): Promise<void> {
  const { template, to, bookingId, notificationId, payload } = job.data
  const log = queueLogger.child({ jobId: job.id, template, to, bookingId })

  log.info('📧 Email job received')

  // ── MESSAGING POLICY GUARD ──────────────────────────────────────────────
  // Only the 2 allowed customer emails are ever sent. Anything else is dropped
  // here (not an error — a deliberate, logged skip) so retries don't pile up.
  if (!ALLOWED_TEMPLATES.has(template)) {
    log.warn(
      { template, allowed: Array.from(ALLOWED_TEMPLATES) },
      '🚫 Email template not in allowlist — skipping (messaging is limited to pre-approval + final-confirmation)'
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

  // The unsubscribe link is derived from the RECIPIENT here rather than trusted
  // from the payload — a queued job cannot smuggle in someone else's link, and
  // promotional templates get a working link even when the enqueuer forgot one.
  const emailClass = classifyTemplate(template)
  const renderPayload: Record<string, unknown> =
    emailClass === 'promotional' ? { ...payload, unsubscribeUrl: unsubscribeUrl(to) ?? undefined } : payload

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
  const subject =
    (payload.subject as string) ||
    (payload.locale ? emailSubject(template, payload.locale as string) : SUBJECTS[template])

  // ── THE SEND GATE ───────────────────────────────────────────────────────
  // guardedSend owns suppression, the live state recheck, frequency caps, quiet
  // hours, payload validation, and the idempotency claim. This worker no longer
  // talks to Resend directly, so the guard cannot be bypassed here.
  //
  // `eventId` anchors the idempotency key. A booking-scoped email is
  // exactly-once PER BOOKING; without a bookingId we fall back to the queue job
  // id, which still stops a BullMQ retry from double-sending.
  log.info({ subject }, '📤 Handing to the send guard…')
  const outcome = await guardedSend({
    to,
    subject,
    html,
    text,
    template,
    emailClass,
    journey: (payload.journey as string) ?? undefined,
    eventId: bookingId ?? job.id ?? undefined,
    bookingId: bookingId ?? undefined,
    payload: renderPayload,
    recheck: bookingId ? () => bookingEligibility(template, bookingId) : undefined,
  })

  if (!outcome.sent) {
    // ── TRUTHFUL OUTCOME REPORTING (finding EMAIL-P2-16) ──────────────────
    // This used to mark EVERY refusal as notification status FAILED, including
    // quiet-hours and frequency-cap deferrals — so reporting showed a delivery
    // problem where policy had simply said "later". It also swallowed requeue
    // errors, meaning a Redis hiccup silently DROPPED a deferred email while
    // the job reported success.
    const deferred = Boolean(outcome.retryAt)

    if (deferred) {
      const delay = Math.max(0, (outcome.retryAt as Date).getTime() - Date.now())
      log.info({ reason: outcome.reason, delay }, '⏸️ Deferred — re-queueing inside the allowed window')

      if (notificationId) {
        await prisma.notification
          .update({
            where: { id: notificationId },
            data: { status: 'DEFERRED', error: outcome.reason.slice(0, 500) },
          })
          .catch(() => undefined)
      }

      // A stable jobId keyed on the DEFERRAL REASON (not the attempt) means
      // repeated deferrals collapse onto one pending job instead of fanning out.
      // NOT caught: if we cannot re-queue, the email would be lost silently.
      // Throwing hands it back to BullMQ's own retry, which is durable.
      await emailQueue.add(template, job.data, {
        delay,
        jobId: `${job.id}:deferred:${outcome.reason}`,
      })
      return
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
    connection: bullConnection,
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
