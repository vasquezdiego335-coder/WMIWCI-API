// ════════════════════════════════════════════════════════════════════════
//  EMAIL REGISTRY — the machine-readable answer to "what emails exist, and
//  what actually triggers them?" (owner spec 2026-07-21)
//  ---------------------------------------------------------------------
//  WHY THIS EXISTS: the send guard, the templates, the journeys and the
//  suppression list were all built and audited — but nothing tied them
//  together in a form a human could READ. The owner's questions ("what fires
//  this? who is eligible? is it promotional?") were answerable only by reading
//  five source files and a worker allowlist. Admin pages built on prose would
//  drift the moment a template moved.
//
//  THE RULE THIS MODULE FOLLOWS: it never invents facts that live elsewhere.
//   • transactional vs promotional  → email-guard.classifyTemplate (imported)
//   • which booking states are truthful → emails/status.TEMPLATE_ALLOWED_STATUSES
//   • required payload fields       → emails/validation.REQUIRED_FIELDS
//   • journey stages + delays       → lib/journeys (imported constants)
//  What it ADDS is the editorial metadata no other file owns: the trigger in
//  plain English, the stop rules, the owner-facing description, and whether a
//  template is wired to something real or merely exists as a file.
//
//  `templateRegistry()` is PURE and offline-testable. A conformance test
//  (email-registry.test.ts) asserts this registry against the worker's
//  ALLOWED_TEMPLATES set, so a template added to the worker without a registry
//  entry FAILS THE BUILD rather than appearing in the admin as a mystery row.
//
//  A FILE IS NOT A FEATURE: `wiring` records whether a template is actually
//  reachable. `email-archive/` holds nine legacy React templates that no send
//  path can reach; they are deliberately absent here rather than listed as
//  "active" because their file exists.
// ════════════════════════════════════════════════════════════════════════

import { classifyTemplate } from './email-guard'
import { TEMPLATE_ALLOWED_STATUSES } from '../emails/status'
import { REQUIRED_FIELDS } from '../emails/validation'
import { ABANDONED_STAGES, QUOTE_STAGES, REMINDER_OFFSETS } from './journeys'
import type { EmailClass } from './email-suppression'

/** How a template is reached today. Honest about the difference. */
export type Wiring =
  /** A production code path enqueues or sends it. */
  | 'wired'
  /** Reachable only when an operator clicks something in the admin. */
  | 'manual'
  /** Wired, but behind an environment flag that is OFF by default. */
  | 'flag-gated'

export type TemplateEntry = {
  /** The key the guard, the ledger and the worker all use. */
  key: string
  /** Owner-facing name. */
  name: string
  /** React component file, relative to src/. */
  file: string
  category: 'booking' | 'payment' | 'move-day' | 'post-move' | 'recovery' | 'lead' | 'internal'
  /** From email-guard.classifyTemplate — never restated by hand. */
  emailClass: EmailClass
  /** What causes this email, in plain English. */
  trigger: string
  /** The journey it belongs to, when it belongs to one. */
  journey: string | null
  /** Env flag that must be 'true', when one gates it. */
  flag: string | null
  wiring: Wiring
  /** Booking statuses in which this email tells the truth (from status.ts). */
  allowedStatuses: readonly string[] | null
  /** Payload fields the validation gate demands (from validation.ts). */
  requiredFields: readonly string[]
  /** What stops it from being sent, beyond suppression and the caps. */
  stopRules: string[]
  /** English subject the worker uses when no locale-specific one applies. */
  subject: string
}

// ── The editorial layer. Everything factual is derived below. ────────────
type Seed = Omit<TemplateEntry, 'emailClass' | 'allowedStatuses' | 'requiredFields'>

