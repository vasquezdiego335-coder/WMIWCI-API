// ════════════════════════════════════════════════════════════════════════
//  AUTOMATION RUNTIME (owner spec 2026-07-22)
//  ---------------------------------------------------------------------
//  THE GAP THIS CLOSES: owner-created automations could be configured,
//  versioned, validated, TESTed and moved to ACTIVE — and then nothing
//  enrolled anyone and nothing executed a stage. `automationJobId()` existed
//  with no caller. This module is the runtime those definitions were
//  waiting for.
//
//  MODEL
//   • A TRIGGER fires from a real business event (or the grounded sweep for
//     time-based conditions). Every ACTIVE automation on that trigger gets a
//     chance to enroll the subject.
//   • An ENROLLMENT pins the automation VERSION forever. Editing writes a new
//     version (the builder already guarantees that); in-flight enrollments
//     keep executing the rules that enrolled them.
//   • dedupeKey = automation + version + subject is UNIQUE — a re-fired
//     trigger is a no-op. Re-entry under a NEW version is possible and
//     deliberate (the id scheme automationJobId() was designed for exactly
//     this).
//   • Each STAGE re-evaluates live state (stop rules, suppression, caps,
//     the master promo switch) IMMEDIATELY before sending, then delivers
//     through `guardedSend` with a per-stage idempotency key. A worker retry
//     or duplicate queue job resumes the same logical send — never a second
//     email.
//   • PAUSED automation: stages are NOT executed and NOT lost. The sweep
//     re-enqueues due stages once the automation is ACTIVE again.
//     ARCHIVED automation: enrollments stop with a named reason.
// ════════════════════════════════════════════════════════════════════════

import { prisma } from './db'
import { queueLogger } from './logger'
import { scheduledQueue } from './queues'
import { guardedSend } from './email-guard'
import { renderTemplate } from './email-render'
import { templateByKey } from './email-registry'
import { normalizeEmail } from './email-tokens'
import { buildMarketingContext, applyMarketingContext } from './marketing-context'
import { validateAutomationDefinition, automationJobId, type AutomationDefinition, type TriggerKey } from './email-automation'
import { validateAudienceDefinition, resolveCandidates, type Candidate } from './email-audience'
import { buildRecipientContext } from './email-recipient-context'
import { promotionsEnabled } from './email-campaign-run'
import type { StopRuleKey } from './email-journey-config'

const log = queueLogger.child({ mod: 'email-automation-runtime' })

const DAY = 24 * 3_600_000

// ── Pure helpers (offline-tested) ───────────────────────────────────────

export type AutomationSubject = {
  email: string
  bookingId?: string | null
  leadId?: string | null
  customerId?: string | null
  /** Values that qualified the subject, recorded on the enrollment. */
  snapshot?: Record<string, unknown>
}

export function subjectTypeFor(subject: AutomationSubject): 'booking' | 'lead' | 'customer' {
  if (subject.bookingId) return 'booking'
  if (subject.leadId) return 'lead'
  return 'customer'
}

/** The stable identity of a subject inside dedupe keys and job ids. */
export function subjectKeyFor(subject: AutomationSubject): string {
  return subject.bookingId ?? subject.leadId ?? subject.customerId ?? normalizeEmail(subject.email)
}

/** UNIQUE enrollment key — one enrollment per automation VERSION and subject. */
export function enrollmentDedupeKey(automationId: string, version: number, subject: AutomationSubject): string {
  return `automation:${automationId}:v${version}:${subjectKeyFor(subject)}`
}

/** When stage `index` is due: anchored to ENROLLMENT time, never to "now". */
export function stageDueAt(enrolledAt: Date, def: AutomationDefinition, index: number): Date {
  return new Date(enrolledAt.getTime() + (def.stages[index]?.delayMs ?? 0))
}

/** The idempotency event id for one stage of one enrollment. */
export function stageEventId(automationId: string, version: number, stageKey: string, subjectKey: string): string {
  return `${automationId}:v${version}:${stageKey}:${subjectKey}`
}

