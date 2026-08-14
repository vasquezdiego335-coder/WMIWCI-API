import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { emailQueue } from '@/lib/queues'
import { apiLogger } from '@/lib/logger'
import { onBookingCompleted } from '@/lib/followups'
import { onBookingCancelled, onBookingConfirmed, onBookingCompletedBalance } from '@/lib/journeys'
import { confirmationScheduleData } from '@/lib/scheduling'
import {
  approveBooking,
  declineBooking,
  isMigrationMissing,
  loadApprovableBooking,
  STATUS_ROUTE_BOOKING_SELECT,
  STATUS_ROUTE_EXTRA_COLUMNS,
  type StatusRouteBooking,
} from '@/lib/booking-approval'
import { ensureJobForBooking } from '@/lib/labor-service'
import { z } from 'zod'

const VALID_TRANSITIONS: Record<string, string[]> = {
  PENDING_APPROVAL: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['SCHEDULED', 'CANCELLED'],
  SCHEDULED: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED'],
  COMPLETED: ['ARCHIVED'],
}

const StatusSchema = z.object({
  status: z.string(),
})

// Deadline guard for queue enqueues (same idiom as notify.ts/journeys.ts):
// BullMQ's .add() awaits connection readiness, which never settles during a
// Redis outage — an un-raced await here HUNG this route indefinitely
// (observed in the release staging rehearsal). The .catch at each call site
// already handles the failure; this makes the failure actually happen.
function withDeadline<T>(p: Promise<T>, ms = 5000): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`queue enqueue timed out after ${ms}ms (Redis?)`)), ms)),
  ])
}

// ── ITEM R3-2 — the response read must not 500 a transition that SUCCEEDED ──
// The gate read above uses an explicit select, but this one returns the whole
// row to the caller, and an unqualified findUnique asks for every column the
// GENERATED client knows about — P2022 during the code-before-SQL window. The
// approval (and its capture) has already happened by the time we get here, so a
// throw would report a false failure and invite a double-approve. Try the full
// row, degrade to the columns that certainly exist.
async function readBookingResponse(id: string): Promise<unknown> {
  try {
    return await prisma.booking.findUnique({ where: { id } })
  } catch (err) {
    if (!isMigrationMissing(err)) throw err
    const { booking } = await loadApprovableBooking<StatusRouteBooking>(
      (select) => prisma.booking.findUnique({ where: { id }, select }),
      STATUS_ROUTE_EXTRA_COLUMNS,
    )
    return booking
  }
}

