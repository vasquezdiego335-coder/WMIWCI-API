// ════════════════════════════════════════════════════════════════════════
//  PROMOTIONAL ELIGIBILITY — the one answer to "may we send this person a
//  promotional email, in this context, for this subject?"
//  (email consent release 2026-09-16, DESIGN-v2 §5)
//  ---------------------------------------------------------------------
//  PROHIBITIONS BELONG TO THE PERSON. PERMISSIONS BELONG TO THE SUBMISSION.
//
//  Prohibitions are keyed on the normalized address across EVERY row, are
//  checked first, and always win:
//    1. any EmailSuppression row (every reason, both scopes) → 'suppressed';
//       Customer.marketingOptOut on any customer row → 'opted_out'
//    2. an opt-out (capture box, unsubscribe) at or after the latest CONFIRMED
//       express opt-in (the status row) → 'opted_out'. A legacy consent column
//       never lifts an opt-out: a form submission cannot resubscribe anyone.
//    3. an old-page decline at or after the latest express opt-in, legacy
//       columns included (today's "a later tick replaces a decline") → 'declined'
//    4. a test / staff / role identity → 'test_identity'
//  A tie goes to the prohibition.
//
//  Permissions:
//    5. EXPRESS — every context. email_marketing_status.express_opt_in_at (a
//       token-authenticated resubscribe — express_opt_in events are only ever
//       written by that flow; no form submission, the popup included, is ever
//       recorded as an opt-in), or a legacy consent column that is true. The legacy columns keep
//       TODAY'S scoping exactly, so nothing becomes looser: a campaign honours
//       a true on ANY Lead or Customer row for the address (email-audience.ts
//       consentingEmails); every other context honours only the SUBJECT's own
//       row (the lead's column for a lead sequence, the customer's column for a
//       booking), as journeys.ts and email-eligibility.ts do today.
//    6. NOTICE — context 'scenario_flow' only, and only through the subject's
//       own basisEventId: a notice_accepted event for THIS address, recorded on
//       a surface whose scenario includes THIS sequence kind, describing copy
//       the registry still recognises, on or after NOTICE_POLICY_START, within
//       183 days, with a region signal other than 'non_nanp', while
//       EMAIL_NOTICE_BASIS_ENABLED === 'true'.
//    7. EBR — context 'post_move' only: a paid or completed real booking within
//       two years, while EMAIL_EBR_BASIS_ENABLED === 'true' (default off, so
//       post-move follow-ups keep requiring express consent exactly as today
//       until the owner decides otherwise).
//    8. NOTICE FOR OFFERS — context 'campaign' only (owner direction
//       2026-09-16: every form submission may lead to promotional email,
//       including relevant owner-approved offers). The person's LATEST form
//       submission (email_marketing_status.last_notice_event_id) is the basis,
//       checked exactly like rule 6 (registry, policy start, region, 183 days,
//       EMAIL_NOTICE_BASIS_ENABLED) — except that a support or existing-booking
//       message (surface 'contact_support') counts like every other topic
//       (owner direction 2026-09-16): the route answers it first, then the
//       person enters marketing.
//    9. otherwise: 'no_marketing_basis'.
//
//  The discovery drafter, enrollCustomer and non-scenario automations therefore
//  stay express-only; campaigns take an express permission or rule 8.
//
//  decidePromotionalEligibility() is PURE over explicit facts, so every rule is
//  table-tested offline. promotionalEligibility() gathers those facts and FAILS
//  CLOSED: a read error is 'eligibility_read_failed' (retryable), never a send.
// ════════════════════════════════════════════════════════════════════════

import type { PrismaClient } from '@prisma/client'
import { prisma } from '../db'
import { normalizeEmail } from '../email-tokens'
import { isPlausibleEmail } from './consent-events'
import {
  NOTICE_POLICY_START,
  NOTICE_VERSIONS,
  SURFACE_SEQUENCE_KINDS,
  isNoticeSurface,
  storedNoticeMatchesRegistry,
  type SequenceKind,
} from './notice-registry'
import { testIdentityReason, type StaffEmails, type TestIdentityReason } from './test-identity'

const DAY_MS = 24 * 60 * 60 * 1000

/** A notice basis lasts this long from the submission that recorded it. */
export const NOTICE_BASIS_DAYS = 183
/** An existing business relationship lasts this long from the paid/completed booking. */
export const EBR_BASIS_DAYS = 730