export type StopEvaluation = { stop: false } | { stop: true; reason: string }

export type LiveSubjectState = {
  booking?: { status: string; depositPaid: boolean; moveDate: Date | null; hasReview: boolean; cancelled: boolean } | null
  lead?: { status: string; bookedAt: Date | null; convertedBookingId: string | null; lostAt: Date | null; moveDate: Date | null } | null
  suppressed?: { reason: string } | null
  referralAskSent?: boolean
}

/**
 * Evaluate the definition's stop rules against LIVE state. Pure — the runtime
 * loads the rows, this decides. Locked rules (unsubscribe/bounce/complaint)
 * are enforced regardless of the stored booleans, mirroring the guard.
 */
export function evaluateStopRules(def: AutomationDefinition, state: LiveSubjectState, now: Date = new Date()): StopEvaluation {
  const rule = (k: StopRuleKey): boolean => def.stopRules[k] !== false

  if (state.suppressed) return { stop: true, reason: `suppressed:${state.suppressed.reason.toLowerCase()}` }

  const lead = state.lead
  if (lead) {
    if (rule('stopAfterBooking') && (lead.bookedAt || lead.convertedBookingId)) return { stop: true, reason: 'lead_converted' }
    if (lead.lostAt || ['LOST'].includes(lead.status?.toUpperCase?.() ?? '')) return { stop: true, reason: 'lead_lost' }
    if (lead.moveDate && lead.moveDate.getTime() + DAY < now.getTime()) return { stop: true, reason: 'move_date_passed' }
  }

  const booking = state.booking
  if (booking) {
    if (rule('stopAfterCancellation') && (booking.cancelled || booking.status === 'CANCELLED')) return { stop: true, reason: 'booking_cancelled' }
    if (rule('stopAfterPayment') && booking.depositPaid && def.trigger === 'booking_abandoned') return { stop: true, reason: 'deposit_paid' }
    if (rule('stopAfterPayment') && def.trigger === 'booking_started' && booking.status !== 'PENDING_PAYMENT') {
      return { stop: true, reason: 'booking_advanced' }
    }
    if (rule('stopAfterReview') && booking.hasReview && (def.trigger === 'review_eligible' || def.trigger === 'move_completed')) {
      return { stop: true, reason: 'review_exists' }
    }
    if (rule('stopAfterReferral') && state.referralAskSent && def.trigger === 'referral_eligible') {
      return { stop: true, reason: 'referral_already_sent' }
    }
    if (
      booking.moveDate &&
      booking.moveDate.getTime() + DAY < now.getTime() &&
      (def.trigger === 'move_date_approaching' || def.trigger === 'booking_abandoned' || def.trigger === 'booking_started')
    ) {
      return { stop: true, reason: 'move_date_passed' }
    }
  }

  return { stop: false }
}

// ── Loading live state ──────────────────────────────────────────────────

async function loadLiveState(enrollment: { bookingId: string | null; leadId: string | null; email: string }): Promise<LiveSubjectState> {
  const state: LiveSubjectState = {}
  if (enrollment.bookingId) {
    const b = await prisma.booking.findUnique({
      where: { id: enrollment.bookingId },
      select: {
        status: true,
        depositPaid: true,
        scheduledStart: true,
        confirmedDate: true,
        requestedDate: true,
        review: { select: { id: true } },
      },
    })
    state.booking = b
      ? {
          status: b.status,
          depositPaid: b.depositPaid,
          moveDate: b.scheduledStart ?? b.confirmedDate ?? b.requestedDate,
          hasReview: Boolean(b.review),
          cancelled: b.status === 'CANCELLED',
        }
      : null
    if (b) {
      const referral = await prisma.emailSend.findFirst({
        where: { template: 'referral', bookingId: enrollment.bookingId, status: 'delivered' },
        select: { id: true },
      })
      state.referralAskSent = Boolean(referral)
    }
  }
  if (enrollment.leadId) {
    state.lead = await prisma.lead.findUnique({
      where: { id: enrollment.leadId },
      select: { status: true, bookedAt: true, convertedBookingId: true, lostAt: true, moveDate: true },
    })
  }
  const suppression = await prisma.emailSuppression.findUnique({
    where: { email: normalizeEmail(enrollment.email) },
    select: { reason: true },
  })
  state.suppressed = suppression ? { reason: suppression.reason as string } : null
  return state
}