const SEEDS: Seed[] = [
  // ── Booking lifecycle (transactional) ─────────────────────────────────
  {
    key: 'pre-approval',
    name: 'Booking request received',
    file: 'emails/pre-approval.tsx',
    category: 'booking',
    trigger: 'A customer submits a booking and the $49 authorization hold is placed. Sent immediately.',
    journey: 'booking',
    flag: null,
    wiring: 'wired',
    stopRules: ['Booking deleted', 'Address suppressed (hard bounce / complaint / admin block)'],
    subject: "We've received your booking request",
  },
  {
    key: 'final-confirmation',
    name: 'Booking approved',
    file: 'emails/final-confirmation.tsx',
    category: 'booking',
    trigger: 'An owner approves a PENDING_APPROVAL booking, which captures the $49 hold.',
    journey: 'booking',
    flag: null,
    wiring: 'wired',
    stopRules: [
      'Booking left the confirmed states (CONFIRMED / SCHEDULED / IN_PROGRESS / COMPLETED)',
      'Booking cancelled or archived before the send',
    ],
    subject: 'Your booking is approved',
  },
  {
    key: 'booking-declined',
    name: 'Booking declined',
    file: 'emails/booking-declined.tsx',
    category: 'booking',
    trigger: 'An owner declines a booking request before capture. The hold is released.',
    journey: 'booking',
    flag: null,
    wiring: 'wired',
    stopRules: ['Booking was subsequently approved'],
    subject: 'About your booking request',
  },
  {
    key: 'booking-updated',
    name: 'Booking updated',
    file: 'emails/booking-updated.tsx',
    category: 'booking',
    trigger: 'A date, time, address or service change is saved on a live booking.',
    journey: 'booking',
    flag: null,
    wiring: 'wired',
    stopRules: ['Booking cancelled', 'Change reverted before the send'],
    subject: 'Your booking has been updated',
  },
  {
    key: 'booking-cancellation',
    name: 'Booking cancelled',
    file: 'emails/booking-cancellation.tsx',
    category: 'booking',
    trigger: 'A captured booking is cancelled.',
    journey: 'booking',
    flag: null,
    wiring: 'wired',
    stopRules: ['Booking is no longer CANCELLED (reinstated)'],
    subject: 'Your booking has been cancelled',
  },
  {
    key: 'information-required',
    name: 'More details needed',
    file: 'emails/information-required.tsx',
    category: 'booking',
    trigger: 'An operator requests missing details needed to schedule the move.',
    journey: 'booking',
    flag: null,
    wiring: 'manual',
    stopRules: ['Booking cancelled', 'Details supplied before the send'],
    subject: 'We need a few details to schedule your move',
  },

  // ── Payment (transactional) ───────────────────────────────────────────
  {
    key: 'payment-receipt',
    name: 'Payment receipt',
    file: 'emails/payment-receipt.tsx',
    category: 'payment',
    trigger: 'A payment is CAPTURED (not merely authorized). Also fired by the admin "resend receipt" action.',
    journey: 'booking',
    flag: null,
    wiring: 'wired',
    stopRules: [
      'Payment is a hold, failed, or refunded — a receipt asserts money was taken',
      'Booking is an internal test record',
    ],
    subject: 'Payment received — receipt enclosed',
  },
  {
    key: 'payment-failed',
    name: 'Payment failed',
    file: 'emails/payment-failed.tsx',
    category: 'payment',
    trigger: 'Stripe reports a failed charge or an expired authorization.',
    journey: 'booking',
    flag: null,
    wiring: 'wired',
    stopRules: ['Payment subsequently succeeded', 'Booking cancelled'],
    subject: 'Action required — update your payment method',
  },
  {
    key: 'final-invoice',
    name: 'Final invoice',
    file: 'emails/final-invoice.tsx',
    category: 'payment',
    trigger: 'The move is complete and the final balance is issued to the customer.',
    journey: 'post-move',
    flag: null,
    wiring: 'manual',
    stopRules: ['Move not COMPLETED', 'Balance already settled'],
    subject: 'Your final invoice',
  },

  // ── Move day (transactional) ──────────────────────────────────────────
  {
    key: 'job-reminder',
    name: 'Move reminder (72h / 24h)',
    file: 'emails/job-reminder.tsx',
    category: 'move-day',
    trigger: 'Scheduled from the move date by journeys.onMoveDateSet — one at 72h out, one at 24h out.',
    journey: 'pre-move',
    flag: 'EMAIL_JOURNEYS_ENABLED',
    wiring: 'flag-gated',
    stopRules: [
      'Booking no longer CONFIRMED or SCHEDULED',
      'Move date changed (the sequence is re-anchored, old jobs cancelled)',
      'Reminder window already passed when scheduled — skipped, never fired late',
    ],
    subject: 'Your move is almost here',
  },
  {
    key: 'operational-alert',
    name: 'Operational alert',
    file: 'emails/operational-alert.tsx',
    category: 'move-day',
    trigger: 'An operator sends a same-day update (crew running late, access problem, weather).',
    journey: null,
    flag: null,
    wiring: 'manual',
    stopRules: ['Booking cancelled'],
    subject: 'An update about your move',
  },
  {
    key: 'job-completion',
    name: 'Move complete',
    file: 'emails/job-completion.tsx',
    category: 'post-move',
    trigger: 'The booking transitions to COMPLETED.',
    journey: 'post-move',
    flag: null,
    wiring: 'wired',
    stopRules: ['Booking is not COMPLETED'],
    subject: 'Your move is complete — thank you',
  },

  // ── Post-move (promotional) ───────────────────────────────────────────
  {
    key: 'review-request',
    name: 'Review request',
    file: 'emails/review-request.tsx',
    category: 'post-move',
    trigger: 'Two hours after completion, via followups.onBookingCompleted.',
    journey: 'post-job',
    flag: 'MARKETING_FOLLOWUPS_ENABLED',
    wiring: 'flag-gated',
    stopRules: [
      'A review already exists for the booking',
      'GOOGLE_REVIEW_URL unset or unsafe — the send is blocked rather than sent without a link',
      'Customer unsubscribed from promotional email',
    ],
    subject: 'How did we do? Leave us a review',
  },
  {
    key: 'review-reminder',
    name: 'Review reminder',
    file: 'emails/review-request.tsx',
    category: 'post-move',
    trigger: '48 hours after completion, if no review has been recorded.',
    journey: 'post-job',
    flag: 'MARKETING_FOLLOWUPS_ENABLED',
    wiring: 'flag-gated',
    stopRules: ['A review was recorded in the meantime', 'Frequency cap', 'Unsubscribed'],
    subject: 'How did we do? Leave us a review',
  },
  {
    key: 'referral',
    name: 'Referral invitation',
    file: 'emails/referral.tsx',
    category: 'post-move',
    trigger:
      'Five days after completion (fallback), or 24h after a POSITIVE review is recorded. The ledger dedupes so only one is ever sent.',
    journey: 'post-job',
    flag: 'REFERRAL_PROGRAM_ENABLED',
    wiring: 'flag-gated',
    stopRules: [
      'A referral ask was already sent for this booking (ledger unique key)',
      'The review recorded was not positive',
      'Unsubscribed',
    ],
    subject: 'Give 15%. Get 15%.',
  },
  {
    key: 'referral-reward',
    name: 'Referral reward',
    file: 'emails/referral-reward.tsx',
    category: 'post-move',
    trigger: 'A referred booking completes and the referrer has earned their reward.',
    journey: 'post-job',
    flag: 'REFERRAL_PROGRAM_ENABLED',
    wiring: 'manual',
    stopRules: ['Referred booking cancelled before completion', 'Reward already issued'],
    subject: 'Your referral reward is here',
  },
  {
    key: 'repeat-reminder',
    name: 'Repeat customer reminder',
    file: 'emails/review-request.tsx',
    category: 'post-move',
    trigger: '30 days after completion.',
    journey: 'post-job',
    flag: 'MARKETING_FOLLOWUPS_ENABLED',
    wiring: 'flag-gated',
    stopRules: ['Customer booked again in the meantime', 'Frequency cap', 'Unsubscribed'],
    subject: 'Planning another move?',
  },

  // ── Recovery (promotional) ────────────────────────────────────────────
  {
    key: 'abandoned-checkout',
    name: 'Abandoned checkout — stage 1',
    file: 'emails/abandoned-checkout.tsx',
    category: 'recovery',
    trigger: '~45 minutes after a Stripe checkout is created with no deposit paid.',
    journey: 'abandoned',
    flag: 'EMAIL_JOURNEYS_ENABLED',
    wiring: 'flag-gated',
    stopRules: [
      'Booking is no longer PENDING_PAYMENT — the moment the customer pays, the whole sequence dies',
      'Booking cancelled or deleted',
      'Unsubscribed',
    ],
    subject: 'Your date is still available',
  },
  {
    key: 'abandoned-checkout-2',
    name: 'Abandoned checkout — stage 2',
    file: 'emails/abandoned-checkout.tsx',
    category: 'recovery',
    trigger: '24 hours after checkout creation, if still unpaid.',
    journey: 'abandoned',
    flag: 'EMAIL_JOURNEYS_ENABLED',
    wiring: 'flag-gated',
    stopRules: ['Deposit paid', 'Booking cancelled', 'Unsubscribed', 'Frequency cap'],
    subject: "What's included in a labor-only move",
  },
  {
    key: 'abandoned-checkout-3',
    name: 'Abandoned checkout — stage 3',
    file: 'emails/abandoned-checkout.tsx',
    category: 'recovery',
    trigger: '72 hours after checkout creation, if still unpaid. Final stage — there is deliberately no 4th.',
    journey: 'abandoned',
    flag: 'EMAIL_JOURNEYS_ENABLED',
    wiring: 'flag-gated',
    stopRules: ['Deposit paid', 'Booking cancelled', 'Unsubscribed', 'Frequency cap'],
    subject: 'Did your moving plans change?',
  },
  {
    key: 'quote-followup-1',
    name: 'Quote follow-up — stage 1',
    file: 'emails/quote-followup.tsx',
    category: 'lead',
    trigger: '24 hours after a REAL quote (Lead.quotedAt). A lead with no quotedAt gets nothing.',
    journey: 'quote',
    flag: 'EMAIL_JOURNEYS_ENABLED',
    wiring: 'flag-gated',
    stopRules: [
      'Lead converted (bookedAt / convertedBookingId set) — the booking journey owns them now',
      'Lead lost, or status WON / LOST / BOOKED / CONVERTED',
      'The move date has passed',
      'Unsubscribed',
    ],
    subject: 'Did your quote come through?',
  },
  {
    key: 'quote-followup-2',
    name: 'Quote follow-up — stage 2',
    file: 'emails/quote-followup.tsx',
    category: 'lead',
    trigger: '3 days after the quote.',
    journey: 'quote',
    flag: 'EMAIL_JOURNEYS_ENABLED',
    wiring: 'flag-gated',
    stopRules: ['Lead converted or lost', 'Move date passed', 'Unsubscribed', 'Frequency cap'],
    subject: 'What "labor-only" actually means',
  },
  {
    key: 'quote-followup-final',
    name: 'Quote follow-up — final',
    file: 'emails/quote-followup.tsx',
    category: 'lead',
    trigger: '7 days after the quote. Last stage.',
    journey: 'quote',
    flag: 'EMAIL_JOURNEYS_ENABLED',
    wiring: 'flag-gated',
    stopRules: ['Lead converted or lost', 'Move date passed', 'Unsubscribed', 'Frequency cap'],
    subject: 'Are you still planning your move?',
  },

  // ── Lead intake (transactional) ───────────────────────────────────────
  {
    key: 'lead-acknowledgement',
    name: 'Lead acknowledgement',
    file: 'lib/notify.ts (inline)',
    category: 'lead',
    trigger: 'Someone submits the quote or contact form. Acknowledges an enquiry they just made.',
    journey: 'lead-intake',
    flag: null,
    wiring: 'wired',
    stopRules: ['Address suppressed', 'Duplicate form submission (same event id)'],
    subject: "We've got your request",
  },
]

