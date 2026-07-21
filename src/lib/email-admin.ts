// ════════════════════════════════════════════════════════════════════════
//  EMAIL ADMIN QUERIES — the read layer behind /admin/email-marketing.
//  (owner spec 2026-07-21)
//  ---------------------------------------------------------------------
//  The email system already RECORDED everything the owner needs: every send,
//  every refusal with a machine-readable reason, every provider event, every
//  suppression. None of it was readable outside a psql prompt.
//
//  This module turns those tables into the seven answers the owner asked for:
//  what was sent, what was delivered, what bounced, who complained, who
//  unsubscribed, what was blocked and WHY, and what is still scheduled.
//
//  TWO RULES IT KEEPS:
//   1. NEVER INVENT A DENOMINATOR. A delivery rate over zero sends is null, not
//      0% and not 100%. Every rate carries the counts it came from so the owner
//      can see when a number is built on three data points.
//   2. DATA COMPLETENESS IS PART OF THE ANSWER. Open and click tracking only
//      exist when the provider sends those events; the queue view is empty when
//      Redis is unreachable. Both are reported as "unavailable", never as zero.
//      A zero that means "nothing happened" and a zero that means "we could not
//      look" must never render identically.
// ════════════════════════════════════════════════════════════════════════

import { prisma } from './db'
import { scheduledQueue } from './queues'
import { classifyBlock } from './email-guard'
import { templateLabel } from './email-registry'
import { isSafeUrl } from '../emails/validation'
import { businessPostalAddress } from './marketing-context'

// ── Time ranges ─────────────────────────────────────────────────────────

export type RangeKey = '24h' | '7d' | '30d' | '90d' | 'all'

export const RANGE_LABELS: Record<RangeKey, string> = {
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
  all: 'All time',
}

const DAY = 24 * 60 * 60 * 1000

export function rangeStart(key: RangeKey): Date | null {
  const now = Date.now()
  switch (key) {
    case '24h':
      return new Date(now - DAY)
    case '7d':
      return new Date(now - 7 * DAY)
    case '30d':
      return new Date(now - 30 * DAY)
    case '90d':
      return new Date(now - 90 * DAY)
    case 'all':
      return null
  }
}

export function parseRange(raw: string | null | undefined): RangeKey {
  return raw && raw in RANGE_LABELS ? (raw as RangeKey) : '30d'
}

// ── Overview ────────────────────────────────────────────────────────────

/** A rate that knows whether it is meaningful. */
export type Rate = {
  /** Basis points (10000 = 100%). Null when the denominator is zero. */
  bp: number | null
  numerator: number
  denominator: number
}

const rate = (numerator: number, denominator: number): Rate => ({
  bp: denominator > 0 ? Math.round((numerator / denominator) * 10_000) : null,
  numerator,
  denominator,
})

export function formatRate(r: Rate): string {
  if (r.bp == null) return '—'
  return `${(r.bp / 100).toFixed(1)}%`
}

export type Overview = {
  range: RangeKey
  rangeLabel: string
  since: Date | null
  /** Rows in email_sends created in the window, by attempt status. */
  byStatus: Record<string, number>
  /** Provider + first-party events in the window, by type. */
  byEvent: Record<string, number>
  sent: number
  /** Provider CONFIRMED delivery (a 'delivered' webhook event), not acceptance. */
  confirmedDelivered: number
  deferred: number
  blocked: number
  failed: number
  ambiguous: number
  bounced: number
  complained: number
  unsubscribed: number
  opened: number
  clicked: number
  deliveryRate: Rate
  bounceRate: Rate
  complaintRate: Rate
  /** Top refusal reasons, most common first. */
  topBlockReasons: Array<{ reason: string; count: number; blockClass: string }>
  /** Sends per template, most active first. */
  byTemplate: Array<{ template: string; label: string; total: number; sent: number }>
  suppressionTotals: Record<string, number>
  /** Suppression side effects that never completed. MUST be zero. */
  unfinishedSideEffects: number
  /** True when a table read failed — the numbers below are incomplete. */
  degraded: boolean
  notes: string[]
}

/** Attempt statuses that mean the provider accepted the message. */
const SENT_STATUSES = ['delivered']
const BLOCKED_STATUSES = ['blocked_terminal', 'blocked_retryable']

