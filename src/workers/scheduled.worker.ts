import { Worker, Job } from 'bullmq'
import { bullConnection } from '../lib/redis'
import { prisma } from '../lib/db'
import { emailQueue, discordQueue, scheduledQueue, smsQueue } from '../lib/queues'
import { queueLogger } from '../lib/logger'
import { deleteFiles } from '../lib/cloudinary'
import { runFollowup, type FollowupType } from '../lib/followups'
import { quoteFollowupBlockReason } from '../lib/journeys'
import { isSafeUrl } from '../emails/validation'
import { etDayRange, moveDateInRange, effectiveMoveDate } from '../lib/scheduling'
import { dayOfMoveSms } from '../lib/waiting-time'
import { processCampaignBatch, processRecipientRetry, sweepCampaignRuns } from '../lib/email-campaign-dispatch'
import { executeAutomationStage, sweepAutomationEnrollments } from '../lib/email-automation-runtime'
import { customerBalance, JOB_MONEY_PAYMENT_SELECT } from '../lib/job-money'
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
    // ── Abandoned checkout recovery — 3 stages, one template ──────
    // Scheduled by src/lib/journeys.onCheckoutStarted. Each stage re-reads the
    // booking: the moment the deposit is paid, or the booking is cancelled, or
    // the move date passes, the remaining stages self-cancel. The email worker's
    // stillWantedForBooking() checks the SAME conditions once more immediately
    // before the provider call, so a stage that slips through here still dies.
    case 'abandoned-checkout-recovery':
    case 'abandoned-checkout-recovery-2':
    case 'abandoned-checkout-recovery-3': {
      if (!bookingId) break
      const stage = type === 'abandoned-checkout-recovery' ? 1 : type === 'abandoned-checkout-recovery-2' ? 2 : 3
      const booking = await prisma.booking.findUnique({
        where: { id: bookingId },
        include: { customer: true },
      })
      if (!booking) break
      if (booking.status !== 'PENDING_PAYMENT') {
        log.info({ bookingId, stage, status: booking.status }, 'Booking advanced — skipping recovery stage')
        break
      }
      if (booking.isInternalTest) break

      // Never chase a date that has already gone by.
      const target = effectiveMoveDate(booking)
      if (target && target.getTime() + 24 * 3_600_000 < Date.now()) {
        log.info({ bookingId, stage }, 'Move date passed — skipping recovery stage')
        break
      }

      // The continuation URL must be real. An unusable "finish your booking"
      // link is worse than no email — the guard's URL gate would block it, but
      // we skip early so the reason is recorded honestly.
      if (!process.env.APP_URL) {
        log.warn({ bookingId, stage }, 'APP_URL unset — cannot build a continuation URL; skipping')
        break
      }
      const appUrl = process.env.APP_URL.replace(/\/+$/, '')

      await emailQueue.add(`abandoned-checkout-${stage}`, {
        // One template, three send times + three subjects (same pattern the
        // 72h/24h reminder already uses).
        template: stage === 1 ? 'abandoned-checkout' : stage === 2 ? 'abandoned-checkout-2' : 'abandoned-checkout-3',
        to: booking.customer.email,
        bookingId,
        payload: {
          customerName: booking.customer.name,
          displayId: booking.displayId,
          requestedDate: booking.requestedDate?.toISOString(),
          checkoutUrl: `${appUrl}/api/stripe/checkout?resume=${bookingId}`,
          portalUrl: `${appUrl}/my-booking/${booking.customerToken}`,
          heroGifUrl: process.env.EMAIL_HERO_GIF_URL || 'https://moveitclearit.com/email/truck-hero.gif',
          locale: booking.customer.locale,
          journey: 'abandoned',
          stage,
        },
      })
      log.info({ bookingId, stage }, 'Abandoned checkout recovery email queued')
      break
    }

    // ── 72h / 24h job reminders (transactional) ───────────────────
    case 'job-reminder-72h':
    case 'job-reminder-24h': {
      if (!bookingId) break
      const is24h = type === 'job-reminder-24h'
      const booking = await prisma.booking.findUnique({
        where: { id: bookingId },
        include: { customer: true },
      })
      if (!booking || !['CONFIRMED', 'SCHEDULED'].includes(booking.status)) break
      if (booking.isInternalTest) break
      const es = booking.customer.locale === 'es'
      await emailQueue.add('job-reminder', {
        template: 'job-reminder',
        to: booking.customer.email,
        bookingId,
        payload: {
          customerName: booking.customer.name,
          displayId: booking.displayId,
          scheduledStart: booking.scheduledStart?.toISOString(),
          timeLabel: booking.arrivalWindow ?? undefined,
          leadLabel: is24h ? (es ? 'mañana' : 'tomorrow') : es ? 'en 3 días' : 'in 3 days',
          originAddress: booking.originAddress,
          portalUrl: `${process.env.APP_URL}/my-booking/${booking.customerToken}`,
          heroGifUrl: process.env.EMAIL_HERO_GIF_URL || 'https://moveitclearit.com/email/truck-hero.gif',
          locale: booking.customer.locale,
        },
      })
      log.info({ bookingId, type }, 'job reminder queued')
      break
    }

    // ── Quote follow-up (LEAD-scoped) ─────────────────────────────
    // Only ever sent for a lead with a REAL quotedAt. quoteFollowupBlockReason
    // is the shared stop-rule check (converted / lost / move date passed).
    case 'quote-followup-1':
    case 'quote-followup-2':
    case 'quote-followup-final': {
      const leadId = job.data.leadId
      if (!leadId) break
      const lead = await prisma.lead.findUnique({
        where: { id: leadId },
        select: {
          name: true,
          email: true,
          status: true,
          quotedAt: true,
          bookedAt: true,
          lostAt: true,
          moveDate: true,
          convertedBookingId: true,
          jobType: true,
        },
      })
      const block = quoteFollowupBlockReason(lead)
      if (block) {
        log.info({ leadId, type, reason: block }, 'quote follow-up skipped')
        break
      }
      const stage = type === 'quote-followup-1' ? 1 : type === 'quote-followup-2' ? 2 : 3
      await emailQueue.add(type, {
        template: type,
        to: lead!.email as string,
        // Carried through the hop so the email worker can recheck the lead
        // immediately before sending (finding EMAIL-P1-12).
        leadId,
        // STABLE business identity: lead + journey stage. The previous key was
        // the generated queue job id, so a scheduler retry minted a NEW key and
        // produced a second logical send of the same stage.
        businessEventKey: `lead:${leadId}:${type}`,
        payload: {
          customerName: lead!.name,
          jobType: lead!.jobType ?? undefined,
          moveDate: lead!.moveDate?.toISOString(),
          bookingUrl: `${(process.env.MARKETING_SITE_URL || 'https://www.moveitclearit.com').replace(/\/+$/, '')}/booking-form.html?utm_source=email&utm_medium=lifecycle&utm_campaign=quote-followup&utm_content=stage-${stage}`,
          locale: 'en',
          journey: 'quote',
          stage,
        },
      })
      log.info({ leadId, stage }, 'quote follow-up queued')
      break
    }

    // ── 48h post-completion review request ────────────────────────
    case 'review-request-48h': {
      if (!bookingId) break
      // CONFIGURATION GATE (finding EMAIL-P1-15): never queue a review request
      // without a verified destination. The old default was a placeholder
      // Google URL, so an unconfigured environment mailed customers a dead link.
      const reviewDestination = process.env.GOOGLE_REVIEW_URL?.trim() ?? ''
      if (!isSafeUrl(reviewDestination)) {
        log.error(
          { bookingId, configured: Boolean(reviewDestination) },
          'GOOGLE_REVIEW_URL is missing or not a valid destination — review request NOT queued'
        )
        break
      }
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
          googleReviewUrl: reviewDestination,
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

      // ── Day-of-move customer SMS (Late Arrival & Delay Policy) ──
      // Automatic "crew is on the way — please be packed + ready; 30-min grace,
      // then waiting charges" text to every customer with a move today. The
      // morning digest is a once-daily cron, so this fires once per job. Only
      // customers still awaiting the crew (not already IN_PROGRESS) are texted.
      let smsSent = 0
      for (const b of jobs) {
        if (b.status === 'IN_PROGRESS') continue
        const phone = b.customer?.phone
        if (!phone) continue
        await smsQueue.add('day-of-move-reminder', {
          to: phone,
          message: dayOfMoveSms(b.customer?.locale),
          bookingId: b.id,
        })
        smsSent++
      }

      log.info({ count: formatted.length, smsSent }, 'Morning schedule digest + day-of SMS queued')
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

    // ── CAMPAIGN DISPATCH RUNTIME (owner spec 2026-07-22) ─────────
    // All real work lives in src/lib/email-campaign-dispatch.ts; these cases
    // validate the payload and dispatch. Every send inside goes through
    // guardedSend, and every job id is deterministic, so a BullMQ retry or a
    // duplicate enqueue resumes the same logical work.
    case 'campaign-batch': {
      const runId = typeof payload?.runId === 'string' ? payload.runId : null
      const batchIndex = typeof payload?.batchIndex === 'number' && Number.isInteger(payload.batchIndex) ? payload.batchIndex : null
      if (!runId || batchIndex === null || batchIndex < 0) {
        log.error({ payload }, 'campaign-batch payload invalid — dropped')
        break
      }
      const result = await processCampaignBatch(runId, batchIndex)
      log.info({ runId, batchIndex, ...result }, 'campaign batch processed')
      break
    }

    case 'campaign-recipient-retry': {
      const recipientId = typeof payload?.recipientId === 'string' ? payload.recipientId : null
      if (!recipientId) {
        log.error({ payload }, 'campaign-recipient-retry payload invalid — dropped')
        break
      }
      await processRecipientRetry(recipientId)
      break
    }

    case 'campaign-sweep': {
      // Cron: dispatch due SCHEDULED campaigns, re-open stale claims,
      // re-enqueue lost batches, finalize settled runs.
      const result = await sweepCampaignRuns()
      log.info(result, 'campaign sweep complete')
      break
    }

    // ── AUTOMATION RUNTIME (owner spec 2026-07-22) ────────────────
    case 'automation-stage': {
      const enrollmentId = typeof payload?.enrollmentId === 'string' ? payload.enrollmentId : null
      const stageIndex = typeof payload?.stageIndex === 'number' && Number.isInteger(payload.stageIndex) ? payload.stageIndex : null
      if (!enrollmentId || stageIndex === null || stageIndex < 0) {
        log.error({ payload }, 'automation-stage payload invalid — dropped')
        break
      }
      const outcome = await executeAutomationStage(enrollmentId, stageIndex)
      log.info({ enrollmentId, stageIndex, outcome }, 'automation stage processed')
      break
    }

    case 'automation-sweep': {
      // Cron: requeue due-but-idle stages (restart recovery, un-pause) and
      // evaluate the grounded time-based triggers (inactive customers,
      // approaching move dates, abandonment, review/referral eligibility).
      const result = await sweepAutomationEnrollments()
      log.info(result, 'automation sweep complete')
      break
    }

    // ── Post-completion balance reminder (real amounts ONLY) ──────
    // Scheduled by journeys.onBookingCompletedBalance at completion +24h.
    // Everything is recomputed HERE, at send time: a payment recorded in the
    // meantime, a cancellation, or a zero balance all skip with a named
    // reason. Amounts come from job-money.customerBalance — never hardcoded.
    case 'balance-reminder-post': {
      if (!bookingId) break
      const booking = await prisma.booking.findUnique({
        where: { id: bookingId },
        include: { payments: { select: JOB_MONEY_PAYMENT_SELECT }, customer: true },
      })
      if (!booking || !booking.customer?.email) break
      if (booking.isInternalTest) break
      if (booking.status !== 'COMPLETED') {
        log.info({ bookingId, status: booking.status }, 'balance reminder skipped — booking not COMPLETED')
        break
      }
      const balance = customerBalance(booking as never)
      if (balance.outstandingCents <= 0) {
        log.info({ bookingId }, 'balance reminder skipped — nothing owed')
        break
      }
      if (!process.env.APP_URL) {
        log.warn({ bookingId }, 'APP_URL unset — cannot build the portal link; balance reminder skipped')
        break
      }
      const base = process.env.APP_URL.replace(/\/+$/, '')
      const dollars = (cents: number) => (cents / 100).toFixed(2)
      await emailQueue.add('final-invoice', {
        template: 'final-invoice',
        to: booking.customer.email,
        bookingId,
        // Exactly-once per booking for this reminder, across every retry.
        businessEventKey: `booking:${bookingId}:balance-reminder-post`,
        payload: {
          customerName: booking.customer.name,
          displayId: booking.displayId,
          date: booking.completedAt?.toISOString(),
          grandTotal: dollars(balance.finalBilledCents),
          amountPaid: dollars(balance.collectedCents),
          balanceDue: dollars(balance.outstandingCents),
          portalUrl: `${base}/my-booking/${booking.customerToken}`,
          locale: booking.customer.locale,
          journey: 'balance',
        },
      })
      log.info({ bookingId, outstandingCents: balance.outstandingCents }, 'balance reminder queued')
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

  // ── Email dispatch runtime sweeps (owner spec 2026-07-22) ──
  // campaign-sweep: every 5 min — dispatches due SCHEDULED campaigns,
  // re-opens stale recipient claims, re-enqueues lost batches, finalizes
  // settled runs. automation-sweep: every 15 min — requeues due stages
  // (restart / un-pause recovery) and evaluates the grounded time-based
  // triggers. Both are cheap no-ops when there is nothing to do, and every
  // action they take is individually idempotent, so the cadence is a
  // freshness knob rather than a correctness one.
  await scheduledQueue.add(
    'campaign-sweep',
    { type: 'campaign-sweep' },
    { repeat: { pattern: '*/5 * * * *' }, jobId: 'cron:campaign-sweep' }
  )
  await scheduledQueue.add(
    'automation-sweep',
    { type: 'automation-sweep' },
    { repeat: { pattern: '*/15 * * * *' }, jobId: 'cron:automation-sweep' }
  )

  queueLogger.info('Cron jobs registered (daily digests + campaign/automation sweeps)')
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
