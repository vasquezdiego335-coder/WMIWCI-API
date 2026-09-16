// ════════════════════════════════════════════════════════════════════════
//  CONSENT EVENTS — the append-only record of what a person was shown and
//  what they did (email consent release 2026-09-16, DESIGN-v2 §2).
//  ---------------------------------------------------------------------
//  email_consent_events is the SOURCE OF TRUTH. email_marketing_status is its
//  per-person summary and is written IN THE SAME TRANSACTION as every event,
//  so the two can never disagree about a committed fact.
//
//  FORWARD-ONLY. Each status timestamp is written with a conditional update
//  (`WHERE column IS NULL OR column < :at`). PostgreSQL re-evaluates that
//  condition after taking the row lock, so two concurrent events for the same
//  person cannot move a timestamp backwards, and a replayed or late event can
//  never un-withdraw anyone.
//
//  IDEMPOTENT PER REQUEST. UNIQUE (request_id, kind): a retried request, a
//  double click that reuses the id, or a beacon replay records once and
//  returns the original event with created:false.
//
//  WITHDRAWALS STOP SEQUENCES IN THE SAME TRANSACTION. opted_out_at_capture,
//  declined_at_capture and unsubscribed mark the person's active enrollments
//  stopped before the event commits; the stopped rows are returned so the
//  caller can cancel queued jobs (an optimisation — the send-time gate is the
//  enforcement).
//
//  WHAT THIS NEVER DOES: set emailMarketingConsent on a Lead or Customer, touch
//  a suppression row, or trust a notice the registry does not know.
//  Never throws: every failure is a result the caller can log and move past,
//  because saving the customer's lead must not depend on this.
// ════════════════════════════════════════════════════════════════════════

import type { Prisma, PrismaClient } from '@prisma/client'
import { prisma } from '../db'
import { normalizeEmail } from '../email-tokens'
import { NOTICE_VERSIONS, storedNoticeMatchesRegistry } from './notice-registry'
import { stopActiveEnrollments, type EnrollmentRef } from './sequence-enrollment'

/** Kept in step with the CHECK constraint in 20260916120000_email_consent_enrollment. */
export const CONSENT_EVENT_KINDS = [
  'notice_accepted',
  'express_opt_in',
  'opted_out_at_capture',
  'declined_at_capture',
  'unsubscribed',
  'resubscribed',
  'basis_withheld',
] as const
export type ConsentEventKind = (typeof CONSENT_EVENT_KINDS)[number]

/**
 * Capture-time grants. These are what the per-IP and global throttles count.
 * Every form — the popup included — records a notice; nothing a form submits
 * is ever recorded as an opt-in (owner direction 2026-09-16).
 */
export const GRANT_EVENT_KINDS: readonly ConsentEventKind[] = ['notice_accepted']

/** Events that withdraw permission and stop the person's active sequences. */
export const WITHDRAWAL_EVENT_KINDS: readonly ConsentEventKind[] = ['opted_out_at_capture', 'declined_at_capture', 'unsubscribed']

export const REGION_SIGNALS = ['nanp', 'non_nanp', 'unknown'] as const
export type RegionSignal = (typeof REGION_SIGNALS)[number]

export type ConsentEventsDb = Pick<PrismaClient, 'emailConsentEvent' | 'emailMarketingStatus' | 'sequenceEnrollment' | '$transaction'>
export type ConsentStatusReadDb = Pick<PrismaClient, 'emailMarketingStatus'> | Prisma.TransactionClient

export type ConsentEventInput = {
  /** Any spelling; stored as normalizeEmail(email). */
  email: string
  kind: ConsentEventKind
  /** DERIVED BY THE ROUTE ('quote' | 'booking' | 'contact' | 'tracker' | 'popup' | 'unsubscribe' | …). */
  surface: string
  /** Unique per request. With `kind`, the idempotency key. */
  requestId: string
  leadId?: string | null
  customerId?: string | null
  bookingId?: string | null
  /** Required for notice_accepted (a resolveNotice() result). */
  noticeVersion?: string | null
  noticeCopySha256?: string | null
  locale?: string | null
  regionSignal?: RegionSignal | null
  trigger?: string | null
  emailUserTyped?: boolean | null
  optOutBox?: boolean | null
  turnstileOk?: boolean | null
  /** Required for basis_withheld. */
  withheldReason?: string | null
  /** Any URL; only origin + path are stored. */
  pageUrl?: string | null
  ipHmac?: string | null
  uaHash?: string | null
  /** Defaults to now. Also the time written into email_marketing_status. */
  occurredAt?: Date
}