export const ELIGIBILITY_CONTEXTS = ['scenario_flow', 'campaign', 'automation', 'post_move'] as const
export type EligibilityContext = (typeof ELIGIBILITY_CONTEXTS)[number]

export type MarketingBasis = 'express' | 'notice' | 'ebr'

export const INELIGIBLE_REASONS = [
  'suppressed',
  'opted_out',
  'declined',
  'test_identity',
  'no_marketing_basis',
  'notice_expired',
  'notice_basis_disabled',
  'basis_email_mismatch',
  'invalid_email',
  'eligibility_read_failed',
] as const
export type IneligibleReason = (typeof INELIGIBLE_REASONS)[number]

/** Every reason is terminal except a read failure, which may be retried. */
export const RETRYABLE_INELIGIBLE_REASONS: readonly IneligibleReason[] = ['eligibility_read_failed']

export type EligibilityDecision =
  | { eligible: true; basis: MarketingBasis; basisEventId: string | null }
  | { eligible: false; reason: IneligibleReason; terminal: boolean; detail?: string }

export type EligibilitySubjectType = 'lead' | 'booking' | 'customer' | 'none'

export type BasisEventFact = {
  id: string
  emailNormalized: string
  kind: string
  surface: string
  occurredAt: Date
  regionSignal: string | null
  noticeVersion: string | null
  noticeCopySha256: string | null
  locale: string | null
}

export type LegacyConsentFact = {
  record: 'lead' | 'customer'
  id: string
  /** emailMarketingConsent. Null rows are not facts and are left out. */
  value: boolean
  /** marketingConsentAt; null when the row never recorded a time. */
  at: Date | null
  /** This row IS the subject (the lead, or the booking's/subject's customer). */
  isSubject: boolean
}

export type EligibilityFacts = {
  context: EligibilityContext
  now: Date
  emailNormalized: string
  suppression: { reason: string; scope: string } | null
  customerMarketingOptOut: boolean
  status: {
    expressOptInAt: Date | null
    expressEventId: string | null
    optedOutAt: Date | null
    declinedAt: Date | null
  } | null
  legacyConsent: LegacyConsentFact[]
  testIdentity: TestIdentityReason | null
  subject: {
    type: EligibilitySubjectType
    id: string | null
    sequenceKind: SequenceKind | null
    basisEventId: string | null
  }
  /** The event subject.basisEventId points at, or null when absent/not found. */
  basisEvent: BasisEventFact | null
  /**
   * Campaign context only: the event email_marketing_status.last_notice_event_id
   * points at — the person's latest form submission — or null.
   */
  latestNotice?: BasisEventFact | null
  /** Latest paid or completed real booking time for the address. */
  ebrAt: Date | null
  flags: { noticeBasisEnabled: boolean; ebrBasisEnabled: boolean }
}

const no = (reason: IneligibleReason, detail?: string): EligibilityDecision => ({
  eligible: false,
  reason,
  terminal: !RETRYABLE_INELIGIBLE_REASONS.includes(reason),
  ...(detail ? { detail } : {}),
})

/** Legacy rows with no recorded time sort before every real timestamp. */
const legacyTime = (at: Date | null): number => (at ? at.getTime() : 0)

/**
 * PURE. Apply DESIGN-v2 §5 to explicit facts. No I/O, no clock, no env.
 */
