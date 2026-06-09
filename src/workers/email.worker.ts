import { Worker, Job } from 'bullmq'
import { render } from '@react-email/render'
import { bullConnection } from '../lib/redis'
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from '../lib/resend'
import { prisma } from '../lib/db'
import { queueLogger } from '../lib/logger'
import type { EmailJobData } from '../lib/queues'

// ── Email template imports ─────────────────────────────────────
// Each template is a React component
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
import { emailSubject } from '../lib/i18n'

const TEMPLATES: Record<
  EmailJobData['template'],
  (payload: Record<string, unknown>) => React.ReactElement
> = {
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
}

// English fallbacks. Bilingual subjects come from emailSubject(template, locale)
// when the job payload carries a `locale`.
const SUBJECTS: Record<EmailJobData['template'], string> = {
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
}

async function processEmailJob(job: Job<EmailJobData>): Promise<void> {
  const { template, to, bookingId, notificationId, payload } = job.data
  const log = queueLogger.child({ jobId: job.id, template, to })

  log.info('Processing email job')

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

  const html = render(component(payload))
  // Subject precedence: explicit payload.subject → bilingual catalog (if the
  // payload carries a locale) → English fallback.
  const subject =
    (payload.subject as string) ||
    (payload.locale ? emailSubject(template, payload.locale as string) : SUBJECTS[template])

  const { error } = await resend.emails.send({
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

  log.info('Email sent successfully')
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
