import { Worker, Job } from 'bullmq'
import { bullConnection } from '../lib/redis'
import { prisma } from '../lib/db'
import { emailQueue, discordQueue, scheduledQueue } from '../lib/queues'
import { queueLogger } from '../lib/logger'
import { deleteFiles } from '../lib/cloudinary'
import { runFollowup, type FollowupType } from '../lib/followups'
import { etDayRange, moveDateInRange, effectiveMoveDate } from '../lib/scheduling'
import type { ScheduledJobData } from '../lib/queues'

type DigestBooking = {
  displayId: string
  itemsDescription: string | null
  originAddress: string
  scheduledStart: Date | null
  confirmedDate: Date | null
  requestedDate: Date | null
  customer: { name: string }
}

// Shape confirmed bookings into the daily-digest summaries, ordered by — and
// timed off — their effective move date (scheduledStart ?? confirmedDate ??
// requestedDate) so a booking is never dropped or mistimed because one date
// field was blank. All times render in America/New_York.
function formatDigestJobs(bookings: DigestBooking[]) {
  return bookings
    .map((b) => ({ b, when: effectiveMoveDate(b) }))
    .sort((a, z) => (a.when?.getTime() ?? 0) - (z.when?.getTime() ?? 0))
    .map(({ b, when }) => ({
      displayId: b.displayId,
      customerName: b.customer.name,
      serviceType: b.itemsDescription?.split('\n')[0]?.replace('Service: ', '') ?? 'Unknown',
      scheduledTime: when
        ? when.toLocaleTimeString('en-US', {
            hour: 'numeric',
            minute: '2-digit',
            timeZone: 'America/New_York',
          })
        : 'TBD',
      originAddress: b.originAddress,
    }))
}