// ── ITEM R3-2 — the same hole on the WRITE's returned row ────────────────────
// `prisma.booking.update` returns `$scalars` from the GENERATED client exactly
// like an unqualified findUnique does, so during the code-before-SQL window the
// generic transition below (CONFIRMED → SCHEDULED — the item R3-5 staffing
// repair trigger — IN_PROGRESS, COMPLETED, CANCELLED) raised P2022 on the way
// out and 500'd a status change the owner had every right to make.
//
// Retrying is safe: Postgres fails the UPDATE ... RETURNING statement as a unit,
// so nothing was written on the first attempt, and the data is the same literal
// either way. The fallback names its columns explicitly, so it cannot break
// again the next time a column is added.
async function updateBookingStatusRow(id: string, data: Record<string, unknown>): Promise<unknown> {
  try {
    return await prisma.booking.update({ where: { id }, data })
  } catch (err) {
    if (!isMigrationMissing(err)) throw err
    apiLogger.warn({ bookingId: id }, 'booking status write returned a degraded row (unapplied migration) — the status change stands')
    return prisma.booking.update({ where: { id }, data, select: STATUS_ROUTE_BOOKING_SELECT })
  }
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const session = await getSession()
  if (!session || !['OWNER', 'MANAGER'].includes(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // ── ITEM R3-2 — the admin surface died one step BEFORE approveBooking did.
  //    This read was `include: { customer: true }`, which makes Prisma select
  //    `$scalars` from the GENERATED schema — `startTimeKnown` and
  //    `staffingPlan` included. In the normal code-before-SQL deploy window it
  //    raised P2022, so every admin approval 500'd here and no $49 was ever
  //    captured. Explicit columns + the same degraded ladder the approval path
  //    uses: the only thing a missing column costs is the day-level flag, which
  //    scheduling.moveIsDayLevel then infers from the 00:00 ET anchor. ──
  const { booking, degraded, reason } = await loadApprovableBooking<StatusRouteBooking>(
    (select) => prisma.booking.findUnique({ where: { id: params.id }, select }),
    STATUS_ROUTE_EXTRA_COLUMNS,
  )
  if (!booking) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (degraded) {
    apiLogger.warn({ bookingId: params.id, reason }, 'booking status read degraded (unapplied migration) — continuing')
  }

  const body = await req.json()
  const parsed = StatusSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 422 })

  const { status: newStatus } = parsed.data
  const allowed = VALID_TRANSITIONS[booking.status] ?? []
  if (!allowed.includes(newStatus)) {
    return NextResponse.json({ error: `Cannot transition from ${booking.status} to ${newStatus}` }, { status: 422 })
  }

  // ── PENDING_APPROVAL → CONFIRMED goes through the ONE shared approval service
  //    (src/lib/booking-approval.ts). It CAPTURES the $49 hold, records the
  //    Payment, upserts the Job, writes the audit log, and sends the customer
  //    confirmation — byte-identical to the Discord approve path. A bare status
  //    flip here used to skip the capture entirely, so an admin-confirmed
  //    booking could leave the authorization to expire (money lost). ──
  if (booking.status === 'PENDING_APPROVAL' && newStatus === 'CONFIRMED') {
    const result = await approveBooking({
      bookingId: params.id,
      actor: { name: session.name, userId: session.userId, role: session.role },
      source: 'admin',
    })
    if (!result.ok) {
      // ITEM P0-E — 'migration_missing' is a REFUSAL BEFORE the capture: no
      // claim taken, no money moved, and the message names the migration. 503
      // (not 409) so the workspace shows it as "the server can't do this yet"
      // rather than "somebody else already handled it".
      const status =
        result.code === 'forbidden' ? 403
          : result.code === 'capture_failed' ? 502
            : result.code === 'migration_missing' ? 503
              : 409
      return NextResponse.json({ error: result.message }, { status })
    }
    // Move date is now confirmed → (re-)anchor the 72h/24h pre-move reminders.
    // Non-fatal: the reminder journey is a convenience over the authoritative
    // move date, and every stage rechecks at send time.
    await onBookingConfirmed(params.id).catch((err) =>
      apiLogger.error({ err: err instanceof Error ? err.message : String(err), bookingId: params.id }, 'onBookingConfirmed failed (non-fatal)')
    )
    const updated = await readBookingResponse(params.id)
    return NextResponse.json(updated)
  }

  // ── PENDING_APPROVAL → CANCELLED goes through the shared decline service so the
  //    uncaptured $49 hold is RELEASED (not left to expire) and the customer gets
  //    the booking-declined email — identical to the Discord "Deny" button. Other
  //    cancellations (e.g. CONFIRMED → CANCELLED, already captured) fall through to
  //    the generic path below, which sends the cancellation email. ──
  if (booking.status === 'PENDING_APPROVAL' && newStatus === 'CANCELLED') {
    const result = await declineBooking({
      bookingId: params.id,
      actor: { name: session.name, userId: session.userId, role: session.role },
      source: 'admin',
    })
    if (!result.ok) {
      const status = result.code === 'forbidden' ? 403 : 409
      return NextResponse.json({ error: result.message }, { status })
    }
    const updated = await readBookingResponse(params.id)
    return NextResponse.json(updated)
  }

  const data: Record<string, unknown> = { status: newStatus }

  // Confirming here must schedule the booking exactly like the Discord approve
  // path does: populate scheduledStart (what every schedule view queries on) and
  // ensure a Job record exists. Without this, an admin-confirmed booking would be
  // invisible to the daily digest + dashboards.
  if (newStatus === 'CONFIRMED') {
    const sched = confirmationScheduleData(booking)
    if (sched) Object.assign(data, sched)
    await prisma.job.upsert({
      where: { bookingId: params.id },
      update: { status: 'SCHEDULED' },
      create: { bookingId: params.id, status: 'SCHEDULED' },
    })
  }

  // ── ITEM R3-5 — CONFIRMED → SCHEDULED is THE reachable staffing repair ──
  //    "Mark scheduled" is one of only two buttons the admin UI offers on a
  //    confirmed booking, and it means "this move is on the schedule" — so it
  //    is exactly where a job that came out of approval WITHOUT a staffing
  //    requirement (a transient DB error, or the unapplied-migration window)
  //    must get one. `ensureJobForBooking` resolves-or-creates the Job and then
  //    runs the create-if-missing staffing ensure, so an owner-tuned
  //    requirement is never touched and running it twice changes nothing.
  //    Fail-soft: the status change is the owner's action and must stand even
  //    if staffing cannot be written.
  if (booking.status === 'CONFIRMED' && newStatus === 'SCHEDULED') {
    await ensureJobForBooking(params.id, { source: 'status_scheduled', userId: session.userId }).catch((err) =>
      apiLogger.error(
        { err: err instanceof Error ? err.message : String(err), bookingId: params.id },
        'staffing repair on CONFIRMED→SCHEDULED failed (non-fatal)',
      ),
    )
  }

  // Set timestamps on the linked Job record if it exists
  if (newStatus === 'IN_PROGRESS') {
    await prisma.job.updateMany({
      where: { bookingId: params.id },
      data: { status: 'IN_PROGRESS', startedAt: new Date() },
    })
  }
  if (newStatus === 'COMPLETED') {
    await prisma.job.updateMany({
      where: { bookingId: params.id },
      data: { status: 'COMPLETED', completedAt: new Date() },
    })
  }

  const updated = await updateBookingStatusRow(params.id, data)

  await prisma.auditLog.create({
    data: {
      action: 'BOOKING_STATE_CHANGED',
      userId: session.userId,
      bookingId: params.id,
      details: { from: booking.status, to: newStatus, changedBy: session.name },
    },
  })

  // ── Customer emails on terminal transitions (guarded, never fatal) ───────
  //   CANCELLED: honest by capture state — a not-yet-captured booking is a
  //     "declined" (auth hold releases, no charge); a captured one is a
  //     "cancellation" (owner follows up on the $49 deposit — no auto-refund is
  //     issued here, so we never claim one). COMPLETED: the move-complete email.
  const appBase = (process.env.APP_URL ?? 'https://moveitclearit.com').replace(/\/+$/, '')
  const es = booking.customer.locale === 'es'
  const amount = String(Math.round(booking.depositAmount / 100))
  if (booking.customer.email && newStatus === 'CANCELLED') {
    const label: 'booking-cancellation' | 'booking-declined' = booking.depositPaid ? 'booking-cancellation' : 'booking-declined'
    const payload = booking.depositPaid
      ? {
          customerName: booking.customer.name,
          displayId: booking.displayId,
          date: (booking.scheduledStart ?? booking.confirmedDate ?? booking.requestedDate)?.toISOString(),
          amount,
          refundStatus: 'custom' as const,
          statusText: es
            ? `Nuestro equipo se comunicará contigo sobre tu depósito de $${amount}. Si tienes preguntas, escríbenos cuando quieras.`
            : `Our team will follow up with you about your $${amount} deposit. If you have any questions, reach out any time.`,
          rebookUrl: `${appBase}/book`,
          locale: booking.customer.locale,
        }
      : {
          customerName: booking.customer.name,
          displayId: booking.displayId,
          requestedDate: booking.requestedDate?.toISOString(),
          amountHold: amount,
          rebookUrl: `${appBase}/book`,
          locale: booking.customer.locale,
        }
    await withDeadline(
      emailQueue.add(label, { template: label, to: booking.customer.email, bookingId: params.id, payload })
    ).catch((err) => apiLogger.error({ err: err instanceof Error ? err.message : String(err), bookingId: params.id }, `${label} email enqueue failed (non-fatal)`))
  }
  if (booking.customer.email && newStatus === 'COMPLETED') {
    await withDeadline(
      emailQueue.add('job-completion', {
        template: 'job-completion',
        to: booking.customer.email,
        bookingId: params.id,
        payload: {
          customerName: booking.customer.name,
          displayId: booking.displayId,
          completedAt: new Date().toISOString(),
          portalUrl: `${appBase}/my-booking/${booking.customerToken}`,
          items: booking.itemsDescription ?? undefined,
          locale: booking.customer.locale,
        },
      })
    ).catch((err) => apiLogger.error({ err: err instanceof Error ? err.message : String(err), bookingId: params.id }, 'job-completion email enqueue failed (non-fatal)'))
  }

  // Phase 3: kick off the post-move follow-up sequence (review/repeat/referral).
  // Idempotent + self-guarded; awaited so the queue writes happen before we
  // respond, but never allowed to fail the status change.
  if (newStatus === 'COMPLETED') {
    try {
      await onBookingCompleted(params.id)
    } catch (err) {
      apiLogger.error({ err: err instanceof Error ? err.message : String(err), bookingId: params.id }, 'onBookingCompleted failed (non-fatal)')
    }
    // Post-completion balance reminder (+ the move_completed automation
    // trigger). Recomputes customerBalance() at send time — a zero balance,
    // a payment recorded meanwhile, or a cancellation kills it.
    try {
      await onBookingCompletedBalance(params.id)
    } catch (err) {
      apiLogger.error({ err: err instanceof Error ? err.message : String(err), bookingId: params.id }, 'onBookingCompletedBalance failed (non-fatal)')
    }
  }

  // STOP RULE: a cancelled booking must not keep receiving recovery emails,
  // move-day reminders, or post-job review/referral asks. Best-effort queue
  // cleanup; the send-time rechecks are the real guarantee.
  if (newStatus === 'CANCELLED') {
    try {
      await onBookingCancelled(params.id)
    } catch (err) {
      apiLogger.error({ err: err instanceof Error ? err.message : String(err), bookingId: params.id }, 'onBookingCancelled failed (non-fatal)')
    }
  }

  return NextResponse.json(updated)
}