export type ConsentEventRecord = {
  id: string
  emailNormalized: string
  kind: string
  surface: string
  noticeVersion: string | null
  noticeCopySha256: string | null
  locale: string | null
  regionSignal: string | null
  requestId: string
  occurredAt: Date
}

export type RecordConsentEventResult =
  | {
      ok: true
      /** false when this (requestId, kind) was already recorded: the original is returned. */
      created: boolean
      event: ConsentEventRecord
      /** Enrollments this withdrawal stopped (empty for other kinds, or on a replay). */
      stoppedEnrollments: EnrollmentRef[]
    }
  | {
      ok: false
      reason: 'invalid_email' | 'invalid_input' | 'unregistered_notice' | 'opt_out_box_ticked' | 'db_error'
      detail?: string
    }

export type MarketingStatus = {
  emailNormalized: string
  expressOptInAt: Date | null
  expressEventId: string | null
  optedOutAt: Date | null
  declinedAt: Date | null
  lastNoticeAt: Date | null
  lastNoticeEventId: string | null
  updatedAt: Date
}

const clip = (v: string | null | undefined, max: number): string | null => {
  if (v === null || v === undefined) return null
  const t = String(v).trim()
  return t ? t.slice(0, max) : null
}

/** An address shape check: one '@', something on both sides. */
export function isPlausibleEmail(email: string): boolean {
  const at = email.indexOf('@')
  return at > 0 && at === email.lastIndexOf('@') && at < email.length - 1 && !/\s/.test(email)
}

/**
 * Origin + path only. A query string or fragment can carry a name, an email or
 * a token (the quote handoff puts contact details in the URL), so it is never
 * stored. Anything that does not parse as http(s) is dropped.
 */
export function sanitizePageUrl(url: string | null | undefined): string | null {
  if (!url || typeof url !== 'string') return null
  try {
    const u = new URL(url.trim())
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    return `${u.origin}${u.pathname}`.slice(0, 500)
  } catch {
    return null
  }
}

const isUniqueViolation = (err: unknown): boolean =>
  Boolean(err && typeof err === 'object' && (err as { code?: unknown }).code === 'P2002')

const EVENT_SELECT = {
  id: true,
  emailNormalized: true,
  kind: true,
  surface: true,
  noticeVersion: true,
  noticeCopySha256: true,
  locale: true,
  regionSignal: true,
  requestId: true,
  occurredAt: true,
} as const

/** Which status columns an event kind moves forward. */
function statusFieldsFor(kind: ConsentEventKind): { at: 'expressOptInAt' | 'optedOutAt' | 'declinedAt' | 'lastNoticeAt'; eventId?: 'expressEventId' | 'lastNoticeEventId' } | null {
  switch (kind) {
    case 'express_opt_in':
      return { at: 'expressOptInAt', eventId: 'expressEventId' }
    case 'opted_out_at_capture':
    case 'unsubscribed':
      return { at: 'optedOutAt' }
    case 'declined_at_capture':
      return { at: 'declinedAt' }
    case 'notice_accepted':
      return { at: 'lastNoticeAt', eventId: 'lastNoticeEventId' }
    default:
      // resubscribed, basis_withheld: evidence only. A resubscribe is recorded
      // with its own express_opt_in event by the resubscribe flow.
      return null
  }
}

