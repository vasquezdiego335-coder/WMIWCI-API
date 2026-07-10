import { Worker, Job } from 'bullmq'
import { randomUUID } from 'node:crypto'
import { render } from '@react-email/render'
import { bullConnection } from '../lib/redis'
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from '../lib/resend'
import { prisma } from '../lib/db'
import { queueLogger } from '../lib/logger'
import type { EmailJobData } from '../lib/queues'

// ── Email template imports ─────────────────────────────────────
// Each template is a React component
import PreApprovalEmail from '../emails/pre-approval'
import FinalConfirmationEmail from '../emails/final-confirmation'
import BookingConfirmationEmail from '../emails/booking-confirmation'
import PaymentReceiptEmail from '../emails/payment-receipt'
import PendingApprovalEmail from '../emails/pending-approval'
import BookingConfirmedEmail from '../emails/booking-confirmed'
import BookingDeniedEmail from '../emails/booking-denied'
import JobReminderEmail from '../emails/job-reminder'
import JobCompletionEmail from '../emails/job-completion'
import ReviewRequestEmail from '../emails/review-request'
import AbandonedCheckoutEmail from '../emails/abandoned-checkout'
import ContactAckEmail from '../emails/contact-ack'
import RescheduleOfferEmail from '../emails/reschedule-offer'
import BookingRescheduledEmail from '../emails/booking-rescheduled'
import { emailSubject } from '../lib/i18n'

// ════════════════════════════════════════════════════════════════════════
//  MESSAGING POLICY — exactly TWO customer emails exist in this system:
//    • 'pre-approval'       → queued by the Discord approval handler
//    • 'final-confirmation' → queued by fulfillPaidCheckout()
//  ALLOWED_TEMPLATES is the single hard guarantee: any other template (legacy
//  booking-confirmation, contact-ack, booking-denied, reschedule-offer, the
//  scheduled digests, …) is DROPPED at this choke point with a clear log, so a
//  stray enqueue anywhere in the codebase can never send a third kind of email.
// ════════════════════════════════════════════════════════════════════════
const ALLOWED_TEMPLATES = new Set<EmailJobData['template']>([
  'pre-approval',
  'final-confirmation',
])

const TEMPLATES: Record<
  EmailJobData['template'],
  (payload: Record<string, unknown>) => React.ReactElement
> = {
  'pre-approval': (p) => PreApprovalEmail(p as any),
  'final-confirmation': (p) => FinalConfirmationEmail(p as any),
  'booking-confirmation': (p) => BookingConfirmationEmail(p as any),
  'payment-receipt': (p) => PaymentReceiptEmail(p as any),
  'pending-approval': (p) => PendingApprovalEmail(p as any),
  'booking-confirmed': (p) => BookingConfirmedEmail(p as any),
  'booking-denied': (p) => BookingDeniedEmail(p as any),
  'job-reminder': (p) => JobReminderEmail(p as any),
  'job-completion': (p) => JobCompletionEmail(p as any),
  'review-request': (p) => ReviewRequestEmail(p as any),
  'abandoned-checkout': (p) => AbandonedCheckoutEmail(p as any),
  'contact-ack': (p) => ContactAckEmail(p as any),
  'reschedule-offer': (p) => RescheduleOfferEmail(p as any),
  'booking-rescheduled': (p) => BookingRescheduledEmail(p as any),
}

// English fallbacks. Bilingual subjects come from emailSubject(template, locale)
// when the job payload carries a `locale`.
const SUBJECTS: Record<EmailJobData['template'], string> = {
  'pre-approval': "We've received your booking request",
  'final-confirmation': 'Your booking is approved',
  'booking-confirmation': 'Your booking request has been received',
  'payment-receipt': 'Payment confirmed — We Move It. We Clear It.',
  'pending-approval': "We're reviewing your booking",
  'booking-confirmed': '✅ Booking confirmed! See you on move day',
  'booking-denied': 'Booking update — new times available',
  'job-reminder': "⏰ Reminder: Your move is tomorrow",
  'job-completion': '✅ Job complete — thank you!',
  'review-request': 'How did we do? Leave us a review',
  'abandoned-checkout': 'Your booking is waiting — complete your deposit',
  'contact-ack': 'We got your message',
  'reschedule-offer': 'Pick a new date for your move',
  'booking-rescheduled': 'Your move has been rescheduled',
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

  let html = render(component(payload))
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

  log.info({ subject }, '📤 Sending email via Resend…')
  const { data, error } = await resend.emails.send({
    from: EMAIL_FROM,
    to,
    reply_to: EMAIL_REPLY_TO,
    subject,
    html,
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
