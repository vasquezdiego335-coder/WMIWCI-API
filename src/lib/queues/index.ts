import { Queue } from 'bullmq'
import { getLazyBullConnection } from '../redis'

// ════════════════════════════════════════════════════════════════════════
//  Lazy BullMQ queues
//  ────────────────────────────────────────────────────────────────────
//  Queues are created on FIRST ACCESS, not at import time.  This is
//  critical for Vercel: during `next build`, Next.js imports every
//  route handler to collect page data.  If Queue constructors fire at
//  import time they open 6× Redis connections inside the build
//  container — which has no Redis — flooding the log with hundreds of
//  WRONGPASS / ECONNREFUSED errors and potentially timing out the build.
//
//  The fix: wrap each Queue in a getter backed by a cached singleton.
//  First real request (POST /api/stripe/webhook, etc.) creates the
//  queues once; subsequent requests reuse them.
// ════════════════════════════════════════════════════════════════════════

// ── Cached singletons (undefined until first access) ────────────────
let _emailQueue: Queue | undefined
let _smsQueue: Queue | undefined
let _discordQueue: Queue | undefined
let _webhookRetryQueue: Queue | undefined
let _scheduledQueue: Queue | undefined
let _marketingQueue: Queue | undefined

// ── Named queue getters ─────────────────────────────────────────────
export function getEmailQueue(): Queue {
  if (!_emailQueue) _emailQueue = new Queue('email', {
    connection: getLazyBullConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: { count: 500 },
      removeOnFail: { count: 200 },
    },
  })
  return _emailQueue
}

export function getSmsQueue(): Queue {
  if (!_smsQueue) _smsQueue = new Queue('sms', {
    connection: getLazyBullConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: { count: 200 },
      removeOnFail: { count: 100 },
    },
  })
  return _smsQueue
}

export function getDiscordQueue(): Queue {
  if (!_discordQueue) _discordQueue = new Queue('discord', {
    connection: getLazyBullConnection(),
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 3000 },
      removeOnComplete: { count: 500 },
      removeOnFail: { count: 200 },
    },
  })
  return _discordQueue
}

export function getWebhookRetryQueue(): Queue {
  if (!_webhookRetryQueue) _webhookRetryQueue = new Queue('webhook-retry', {
    connection: getLazyBullConnection(),
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 10000 },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 100 },
    },
  })
  return _webhookRetryQueue
}

export function getScheduledQueue(): Queue {
  if (!_scheduledQueue) _scheduledQueue = new Queue('scheduled', {
    connection: getLazyBullConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'fixed', delay: 60000 },
      removeOnComplete: { count: 200 },
      removeOnFail: { count: 100 },
    },
  })
  return _scheduledQueue
}

export function getMarketingQueue(): Queue {
  if (!_marketingQueue) _marketingQueue = new Queue('marketing', {
    connection: getLazyBullConnection(),
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: { count: 200 },
      removeOnFail: { count: 100 },
    },
  })
  return _marketingQueue
}

// ── Backward-compatible named exports (lazy proxies) ────────────────
// Existing code like `emailQueue.add(...)` keeps working unchanged.
// The Queue instance is created on first property access, not import.
export const emailQueue = new Proxy({} as Queue, { get(_, p, r) { return Reflect.get(getEmailQueue(), p, r) } })
export const smsQueue = new Proxy({} as Queue, { get(_, p, r) { return Reflect.get(getSmsQueue(), p, r) } })
export const discordQueue = new Proxy({} as Queue, { get(_, p, r) { return Reflect.get(getDiscordQueue(), p, r) } })
export const webhookRetryQueue = new Proxy({} as Queue, { get(_, p, r) { return Reflect.get(getWebhookRetryQueue(), p, r) } })
export const scheduledQueue = new Proxy({} as Queue, { get(_, p, r) { return Reflect.get(getScheduledQueue(), p, r) } })
export const marketingQueue = new Proxy({} as Queue, { get(_, p, r) { return Reflect.get(getMarketingQueue(), p, r) } })

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