/** Validate an input. Returns an error result, or null when it may be written. */
function validate(input: ConsentEventInput, email: string): Extract<RecordConsentEventResult, { ok: false }> | null {
  if (!isPlausibleEmail(email)) return { ok: false, reason: 'invalid_email' }
  if (!(CONSENT_EVENT_KINDS as readonly string[]).includes(input.kind)) {
    return { ok: false, reason: 'invalid_input', detail: 'unknown kind' }
  }
  if (!input.surface || !/^[a-z][a-z0-9_]{0,39}$/.test(input.surface)) {
    return { ok: false, reason: 'invalid_input', detail: 'surface must be a route-derived snake_case id' }
  }
  if (!clip(input.requestId, 200)) return { ok: false, reason: 'invalid_input', detail: 'requestId is required' }
  if (input.regionSignal != null && !(REGION_SIGNALS as readonly string[]).includes(input.regionSignal)) {
    return { ok: false, reason: 'invalid_input', detail: 'unknown region signal' }
  }
  if (input.kind === 'basis_withheld' && !clip(input.withheldReason, 80)) {
    return { ok: false, reason: 'invalid_input', detail: 'basis_withheld needs a withheldReason' }
  }
  if (input.kind === 'notice_accepted') {
    //  Defence in depth behind resolveNotice(): a grant event may only describe
    //  registered copy, for this surface and locale, with the registered hash,
    //  and of the right basis. A notice can never be accepted with the opt-out
    //  box ticked — that submission is a withdrawal, not a grant.
    const stored = {
      noticeVersion: input.noticeVersion ?? null,
      noticeCopySha256: input.noticeCopySha256 ?? null,
      locale: input.locale ?? null,
      surface: input.surface,
    }
    if (!storedNoticeMatchesRegistry(stored)) return { ok: false, reason: 'unregistered_notice' }
    if (NOTICE_VERSIONS[stored.noticeVersion as string].basis !== 'notice') {
      return { ok: false, reason: 'unregistered_notice', detail: 'version basis is not notice' }
    }
    if (input.optOutBox === true) return { ok: false, reason: 'opt_out_box_ticked' }
  }
  if (input.occurredAt !== undefined && !(input.occurredAt instanceof Date && !Number.isNaN(input.occurredAt.getTime()))) {
    return { ok: false, reason: 'invalid_input', detail: 'occurredAt must be a valid Date' }
  }
  return null
}

/**
 * Record one consent event and move the person's status forward, atomically.
 *
 * Grants (notice_accepted) must already have passed
 * resolveNotice() and evaluateGrantSafeguards(); a refused grant is recorded
 * as kind 'basis_withheld' with the reason instead.
 *
 * NEVER sets consent columns on Lead/Customer and never touches suppressions.
 * Never throws.
 */