export function decidePromotionalEligibility(f: EligibilityFacts): EligibilityDecision {
  if (!isPlausibleEmail(f.emailNormalized)) return no('invalid_email')

  // ── PROHIBITIONS ──────────────────────────────────────────────────────
  if (f.suppression) return no('suppressed', `suppression:${String(f.suppression.reason).toLowerCase()}`)
  if (f.customerMarketingOptOut) return no('opted_out', 'customer_marketing_opt_out')

  //  The latest express permission that counts in this context.
  let expressAt: number | null = null
  let expressEventId: string | null = null
  if (f.status?.expressOptInAt) {
    expressAt = f.status.expressOptInAt.getTime()
    expressEventId = f.status.expressEventId ?? null
  }
  for (const row of f.legacyConsent) {
    if (row.value !== true) continue
    if (f.context !== 'campaign' && !row.isSubject) continue
    const t = legacyTime(row.at)
    if (expressAt === null || t > expressAt) {
      expressAt = t
      expressEventId = null
    }
  }

  //  A WITHDRAWAL yields only to a later CONFIRMED express opt-in (the status
  //  row: a token resubscribe). A legacy consent column is a form
  //  submission anyone can forge, and a form submission never lifts an opt-out.
  const confirmedExpressAt = f.status?.expressOptInAt ? f.status.expressOptInAt.getTime() : null
  if (f.status?.optedOutAt && (confirmedExpressAt === null || f.status.optedOutAt.getTime() >= confirmedExpressAt)) {
    return no('opted_out')
  }

  //  DECLINES. A decline EVENT (status row) is per person and wins unless a
  //  later express permission exists. A LEGACY `false` column is weaker: it
  //  records an unticked box, and today's rule (consent.ts decideConsent) is
  //  that "an unchecked box on a later form is not an unsubscribe, so it does
  //  not revoke consent". So a legacy false counts only for a person with NO
  //  express permission anywhere — no legacy true on any row and no confirmed
  //  opt-in — where it still blocks a notice basis. Counting it against an
  //  opted-in customer who later left a box unticked would silently stop the
  //  mail they asked for (post-move follow-ups, campaigns) from deploy day.
  const hasAnyExpress = Boolean(f.status?.expressOptInAt) || f.legacyConsent.some((row) => row.value === true)
  let declinedAt: number | null = f.status?.declinedAt ? f.status.declinedAt.getTime() : null
  if (!hasAnyExpress) {
    for (const row of f.legacyConsent) {
      if (row.value !== false) continue
      const t = legacyTime(row.at)
      if (declinedAt === null || t > declinedAt) declinedAt = t
    }
  }
  if (declinedAt !== null && (expressAt === null || declinedAt >= expressAt)) return no('declined')

  //  A FAILED staff lookup is not a finding about the person: it is a read
  //  error, and every caller here (send, enrollment, stage, campaign audience)
  //  must retry it rather than record a terminal "test identity" — a pool
  //  timeout would otherwise block a real customer's sends for good and mark a
  //  whole campaign SKIPPED. Grant time keeps refusing (grant-safeguards).
  if (f.testIdentity === 'staff_lookup_failed') return no('eligibility_read_failed', 'staff_lookup_failed')
  if (f.testIdentity) return no('test_identity', f.testIdentity)

  // ── PERMISSIONS ───────────────────────────────────────────────────────
  if (expressAt !== null) return { eligible: true, basis: 'express', basisEventId: expressEventId }

  if (f.context === 'scenario_flow' && f.subject.basisEventId) {
    if (!f.flags.noticeBasisEnabled) return no('notice_basis_disabled')
    const ev = f.basisEvent
    if (!ev || ev.id !== f.subject.basisEventId) return no('no_marketing_basis', 'basis_event_not_found')
    if (ev.kind !== 'notice_accepted') return no('no_marketing_basis', 'basis_event_not_a_notice')
    if (ev.emailNormalized !== f.emailNormalized) return no('basis_email_mismatch')
    if (!isNoticeSurface(ev.surface)) return no('no_marketing_basis', 'unknown_surface')
    if (!f.subject.sequenceKind || !SURFACE_SEQUENCE_KINDS[ev.surface].includes(f.subject.sequenceKind)) {
      return no('no_marketing_basis', 'sequence_not_in_scenario')
    }
    if (!storedNoticeMatchesRegistry(ev) || NOTICE_VERSIONS[ev.noticeVersion as string].basis !== 'notice') {
      return no('no_marketing_basis', 'unregistered_notice')
    }
    if (ev.occurredAt.getTime() < NOTICE_POLICY_START.getTime()) return no('no_marketing_basis', 'pre_policy_notice')
    if (ev.regionSignal === 'non_nanp') return no('no_marketing_basis', 'non_nanp')
    if (f.now.getTime() - ev.occurredAt.getTime() > NOTICE_BASIS_DAYS * DAY_MS) return no('notice_expired')
    return { eligible: true, basis: 'notice', basisEventId: ev.id }
  }

  if (f.context === 'campaign' && f.latestNotice) {
    if (!f.flags.noticeBasisEnabled) return no('notice_basis_disabled')
    const ev = f.latestNotice
    const problem = storedNoticeProblem(ev, f)
    if (problem) return problem
    return { eligible: true, basis: 'notice', basisEventId: ev.id }
  }

  if (f.context === 'post_move' && f.flags.ebrBasisEnabled && f.ebrAt) {
    const age = f.now.getTime() - f.ebrAt.getTime()
    if (age >= 0 && age <= EBR_BASIS_DAYS * DAY_MS) return { eligible: true, basis: 'ebr', basisEventId: null }
  }

  return no('no_marketing_basis')
}

