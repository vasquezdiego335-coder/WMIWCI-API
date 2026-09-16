import { Worker, Job } from 'bullmq'
import { getLazyBullConnection } from '../lib/redis'
import { prisma } from '../lib/db'
import { emailQueue, discordQueue, scheduledQueue } from '../lib/queues'
import { queueLogger } from '../lib/logger'
import { deleteFiles } from '../lib/cloudinary'
import { runFollowup, type FollowupType } from '../lib/followups'
import { leadNurtureBlockReason, quoteFollowupBlockReason } from '../lib/journeys'
import { isSafeUrl } from '../emails/validation'
import { etDayRange, moveDateInRange, effectiveMoveDate } from '../lib/scheduling'
import { bookingMarketingBlockReason } from '../lib/email-eligibility'
import { hasEverBooked, markStaleLeadsAbandoned, purgeAbandonedLeads } from '../lib/leads'
import { processCampaignBatch, processRecipientRetry, sweepCampaignRuns } from '../lib/email-campaign-dispatch'
import { retryPendingSideEffects } from '../lib/email-events'
import { runEmailMonitoring } from '../lib/email-monitoring'
import { executeAutomationStage, sweepAutomationEnrollments } from '../lib/email-automation-runtime'
import { customerBalance, JOB_MONEY_PAYMENT_SELECT } from '../lib/job-money'
import type { ScheduledJobData } from '../lib/queues'
import { jobReminderEventKey } from '../lib/email-event-keys'
import { queueSafeJobId } from '../lib/email-deferral'
import { CRON_SCHEDULES, createCronReconciler, type CronReconciler, type CronStatus } from '../lib/cron-schedules'
import { pingAppRedis, sanitizeRedisError } from '../lib/redis-health'
import { createErrorLogLimiter } from '../lib/worker-health'

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
          checkoutUrl: `${appUrl}/api/stripe/checkout/resume?booking=${booking.id}`,
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
        // DISTINCT per offset. Both reminders use ONE template, so without this
        // the send key fell back to bookingId alone
        // (email|job-reminder|none|<bookingId>|v1) and the 24h reminder was
        // refused as a 'duplicate' of the delivered 72h one. Stable across
        // scheduler retries, so a retry still dedupes.
        businessEventKey: jobReminderEventKey(bookingId, type, effectiveMoveDate(booking)),
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
          // Quote follow-ups are PROMOTIONAL, so the gate refuses without an
          // explicit opt-in. A select that omits this would not compile —
          // which is the point of LeadState requiring it.
          emailMarketingConsent: true,
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

    // ── Non-quote lead nurture (LEAD-scoped) ──────────────────────
    // Sequence B: an opted-in lead with an email and an intent but NO
    // calculated quote. leadNurtureBlockReason is the shared stop-rule check
    // (consent / has-quote / previous customer / converted / lost / move date
    // passed); the email worker runs it AGAIN immediately before the send, via
    // leadEligibility, because any of those can become true in between.
    case 'lead-nurture-1':
    case 'lead-nurture-2':
    case 'lead-nurture-final': {
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
          // PROMOTIONAL — a select that omits this would not compile, which is
          // the point of NurtureLeadState requiring it.
          emailMarketingConsent: true,
        },
      })
      // BOOKING history, not lead status — a returning customer must never be
      // walked through the first-time sequence.
      const previousCustomer = lead ? await hasEverBooked(lead.email) : false
      const block = leadNurtureBlockReason(lead ? { ...lead, previousCustomer } : null)
      if (block) {
        log.info({ leadId, type, reason: block }, 'lead nurture skipped')
        break
      }
      const stage = type === 'lead-nurture-1' ? 1 : type === 'lead-nurture-2' ? 2 : 3
      await emailQueue.add(type, {
        template: type,
        to: lead!.email as string,
        leadId,
        // STABLE business identity: lead + stage. A scheduler retry reuses it,
        // so guardedSend dedupes rather than minting a second logical send.
        businessEventKey: `lead:${leadId}:${type}`,
        payload: {
          customerName: lead!.name,
          // The quick quote is where a real number actually comes from, so that
          // is where the one CTA goes — never the booking form, which would ask
          // someone with no price to start a checkout.
          quoteUrl: `${(process.env.MARKETING_SITE_URL || 'https://www.moveitclearit.com').replace(/\/+$/, '')}/quote.html?utm_source=email&utm_medium=lifecycle&utm_campaign=lead-nurture&utm_content=stage-${stage}`,
          locale: 'en',
          journey: 'lead-nurture',
          stage,
        },
      })
      log.info({ leadId, stage }, 'lead nurture queued')
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
      // PROMOTIONAL CONSENT (owner spec 2026-08-06). review-request is
      // promotional, so an explicit opt-in is required. bookingEligibility
      // refuses it at send time; refusing here keeps the reason in the log at
      // the moment the job runs rather than leaving a blocked row to explain.
      const consentBlock = await bookingMarketingBlockReason(bookingId)
      if (consentBlock) {
        log.info({ bookingId, reason: consentBlock }, 'review request skipped — no promotional consent')
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
          // SAME journey as the post-job follow-up sequence (followups.ts sends
          // 'review-request' with journey 'post-job'), so the two paths share
          // one idempotency key and can never both send a review request.
          journey: 'post-job',
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

    // ── Daily lead hygiene (owner review 2026-07-24) ──────────────
    // Two gaps this closes: lifecycle ABANDONED was never set by anything (so
    // the admin "Abandoned" view was permanently empty), and self-captured
    // partial leads accumulated with no retention policy. Both steps are
    // conservative — a lead that was quoted, booked, converted, or that carries
    // a consent DECISION is never aged out and never purged. Suppression and
    // unsubscribe records live in their own table and are untouched.
    case 'lead-maintenance': {
      const abandoned = await markStaleLeadsAbandoned()
      const purged = await purgeAbandonedLeads()
      log.info({ abandoned, purged }, 'lead maintenance complete')
      break
    }

    // ── STRANDED LIFECYCLE REPAIR (owner spec 2026-08-07) ─────────
    // Enrolment used to get exactly one attempt, at the instant a quote was
    // recorded. A refusal for a TEMPORARY reason — the rollout allowlist during
    // a canary, a Redis stall, consent that arrives on a later form save — left
    // the lead quoted forever with no follow-up and nothing that would ever look
    // at it again. This is the retry. It only touches leads the send layer has
    // never seen, inside the journey's own 14-day window, with an explicit
    // opt-in, still open — and every candidate re-passes the full eligibility
    // matrix. A no-op costs one indexed query.
    case 'lifecycle-repair': {
      const { repairStrandedQuoteJourneys } = await import('../lib/journeys')
      // Isolated in BOTH directions (2026-09-15): a Postgres or Redis error in
      // the quote repair must not skip the durable enqueue-retry sweep below,
      // because an outage is exactly when that sweep has work to do. Each
      // repair runs again next hour on its own.
      const report = await repairStrandedQuoteJourneys().catch((err) => {
        log.error({ err: err instanceof Error ? err.message : String(err) }, 'stranded quote journey repair FAILED to run')
        return null
      })
      if (report && report.scheduled > 0) {
        log.warn(report, 'stranded quote journeys repaired — a temporary block had stopped them enrolling')
      } else if (report) {
        log.info(report, 'lifecycle repair sweep complete (nothing stranded)')
      }
      // Post-job follow-ups left retryable (a temporary email failure) were
      // never re-driven: runFollowup wrote next_attempt_at and nothing read it.
      // Same hourly window, bounded, every gate re-runs.
      const { retryDueFollowups } = await import('../lib/followups')
      const retried = await retryDueFollowups().catch((err) => {
        log.warn({ err: err instanceof Error ? err.message : String(err) }, 'follow-up retry sweep failed (non-fatal)')
        return 0
      })
      if (retried > 0) log.info({ retried }, 'retryable post-job follow-ups re-driven')
      // DURABLE ENQUEUE RETRIES (2026-09-15): re-add, under the same job id,
      // every lifecycle job whose live enqueue failed and was recorded — never
      // past its row's lateness bound. Isolated so a database error here cannot
      // cost the two repairs above.
      const { runLifecycleRetrySweep } = await import('../lib/lifecycle-retry-sweep')
      const sweep = await runLifecycleRetrySweep().catch((err) => {
        log.error({ err: err instanceof Error ? err.message : String(err) }, 'lifecycle enqueue retry sweep FAILED to run')
        return null
      })
      if (sweep && (sweep.failed > 0 || sweep.abandonedTooLate > 0 || sweep.abandonedUnroutable > 0)) {
        log.error(sweep, 'lifecycle enqueue retry sweep complete — some jobs could not be re-enqueued')
      } else if (sweep && sweep.enqueued > 0) {
        log.warn(sweep, 'lifecycle enqueue retry sweep re-enqueued jobs whose live enqueue had failed')
      } else if (sweep) {
        log.info(sweep, 'lifecycle enqueue retry sweep complete (nothing due)')
      }
      break
    }

    // ── MARKETING DISCOVERY (owner spec 2026-08-07) ───────────────
    // The AI marketing agent's daily sweep: deterministic reactivation
    // audiences → at most one DRAFT campaign + a Discord opportunity notice.
    // It cannot send — dispatch stays behind the admin's validate → approve →
    // start chain — and it is flag-gated OFF until the owner enables it.
    case 'marketing-discovery': {
      const { discoverCampaignOpportunities } = await import('../lib/email-marketing-agent')
      const report = await discoverCampaignOpportunities()
      if (!report.ran) {
        log.info({ reason: report.reason }, 'marketing discovery skipped')
      } else if (report.created) {
        log.info(
          { campaignId: report.created.campaignId, eligible: report.created.eligible, discordPosted: report.created.discordPosted },
          'marketing discovery drafted a campaign — waiting for owner approval'
        )
      } else {
        log.info({ considered: report.considered }, 'marketing discovery complete (no opportunity today)')
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

      // LAST ACTIVITY (incident 2026-09-14): lead, email and booking recency
      // side by side, so "emails stopped" and "customers stopped" never look
      // alike again. Aggregate timestamps only; never blocks the digest.
      const { lastActivitySnapshot, activityLines } = await import('../lib/ops-activity')
      const activity = await lastActivitySnapshot()
        .then((s) => activityLines(s))
        .catch(() => null)

      await discordQueue.add('daily-schedule', {
        type: 'daily-schedule',
        payload: {
          title: `☀️ Today's Jobs — ${today}`,
          jobs: formatted,
          ...(activity ? { activity } : {}),
        },
      })

      // No day-of-move customer SMS: Move It Clear It no longer texts customers
      // (owner, 2026-09-15). The digest goes to the team on Discord only.
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

    // ── TRANSACTIONAL OUTBOX — event driven, with durable recovery ──
    // A real payment/approval/reschedule event publishes an immediate drain
    // nudge after its email_jobs transaction commits. The recovery variant is
    // registered on the shared 15-minute wake window and catches the one gap
    // Redis cannot close: the process dying (or Redis failing) between commit
    // and enqueue. Neither path runs when the outbox feature itself is off.
    case 'outbox-email-drain':
    case 'outbox-email-recovery': {
      if (process.env.OUTBOX_ENABLED !== 'true') {
        log.info('outbox drain skipped — OUTBOX_ENABLED is not true')
        break
      }
      const { drainOutbox } = await import('../outbox/workers/emailWorker')
      const result = await drainOutbox()
      if (result.truncated) {
        log.warn(result, 'outbox drain hit its safety bound; the next recovery pass will continue')
      } else if (result.processed || result.reaped) {
        log.info(result, 'outbox drain complete')
      }
      break
    }

    // ── EMAIL FEEDBACK RECOVERY (audit E-02) ──────────────────────
    // `retryPendingSideEffects` existed, documented itself as the sweep that
    // recovers failed suppressions, and was NEVER SCHEDULED. A bounce whose
    // suppression write failed stayed `side_effect_failed` forever and the
    // address remained sendable — the system would keep mailing a hard-bounced
    // or complaining customer with nothing surfacing anywhere.
    case 'email-side-effect-sweep': {
      const result = await retryPendingSideEffects(50)
      // A dead-lettered event means every retry is exhausted and only a human
      // can suppress that address. It is logged at ERROR so log-based alerting
      // catches it without extra plumbing.
      const deadLettered = await prisma.emailEvent.count({ where: { processingStatus: 'dead_letter' } })
      if (deadLettered > 0) {
        log.error(
          { deadLettered },
          `EMAIL ALERT (critical): ${deadLettered} bounce/complaint event(s) exhausted every suppression retry — those addresses are STILL SENDABLE and must be suppressed by hand.`
        )
      }
      log.info({ ...result, deadLettered }, 'email side-effect sweep complete')
      break
    }

    // ── EMAIL MONITORING (audit E-04) ─────────────────────────────
    // Every safety mechanism fails closed; none of them announced that they
    // had. This turns the silent ones — complaint spikes, stranded recipients,
    // stuck runs, missed schedules — into log-level alerts.
    case 'email-monitoring': {
      const report = await runEmailMonitoring()
      log.info({ severity: report.severity, checks: report.checks.length, errors: report.errors.length }, 'email monitoring sweep complete')
      break
    }

    case 'lead-notification-sweep': {
      //  THE SAFETY NET, and the reason the outbox is durable in practice
      //  rather than only on paper. Lead notices are delivered inline at
      //  capture, which covers the ordinary case. It cannot cover the process
      //  dying between the commit and the send, Discord being down for longer
      //  than one request, or a row left `pending` by any future path.
      //
      //  A site with no visitors is exactly when a stuck notice matters most,
      //  so this runs on a timer rather than on a request path. It is safe on
      //  every replica: a PostgreSQL advisory lock means the losers return
      //  immediately, and it works in bounded batches.
      const { sweepLeadNotifications } = await import('../lib/lead-notification-sweeper')
      const { discordQueue } = await import('../lib/queues')
      const result = await sweepLeadNotifications(async (dedupeKey) => {
        //  SHAPE MATTERS: the handler reads job.data.payload.dedupeKey. Sending
        //  it at the top level is what made every notice a silent no-op for two
        //  deploys - see queue-contract.test.ts.
        //  The DB dedupe key keeps its colons; the QUEUE id is its BullMQ-safe
        //  spelling (src/lib/email-deferral.ts queueSafeJobId).
        const jobId = queueSafeJobId(dedupeKey)
        await discordQueue.remove(jobId).catch(() => {})
        await discordQueue.add(
          'lead-notify',
          { type: 'lead-notify', payload: { dedupeKey } },
          { jobId },
        )
      })
      if (result.scanned || result.staleRecovered || result.failed) {
        log.info(result, 'lead-notification sweep complete')
      }
      break
    }
    case 'campaign-sweep': {
      // Cron: dispatch due SCHEDULED campaigns, re-open stale claims,
      // re-enqueue lost batches, finalize settled runs.
      const result = await sweepCampaignRuns()
      log.info(result, 'campaign sweep complete')
      break
    }

    // ── EMAIL OPERATIONS AGENT (owner spec 2026-07-27) ────────────
    // The supervised watcher. It runs the deterministic health engine, groups
    // what it finds into incidents, remembers, investigates, and alerts. It
    // executes nothing unless the mode is safe_auto AND the policy engine
    // classifies the action automatic.
    //
    // The cycle takes its own Postgres advisory lock, so a duplicate job, a
    // second container or a manual run from the admin cannot produce two
    // concurrent cycles. It never throws: a failed cycle records itself as
    // failed and the worker carries on.
    case 'email-agent-cycle': {
      const { runAgentCycle } = await import('../lib/email-agent/runner')
      const result = await runAgentCycle({ trigger: 'scheduled' })
      if (!result.ran) {
        log.info({ reason: result.skippedReason }, 'email agent cycle did not run')
      } else {
        log.info(
          {
            status: result.overallStatus, findings: result.findings, criticals: result.criticals,
            opened: result.incidentsOpened, resolved: result.incidentsResolved,
            actions: result.actionsExecuted, approvals: result.approvalsCreated,
            alerts: result.alertsSent, ai: result.aiInvoked, durationMs: result.durationMs,
          },
          'email agent cycle complete'
        )
      }
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

// ── Recurring schedules (self-healing; see src/lib/cron-schedules.ts) ──
//
// The twelve schedules live in CRON_SCHEDULES (names, patterns, tz and jobIds
// byte-identical to what production Redis holds). Registration used to be twelve
// sequential awaits, fire-and-forget at startup: the first rejection skipped the
// rest, an outage hung silently, and nothing ever retried. The reconciler now
// registers each schedule in isolation, verifies presence from Redis, prunes
// same-name entries whose pattern or tz changed (BullMQ keys a repeatable on
// name + jobId + tz + pattern, so a changed pattern ADDS a schedule instead of
// replacing it), and keeps re-verifying so a flushed Redis heals itself.
// Its status is what the worker host's readiness reports.
let cronReconciler: CronReconciler | null = null
const scheduledErrorLog = createErrorLogLimiter()

export function registerCronJobs(): CronReconciler {
  if (!cronReconciler) {
    cronReconciler = createCronReconciler({
      queue: scheduledQueue,
      // Fail-fast probe: during an outage no queue command is issued, so nothing
      // piles up in the BullMQ connection's offline queue.
      redisOk: async () => (await pingAppRedis()).ok,
      schedules: CRON_SCHEDULES,
      logger: queueLogger,
    })
  }
  cronReconciler.start()
  return cronReconciler
}

/** Readiness snapshot; null until the scheduled worker has started. */
export function getCronStatus(): CronStatus | null {
  return cronReconciler ? cronReconciler.status() : null
}

/** Stop the background reconcile loop (graceful shutdown). */
export function stopCronJobs(): void {
  cronReconciler?.stop()
}

export function startScheduledWorker() {
  const worker = new Worker<ScheduledJobData>('scheduled', processScheduledJob, {
    connection: getLazyBullConnection(),
    concurrency: 2,
  })

  worker.on('failed', (job, err) => {
    queueLogger.error({ jobId: job?.id, err: err.message }, 'Scheduled job failed')
  })

  // BullMQ emits 'Failed to add repeatable job for next iteration' (and then
  // schedules NO next run) when it cannot create a repeatable's next iteration.
  // The repeat entry itself survives, so the schedule still LOOKS registered and
  // a presence check would repair nothing: ask for a FORCED reconcile, which
  // re-adds every schedule and so recreates the lost delayed job. The worker
  // host attaches its own rate-limited error log; when this is the only listener
  // (the dev entrypoint) log here, rate-limited, so errors are never swallowed.
  worker.on('error', (err) => {
    const message = err instanceof Error ? err.message : String(err)
    if (/Failed to add repeatable job for next iteration/.test(message)) {
      cronReconciler?.requestReconcile(5_000, { forceReadd: true })
    }
    if (worker.listenerCount('error') === 1 && scheduledErrorLog(message).log) {
      queueLogger.error({ queue: 'scheduled', err: sanitizeRedisError(message) }, 'Scheduled worker error')
    }
  })

  // Register + verify recurring schedules; retries in the background, never throws.
  registerCronJobs()

  return worker
}
