import { randomUUID } from 'crypto'
import type { Prisma, PrismaClient } from '@prisma/client'
import { prisma } from './client'
import { EventType, EmailJob, EmailJobPayload } from '../domain/events'
import { BookingState } from '../domain/booking-states'

// Works with the base client and an interactive-transaction client alike.
type Db = PrismaClient | Prisma.TransactionClient

const DEFAULT_MAX_ATTEMPTS = 5
const MAX_BACKOFF_MS = 60 * 60 * 1000 // 1 hour cap

export const idempotencyKeyFor = (bookingId: string, eventType: EventType | string): string =>
  `${bookingId}::${eventType}`

// ── Booking outbox-state helpers (raw SQL → no dependency on the generated
//    Prisma model types; only requires the bookings.outbox_state column). ──

/** Read + row-lock a booking's outbox state inside a transaction.
 *  Returns `undefined` if the booking row does not exist, `null` if it exists
 *  but its outbox_state has never been set. */
export async function readBookingOutboxState(
  tx: Db,
  bookingId: string
): Promise<BookingState | null | undefined> {
  const rows = await tx.$queryRaw<{ outbox_state: string | null }[]>`
    SELECT outbox_state FROM bookings WHERE id = ${bookingId} FOR UPDATE
  `
  if (rows.length === 0) return undefined
  return (rows[0].outbox_state as BookingState | null) ?? null
}

/** Persist a new outbox state on the booking row. */
export async function writeBookingOutboxState(
  tx: Db,
  bookingId: string,
  state: BookingState
): Promise<void> {
  await tx.$executeRaw`
    UPDATE bookings
       SET outbox_state = ${state}::"BookingState", updated_at = now()
     WHERE id = ${bookingId}
  `
}

// ── email_jobs outbox table ───────────────────────────────────────────────

/**
 * Insert one outbox row, ON CONFLICT DO NOTHING on the unique idempotency_key.
 * Call inside the same transaction that updates the booking state so the event
 * is committed atomically. Returns whether a row was actually inserted
 * (false = the event already existed → no duplicate).
 */
export async function saveEmailJob(
  db: Db,
  params: {
    bookingId: string
    eventType: EventType
    payload: EmailJobPayload
    maxAttempts?: number
  }
): Promise<{ inserted: boolean; idempotencyKey: string }> {
  const idempotencyKey = idempotencyKeyFor(params.bookingId, params.eventType)
  const maxAttempts = params.maxAttempts ?? DEFAULT_MAX_ATTEMPTS

  const affected = await db.$executeRaw`
    INSERT INTO email_jobs
      (id, booking_id, event_type, idempotency_key, payload,
       status, attempts, max_attempts, next_attempt_at, created_at, updated_at)
    VALUES
      (${randomUUID()}, ${params.bookingId}, ${params.eventType}, ${idempotencyKey},
       ${JSON.stringify(params.payload)}::jsonb,
       'pending', 0, ${maxAttempts}, now(), now(), now())
    ON CONFLICT (idempotency_key) DO NOTHING
  `
  return { inserted: affected === 1, idempotencyKey }
}

/**
 * Atomically CLAIM up to `limit` due jobs: flip pending -> processing and bump
 * attempts in a single statement. FOR UPDATE SKIP LOCKED means concurrent
 * workers never grab the same row — the worker is safe to run many times.
 */
