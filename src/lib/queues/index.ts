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
// Existing code like `emailQueue.add(...)` keeps working unchanged; the Queue
// instance is created on first property access, not at import (so `next build`
// never opens Redis connections).
//
// ⚠️ The proxy MUST forward BOTH reads and writes to the real Queue, and run
// accessors with the real Queue as the receiver. A get-only proxy (the previous
// version) ran BullMQ's internal getters with `this` = the proxy. BullMQ 5.77's
// `get repeat()` does `this._repeat = new Repeat(); this._repeat.on('error', …)`
// — with no `set` trap that write landed on the empty proxy target and vanished,
// so the very next line read `this._repeat` back as undefined →
// "Cannot read properties of undefined (reading 'on')" the instant the scheduled
// worker registered a repeatable (cron) job. Forwarding `set` and using the real
// Queue as the receiver makes the proxy behave exactly like the instance.
function lazyQueue(getQueue: () => Queue): Queue {
  return new Proxy({} as Queue, {
    get(_t, p) { const q = getQueue(); return Reflect.get(q, p, q) },
    set(_t, p, v) { const q = getQueue(); return Reflect.set(q, p, v, q) },
    has(_t, p) { return Reflect.has(getQueue(), p) },
  })
}

export const emailQueue = lazyQueue(getEmailQueue)
export const smsQueue = lazyQueue(getSmsQueue)
export const discordQueue = lazyQueue(getDiscordQueue)
export const webhookRetryQueue = lazyQueue(getWebhookRetryQueue)
export const scheduledQueue = lazyQueue(getScheduledQueue)
export const marketingQueue = lazyQueue(getMarketingQueue)

// ── Job type definitions ──────────────────────────────────────
export type EmailJobData = {
  template:
    // ── The ONLY 2 customer emails the system sends (enforced by the
    //    allowlist in src/workers/email.worker.ts) ──
    | 'pre-approval'        // admin clicked ✅ Approve in Discord
    | 'final-confirmation'  // payment completed (fulfillPaidCheckout)
    // ── Legacy templates: still defined so existing call sites typecheck, but
    //    the email-worker allowlist drops them at runtime (logged, never sent). ──
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
    | 'booking-rescheduled'// customer picked a new date → confirmation
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
    // ── Phase 3 post-move follow-ups (handled by runFollowup in followups.ts) ──
    | 'review-request'
    | 'review-reminder'
    | 'repeat-reminder'
    | 'referral-ask'
  bookingId?: string
  payload?: Record<string, unknown>
}