export async function getOverview(range: RangeKey = '30d'): Promise<Overview> {
  const since = rangeStart(range)
  // Test sends are excluded from every headline number: an owner reading
  // "142 delivered" must be reading customer mail, not rehearsals.
  const sendWhere = { isTest: false, ...(since ? { createdAt: { gte: since } } : {}) }
  const eventWhere = { emailSend: { isTest: false }, ...(since ? { occurredAt: { gte: since } } : {}) }
  const notes: string[] = []
  let degraded = false

  const safe = async <T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn()
    } catch (err) {
      degraded = true
      notes.push(`${label} could not be read: ${err instanceof Error ? err.message : String(err)}`)
      return fallback
    }
  }

  const [statusRows, eventRows, blockRows, templateRows, suppressionRows, stuck] = await Promise.all([
    safe('send statuses', () => prisma.emailSend.groupBy({ by: ['status'], _count: true, where: sendWhere }), [] as Array<{ status: string; _count: number }>),
    safe('provider events', () => prisma.emailEvent.groupBy({ by: ['type'], _count: true, where: eventWhere }), [] as Array<{ type: string; _count: number }>),
    safe(
      'block reasons',
      () =>
        prisma.emailSend.groupBy({
          by: ['blockedReason'],
          _count: true,
          where: { ...sendWhere, blockedReason: { not: null } },
          orderBy: { _count: { blockedReason: 'desc' } },
          take: 12,
        }),
      [] as Array<{ blockedReason: string | null; _count: number }>
    ),
    safe('per-template counts', () => prisma.emailSend.groupBy({ by: ['template', 'status'], _count: true, where: sendWhere }), [] as Array<{ template: string; status: string; _count: number }>),
    safe('suppressions', () => prisma.emailSuppression.groupBy({ by: ['reason'], _count: true }), [] as Array<{ reason: string; _count: number }>),
    safe('unfinished side effects', () => prisma.emailEvent.count({ where: { processingStatus: { in: ['side_effect_failed', 'dead_letter'] } } }), 0),
  ])

  const byStatus: Record<string, number> = {}
  for (const r of statusRows) byStatus[r.status] = r._count
  const byEvent: Record<string, number> = {}
  for (const r of eventRows) byEvent[r.type] = r._count

  const sum = (keys: string[], src: Record<string, number>) => keys.reduce((n, k) => n + (src[k] ?? 0), 0)

  const sent = sum(SENT_STATUSES, byStatus)
  const bounced = byEvent['bounced'] ?? 0
  const complained = byEvent['complained'] ?? 0
  const confirmedDelivered = byEvent['delivered'] ?? 0

  // Per-template rollup.
  const tmap = new Map<string, { total: number; sent: number }>()
  for (const r of templateRows) {
    const e = tmap.get(r.template) ?? { total: 0, sent: 0 }
    e.total += r._count
    if (SENT_STATUSES.includes(r.status)) e.sent += r._count
    tmap.set(r.template, e)
  }

  if (confirmedDelivered === 0 && sent > 0) {
    notes.push(
      'No `delivered` webhook events in this window. Provider acceptance is recorded, but confirmed delivery requires the Resend webhook — check Deliverability.'
    )
  }
  if ((byEvent['opened'] ?? 0) === 0 && (byEvent['clicked'] ?? 0) === 0) {
    notes.push('No open or click events recorded. These exist only if open/click tracking is enabled at the provider.')
  }

  return {
    range,
    rangeLabel: RANGE_LABELS[range],
    since,
    byStatus,
    byEvent,
    sent,
    confirmedDelivered,
    deferred: byStatus['deferred'] ?? 0,
    blocked: sum(BLOCKED_STATUSES, byStatus),
    failed: byStatus['failed_terminal'] ?? 0,
    ambiguous: byStatus['ambiguous'] ?? 0,
    bounced,
    complained,
    unsubscribed: byEvent['unsubscribed'] ?? 0,
    opened: byEvent['opened'] ?? 0,
    clicked: byEvent['clicked'] ?? 0,
    // Denominator is provider ACCEPTANCE — the only population that could have
    // produced a delivery event at all.
    deliveryRate: rate(confirmedDelivered, sent),
    bounceRate: rate(bounced, sent),
    complaintRate: rate(complained, sent),
    topBlockReasons: blockRows
      .filter((r) => r.blockedReason)
      .map((r) => ({
        reason: r.blockedReason as string,
        count: r._count,
        blockClass: classifyBlock(r.blockedReason as string),
      })),
    byTemplate: Array.from(tmap.entries())
      .map(([template, v]) => ({ template, label: templateLabel(template), ...v }))
      .sort((a, b) => b.total - a.total),
    suppressionTotals: Object.fromEntries(suppressionRows.map((r) => [r.reason, r._count])),
    unfinishedSideEffects: stuck,
    degraded,
    notes,
  }
}