// ── Loading the pinned definition ───────────────────────────────────────

type PinnedAutomation = {
  automation: { id: string; name: string; status: string }
  definition: AutomationDefinition
}

async function loadPinnedDefinition(automationId: string, version: number): Promise<PinnedAutomation | { error: string }> {
  const automation = await prisma.emailAutomation.findUnique({
    where: { id: automationId },
    select: { id: true, name: true, status: true, versions: { where: { version }, select: { definition: true } } },
  })
  if (!automation) return { error: 'automation_deleted' }
  const raw = automation.versions[0]?.definition
  if (!raw) return { error: 'version_missing' }
  const validated = validateAutomationDefinition(raw)
  if (!validated.ok) return { error: `definition_invalid:${validated.errors.join(' ')}`.slice(0, 300) }
  return { automation: { id: automation.id, name: automation.name, status: automation.status }, definition: validated.definition }
}

// ── Enrollment ──────────────────────────────────────────────────────────

/**
 * Does this subject satisfy the automation's audience narrowing?
 * No audience = every subject of the trigger. FAILS CLOSED on errors.
 */
async function subjectMatchesAudience(def: AutomationDefinition, subject: AutomationSubject): Promise<boolean> {
  if (!def.audience) return true
  const audience = validateAudienceDefinition(def.audience)
  if (!audience.ok) return false
  try {
    const candidates = await resolveCandidates(audience.definition)
    const email = normalizeEmail(subject.email)
    return candidates.some((c) => normalizeEmail(c.email) === email)
  } catch (err) {
    log.warn({ err: String(err) }, 'audience membership check failed — failing closed (no enrollment)')
    return false
  }
}

/**
 * Fire one trigger for one subject. Called from real business-event sites.
 * Idempotent (unique dedupeKey) and never throws — a trigger failure must not
 * break the business event that fired it.
 */
export async function fireAutomationTrigger(trigger: TriggerKey, subject: AutomationSubject): Promise<number> {
  let enrolled = 0
  try {
    const email = normalizeEmail(subject.email)
    if (!email) return 0

    const automations = await prisma.emailAutomation.findMany({
      where: { status: 'ACTIVE', activeVersion: { not: null } },
      select: { id: true, activeVersion: true },
    })

    for (const a of automations) {
      const version = a.activeVersion as number
      const pinned = await loadPinnedDefinition(a.id, version)
      if ('error' in pinned) continue
      if (pinned.definition.trigger !== trigger) continue
      if (!(await subjectMatchesAudience(pinned.definition, subject))) continue

      const dedupeKey = enrollmentDedupeKey(a.id, version, subject)
      const firstDue = stageDueAt(new Date(), pinned.definition, 0)
      try {
        const enrollment = await prisma.emailAutomationEnrollment.create({
          data: {
            automationId: a.id,
            version,
            dedupeKey,
            subjectType: subjectTypeFor(subject),
            bookingId: subject.bookingId ?? null,
            leadId: subject.leadId ?? null,
            customerId: subject.customerId ?? null,
            email,
            trigger,
            triggerSnapshot: (subject.snapshot ?? null) as never,
            status: 'ACTIVE',
            currentStage: 0,
            nextRunAt: firstDue,
          },
          select: { id: true, enrolledAt: true },
        })
        await scheduleStageJob(enrollment.id, a.id, version, pinned.definition, 0, enrollment.enrolledAt)
        enrolled++
        log.info({ automationId: a.id, version, trigger, enrollmentId: enrollment.id }, 'automation enrollment created')
      } catch (err) {
        if ((err as { code?: string })?.code === 'P2002') continue // already enrolled — the point of the key
        log.warn({ err: String(err), automationId: a.id }, 'enrollment create failed (non-fatal)')
      }
    }
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err), trigger }, 'fireAutomationTrigger failed (non-fatal)')
  }
  return enrolled
}