async function processScheduledJob(job: Job<ScheduledJobData>): Promise<void> {
  const { type, bookingId, payload } = job.data
  const log = queueLogger.child({ jobId: job.id, type })

  switch (type) {
    // ── Abandoned checkout recovery (2h after checkout created) ──
    case 'abandoned-checkout-recovery': {
      if (!bookingId) break
      const booking = await prisma.booking.findUnique({
        where: { id: bookingId },
        include: { customer: true },
      })
      if (!booking || booking.status !== 'PENDING_PAYMENT') {
        log.info('Booking already paid or cancelled — skipping recovery')
        break
      }
      await emailQueue.add('abandoned-checkout', {
        template: 'abandoned-checkout',
        to: booking.customer.email,
        bookingId,
        payload: {
          customerName: booking.customer.name,
          displayId: booking.displayId,
          requestedDate: booking.requestedDate?.toISOString(),
          checkoutUrl: `${process.env.APP_URL}/api/stripe/checkout?resume=${bookingId}`,
          portalUrl: `${process.env.APP_URL}/my-booking/${booking.customerToken}`,
          heroGifUrl: process.env.EMAIL_HERO_GIF_URL || 'https://moveitclearit.com/email/truck-hero.gif',
          locale: booking.customer.locale,
        },
      })
      log.info({ bookingId }, 'Abandoned checkout recovery email queued')
      break
    }

    // ── 24h job reminder ──────────────────────────────────────────
    case 'job-reminder-24h': {
      if (!bookingId) break
      const booking = await prisma.booking.findUnique({
        where: { id: bookingId },
        include: { customer: true },
      })
      if (!booking || !['CONFIRMED', 'SCHEDULED'].includes(booking.status)) break
      await emailQueue.add('job-reminder', {
        template: 'job-reminder',
        to: booking.customer.email,
        bookingId,
        payload: {
          customerName: booking.customer.name,
          displayId: booking.displayId,
          scheduledStart: booking.scheduledStart?.toISOString(),
          timeLabel: booking.arrivalWindow ?? undefined,
          leadLabel: booking.customer.locale === 'es' ? 'mañana' : 'tomorrow',
          originAddress: booking.originAddress,
          portalUrl: `${process.env.APP_URL}/my-booking/${booking.customerToken}`,
          heroGifUrl: process.env.EMAIL_HERO_GIF_URL || 'https://moveitclearit.com/email/truck-hero.gif',
          locale: booking.customer.locale,
        },
      })
      log.info({ bookingId }, '24h job reminder queued')
      break
    }

    // ── 48h post-completion review request ────────────────────────
    case 'review-request-48h': {
      if (!bookingId) break
      const booking = await prisma.booking.findUnique({
        where: { id: bookingId },
        include: { customer: true },
      })
      if (!booking) break
      await emailQueue.add('review-request', {
        template: 'review-request',
        to: booking.customer.email,
        bookingId,
        payload: {
          customerName: booking.customer.name,
          googleReviewUrl: process.env.GOOGLE_REVIEW_URL || 'https://g.page/r/REPLACE_WITH_GOOGLE_REVIEW_LINK/review',
          portalUrl: `${process.env.APP_URL}/my-booking/${booking.customerToken}`,
          heroGifUrl: process.env.EMAIL_HERO_GIF_URL || 'https://moveitclearit.com/email/truck-hero.gif',
          locale: booking.customer.locale,
        },
      })
      log.info({ bookingId }, 'Review request queued')
      break
    }

    // ── Orphan file cleanup (runs via cron) ───────────────────────
    case 'file-cleanup': {
      const cutoff = new Date()
      cutoff.setDate(cutoff.getDate() - 30) // 30 days old

      const orphanedFiles = await prisma.file.findMany({
        where: {
          bookingId: null,
          jobId: null,
          createdAt: { lt: cutoff },
        },
      })

      if (orphanedFiles.length > 0) {
        const ids = orphanedFiles.map((f) => f.cloudinaryId)
        await deleteFiles(ids)
        await prisma.file.deleteMany({
          where: { id: { in: orphanedFiles.map((f) => f.id) } },
        })
        log.info({ count: orphanedFiles.length }, 'Orphaned files cleaned up')
      }
      break
    }

    // ── 7 AM: Today's confirmed jobs ──────────────────────────────
    case 'daily-schedule-morning': {
      // Day boundaries pinned to America/New_York (not the server's local zone),
      // so a Sunday ET move can't slip into Saturday-night / Monday UTC.
      const { start: todayStart, end: todayEnd } = etDayRange(0)

      const jobs = await prisma.booking.findMany({
        where: {
          status: { in: ['CONFIRMED', 'SCHEDULED', 'IN_PROGRESS'] },
          ...moveDateInRange(todayStart, todayEnd),
        },
        include: { customer: true },
      })

      const formatted = formatDigestJobs(jobs)

      const today = new Date().toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        timeZone: 'America/New_York',
      })

      await discordQueue.add('daily-schedule', {
        type: 'daily-schedule',
        payload: {
          title: `☀️ Today's Jobs — ${today}`,
          jobs: formatted,
        },
      })

      log.info({ count: formatted.length }, 'Morning schedule digest queued')
      break
    }

    // ── 7 PM: Tomorrow's confirmed jobs ───────────────────────────
    case 'daily-schedule-evening': {
      // Tomorrow's ET calendar day (DST-safe — the shift is done in calendar
      // space, and the boundaries are ET midnights, not server-local ones).
      const { start: tomorrowStart, end: tomorrowEnd } = etDayRange(1)

      const jobs = await prisma.booking.findMany({
        where: {
          status: { in: ['CONFIRMED', 'SCHEDULED'] },
          ...moveDateInRange(tomorrowStart, tomorrowEnd),
        },
        include: { customer: true },
      })

      const formatted = formatDigestJobs(jobs)

      const tomorrowLabel = tomorrowStart.toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        timeZone: 'America/New_York',
      })

      await discordQueue.add('daily-schedule', {
        type: 'daily-schedule',
        payload: {
          title: `🌙 Tomorrow's Jobs — ${tomorrowLabel}`,
          jobs: formatted,
        },
      })

      log.info({ count: formatted.length }, 'Evening schedule digest queued')
      break
    }

    // ── Phase 3 post-move follow-ups (review/repeat/referral) ─────
    case 'review-request':
    case 'review-reminder':
    case 'repeat-reminder':
    case 'referral-ask': {
      if (!bookingId) break
      // All guards (enabled flag, opt-out, quiet hours, frequency cap, exactly-
      // once ledger) live in runFollowup so this worker stays a thin dispatcher.
      const result = await runFollowup(bookingId, type as FollowupType)
      log.info({ bookingId, type, result }, 'follow-up processed')
      break
    }

    default:
      log.warn({ type }, 'Unknown scheduled job type')
  }
}

// ── Register repeatable cron jobs (idempotent — safe to call on startup) ──
//
// Cron times use America/New_York timezone:
//   7:00 AM ET → morning digest (today's jobs)
//   7:00 PM ET → evening digest (tomorrow's jobs)
//
// BullMQ deduplicates by the job name + repeat key, so calling this on
// every worker start won't create duplicate cron entries.
async function registerCronJobs(): Promise<void> {
  await scheduledQueue.add(
    'daily-schedule-morning',
    { type: 'daily-schedule-morning' },
    {
      repeat: {
        pattern: '0 7 * * *',
        tz: 'America/New_York',
      },
      jobId: 'cron:daily-schedule-morning', // stable ID prevents duplicates
    }
  )

  await scheduledQueue.add(
    'daily-schedule-evening',
    { type: 'daily-schedule-evening' },
    {
      repeat: {
        pattern: '0 19 * * *',
        tz: 'America/New_York',
      },
      jobId: 'cron:daily-schedule-evening',
    }
  )

  queueLogger.info('Daily schedule cron jobs registered (7 AM + 7 PM ET)')
}

export function startScheduledWorker() {
  const worker = new Worker<ScheduledJobData>('scheduled', processScheduledJob, {
    connection: bullConnection,
    concurrency: 2,
  })

  worker.on('failed', (job, err) => {
    queueLogger.error({ jobId: job?.id, err: err.message }, 'Scheduled job failed')
  })

  // Register recurring digests on startup (idempotent)
  registerCronJobs().catch((err) =>
    queueLogger.error({ err }, 'Failed to register cron jobs')
  )

  return worker
}