/** Why a stored notice event cannot be a basis today, or null when it can. */
function storedNoticeProblem(ev: BasisEventFact, f: EligibilityFacts): EligibilityDecision | null {
  if (ev.kind !== 'notice_accepted') return no('no_marketing_basis', 'basis_event_not_a_notice')
  if (ev.emailNormalized !== f.emailNormalized) return no('basis_email_mismatch')
  if (!isNoticeSurface(ev.surface)) return no('no_marketing_basis', 'unknown_surface')
  if (!storedNoticeMatchesRegistry(ev) || NOTICE_VERSIONS[ev.noticeVersion as string].basis !== 'notice') {
    return no('no_marketing_basis', 'unregistered_notice')
  }
  if (ev.occurredAt.getTime() < NOTICE_POLICY_START.getTime()) return no('no_marketing_basis', 'pre_policy_notice')
  if (ev.regionSignal === 'non_nanp') return no('no_marketing_basis', 'non_nanp')
  if (f.now.getTime() - ev.occurredAt.getTime() > NOTICE_BASIS_DAYS * DAY_MS) return no('notice_expired')
  return null
}

/** The event columns a basis decision reads. */
export const BASIS_EVENT_SELECT = {
  id: true,
  emailNormalized: true,
  kind: true,
  surface: true,
  occurredAt: true,
  regionSignal: true,
  noticeVersion: true,
  noticeCopySha256: true,
  locale: true,
} as const

// ── THE LOADER ──────────────────────────────────────────────────────────────

export type EligibilityDb = Pick<
  PrismaClient,
  'emailSuppression' | 'customer' | 'lead' | 'booking' | 'emailMarketingStatus' | 'emailConsentEvent' | 'user' | 'crewInvitation'
>

export type EligibilityDeps = {
  db?: EligibilityDb
  env?: Record<string, string | undefined>
  /** Defaults to testIdentityReason() with staff loaded from `db`. */
  testIdentity?: (email: string) => Promise<TestIdentityReason | null>
}

export type EligibilityRequest = {
  context: EligibilityContext
  /** The address the email would be sent to. */
  email: string
  subject?: {
    type: EligibilitySubjectType
    /** Lead id, booking id or customer id. */
    id?: string | null
    /** Required for a notice basis. */
    sequenceKind?: SequenceKind | null
    /**
     * Only used when the subject has no row to read it from (type 'none').
     * For a lead or booking the STORED basisEventId is authoritative.
     */
    basisEventId?: string | null
  }
  now?: Date
}

const insensitive = (email: string) => ({ equals: email, mode: 'insensitive' as const })

/**
 * The two flags this gate reads, read at CALL time (not module load) so a flag
 * flip takes effect without a restart. Both default OFF.
 */
export function eligibilityFlags(env: Record<string, string | undefined> = process.env): EligibilityFacts['flags'] {
  return {
    noticeBasisEnabled: env.EMAIL_NOTICE_BASIS_ENABLED === 'true',
    ebrBasisEnabled: env.EMAIL_EBR_BASIS_ENABLED === 'true',
  }
}

/**
 * Gather the facts and decide. The ONLY entry point for send-time and
 * enrollment-time promotional checks in new code. Never throws.
 */