/**
 * Convenience: fire a booking-scoped trigger from a call site that only has
 * the id. Loads the booking + customer, refuses internal-test rows, fails soft.
 */
export async function fireBookingTrigger(trigger: TriggerKey, bookingId: string): Promise<number> {
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      select: { id: true, isInternalTest: true, customer: { select: { id: true, email: true } } },
    })
    if (!booking || booking.isInternalTest || !booking.customer?.email) return 0
    return fireAutomationTrigger(trigger, {
      email: booking.customer.email,
      bookingId: booking.id,
      customerId: booking.customer.id,
      snapshot: { bookingId: booking.id },
    })
  } catch (err) {
    log.warn({ err: String(err), trigger, bookingId }, 'fireBookingTrigger failed (non-fatal)')
    return 0
  }
}

/** Convenience: fire a lead-scoped trigger from an id. Fails soft. */
export async function fireLeadTrigger(trigger: TriggerKey, leadId: string): Promise<number> {
  try {
    const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { id: true, email: true } })
    if (!lead?.email) return 0
    return fireAutomationTrigger(trigger, { email: lead.email, leadId: lead.id, snapshot: { leadId: lead.id } })
  } catch (err) {
    log.warn({ err: String(err), trigger, leadId }, 'fireLeadTrigger failed (non-fatal)')
    return 0
  }
}

/** Queue one stage with the STABLE id automationJobId() was built for. */
async function scheduleStageJob(
  enrollmentId: string,
  automationId: string,
  version: number,
  def: AutomationDefinition,
  stageIndex: number,
  enrolledAt: Date
): Promise<void> {
  const stage = def.stages[stageIndex]
  if (!stage) return
  const subjectKey = enrollmentId // the enrollment IS the subject identity now
  const delay = Math.max(0, stageDueAt(enrolledAt, def, stageIndex).getTime() - Date.now())
  await scheduledQueue
    .add(
      'automation-stage',
      { type: 'automation-stage', payload: { enrollmentId, stageIndex } },
      { delay, jobId: automationJobId(automationId, version, stage.key, subjectKey) }
    )
    .catch((err) => log.warn({ err: String(err), enrollmentId, stageIndex }, 'stage enqueue failed — sweep will recover'))
}

// ── Stage execution ─────────────────────────────────────────────────────

export type StageOutcome =
  | 'sent'
  | 'skipped'
  | 'stopped'
  | 'deferred'
  | 'completed'
  | 'not_due'
  | 'automation_paused'
  | 'failed'

async function appendHistory(enrollmentId: string, entry: Record<string, unknown>): Promise<void> {
  const row = await prisma.emailAutomationEnrollment.findUnique({ where: { id: enrollmentId }, select: { history: true } })
  const history = Array.isArray(row?.history) ? (row?.history as unknown[]) : []
  history.push({ ...entry, at: new Date().toISOString() })
  await prisma.emailAutomationEnrollment
    .update({ where: { id: enrollmentId }, data: { history: history.slice(-50) as never } })
    .catch(() => undefined)
}

/**
 * Execute ONE stage of ONE enrollment. Safe to call twice — the EmailSend
 * idempotency key collapses duplicates, and the stage pointer only advances
 * under a guarded update.
 */
