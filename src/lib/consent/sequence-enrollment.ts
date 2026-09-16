// ════════════════════════════════════════════════════════════════════════
//  SCENARIO SEQUENCE ENROLLMENT — one sequence per person, per kind, per
//  30-day window (email consent release 2026-09-16, DESIGN-v2 §2 and §7).
//  ---------------------------------------------------------------------
//  THE DEFECT THIS REPLACES. Every journey was keyed per LEAD: BullMQ job ids
//  and guard keys named the lead id, and "is this person already in a
//  sequence?" was a read followed by a write. Two submissions for one address
//  (a double click, a quote then a contact message, two open leads) each passed
//  the read before either wrote, and the person got two sequences.
//
//  THE INVARIANT is a database constraint, not a check:
//    UNIQUE (email_normalized, sequence_kind, window_start)
//  The insert either creates the row or fails, and the loser reports
//  'already_enrolled'. window_start is the first day of a fixed 30-day bucket;
//  a read of the last 30 days covers the edge where two enrollments straddle a
//  bucket boundary.
//
//  STOPPING. stopEnrollmentsForPerson() marks a person's active enrollments
//  stopped (an opt-out, a decline, an unsubscribe, a booking). Cancelling the
//  queued jobs is the CALLER's optimisation; the real stop is enforced at send
//  time by the eligibility gate and personBookedSince(), because a job removal
//  can miss an active job or hit a Redis error.
// ════════════════════════════════════════════════════════════════════════

import type { Prisma, PrismaClient } from '@prisma/client'
import { prisma } from '../db'
import { normalizeEmail } from '../email-tokens'
import { isSequenceKind, type SequenceKind } from './notice-registry'

const DAY_MS = 24 * 60 * 60 * 1000

/** Length of an enrollment window, and of the per-person re-enrollment gap. */
export const ENROLLMENT_WINDOW_DAYS = 30

/** Buckets are anchored here (the release day, UTC) so they never move. */
const WINDOW_ANCHOR_MS = Date.UTC(2026, 8, 16)

export const ENROLLMENT_SUBJECT_TYPES = ['lead', 'booking', 'customer', 'email'] as const
export type EnrollmentSubjectType = (typeof ENROLLMENT_SUBJECT_TYPES)[number]

export type EnrollmentStatus = 'active' | 'stopped' | 'completed'

/** The Prisma surface this module uses — a PrismaClient or a transaction client. */
export type EnrollmentDb = Pick<PrismaClient, 'sequenceEnrollment'> | Prisma.TransactionClient
export type BookingHistoryDb = Pick<PrismaClient, 'booking'> | Prisma.TransactionClient

export type EnrollmentRecord = {
  id: string
  emailNormalized: string
  sequenceKind: string
  subjectType: string
  subjectId: string
  basisEventId: string | null
  windowStart: Date
  status: string
  stopReason: string | null
  createdAt: Date
  updatedAt: Date
}

export type EnrollmentRef = Pick<EnrollmentRecord, 'id' | 'sequenceKind' | 'subjectType' | 'subjectId'>

/** First day (UTC midnight) of the fixed 30-day bucket containing `now`. */
export function windowStartFor(now: Date): Date {
  const size = ENROLLMENT_WINDOW_DAYS * DAY_MS
  const index = Math.floor((now.getTime() - WINDOW_ANCHOR_MS) / size)
  return new Date(WINDOW_ANCHOR_MS + index * size)
}

const isUniqueViolation = (err: unknown): boolean =>
  Boolean(err && typeof err === 'object' && (err as { code?: unknown }).code === 'P2002')

const validEmail = (email: string): boolean => {
  const at = email.indexOf('@')
  return at > 0 && at === email.lastIndexOf('@') && at < email.length - 1
}

export type EnrollSequenceInput = {
  email: string
  sequenceKind: SequenceKind
  subjectType: EnrollmentSubjectType
  subjectId: string
  /** The event the sequence runs under; null for legacy express consent. */
  basisEventId: string | null
  now?: Date
}

export type EnrollSequenceResult =
  | { outcome: 'created'; enrollment: EnrollmentRecord }
  /** A sequence of this kind already exists for the person inside the window. */
  | { outcome: 'already_enrolled'; enrollment: EnrollmentRecord | null }
  | { outcome: 'refused'; reason: 'invalid_email' | 'invalid_kind' | 'invalid_subject' }
  /** The database could not be read or written. Do NOT schedule the sequence. */
  | { outcome: 'error'; reason: 'db_error'; detail: string }

/**
 * Enroll a person in a scenario sequence, idempotently.
 *
 * Only 'created' means "schedule the sequence". Every other outcome means do
 * not — including 'error', because a sequence scheduled without its row is a
 * sequence no stop rule can find.
 *
 * Call it only AFTER the eligibility gate and the grant safeguards have passed.
 * It does not re-check consent; it guarantees uniqueness.
 */