/**
 * The registry, with every derivable fact taken from the module that owns it.
 * Pure — safe to call from a server component, a test, or a script.
 */
export function templateRegistry(): TemplateEntry[] {
  return SEEDS.map((s) => ({
    ...s,
    emailClass: classifyTemplate(s.key),
    allowedStatuses: TEMPLATE_ALLOWED_STATUSES[s.key] ?? null,
    requiredFields: (REQUIRED_FIELDS as Record<string, readonly string[]>)[s.key] ?? [],
  }))
}

export function templateByKey(key: string): TemplateEntry | undefined {
  return templateRegistry().find((t) => t.key === key)
}

/** Owner-facing label for a template key that may not be in the registry. */
export function templateLabel(key: string): string {
  return templateByKey(key)?.name ?? key
}

// ════════════════════════════════════════════════════════════════════════
//  JOURNEYS — a named sequence of stages with delays and an anchor event.
//  Stage timings are IMPORTED from lib/journeys and lib/followups rather than
//  restated, so the admin cannot show a schedule the scheduler does not run.
// ════════════════════════════════════════════════════════════════════════

const HOUR = 3_600_000
const DAY = 24 * HOUR

export type JourneyStageEntry = {
  /** The scheduled-job type the worker dispatches on. */
  type: string
  /** Template the stage renders. */
  template: string
  /** Delay from the anchor, in milliseconds. Negative = BEFORE the anchor. */
  delayMs: number
  label: string
}