// ── Send history ────────────────────────────────────────────────────────

export type SendFilters = {
  range?: RangeKey
  /** Include admin test sends. Off by default so the ledger reads as customer mail. */
  includeTests?: boolean
  status?: string
  template?: string
  journey?: string
  email?: string
  bookingId?: string
  leadId?: string
  /** Only rows that did NOT send. */
  blockedOnly?: boolean
  take?: number
  skip?: number
}

export async function listSends(filters: SendFilters = {}) {
  const since = rangeStart(filters.range ?? '30d')
  const where: Record<string, unknown> = {}
  if (!filters.includeTests) where.isTest = false
  if (since) where.createdAt = { gte: since }
  if (filters.status) where.status = filters.status
  if (filters.template) where.template = filters.template
  if (filters.journey) where.journey = filters.journey
  if (filters.email) where.email = filters.email.trim().toLowerCase()
  if (filters.bookingId) where.bookingId = filters.bookingId
  if (filters.leadId) where.leadId = filters.leadId
  if (filters.blockedOnly) {
    where.status = { in: ['blocked_terminal', 'blocked_retryable', 'deferred', 'failed_terminal', 'ambiguous', 'provider_rejected'] }
  }

  const take = Math.min(Math.max(filters.take ?? 100, 1), 500)

  try {
    const [rows, total] = await Promise.all([
      prisma.emailSend.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
        skip: Math.max(filters.skip ?? 0, 0),
        include: {
          events: { orderBy: { occurredAt: 'asc' }, select: { type: true, occurredAt: true, detail: true } },
        },
      }),
      prisma.emailSend.count({ where }),
    ])
    return { rows, total, error: null as string | null }
  } catch (err) {
    return { rows: [], total: 0, error: err instanceof Error ? err.message : String(err) }
  }
}

// ── Scheduled sends (the BullMQ delayed set) ────────────────────────────

export type ScheduledSend = {
  jobId: string
  type: string
  template: string
  label: string
  bookingId: string | null
  leadId: string | null
  /** When the job is due to fire. */
  fireAt: Date | null
  journey: string | null
  state: 'delayed' | 'waiting'
}

/**
 * What is queued but not yet sent.
 *
 * A DELIBERATE HONESTY NOTE: this reads the QUEUE, which is the only place a
 * pending send exists. There is no scheduled-send table, so if Redis is
 * unreachable the answer is "unavailable" — never an empty list, which would
 * read as "nothing is scheduled" and is the opposite of the truth.
 */
export async function listScheduled(limit = 200): Promise<{ rows: ScheduledSend[]; error: string | null }> {
  try {
    const jobs = await Promise.race([
      scheduledQueue.getJobs(['delayed', 'waiting'], 0, limit - 1, true),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('queue read timed out (Redis unreachable?)')), 5000)),
    ])

    const rows: ScheduledSend[] = jobs.map((job) => {
      const data = (job.data ?? {}) as Record<string, unknown>
      const type = String(data.type ?? job.name ?? 'unknown')
      // Journey is encoded in the stable jobId: `journey:<journey>:<stage>:<id>`
      // or `followup:<type>:<bookingId>`.
      const id = String(job.id ?? '')
      const journey = id.startsWith('journey:') ? id.split(':')[1] : id.startsWith('followup:') ? 'post-job' : null
      const template = templateForStage(type)
      return {
        jobId: id,
        type,
        template,
        label: templateLabel(template),
        bookingId: (data.bookingId as string) ?? null,
        leadId: (data.leadId as string) ?? null,
        fireAt: job.delay && job.timestamp ? new Date(job.timestamp + job.delay) : null,
        journey,
        state: job.delay && job.delay > 0 ? 'delayed' : 'waiting',
      }
    })

    rows.sort((a, b) => (a.fireAt?.getTime() ?? 0) - (b.fireAt?.getTime() ?? 0))
    return { rows, error: null }
  } catch (err) {
    return { rows: [], error: err instanceof Error ? err.message : String(err) }
  }
}