export async function enrollSequence(input: EnrollSequenceInput, db: EnrollmentDb = prisma): Promise<EnrollSequenceResult> {
  const email = normalizeEmail(input.email)
  if (!validEmail(email)) return { outcome: 'refused', reason: 'invalid_email' }
  if (!isSequenceKind(input.sequenceKind)) return { outcome: 'refused', reason: 'invalid_kind' }
  if (!(ENROLLMENT_SUBJECT_TYPES as readonly string[]).includes(input.subjectType) || !String(input.subjectId ?? '').trim()) {
    return { outcome: 'refused', reason: 'invalid_subject' }
  }
  const now = input.now ?? new Date()
  const windowStart = windowStartFor(now)

  try {
    //  Across a bucket boundary the unique key differs, so the last 30 days are
    //  read first. The unique insert below remains the race-proof guarantee.
    const recent = await db.sequenceEnrollment.findFirst({
      where: {
        emailNormalized: email,
        sequenceKind: input.sequenceKind,
        createdAt: { gte: new Date(now.getTime() - ENROLLMENT_WINDOW_DAYS * DAY_MS) },
      },
      orderBy: { createdAt: 'desc' },
    })
    if (recent) return { outcome: 'already_enrolled', enrollment: recent }

    const enrollment = await db.sequenceEnrollment.create({
      data: {
        emailNormalized: email,
        sequenceKind: input.sequenceKind,
        subjectType: input.subjectType,
        subjectId: String(input.subjectId).trim(),
        basisEventId: input.basisEventId ?? null,
        windowStart,
        status: 'active',
        //  The same clock as the window and the 30-day read, so an injected
        //  `now` is coherent end to end.
        createdAt: now,
      },
    })
    return { outcome: 'created', enrollment }
  } catch (err) {
    if (isUniqueViolation(err)) {
      try {
        const existing = await db.sequenceEnrollment.findUnique({
          where: {
            emailNormalized_sequenceKind_windowStart: {
              emailNormalized: email,
              sequenceKind: input.sequenceKind,
              windowStart,
            },
          },
        })
        return { outcome: 'already_enrolled', enrollment: existing }
      } catch {
        return { outcome: 'already_enrolled', enrollment: null }
      }
    }
    return { outcome: 'error', reason: 'db_error', detail: String(err instanceof Error ? err.message : err).slice(0, 200) }
  }
}

/**
 * Stop every ACTIVE enrollment for the person. THROWS on a database error, so
 * it can run inside a caller's transaction (recordConsentEvent uses it that
 * way, so a withdrawal and the stop commit together or not at all).
 */
export async function stopActiveEnrollments(db: EnrollmentDb, email: string, reason: string): Promise<EnrollmentRef[]> {
  const normalized = normalizeEmail(email)
  if (!validEmail(normalized)) return []
  const active = await db.sequenceEnrollment.findMany({
    where: { emailNormalized: normalized, status: 'active' },
    select: { id: true, sequenceKind: true, subjectType: true, subjectId: true },
  })
  if (active.length === 0) return []
  await db.sequenceEnrollment.updateMany({
    //  status: 'active' again in the WHERE, so a row completed or stopped by a
    //  concurrent writer keeps its own reason.
    where: { id: { in: active.map((a) => a.id) }, status: 'active' },
    data: { status: 'stopped', stopReason: String(reason).slice(0, 80) },
  })
  return active
}

export type StopEnrollmentsResult = { ok: true; stopped: EnrollmentRef[] } | { ok: false; reason: 'db_error'; detail: string }

/**
 * Stop a person's active enrollments (opt-out, decline, unsubscribe, booked).
 * Returns what was stopped so the caller can cancel the queued jobs — which is
 * an optimisation only; the send-time gate is the enforcement.
 */
export async function stopEnrollmentsForPerson(email: string, reason: string, db: EnrollmentDb = prisma): Promise<StopEnrollmentsResult> {
  try {
    return { ok: true, stopped: await stopActiveEnrollments(db, email, reason) }
  } catch (err) {
    return { ok: false, reason: 'db_error', detail: String(err instanceof Error ? err.message : err).slice(0, 200) }
  }
}

/**
 * The person's newest ACTIVE enrollment of this kind, or null.
 * THROWS on a database error: "unknown" must not read as "not enrolled".
 */
export async function activeEnrollment(email: string, kind: SequenceKind, db: EnrollmentDb = prisma): Promise<EnrollmentRecord | null> {
  const normalized = normalizeEmail(email)
  if (!validEmail(normalized) || !isSequenceKind(kind)) return null
  return db.sequenceEnrollment.findFirst({
    where: { emailNormalized: normalized, sequenceKind: kind, status: 'active' },
    orderBy: { createdAt: 'desc' },
  })
}

/**
 * person_booked_since: has this address created a real (non-test) booking
 * after `since` (normally the enrollment's createdAt)?
 *
 * ANY booking counts, including an unpaid PENDING_PAYMENT one: a person who
 * has started checking out is no longer a lead to nurture, and the
 * booking-scoped abandoned-checkout path takes over from there. Internal test
 * bookings never count.
 *
 * FAILS CLOSED: a read error answers true, so an outage stops a nurture email
 * rather than sending "still planning your move?" to someone who booked.
 */
export async function personBookedSince(email: string, since: Date, db: BookingHistoryDb = prisma): Promise<boolean> {
  const normalized = normalizeEmail(email)
  if (!validEmail(normalized)) return false
  try {
    const found = await db.booking.findFirst({
      where: {
        customer: { email: { equals: normalized, mode: 'insensitive' } },
        isInternalTest: false,
        createdAt: { gt: since },
      },
      select: { id: true },
    })
    return Boolean(found)
  } catch {
    return true
  }
}