export async function promotionalEligibility(req: EligibilityRequest, deps: EligibilityDeps = {}): Promise<EligibilityDecision> {
  const db = deps.db ?? prisma
  const flags = eligibilityFlags(deps.env)
  const now = req.now ?? new Date()
  const email = normalizeEmail(req.email)
  if (!isPlausibleEmail(email)) return no('invalid_email')
  const subjectIn = req.subject ?? { type: 'none' as const }

  try {
    const loadStaff = async (): Promise<StaffEmails> => {
      const [users, invitations] = await Promise.all([
        db.user.findMany({ select: { email: true } }),
        db.crewInvitation.findMany({ select: { email: true } }),
      ])
      return { staff: users.map((u) => u.email), invitations: invitations.map((i) => i.email) }
    }
    const identityOf = deps.testIdentity ?? ((e: string) => testIdentityReason(e, { env: deps.env, loadStaffEmails: loadStaff }))

    const [suppression, customers, leads, status, identity] = await Promise.all([
      db.emailSuppression.findUnique({ where: { email }, select: { reason: true, scope: true } }),
      db.customer.findMany({
        where: { email: insensitive(email) },
        select: { id: true, emailMarketingConsent: true, marketingConsentAt: true, marketingOptOut: true },
      }),
      db.lead.findMany({
        where: { email: insensitive(email) },
        select: { id: true, emailMarketingConsent: true, marketingConsentAt: true },
      }),
      db.emailMarketingStatus.findUnique({ where: { emailNormalized: email } }),
      identityOf(email),
    ])

    //  The subject's own row: its stored basis, and which consent row is "its own".
    let basisEventId: string | null = null
    let subjectLeadId: string | null = null
    let subjectCustomerId: string | null = null
    const subjectId = typeof subjectIn.id === 'string' && subjectIn.id.trim() ? subjectIn.id.trim() : null
    if (subjectIn.type === 'lead' && subjectId) {
      const lead = await db.lead.findUnique({ where: { id: subjectId }, select: { id: true, basisEventId: true } })
      subjectLeadId = lead?.id ?? null
      basisEventId = lead?.basisEventId ?? null
    } else if (subjectIn.type === 'booking' && subjectId) {
      const booking = await db.booking.findUnique({
        where: { id: subjectId },
        select: { id: true, customerId: true, basisEventId: true },
      })
      subjectCustomerId = booking?.customerId ?? null
      basisEventId = booking?.basisEventId ?? null
    } else if (subjectIn.type === 'customer' && subjectId) {
      subjectCustomerId = subjectId
    } else if (subjectIn.type === 'none') {
      basisEventId = subjectIn.basisEventId ?? null
    }

    const basisEvent = basisEventId
      ? await db.emailConsentEvent.findUnique({ where: { id: basisEventId }, select: BASIS_EVENT_SELECT })
      : null

    //  Campaigns: the person's latest form submission (rule 8).
    const latestNotice =
      req.context === 'campaign' && status?.lastNoticeEventId
        ? await db.emailConsentEvent.findUnique({ where: { id: status.lastNoticeEventId }, select: BASIS_EVENT_SELECT })
        : null

    let ebrAt: Date | null = null
    if (req.context === 'post_move' && flags.ebrBasisEnabled) {
      const bookings = await db.booking.findMany({
        where: {
          customer: { email: insensitive(email) },
          isInternalTest: false,
          OR: [{ depositPaid: true }, { status: 'COMPLETED' }],
        },
        select: { createdAt: true, completedAt: true },
        take: 50,
      })
      for (const b of bookings) {
        const at = b.completedAt ?? b.createdAt
        if (!ebrAt || at.getTime() > ebrAt.getTime()) ebrAt = at
      }
    }

    const legacyConsent: LegacyConsentFact[] = []
    for (const l of leads) {
      if (typeof l.emailMarketingConsent !== 'boolean') continue
      legacyConsent.push({ record: 'lead', id: l.id, value: l.emailMarketingConsent, at: l.marketingConsentAt ?? null, isSubject: l.id === subjectLeadId })
    }
    for (const c of customers) {
      if (typeof c.emailMarketingConsent !== 'boolean') continue
      legacyConsent.push({ record: 'customer', id: c.id, value: c.emailMarketingConsent, at: c.marketingConsentAt ?? null, isSubject: c.id === subjectCustomerId })
    }

    return decidePromotionalEligibility({
      context: req.context,
      now,
      emailNormalized: email,
      suppression: suppression ? { reason: String(suppression.reason), scope: suppression.scope } : null,
      customerMarketingOptOut: customers.some((c) => c.marketingOptOut === true),
      status: status
        ? {
            expressOptInAt: status.expressOptInAt,
            expressEventId: status.expressEventId,
            optedOutAt: status.optedOutAt,
            declinedAt: status.declinedAt,
          }
        : null,
      legacyConsent,
      testIdentity: identity,
      subject: {
        type: subjectIn.type,
        id: subjectId,
        sequenceKind: subjectIn.sequenceKind ?? null,
        basisEventId,
      },
      basisEvent,
      latestNotice,
      ebrAt,
      flags,
    })
  } catch (err) {
    return no('eligibility_read_failed', String(err instanceof Error ? err.message : err).slice(0, 120))
  }
}
