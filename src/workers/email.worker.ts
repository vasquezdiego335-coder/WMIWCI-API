import { Worker, Job } from 'bullmq'
import { randomUUID } from 'node:crypto'
import { render } from '@react-email/render'
import { assertEmailPayload, EmailValidationError } from '../emails/validation'
import { bullConnection } from '../lib/redis'
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from '../lib/resend'
import { prisma } from '../lib/db'
import { queueLogger } from '../lib/logger'
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
}

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

  // ── PRE-SEND VALIDATION GATE ────────────────────────────────────────────
  // Fail SAFELY: never send a misleading placeholder (a "confirmation" with no
  // real date, a '#'/localhost link, etc.). Log loudly + drop the job — no
  // throw, because missing data won't heal on a retry.
  try {
    assertEmailPayload(template, payload as Record<string, unknown>)
  } catch (err) {
    if (err instanceof EmailValidationError) {
      log.error({ err: err.message }, '🚫 Email BLOCKED by pre-send validation — not sent')
      if (notificationId) {
        await prisma.notification
          .update({ where: { id: notificationId }, data: { status: 'FAILED', error: err.message.slice(0, 500) } })
          .catch(() => undefined)
      }
      return
    }
    throw err
  }

  let html = render(component(payload))
  // Plain-text multipart part — deliverability (spam score) + accessibility.
  const text = render(component(payload), { plainText: true })
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

  // List-Unsubscribe on PROMOTIONAL messages ONLY (never on transactional
  // receipts/booking updates/move-day messages). Activates when the payload
  // carries a real https unsubscribe URL (see blocker: unsubscribe route).
  const PROMOTIONAL = new Set(['abandoned-checkout', 'review-request', 'referral', 'referral-reward'])
  const unsub = payload.unsubscribeUrl as string | undefined
  const headers =
    PROMOTIONAL.has(template) && unsub && /^https:\/\//.test(unsub)
      ? { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
      : undefined

  log.info({ subject }, '📤 Sending email via Resend…')
  const { data, error } = await resend.emails.send({
    from: EMAIL_FROM,
    to,
    reply_to: EMAIL_REPLY_TO,
    subject,
    html,
    ...(text ? { text } : {}),
    ...(headers ? { headers } : {}),
  })

  if (error) {
    log.error({ error }, 'Resend returned error')
    // Mark notification failed
    if (notificationId) {
      await prisma.notification.update({
        where: { id: notificationId },
        data: { status: 'FAILED', error: JSON.stringify(error) },
      })
    }
    throw new Error(`Resend error: ${error.message}`)
  }

  // Mark notification sent
  if (notificationId) {
    await prisma.notification.update({
      where: { id: notificationId },
      data: { status: 'SENT', sentAt: new Date() },
    })
  }

  log.info({ resendId: data?.id }, '✅ Email sent successfully')
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