export async function recordConsentEvent(input: ConsentEventInput, db: ConsentEventsDb = prisma): Promise<RecordConsentEventResult> {
  const email = normalizeEmail(input.email)
  const invalid = validate(input, email)
  if (invalid) return invalid

  const occurredAt = input.occurredAt ?? new Date()
  const requestId = clip(input.requestId, 200) as string
  const data = {
    emailNormalized: email,
    kind: input.kind,
    surface: input.surface,
    requestId,
    occurredAt,
    leadId: clip(input.leadId, 64),
    customerId: clip(input.customerId, 64),
    bookingId: clip(input.bookingId, 64),
    noticeVersion: clip(input.noticeVersion, 64),
    noticeCopySha256: clip(input.noticeCopySha256, 64),
    locale: clip(input.locale, 10),
    regionSignal: input.regionSignal ?? null,
    trigger: clip(input.trigger, 40),
    emailUserTyped: typeof input.emailUserTyped === 'boolean' ? input.emailUserTyped : null,
    optOutBox: typeof input.optOutBox === 'boolean' ? input.optOutBox : null,
    turnstileOk: typeof input.turnstileOk === 'boolean' ? input.turnstileOk : null,
    withheldReason: clip(input.withheldReason, 80),
    pageUrl: sanitizePageUrl(input.pageUrl),
    ipHmac: clip(input.ipHmac, 128),
    uaHash: clip(input.uaHash, 128),
  }

  try {
    return await db.$transaction(async (tx) => {
      const event = await tx.emailConsentEvent.create({ data, select: EVENT_SELECT })

      const fields = statusFieldsFor(input.kind)
      if (fields) {
        //  ON CONFLICT DO NOTHING: two first events for one person must not
        //  race each other into a unique violation.
        await tx.emailMarketingStatus.createMany({ data: [{ emailNormalized: email }], skipDuplicates: true })
        await tx.emailMarketingStatus.updateMany({
          where: {
            emailNormalized: email,
            OR: [{ [fields.at]: null }, { [fields.at]: { lt: occurredAt } }],
          },
          data: { [fields.at]: occurredAt, ...(fields.eventId ? { [fields.eventId]: event.id } : {}) },
        })
      }

      const stoppedEnrollments = WITHDRAWAL_EVENT_KINDS.includes(input.kind)
        ? await stopActiveEnrollments(tx, email, input.kind)
        : []

      return { ok: true as const, created: true, event, stoppedEnrollments }
    })
  } catch (err) {
    if (isUniqueViolation(err)) {
      //  Already recorded for this request. The transaction rolled back, so the
      //  status is exactly what the ORIGINAL event wrote.
      try {
        const existing = await db.emailConsentEvent.findUnique({
          where: { requestId_kind: { requestId, kind: input.kind } },
          select: EVENT_SELECT,
        })
        if (!existing) return { ok: false, reason: 'db_error', detail: 'unique violation but no existing event' }
        if (existing.emailNormalized !== email) {
          return { ok: false, reason: 'invalid_input', detail: 'requestId already used for a different address' }
        }
        //  A WITHDRAWAL REPEATED AFTER A NEWER OPT-IN. The booking form re-sends
        //  a ticked opt-out on every ping of a session under ONE request id, so
        //  the repeat is a replay of the ORIGINAL withdrawal — dated before a
        //  confirmed opt-in made in between (a token resubscribe)
        //  — and the opt-out the person is still asserting would never take
        //  effect. It is recorded again, once per intervening opt-in, under a
        //  request id derived from that opt-in: bounded, and idempotent for
        //  every later ping. A delayed ping from BEFORE the opt-in changes nothing.
        if (WITHDRAWAL_EVENT_KINDS.includes(input.kind)) {
          const status = await db.emailMarketingStatus.findUnique({ where: { emailNormalized: email } })
          const optIn = status?.expressOptInAt ?? null
          if (optIn && optIn.getTime() > existing.occurredAt.getTime() && occurredAt.getTime() >= optIn.getTime()) {
            const base = requestId.replace(/:after:[^:]*$/, '')
            const after = `:after:${status?.expressEventId ?? optIn.getTime()}`
            return recordConsentEvent({ ...input, occurredAt, requestId: `${base.slice(0, 200 - after.length)}${after}` }, db)
          }
        }
        return { ok: true, created: false, event: existing, stoppedEnrollments: [] }
      } catch (readErr) {
        return { ok: false, reason: 'db_error', detail: String(readErr instanceof Error ? readErr.message : readErr).slice(0, 200) }
      }
    }
    return { ok: false, reason: 'db_error', detail: String(err instanceof Error ? err.message : err).slice(0, 200) }
  }
}

/**
 * The person's status row, or null when no status-moving event exists.
 * THROWS on a database error — "could not read" must never be treated as
 * "no withdrawal on record". Eligibility catches it and fails closed.
 */
export async function readMarketingStatus(email: string, db: ConsentStatusReadDb = prisma): Promise<MarketingStatus | null> {
  const normalized = normalizeEmail(email)
  if (!isPlausibleEmail(normalized)) return null
  return db.emailMarketingStatus.findUnique({ where: { emailNormalized: normalized } })
}

/** One event by id (a Lead/Booking basisEventId). THROWS on a database error. */
export async function readConsentEvent(
  id: string,
  db: Pick<PrismaClient, 'emailConsentEvent'> | Prisma.TransactionClient = prisma,
): Promise<ConsentEventRecord | null> {
  if (!id || typeof id !== 'string') return null
  return db.emailConsentEvent.findUnique({ where: { id }, select: EVENT_SELECT })
}
