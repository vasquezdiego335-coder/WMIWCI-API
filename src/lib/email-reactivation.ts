// ════════════════════════════════════════════════════════════════════════
//  REACTIVATION ELIGIBILITY — when the lifecycle lets go and campaigns may ask
//  (owner spec 2026-08-07)
//  ---------------------------------------------------------------------
//  THE BUSINESS RULE, stated once so it is not scattered as ad-hoc 14-day
//  checks across unrelated code:
//
//    Day 0+        active customer intent — a LIFECYCLE owns the person.
//    Lifecycle     Sequence A runs to +7d, Sequence B to +72h, checkout
//    ends          recovery to +72h. Nothing new is scheduled after that.
//    Day 14+       the person becomes ELIGIBLE for the reactivation /
//                  campaign pool. Eligibility is NOT a send: it means the
//                  deterministic audience queries may now select them, the
//                  discovery sweep may notice them, and a HUMAN-approved
//                  campaign may reach them.
//
//  Because every lifecycle spans at most 7 days, "14 days old" implies "the
//  lifecycle has finished" — one age rule covers both facts. The age is
//  measured from the lifecycle ANCHOR: `quotedAt` for a quoted lead (that is
//  what Sequence A is anchored on), last activity for everyone else.
//
//  LIFECYCLE BEATS CAMPAIGNS. The mirror predicate `activeLifecycleReason`
//  answers "is a journey still running for this person?" from DATE MATH on the
//  database rows — deliberately not from the Redis queue, so the answer is
//  deterministic, testable offline, and survives a queue wipe. Its windows are
//  the journey spans plus one day of slack, so a stage deferred by quiet hours
//  or a daily cap still counts as "the lifecycle owns them".
//
//  Everything here is PURE. The audience layer supplies the rows.
// ════════════════════════════════════════════════════════════════════════

const DAY_MS = 24 * 60 * 60 * 1000

/** Days after the lifecycle anchor before a person enters the campaign pool. */
export const REACTIVATION_AGE_DAYS = Math.max(
  1,
  Number(process.env.EMAIL_REACTIVATION_AGE_DAYS) || 14
)

// ── Lifecycle spans (journey length + 1 day of deferral slack) ──────────
//  Sequence A (quote):     +24h / +3d / +7d      → 8 days
//  Sequence B (nurture):   +4h / +24h / +72h     → 4 days
//  Checkout recovery:      +45m / +24h / +72h    → 4 days
//  These mirror journeys.QUOTE_STAGES / LEAD_NURTURE_STAGES /
//  ABANDONED_STAGES. They are constants rather than imports because they are
//  WINDOWS over the schedule, not the schedule itself — and a campaign
//  erring one day on the side of "still in a lifecycle" is the safe error.
export const QUOTE_JOURNEY_WINDOW_DAYS = 8
export const NURTURE_WINDOW_DAYS = 4
export const RECOVERY_WINDOW_DAYS = 4

/** The lead facts the reactivation rules reason about. */
export type ReactivationLead = {
  email: string | null
  emailMarketingConsent: boolean | null
  quotedAt: Date | null
  bookedAt: Date | null
  convertedBookingId: string | null
  lostAt: Date | null
  moveDate: Date | null
  lastActivityAt: Date | null
  createdAt: Date
}

/** Unpaid-booking facts, for the recovery window. */
export type ReactivationBooking = {
  status: string
  depositPaid: boolean
  createdAt: Date
}

/**
 * The moment this lead's lifecycle was anchored — the clock the 14-day rule
 * runs on. A quoted lead ages from the QUOTE (Sequence A's own anchor); an
 * un-quoted lead ages from its last activity (Sequence B is anchored on
 * capture, and a repeat submission legitimately restarts the person's
 * "active intent" clock).
 */
export function reactivationAnchor(lead: Pick<ReactivationLead, 'quotedAt' | 'lastActivityAt' | 'createdAt'>): Date {
  return lead.quotedAt ?? lead.lastActivityAt ?? lead.createdAt
}

/**
 * Is a lifecycle journey still plausibly running for this lead?
 * Returns the reason, or null when the lifecycle has let go.
 */
export function activeLifecycleReason(
  lead: Pick<ReactivationLead, 'quotedAt' | 'lastActivityAt' | 'createdAt'>,
  now: Date
): string | null {
  if (lead.quotedAt && now.getTime() - lead.quotedAt.getTime() < QUOTE_JOURNEY_WINDOW_DAYS * DAY_MS) {
    return 'active_quote_journey'
  }
  if (!lead.quotedAt) {
    const anchor = lead.lastActivityAt ?? lead.createdAt
    if (now.getTime() - anchor.getTime() < NURTURE_WINDOW_DAYS * DAY_MS) return 'active_nurture'
  }
  return null
}

/** Is an unpaid booking still inside the recovery journey's window? */
export function activeRecoveryReason(booking: ReactivationBooking, now: Date): string | null {
  if (booking.status !== 'PENDING_PAYMENT' || booking.depositPaid) return null
  if (now.getTime() - booking.createdAt.getTime() < RECOVERY_WINDOW_DAYS * DAY_MS) return 'active_checkout_recovery'
  return null
}

/**
 * May this lead enter the reactivation/campaign pool? Reason to refuse, or
 * null to admit. This is the SCHEDULE-time filter; suppression, caps, quiet
 * hours and the final consent check are still enforced downstream by the
 * audience pipeline and guardedSend — nothing here relaxes those.
 */
export function reactivationBlockReason(lead: ReactivationLead, now: Date): string | null {
  if (!lead.email) return 'no_email'
  // ONLY an explicit opt-in qualifies. null and false both refuse — absence of
  // a decision is not consent, and a campaign is the last place to forget it.
  if (lead.emailMarketingConsent !== true) return 'no_marketing_consent'
  if (lead.bookedAt || lead.convertedBookingId) return 'lead_converted'
  if (lead.lostAt) return 'lead_lost'
  // The move already happened — "still planning your move?" would be false.
  if (lead.moveDate && lead.moveDate.getTime() + DAY_MS < now.getTime()) return 'move_date_passed'
  const active = activeLifecycleReason(lead, now)
  if (active) return active
  const age = now.getTime() - reactivationAnchor(lead).getTime()
  if (age < REACTIVATION_AGE_DAYS * DAY_MS) return 'too_recent'
  return null
}

/** The cutoff date audience SQL uses for "aged into the pool". */
export function reactivationCutoff(now: Date): Date {
  return new Date(now.getTime() - REACTIVATION_AGE_DAYS * DAY_MS)
}