export async function executeAutomationStage(enrollmentId: string, stageIndex: number): Promise<StageOutcome> {
  const enrollment = await prisma.emailAutomationEnrollment.findUnique({ where: { id: enrollmentId } })
  if (!enrollment || enrollment.status !== 'ACTIVE') return 'skipped'
  if (enrollment.currentStage !== stageIndex) return 'skipped' // already executed (queue duplicate)

  const stamp = { lastEvaluatedAt: new Date() }

  const pinned = await loadPinnedDefinition(enrollment.automationId, enrollment.version)
  if ('error' in pinned) {
    await prisma.emailAutomationEnrollment.update({
      where: { id: enrollmentId },
      data: { status: 'STOPPED', stopReason: pinned.error, ...stamp },
    })
    return 'stopped'
  }
  const { automation, definition } = pinned

  // An automation that is not ACTIVE does not execute. PAUSED holds the
  // enrollment (the sweep re-schedules after reactivation); ARCHIVED ends it.
  if (automation.status !== 'ACTIVE') {
    if (automation.status === 'ARCHIVED') {
      await prisma.emailAutomationEnrollment.update({
        where: { id: enrollmentId },
        data: { status: 'STOPPED', stopReason: 'automation_archived', ...stamp },
      })
      return 'stopped'
    }
    await prisma.emailAutomationEnrollment.update({ where: { id: enrollmentId }, data: stamp })
    log.info({ enrollmentId, automationId: automation.id, status: automation.status }, 'stage held — automation not ACTIVE')
    return 'automation_paused'
  }

  // MASTER SWITCH — automations are promotional by construction.
  if (!promotionsEnabled()) {
    await prisma.emailAutomationEnrollment.update({ where: { id: enrollmentId }, data: stamp })
    log.info({ enrollmentId }, 'stage held — EMAIL_PROMOTIONS_ENABLED is off')
    return 'automation_paused'
  }

  const stage = definition.stages[stageIndex]
  if (!stage) {
    await prisma.emailAutomationEnrollment.update({
      where: { id: enrollmentId },
      data: { status: 'COMPLETED', completedAt: new Date(), ...stamp },
    })
    return 'completed'
  }

  // Not due yet (restart raced the delay): reschedule, do not send early.
  const due = stageDueAt(enrollment.enrolledAt, definition, stageIndex)
  if (due.getTime() > Date.now() + 60_000) {
    await scheduleStageJob(enrollmentId, automation.id, enrollment.version, definition, stageIndex, enrollment.enrolledAt)
    return 'not_due'
  }

  // ── LIVE STOP-RULE EVALUATION ─────────────────────────────────────────
  const liveState = await loadLiveState(enrollment)
  const verdict = evaluateStopRules(definition, liveState)
  if (verdict.stop) {
    await prisma.emailAutomationEnrollment.update({
      where: { id: enrollmentId },
      data: { status: 'STOPPED', stopReason: verdict.reason, ...stamp },
    })
    await appendHistory(enrollmentId, { stage: stageIndex, key: stage.key, outcome: 'stopped', reason: verdict.reason })
    log.info({ enrollmentId, reason: verdict.reason }, 'enrollment stopped by live state')
    return 'stopped'
  }

  const advance = async (outcome: string, reason?: string): Promise<StageOutcome> => {
    const nextIndex = stageIndex + 1
    const isLast = nextIndex >= definition.stages.length
    // Guarded advance: only move the pointer if it still points here.
    const { count } = await prisma.emailAutomationEnrollment.updateMany({
      where: { id: enrollmentId, currentStage: stageIndex, status: 'ACTIVE' },
      data: isLast
        ? { currentStage: nextIndex, status: 'COMPLETED', completedAt: new Date(), nextRunAt: null, ...stamp }
        : { currentStage: nextIndex, nextRunAt: stageDueAt(enrollment.enrolledAt, definition, nextIndex), ...stamp },
    })
    await appendHistory(enrollmentId, { stage: stageIndex, key: stage.key, outcome, reason: reason ?? null })
    if (count > 0 && !isLast) {
      await scheduleStageJob(enrollmentId, automation.id, enrollment.version, definition, nextIndex, enrollment.enrolledAt)
    }
    return isLast ? 'completed' : (outcome as StageOutcome)
  }

  // ── Automation-level cap ──────────────────────────────────────────────
  const cap = definition.caps.perRecipientPerMonth
  if (cap > 0) {
    const sentRecently = await prisma.emailSend.count({
      where: {
        email: enrollment.email,
        journey: `automation:${automation.id}`,
        status: 'delivered',
        isTest: false,
        sentAt: { gte: new Date(Date.now() - 30 * DAY) },
      },
    })
    if (sentRecently >= cap) return advance('skipped', 'automation_cap_reached')
  }

  // ── Context + render + THE GUARD ──────────────────────────────────────
  const candidate: Candidate = {
    email: enrollment.email,
    name: null,
    customerId: enrollment.customerId,
    leadId: enrollment.leadId,
    bookingId: enrollment.bookingId,
  }
  const context = await buildRecipientContext(stage.template, candidate)
  if (!context.ok) {
    if (context.reason.startsWith('context_ineligible')) {
      await prisma.emailAutomationEnrollment.update({
        where: { id: enrollmentId },
        data: { status: 'STOPPED', stopReason: context.reason, ...stamp },
      })
      await appendHistory(enrollmentId, { stage: stageIndex, key: stage.key, outcome: 'stopped', reason: context.reason })
      return 'stopped'
    }
    return advance('skipped', context.reason)
  }

  let payload = context.payload
  const marketing = buildMarketingContext(enrollment.email, stage.template, (payload.locale as string) ?? 'en')
  if (marketing.ok) payload = applyMarketingContext(payload, marketing.context)

  const rendered = await renderTemplate(stage.template, payload)
  if ('error' in rendered) return advance('skipped', `render_failed:${rendered.error}`.slice(0, 200))

  const subject = templateByKey(stage.template)?.subject ?? stage.template

  const outcome = await guardedSend({
    to: enrollment.email,
    subject,
    html: rendered.html,
    text: rendered.text,
    template: stage.template,
    emailClass: 'promotional',
    journey: `automation:${automation.id}`,
    // Exactly-once per automation VERSION, stage and enrollment.
    eventId: stageEventId(automation.id, enrollment.version, stage.key, enrollmentId),
    bookingId: enrollment.bookingId ?? undefined,
    leadId: enrollment.leadId ?? undefined,
    payload,
    // The guard's own live reload — re-run the stop rules once more inside
    // the claim window.
    recheck: async () => {
      const state = await loadLiveState(enrollment)
      const v = evaluateStopRules(definition, state)
      return v.stop ? v.reason : null
    },
  })

  if (outcome.sent) return advance('sent')

  if (outcome.retryAt) {
    // Quiet hours / caps: re-run THIS stage at the due time. Same stage, new
    // job id suffix; the EmailSend row is resumed, never duplicated.
    const delay = Math.max(0, outcome.retryAt.getTime() - Date.now())
    await scheduledQueue
      .add(
        'automation-stage',
        { type: 'automation-stage', payload: { enrollmentId, stageIndex } },
        { delay, jobId: `${automationJobId(automation.id, enrollment.version, stage.key, enrollmentId)}:retry:${Math.floor(outcome.retryAt.getTime() / 60_000)}` }
      )
      .catch(() => undefined)
    await prisma.emailAutomationEnrollment.update({ where: { id: enrollmentId }, data: { nextRunAt: outcome.retryAt, ...stamp } })
    await appendHistory(enrollmentId, { stage: stageIndex, key: stage.key, outcome: 'deferred', reason: outcome.reason })
    return 'deferred'
  }

  // Terminal refusals that end the whole enrollment.
  if (['unsubscribed', 'hard_bounce', 'spam_complaint', 'admin_block', 'invalid_email'].includes(outcome.reason)) {
    await prisma.emailAutomationEnrollment.update({
      where: { id: enrollmentId },
      data: { status: 'STOPPED', stopReason: outcome.reason, ...stamp },
    })
    await appendHistory(enrollmentId, { stage: stageIndex, key: stage.key, outcome: 'stopped', reason: outcome.reason })
    return 'stopped'
  }

  // Everything else (duplicate, ineligible, retryable config): record and move
  // on — the stage is spent, the sequence continues.
  return advance('skipped', outcome.reason)
}

