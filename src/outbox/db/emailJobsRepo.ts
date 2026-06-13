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
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    UPDATE email_jobs
       SET status = 'processing', attempts = attempts + 1, updated_at = now()
     WHERE id IN (
       SELECT id FROM email_jobs
        WHERE status = 'pending' AND next_attempt_at <= now()
        ORDER BY created_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
     )
    RETURNING id, booking_id, event_type, idempotency_key, payload,
              status, attempts, max_attempts, next_attempt_at, created_at
  `
  return rows.map(mapRow)
}

export async function markJobSent(jobId: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE email_jobs SET status = 'sent', last_error = NULL, updated_at = now() WHERE id = ${jobId}
  `
}

/**
 * Record a failed attempt. Below maxAttempts the job returns to 'pending' with
 * an exponential-backoff next_attempt_at; at the cap it becomes terminal 'failed'.
 */
export async function markJobFailed(job: EmailJob, error: string): Promise<void> {
  const isFinal = job.attempts >= job.maxAttempts
  const backoffMs = Math.min(2 ** job.attempts * 1000, MAX_BACKOFF_MS)
  const nextAttemptAt = new Date(Date.now() + backoffMs)

  await prisma.$executeRaw`
    UPDATE email_jobs
       SET status = ${isFinal ? 'failed' : 'pending'},
           last_error = ${error.slice(0, 1000)},
           next_attempt_at = ${nextAttemptAt},
           updated_at = now()
     WHERE id = ${job.id}
  `
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
