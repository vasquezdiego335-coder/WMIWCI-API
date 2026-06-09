import { Queue } from 'bullmq'
import { bullConnection } from '../redis'

const connection = bullConnection

// ── Named queues ─────────────────────────────────────────────
export const emailQueue = new Queue('email', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 200 },
  },
})

export const smsQueue = new Queue('sms', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 100 },
  },
})

export const discordQueue = new Queue('discord', {
  connection,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 3000 },
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 200 },
  },
})

export const webhookRetryQueue = new Queue('webhook-retry', {
  connection,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 10000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 100 },
  },
})

export const scheduledQueue = new Queue('scheduled', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'fixed', delay: 60000 },
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 100 },
  },
})

// External marketing automation (Mailchimp/HubSpot/Klaviyo/etc.) — see src/lib/marketing.ts
export const marketingQueue = new Queue('marketing', {
  connection,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 100 },
  },
})

// ── Job type definitions ──────────────────────────────────────
export type EmailJobData = {
  template:
    | 'booking-confirmation'
    | 'payment-receipt'
    | 'pending-approval'
    | 'booking-confirmed'
    | 'booking-denied'
    | 'job-reminder'
    | 'job-completion'
    | 'review-request'
    | 'abandoned-checkout'
    | 'contact-ack'        // auto-reply to a customer who used the contact form
    | 'reschedule-offer'   // declined booking → here are alternate dates
  to: string
  bookingId?: string
  notificationId?: string
  payload: Record<string, unknown>
}

export type SmsJobData = {
  to: string
  message: string
  bookingId?: string
}

export type DiscordJobData = {
  type:
    | 'booking-created'
    | 'payment-received'
    | 'discount-request'
    | 'job-started'
    | 'job-completed'
    | 'failure-alert'
    | 'create-job-channels'
    | 'daily-schedule'
    | 'contact-message'    // a new contact-form submission (alerts the team)
    | 'reschedule-offer'   // re-post an approval card after a customer picks a new date
  bookingId?: string
  payload: Record<string, unknown>
}

export type MarketingJobData = {
  type: 'enroll-customer'
  bookingId?: string
  payload: Record<string, unknown>
}

export type ScheduledJobData = {
  type:
    | 'abandoned-checkout-recovery'
    | 'job-reminder-24h'
    | 'review-request-48h'
    | 'file-cleanup'
    | 'daily-schedule-morning'
    | 'daily-schedule-evening'
  bookingId?: string
  payload?: Record<string, unknown>
}