// ── Event-driven stops ──────────────────────────────────────────────────

/**
 * Stop ACTIVE enrollments for a subject the moment an exit condition becomes
 * true. Best-effort — the authoritative protection is the execution-time
 * re-evaluation above, exactly like journey cancellation.
 */
export async function stopEnrollmentsFor(
  subject: { bookingId?: string | null; leadId?: string | null; email?: string | null },
  reason: string,
  /**
   * Restrict the stop to enrollments fired by these triggers. A paid deposit
   * ends an ABANDONMENT sequence but must not kill a move-date-approaching
   * one for the same booking. Omit only for conditions that end everything
   * (cancellation, conversion, suppression).
   */
  options: { triggers?: TriggerKey[] } = {}
): Promise<number> {
  try {
    const or: Record<string, unknown>[] = []
    if (subject.bookingId) or.push({ bookingId: subject.bookingId })
    if (subject.leadId) or.push({ leadId: subject.leadId })
    if (subject.email) or.push({ email: normalizeEmail(subject.email) })
    if (or.length === 0) return 0
    const { count } = await prisma.emailAutomationEnrollment.updateMany({
      where: {
        status: 'ACTIVE',
        OR: or,
        ...(options.triggers ? { trigger: { in: options.triggers } } : {}),
      },
      data: { status: 'STOPPED', stopReason: reason },
    })
    if (count > 0) log.info({ ...subject, reason, count }, 'enrollments stopped by business event')
    return count
  } catch (err) {
    log.warn({ err: String(err), reason }, 'stopEnrollmentsFor failed (non-fatal)')
    return 0
  }
}