export async function fetchPendingJobs(limit = 20): Promise<EmailJob[]> {
  // `attempts < max_attempts`: a row that has used its budget must never be
  // claimed again — reapStaleProcessingJobs closes those as 'failed' instead.
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    UPDATE email_jobs
       SET status = 'processing', attempts = attempts + 1, updated_at = now()
     WHERE id IN (
       SELECT id FROM email_jobs
        WHERE status = 'pending' AND next_attempt_at <= now() AND attempts < max_attempts
        ORDER BY created_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
     )
    RETURNING id, booking_id, event_type, idempotency_key, payload,
              status, attempts, max_attempts, next_attempt_at, created_at
  `
  return rows.map(mapRow)
}

// ── Terminal and retry outcomes ───────────────────────────────────────────
//  `status` is plain TEXT (no CHECK constraint, prisma/baseline/00_init.sql),
//  and only this module reads or writes it, so the truthful values below need
//  no migration:
//    sent       the provider accepted the email (or already had, for this key)
//    skipped    a TERMINAL policy refusal — no email was sent, none will be
//    failed     attempts exhausted, OR an ambiguous provider outcome (last_error
//               says which) — never re-claimed, surfaced for a human
//    pending    waiting for its next attempt (including deliberate HOLDS)
//  Every update is guarded by `status = 'processing' AND attempts = <the
//  claim's attempts>`: it only lands on THE CLAIM IT CAME FROM. A slow worker
//  whose row was reaped and re-claimed by another drain (attempts moved on)
//  can no longer overwrite that newer claim.

/** The claim an update belongs to. */
export type JobClaim = Pick<EmailJob, 'id' | 'attempts'>

/** The provider accepted the email. */
export async function markJobSent(job: JobClaim, note?: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE email_jobs SET status = 'sent', last_error = ${note ?? null}, updated_at = now()
     WHERE id = ${job.id} AND status = 'processing' AND attempts = ${job.attempts}
  `
}

/** A terminal policy refusal: nothing was sent and nothing will be. */
export async function markJobSkipped(job: JobClaim, reason: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE email_jobs
       SET status = 'skipped', last_error = ${`skipped:${reason}`.slice(0, 1000)}, updated_at = now()
     WHERE id = ${job.id} AND status = 'processing' AND attempts = ${job.attempts}
  `
}

/**
 * Closed WITHOUT a retry because retrying could duplicate (ambiguous) or has
 * nothing left to try (attempts exhausted in the send ledger).
 */
export async function markJobTerminalFailure(job: JobClaim, reason: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE email_jobs
       SET status = 'failed', last_error = ${reason.slice(0, 1000)}, updated_at = now()
     WHERE id = ${job.id} AND status = 'processing' AND attempts = ${job.attempts}
  `
}

/**
 * A HOLD (kill switch, dry run): back to pending at `retryAt`, and the attempt
 * the claim just consumed is given back — waiting on an operator must not
 * exhaust the retry budget.
 */
export async function markJobDeferred(job: EmailJob, reason: string, retryAt: Date): Promise<void> {
  await prisma.$executeRaw`
    UPDATE email_jobs
       SET status = 'pending',
           attempts = GREATEST(attempts - 1, 0),
           last_error = ${`held:${reason}`.slice(0, 1000)},
           next_attempt_at = ${retryAt},
           updated_at = now()
     WHERE id = ${job.id} AND status = 'processing' AND attempts = ${job.attempts}
  `
}

/** PURE: when a failed attempt may be retried. Honours a provider/guard due time. */
export function nextAttemptAfterFailure(attempts: number, notBefore: Date | null | undefined, now = Date.now()): Date {
  const backoffMs = Math.min(2 ** attempts * 1000, MAX_BACKOFF_MS)
  const backoffAt = now + backoffMs
  const due = notBefore && Number.isFinite(notBefore.getTime()) ? Math.max(backoffAt, notBefore.getTime()) : backoffAt
  return new Date(due)
}

/**
 * Record a failed attempt. Below maxAttempts the job returns to 'pending' with
 * an exponential-backoff next_attempt_at (never earlier than `notBefore`, the
 * send ledger's own due time); at the cap it becomes terminal 'failed'.
 */
export async function markJobFailed(job: EmailJob, error: string, notBefore?: Date | null): Promise<void> {
  const nextAttemptAt = nextAttemptAfterFailure(job.attempts, notBefore)

  // Final-or-not is decided from the ROW, not the in-memory copy.
  await prisma.$executeRaw`
    UPDATE email_jobs
       SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending' END,
           last_error = ${error.slice(0, 1000)},
           next_attempt_at = ${nextAttemptAt},
           updated_at = now()
     WHERE id = ${job.id} AND status = 'processing' AND attempts = ${job.attempts}
  `
}

/**
 * Recover jobs stuck in 'processing' — a worker that claimed a job and then
 * crashed before resolving it would otherwise orphan it forever
 * (fetchPendingJobs only claims 'pending'). Rows with attempts left return to
 * 'pending'; a row that crashed on its FINAL attempt is closed as 'failed' so
 * it cannot loop forever, and so is a row left 'pending' with no attempts left
 * (the pre-2026-09-15 reaper re-pended final-attempt crashes), which
 * fetchPendingJobs would otherwise never touch again.
 *
 * A re-claimed row re-enters guardedSend. A send that is still live answers
 * 'in_flight' (the outbox waits out the stale window); one whose worker died
 * mid-send is closed by the guard as 'ambiguous' and never re-sent; one that
 * finished answers 'duplicate'. Returns how many rows were recovered.
 */
export async function reapStaleProcessingJobs(staleMs = 5 * 60 * 1000): Promise<number> {
  const cutoff = new Date(Date.now() - staleMs)
  const closed = await prisma.$executeRaw`
    UPDATE email_jobs
       SET status = 'failed',
           last_error = 'stale processing on final attempt — worker died mid-send; check email_sends before any manual retry',
           updated_at = now()
     WHERE status = 'processing' AND updated_at < ${cutoff} AND attempts >= max_attempts
  `
  const requeued = await prisma.$executeRaw`
    UPDATE email_jobs
       SET status = 'pending', updated_at = now()
     WHERE status = 'processing' AND updated_at < ${cutoff} AND attempts < max_attempts
  `
  const exhausted = await prisma.$executeRaw`
    UPDATE email_jobs
       SET status = 'failed',
           last_error = 'attempts exhausted while pending (stale re-claim or legacy reaper) — check email_sends before any manual retry',
           updated_at = now()
     WHERE status = 'pending' AND attempts >= max_attempts
  `
  if (closed + exhausted > 0) {
    console.warn(
      `[outbox] reaper closed ${closed + exhausted} job(s) as failed (${closed} stale on the final attempt, ${exhausted} pending with no attempts left) — check email_sends before any manual retry`
    )
  }
  return closed + requeued + exhausted
}

/** True if the (booking, event) pair was already recorded in the outbox. */
export async function isEventAlreadyProcessed(
  bookingId: string,
  eventType: EventType
): Promise<boolean> {
  const key = idempotencyKeyFor(bookingId, eventType)
  const rows = await prisma.$queryRaw<{ exists: boolean }[]>`
    SELECT EXISTS(SELECT 1 FROM email_jobs WHERE idempotency_key = ${key}) AS "exists"
  `
  return rows[0]?.exists === true
}

function mapRow(r: Record<string, unknown>): EmailJob {
  return {
    id: String(r.id),
    bookingId: String(r.booking_id),
    eventType: r.event_type as EventType,
    idempotencyKey: String(r.idempotency_key),
    payload: r.payload as EmailJob['payload'],
    status: r.status as EmailJob['status'],
    attempts: Number(r.attempts),
    maxAttempts: Number(r.max_attempts),
    nextAttemptAt: new Date(r.next_attempt_at as string),
    createdAt: new Date(r.created_at as string),
  }
}