/** Scheduled-job type → the template it will render. */
export function templateForStage(type: string): string {
  const map: Record<string, string> = {
    'abandoned-checkout-recovery': 'abandoned-checkout',
    'abandoned-checkout-recovery-2': 'abandoned-checkout-2',
    'abandoned-checkout-recovery-3': 'abandoned-checkout-3',
    'job-reminder-72h': 'job-reminder',
    'job-reminder-24h': 'job-reminder',
    'review-request-48h': 'review-reminder',
    'referral-ask': 'referral',
  }
  return map[type] ?? type
}

/**
 * Cancel a pending scheduled send. Refuses anything already active — an
 * in-flight job is stopped by the send-time recheck, not by the queue.
 */
export async function cancelScheduled(jobId: string): Promise<{ ok: boolean; reason: string }> {
  try {
    const job = await scheduledQueue.getJob(jobId)
    if (!job) return { ok: false, reason: 'not_found' }
    const state = await job.getState()
    if (state === 'active') return { ok: false, reason: 'already_running' }
    await job.remove()
    return { ok: true, reason: 'cancelled' }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

// ── Suppressions ────────────────────────────────────────────────────────

export async function listSuppressions(opts: { reason?: string; email?: string; take?: number } = {}) {
  const where: Record<string, unknown> = {}
  if (opts.reason) where.reason = opts.reason
  if (opts.email) where.email = { contains: opts.email.trim().toLowerCase() }
  try {
    const [rows, total] = await Promise.all([
      prisma.emailSuppression.findMany({ where, orderBy: { createdAt: 'desc' }, take: Math.min(opts.take ?? 200, 500) }),
      prisma.emailSuppression.count({ where }),
    ])
    return { rows, total, error: null as string | null }
  } catch (err) {
    return { rows: [], total: 0, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Which suppressions may be lifted, and which may not.
 *
 * HARD_BOUNCE and SPAM_COMPLAINT are NOT restorable from this screen. A
 * complaint is the recipient telling a mailbox provider we are spam; sending
 * again damages the sending domain for every other customer. Lifting one is a
 * deliberate act that belongs at the provider, with a reason — not a button in
 * a list view.
 */
export const RESTORABLE_REASONS = ['UNSUBSCRIBED', 'ADMIN_BLOCK', 'INVALID_ADDRESS'] as const

export function canRestoreSuppression(reason: string): { allow: boolean; why: string } {
  if (reason === 'SPAM_COMPLAINT') {
    return { allow: false, why: 'A spam complaint cannot be lifted here. Re-sending to a complainant damages the sending domain for every customer.' }
  }
  if (reason === 'HARD_BOUNCE') {
    return { allow: false, why: 'A hard bounce means the mailbox does not exist. Correct the address on the customer record instead of lifting the block.' }
  }
  if ((RESTORABLE_REASONS as readonly string[]).includes(reason)) {
    return { allow: true, why: '' }
  }
  return { allow: false, why: `Suppression reason ${reason} is not restorable from the admin.` }
}

// ── Customer / booking timeline ─────────────────────────────────────────

export type TimelineEntry = {
  id: string
  /** The address actually written to — may differ from the customer's current
   *  email if it was changed after the send. */
  email: string
  template: string
  label: string
  emailClass: string
  journey: string | null
  status: string
  outcomeClass: string | null
  blockedReason: string | null
  /** Plain-English explanation of the status. */
  explanation: string
  attempts: number
  createdAt: Date
  sentAt: Date | null
  nextAttemptAt: Date | null
  providerId: string | null
  events: Array<{ type: string; occurredAt: Date }>
}

/**
 * Every email this customer or booking was considered for — including the ones
 * that were NOT sent. That is the point: "why didn't they get the reminder?" is
 * only answerable if refusals are visible beside deliveries.
 */
export async function emailTimeline(opts: { bookingId?: string; email?: string; leadId?: string; take?: number }): Promise<{ rows: TimelineEntry[]; error: string | null }> {
  const or: Array<Record<string, unknown>> = []
  if (opts.bookingId) or.push({ bookingId: opts.bookingId })
  if (opts.leadId) or.push({ leadId: opts.leadId })
  if (opts.email) or.push({ email: opts.email.trim().toLowerCase() })
  if (or.length === 0) return { rows: [], error: null }

  try {
    const rows = await prisma.emailSend.findMany({
      where: { OR: or },
      orderBy: { createdAt: 'desc' },
      take: Math.min(opts.take ?? 100, 300),
      include: { events: { orderBy: { occurredAt: 'asc' }, select: { type: true, occurredAt: true } } },
    })
    return {
      rows: rows.map((r) => ({
        id: r.id,
        email: r.email,
        template: r.template,
        label: templateLabel(r.template),
        emailClass: r.emailClass,
        journey: r.journey,
        status: r.status,
        outcomeClass: r.outcomeClass,
        blockedReason: r.blockedReason,
        explanation: explainSend(r.status, r.blockedReason, r.nextAttemptAt),
        attempts: r.attempts,
        createdAt: r.createdAt,
        sentAt: r.sentAt,
        nextAttemptAt: r.nextAttemptAt,
        providerId: r.providerId,
        events: r.events,
      })),
      error: null,
    }
  } catch (err) {
    return { rows: [], error: err instanceof Error ? err.message : String(err) }
  }
}

// ── Explaining a refusal in English ─────────────────────────────────────

/**
 * Turn a machine-readable status + reason into the sentence an owner can act
 * on. The reasons are already precise; this is the translation layer, and it
 * NEVER guesses — an unrecognised reason is shown verbatim rather than
 * paraphrased into something that might be wrong.
 */
export function explainSend(status: string, reason: string | null, nextAttemptAt?: Date | null): string {
  if (status === 'delivered') return 'Accepted by the email provider.'
  if (status === 'sending') return 'An attempt is in flight.'
  if (status === 'ambiguous') {
    return 'The request left us but the outcome is unknown. Deliberately never auto-resent — reconcile against the provider dashboard before re-driving it.'
  }
  if (status === 'failed_terminal') return 'Attempts exhausted. This send will not be retried automatically.'

  const due = nextAttemptAt ? ` Next attempt after ${nextAttemptAt.toISOString()}.` : ''

  const explanations: Record<string, string> = {
    unsubscribed: 'The recipient unsubscribed from promotional email. Transactional mail is unaffected.',
    hard_bounce: 'The address hard-bounced — the mailbox does not exist.',
    spam_complaint: 'The recipient filed a spam complaint. All mail to this address is blocked.',
    invalid_address: 'The address is not deliverable.',
    admin_block: 'An operator blocked this address.',
    invalid_email: 'The recipient address is not a valid email address.',
    blank_email: 'No recipient address was available on the record.',
    quiet_hours: 'Held back because it fell inside quiet hours (promotional email only).',
    transactional_gap: 'Held back because a transactional email was sent to this address moments ago.',
    cap_daily: 'Held back by the daily promotional frequency cap.',
    cap_weekly: 'Held back by the weekly promotional frequency cap.',
    cap_monthly: 'Held back by the monthly promotional frequency cap.',
    duplicate: 'This exact email was already delivered for this event — refused to send it twice.',
    in_flight: 'Another worker is currently attempting this send.',
    not_due: 'Scheduled for a later time and not yet due.',
    internal_test_booking: 'The booking is an internal test record, so no customer mail was sent.',
    booking_deleted: 'The booking no longer exists.',
    lead_converted: 'The lead booked — the marketing sequence stopped, as designed.',
    lead_lost: 'The lead was marked lost, so the sequence stopped.',
    move_date_passed: 'The move date has already passed.',
    deposit_already_paid: 'The deposit was paid, so the recovery sequence stopped.',
    no_quote: 'No real quote is recorded on the lead, so no quote sequence was sent.',
    no_email: 'The record has no email address.',
    state_read_failed: 'The eligibility recheck could not read the record, so the send was refused (fails closed).',
    suppression_read_failed: 'The suppression list could not be read, so the send was refused (fails closed).',
    eligibility_read_failed: 'The eligibility check could not read the record, so the send was refused (fails closed).',
    attempts_exhausted: 'Every permitted attempt was used.',
    ambiguous: 'The provider outcome is unknown.',
  }

  if (reason && explanations[reason]) return explanations[reason] + due

  if (reason?.startsWith('status_not_allowed:')) {
    return `The booking status makes this email untrue, so it was refused (${reason.slice('status_not_allowed:'.length)}).`
  }
  if (reason?.startsWith('validation:')) {
    return `The email failed its content gate and was NOT sent: ${reason.slice('validation:'.length).trim()}. This is a configuration problem — fix it and the send can be retried.${due}`
  }
  if (reason?.startsWith('missing-configuration:marketing-context:')) {
    const missing = reason.split(':').pop() ?? ''
    return `Blocked because required promotional compliance content is unconfigured (${missing}). A promotional email must carry an unsubscribe link and the business postal address.${due}`
  }
  if (reason?.startsWith('missing-configuration:')) {
    return `Blocked by missing configuration: ${reason.slice('missing-configuration:'.length)}.${due}`
  }
  if (reason?.startsWith('lead_status:')) {
    return `The lead moved to status ${reason.split(':')[1]}, so the sequence stopped.`
  }
  if (reason?.startsWith('terminal:')) {
    return `This logical send is closed (${reason.split(':')[1]}).`
  }

  return reason ? `Not sent — ${reason}.${due}` : `Status: ${status}.`
}

/** Colour band for a send status, shared by every admin table. */
export function statusTone(status: string): 'good' | 'warn' | 'bad' | 'muted' {
  if (status === 'delivered') return 'good'
  if (status === 'sending') return 'muted'
  if (status === 'deferred' || status === 'blocked_retryable' || status === 'retry_pending' || status === 'provider_rejected') return 'warn'
  if (status === 'failed_terminal' || status === 'ambiguous') return 'bad'
  if (status === 'blocked_terminal') return 'muted'
  return 'muted'
}

/** Colour band for a provider event type. */
export function eventTone(type: string): 'good' | 'warn' | 'bad' | 'muted' {
  if (type === 'delivered' || type === 'opened' || type === 'clicked') return 'good'
  if (type === 'delivery_delayed') return 'warn'
  if (type === 'bounced' || type === 'complained') return 'bad'
  return 'muted'
}

// ── Recipient masking ───────────────────────────────────────────────────

/**
 * `di••••@gmail.com` — enough for an operator to recognise a row they are
 * working on, not enough to harvest the customer list.
 *
 * Applied on the SERVER before the data reaches the page, never in CSS: a
 * manager who opens devtools must not find the full address in the payload.
 */
export function maskEmail(email: string): string {
  const at = email.indexOf('@')
  if (at < 1) return '•••'
  const local = email.slice(0, at)
  const domain = email.slice(at)
  const head = local.slice(0, Math.min(2, local.length))
  return `${head}${'•'.repeat(Math.max(3, local.length - head.length))}${domain}`
}

/** Mask unless the viewer holds `email.view_recipients`. */
export const displayEmail = (email: string, maySeeFull: boolean): string =>
  maySeeFull ? email : maskEmail(email)

// ── Deliverability / provider health ────────────────────────────────────

export type WebhookHealth = {
  configured: boolean
  lastEventAt: Date | null
  eventsLast7d: number
  pendingSideEffects: number
  deadLettered: number
  error: string | null
}

export async function webhookHealth(): Promise<WebhookHealth> {
  const configured = Boolean(process.env.RESEND_WEBHOOK_SECRET?.trim())
  try {
    const [last, recent, pending, dead] = await Promise.all([
      prisma.emailEvent.findFirst({ orderBy: { occurredAt: 'desc' }, select: { occurredAt: true } }),
      prisma.emailEvent.count({ where: { occurredAt: { gte: new Date(Date.now() - 7 * DAY) } } }),
      prisma.emailEvent.count({ where: { processingStatus: { in: ['side_effect_pending', 'side_effect_failed'] } } }),
      prisma.emailEvent.count({ where: { processingStatus: 'dead_letter' } }),
    ])
    return {
      configured,
      lastEventAt: last?.occurredAt ?? null,
      eventsLast7d: recent,
      pendingSideEffects: pending,
      deadLettered: dead,
      error: null,
    }
  } catch (err) {
    return { configured, lastEventAt: null, eventsLast7d: 0, pendingSideEffects: 0, deadLettered: 0, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * DNS authentication status.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: claim SPF/DKIM/DMARC are configured
 * because an env var is set. Those records live in DNS at the registrar, and
 * this process cannot see them. Reporting "verified" from a config value would
 * be exactly the kind of false green the deliverability page exists to prevent.
 * Every value here is UNVERIFIED until someone checks the provider dashboard.
 */
export type DnsStatus = 'VERIFIED' | 'UNVERIFIED' | 'MISSING' | 'INVALID'

export type DnsCheck = { name: string; status: DnsStatus; detail: string; verifiedAt: string | null }

/**
 * DNS authentication status.
 *
 * FOUR states, not two, because "we have not checked" and "it is broken" are
 * different facts and collapsing them is how a domain silently stops
 * authenticating:
 *
 *   VERIFIED   — an operator recorded a real check (EMAIL_DNS_VERIFIED_AT plus
 *                the per-record env var). Never inferred.
 *   UNVERIFIED — nobody has recorded a check. The DEFAULT, and the honest one.
 *   MISSING    — an operator recorded that the record is absent.
 *   INVALID    — an operator recorded that the record exists but is wrong.
 *
 * This application CANNOT read DNS. Every value below therefore comes from what
 * a human recorded after checking, and the page says so. Inferring "configured"
 * from the presence of an API key would produce a green light that means
 * nothing — which is the exact failure this page exists to prevent.
 */
export function dnsChecks(): DnsCheck[] {
  const domain = (process.env.EMAIL_FROM ?? '').split('@').pop()?.replace(/>$/, '').trim() || 'unknown'
  const verifiedAt = process.env.EMAIL_DNS_VERIFIED_AT?.trim() || null

  const read = (record: 'SPF' | 'DKIM' | 'DMARC'): DnsCheck => {
    const raw = process.env[`EMAIL_DNS_${record}`]?.trim().toUpperCase()
    const known: DnsStatus[] = ['VERIFIED', 'MISSING', 'INVALID']
    const status: DnsStatus = raw && (known as string[]).includes(raw) ? (raw as DnsStatus) : 'UNVERIFIED'

    // A VERIFIED claim with no date is not a verification — it is an assertion
    // nobody can audit. Downgrade it rather than display it.
    if (status === 'VERIFIED' && !verifiedAt) {
      return {
        name: record,
        status: 'UNVERIFIED',
        detail: `EMAIL_DNS_${record}=VERIFIED but EMAIL_DNS_VERIFIED_AT is unset, so there is no record of WHEN it was checked. Treated as unverified.`,
        verifiedAt: null,
      }
    }

    const detail =
      status === 'VERIFIED'
        ? `Recorded as verified for ${domain}. This is an operator's attestation, not a live lookup — re-check periodically.`
        : status === 'MISSING'
        ? `Recorded as ABSENT for ${domain}. Mail from this domain is far more likely to be filtered.`
        : status === 'INVALID'
        ? `Recorded as present but INCORRECT for ${domain}. Fix the record at the registrar.`
        : `Not verifiable from the application. Check the ${record} record for ${domain} in the Resend dashboard or with a DNS lookup, then record the result in EMAIL_DNS_${record}.`

    return { name: record, status, detail, verifiedAt: status === 'VERIFIED' ? verifiedAt : null }
  }

  return [read('SPF'), read('DKIM'), read('DMARC')]
}

/** Is a required URL configured AND acceptable to the production gate? */
export type UrlCheck = { name: string; status: DnsStatus; detail: string }

export function requiredUrlChecks(): UrlCheck[] {
  const check = (name: string, env: string, why: string): UrlCheck => {
    const raw = process.env[env]?.trim()
    if (!raw) return { name, status: 'MISSING', detail: `${env} is unset. ${why}` }
    if (!isSafeUrl(raw)) return { name, status: 'INVALID', detail: `${env} is ${raw}, which the production URL gate REJECTS. ${why}` }
    return { name, status: 'VERIFIED', detail: raw }
  }
  return [
    check('App URL', 'APP_URL', 'Every unsubscribe and portal link is built from it, so promotional sends are blocked without it.'),
    check('Google review URL', 'GOOGLE_REVIEW_URL', 'Review requests are never queued without it.'),
  ]
}

/** Postal-address compliance — required on every promotional email. */
export function postalAddressCheck(): { status: DnsStatus; detail: string } {
  const postal = businessPostalAddress()
  return postal
    ? { status: 'VERIFIED', detail: `Configured (${postal.length} characters).` }
    : {
        status: 'MISSING',
        detail: 'BUSINESS_POSTAL_ADDRESS is unset or a placeholder. EVERY promotional send is blocked by the compliance gate. Transactional mail is unaffected.',
      }
}