// ── Sweep: recovery + time-based triggers ───────────────────────────────

/** How far in advance move_date_approaching fires (documented, fixed). */
export const MOVE_DATE_LEAD_MS = 7 * DAY

/**
 * Re-enqueue due stages whose queue job was lost (restart recovery), and
 * evaluate the TIME-BASED triggers that have no single event site. Every
 * enrollment it creates is still deduped by the unique key, so running the
 * sweep twice is harmless.
 */
export async function sweepAutomationEnrollments(): Promise<{ requeued: number; enrolled: number }> {
  let requeued = 0
  let enrolled = 0

  // 1. Due-but-idle enrollments (lost jobs, or automation resumed from pause).
  const due = await prisma.emailAutomationEnrollment.findMany({
    where: { status: 'ACTIVE', nextRunAt: { lte: new Date(Date.now() - 5 * 60_000) } },
    select: { id: true, automationId: true, version: true, currentStage: true, enrolledAt: true },
    take: 200,
  })
  for (const e of due) {
    const pinned = await loadPinnedDefinition(e.automationId, e.version)
    if ('error' in pinned) {
      await prisma.emailAutomationEnrollment
        .update({ where: { id: e.id }, data: { status: 'STOPPED', stopReason: pinned.error } })
        .catch(() => undefined)
      continue
    }
    if (pinned.automation.status !== 'ACTIVE') continue // held while paused
    await scheduleStageJob(e.id, e.automationId, e.version, pinned.definition, e.currentStage, e.enrolledAt)
    requeued++
  }

  // 2. Time-based triggers, grounded in real database state.
  const automations = await prisma.emailAutomation.findMany({
    where: { status: 'ACTIVE', activeVersion: { not: null } },
    select: { id: true, activeVersion: true },
  })
  for (const a of automations) {
    const pinned = await loadPinnedDefinition(a.id, a.activeVersion as number)
    if ('error' in pinned) continue
    const trigger = pinned.definition.trigger
    let subjects: AutomationSubject[] = []

    try {
      if (trigger === 'customer_inactive') {
        // Grounded by the automation's own audience (reengagement segment
        // carries inactiveDays). No audience = nothing to ground "inactive" in.
        if (!pinned.definition.audience) continue
        const audience = validateAudienceDefinition(pinned.definition.audience)
        if (!audience.ok || audience.definition.segment !== 'reengagement_eligible') continue
        const candidates = await resolveCandidates(audience.definition)
        subjects = candidates.map((c) => ({ email: c.email, bookingId: c.bookingId, customerId: c.customerId }))
      } else if (trigger === 'move_date_approaching') {
        const soon = new Date(Date.now() + MOVE_DATE_LEAD_MS)
        const bookings = await prisma.booking.findMany({
          where: {
            status: { in: ['CONFIRMED', 'SCHEDULED'] },
            isInternalTest: false,
            OR: [
              { scheduledStart: { gte: new Date(), lte: soon } },
              { scheduledStart: null, confirmedDate: { gte: new Date(), lte: soon } },
            ],
          },
          select: { id: true, customer: { select: { id: true, email: true } } },
          take: 500,
        })
        subjects = bookings.map((b) => ({ email: b.customer.email, bookingId: b.id, customerId: b.customer.id }))
      } else if (trigger === 'booking_abandoned') {
        const bookings = await prisma.booking.findMany({
          where: {
            status: 'PENDING_PAYMENT',
            depositPaid: false,
            isInternalTest: false,
            createdAt: { lte: new Date(Date.now() - 45 * 60_000), gte: new Date(Date.now() - 14 * DAY) },
          },
          select: { id: true, customer: { select: { id: true, email: true } } },
          take: 500,
        })
        subjects = bookings.map((b) => ({ email: b.customer.email, bookingId: b.id, customerId: b.customer.id }))
      } else if (trigger === 'review_eligible') {
        const bookings = await prisma.booking.findMany({
          where: { status: 'COMPLETED', isInternalTest: false, review: null, completedAt: { gte: new Date(Date.now() - 60 * DAY) } },
          select: { id: true, customer: { select: { id: true, email: true } } },
          take: 500,
        })
        subjects = bookings.map((b) => ({ email: b.customer.email, bookingId: b.id, customerId: b.customer.id }))
      } else if (trigger === 'referral_eligible') {
        const bookings = await prisma.booking.findMany({
          where: { status: { in: ['COMPLETED', 'ARCHIVED'] }, isInternalTest: false, review: { isPositive: true }, completedAt: { gte: new Date(Date.now() - 60 * DAY) } },
          select: { id: true, customer: { select: { id: true, email: true } } },
          take: 500,
        })
        subjects = bookings.map((b) => ({ email: b.customer.email, bookingId: b.id, customerId: b.customer.id }))
      } else {
        continue // event-driven triggers enroll at their call sites
      }

      for (const subject of subjects) {
        enrolled += await fireAutomationTrigger(trigger, subject)
      }
    } catch (err) {
      log.warn({ err: String(err), automationId: a.id, trigger }, 'time-based trigger sweep failed (non-fatal)')
    }
  }

  if (requeued || enrolled) log.info({ requeued, enrolled }, 'automation sweep did work')
  return { requeued, enrolled }
}

/** Enrollment counts for the admin — what is ACTUALLY running. */
export async function automationRuntimeStats(automationId: string) {
  const grouped = await prisma.emailAutomationEnrollment.groupBy({
    by: ['status'],
    where: { automationId },
    _count: { _all: true },
  })
  const counts: Record<string, number> = {}
  for (const g of grouped) counts[g.status] = g._count._all
  const upcoming = await prisma.emailAutomationEnrollment.findMany({
    where: { automationId, status: 'ACTIVE', nextRunAt: { not: null } },
    orderBy: { nextRunAt: 'asc' },
    take: 5,
    select: { id: true, email: true, currentStage: true, nextRunAt: true },
  })
  return { counts, upcoming }
}