export type JourneyEntry = {
  key: string
  name: string
  /** The event the delays are measured from. */
  anchor: string
  audience: string
  emailClass: EmailClass
  flag: string | null
  /** True when the gating flag is currently 'true' in this process. */
  enabled: boolean
  stages: JourneyStageEntry[]
  stopRules: string[]
  conversionGoal: string
  /** Where the scheduling code lives. */
  source: string
}

const flagOn = (name: string | null): boolean => (name ? process.env[name] === 'true' : true)

/** Follow-up delays mirror followups.COMPLETION_DELAYS (not exported there). */
const FOLLOWUP_DELAYS: Record<string, number> = {
  'review-request': 2 * HOUR,
  'review-reminder': 48 * HOUR,
  'referral-ask': 5 * DAY,
  'repeat-reminder': 30 * DAY,
}

export function journeyRegistry(): JourneyEntry[] {
  const journeys: JourneyEntry[] = [
    {
      key: 'abandoned',
      name: 'Abandoned booking recovery',
      anchor: 'Stripe checkout created, deposit unpaid (booking parked in PENDING_PAYMENT)',
      audience: 'Someone who started a booking and did not pay the $49 deposit',
      emailClass: 'promotional',
      flag: 'EMAIL_JOURNEYS_ENABLED',
      enabled: flagOn('EMAIL_JOURNEYS_ENABLED'),
      stages: ABANDONED_STAGES.map((s, i) => ({
        type: s.type,
        template: i === 0 ? 'abandoned-checkout' : `abandoned-checkout-${i + 1}`,
        delayMs: s.delay,
        label: `Stage ${i + 1}`,
      })),
      stopRules: [
        'Deposit paid → journeys.onBookingPaid cancels every pending stage',
        'Booking cancelled → journeys.onBookingCancelled cancels everything',
        'Send-time recheck: booking must STILL be PENDING_PAYMENT',
      ],
      conversionGoal: 'Deposit paid → booking confirmed',
      source: 'src/lib/journeys.ts',
    },
    {
      key: 'pre-move',
      name: 'Pre-move reminders',
      anchor: 'The move date',
      audience: 'Every customer with a confirmed or scheduled move',
      emailClass: 'transactional',
      flag: 'EMAIL_JOURNEYS_ENABLED',
      enabled: flagOn('EMAIL_JOURNEYS_ENABLED'),
      stages: REMINDER_OFFSETS.map((r) => ({
        type: r.type,
        template: 'job-reminder',
        delayMs: -r.before,
        label: r.type.endsWith('72h') ? '72 hours before' : '24 hours before',
      })),
      stopRules: [
        'Booking cancelled',
        'Move date changed → the sequence is re-anchored and old jobs are dropped',
        'A window already in the past is skipped, never fired late',
      ],
      conversionGoal: 'Customer prepared; no move-day surprises',
      source: 'src/lib/journeys.ts',
    },
    {
      key: 'quote',
      name: 'Quote follow-up',
      anchor: 'Lead.quotedAt — a REAL recorded quote',
      audience: 'A quoted lead who has not booked',
      emailClass: 'promotional',
      flag: 'EMAIL_JOURNEYS_ENABLED',
      enabled: flagOn('EMAIL_JOURNEYS_ENABLED'),
      stages: QUOTE_STAGES.map((s, i) => ({
        type: s.type,
        template: s.type,
        delayMs: s.delay,
        label: i === QUOTE_STAGES.length - 1 ? 'Final' : `Stage ${i + 1}`,
      })),
      stopRules: [
        'Lead converted (bookedAt / convertedBookingId) → onLeadClosed cancels the sequence',
        'Lead lost, or status WON / LOST / BOOKED / CONVERTED',
        'A stage that would land after the move date is skipped at schedule time',
      ],
      conversionGoal: 'Quoted lead becomes a booking',
      source: 'src/lib/journeys.ts',
    },
    {
      key: 'post-job',
      name: 'Post-move follow-ups',
      anchor: 'Booking marked COMPLETED',
      audience: 'A customer whose move is finished',
      emailClass: 'promotional',
      flag: 'MARKETING_FOLLOWUPS_ENABLED',
      enabled: flagOn('MARKETING_FOLLOWUPS_ENABLED'),
      stages: [
        { type: 'review-request', template: 'review-request', delayMs: FOLLOWUP_DELAYS['review-request'], label: 'Review request' },
        { type: 'review-reminder', template: 'review-reminder', delayMs: FOLLOWUP_DELAYS['review-reminder'], label: 'Review reminder' },
        { type: 'referral-ask', template: 'referral', delayMs: FOLLOWUP_DELAYS['referral-ask'], label: 'Referral ask (fallback)' },
        { type: 'repeat-reminder', template: 'repeat-reminder', delayMs: FOLLOWUP_DELAYS['repeat-reminder'], label: 'Repeat reminder' },
      ],
      stopRules: [
        'A review already exists → the review stages stop',
        'A positive review schedules its own referral ask at +24h; the ledger unique key means only one is ever sent',
        'Booking cancelled → onBookingCancelled cancels the sequence',
      ],
      conversionGoal: 'Google review, referral, repeat booking',
      source: 'src/lib/followups.ts',
    },
    {
      key: 'lead-intake',
      name: 'Lead intake',
      anchor: 'Quote or contact form submitted',
      audience: 'Anyone who enquires',
      emailClass: 'transactional',
      flag: null,
      enabled: true,
      stages: [
        { type: 'lead-acknowledgement', template: 'lead-acknowledgement', delayMs: 0, label: 'Immediate' },
      ],
      stopRules: ['Address suppressed', 'Duplicate submission (same event id)'],
      conversionGoal: 'Enquiry answered; lead enters the funnel',
      source: 'src/lib/notify.ts',
    },
    {
      key: 'booking',
      name: 'Booking lifecycle',
      anchor: 'Each booking state change',
      audience: 'Every customer with a live booking',
      emailClass: 'transactional',
      flag: null,
      enabled: true,
      stages: [
        { type: 'pre-approval', template: 'pre-approval', delayMs: 0, label: 'Request received' },
        { type: 'final-confirmation', template: 'final-confirmation', delayMs: 0, label: 'Approved' },
        { type: 'payment-receipt', template: 'payment-receipt', delayMs: 0, label: 'Payment captured' },
        { type: 'booking-updated', template: 'booking-updated', delayMs: 0, label: 'Details changed' },
        { type: 'booking-cancellation', template: 'booking-cancellation', delayMs: 0, label: 'Cancelled' },
      ],
      stopRules: [
        'Every stage revalidates the booking state at send time (email-eligibility.bookingEligibility)',
        'A template is refused outright when the booking status makes its claim untrue',
      ],
      conversionGoal: 'Customer always knows the true state of their booking',
      source: 'src/workers/email.worker.ts, src/outbox/services/emailService.ts',
    },
  ]
  return journeys
}

export function journeyByKey(key: string): JourneyEntry | undefined {
  return journeyRegistry().find((j) => j.key === key)
}

/**
 * "45 min" / "24 hours" / "3 days" / "72 hours before" — for the admin timeline.
 *
 * Three deliberate choices:
 *  • Units are pluralised properly. Before this, a stage at exactly 24h fell
 *    past the hours branch and rendered as "1 days".
 *  • COUNTDOWNS (negative — a reminder before the move) stay in hours up to 72h,
 *    because the business, the journey docs and the job types all call these
 *    "the 72h and 24h reminders". Rendering them as "3 days" and "1 day" would
 *    make the admin disagree with the name of the thing it is describing.
 *  • FOLLOW-UPS (positive — after an anchor) switch to days past 48h, because
 *    the quote sequence is specified as "24 hours, 3 days, 7 days".
 */
export function formatDelay(ms: number): string {
  const abs = Math.abs(ms)
  const before = ms < 0
  const suffix = before ? ' before' : ''
  if (abs === 0) return 'Immediately'

  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}${suffix}`

  if (abs < HOUR) return `${Math.round(abs / 60_000)} min${suffix}`
  const hourCeiling = before ? 72 * HOUR : 48 * HOUR
  if (abs <= hourCeiling) return unit(Math.round(abs / HOUR), 'hour')
  return unit(Math.round(abs / DAY), 'day')
}
