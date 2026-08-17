import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { emailQueue } from '@/lib/queues'
import { apiLogger } from '@/lib/logger'
import { onBookingConfirmed } from '@/lib/journeys'
import {
  cancelBooking,
  cancelJobForBooking,
  completeBooking,
  replayCompletion,
  replayCompletionMessage,
} from '@/lib/lifecycle-service'
import { confirmationScheduleData } from '@/lib/scheduling'
import {
  approveBooking,
  checkRetryApproval,
  declineBooking,
  isMigrationMissing,
  loadApprovableBooking,
  retryApprovalMessage,
  STATUS_ROUTE_BOOKING_SELECT,
  STATUS_ROUTE_EXTRA_COLUMNS,
  type ApprovalErrorCode,
  type StatusRouteBooking,
} from '@/lib/booking-approval'
import { can, type Role } from '@/lib/permissions'
import { ensureJobForBooking } from '@/lib/labor-service'
import { readDepositEvidence, provenDollars } from '@/lib/deposit-evidence'
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

// ── ITEM R2 — the repair the owner is TOLD to perform, made reachable ────────
//
// After a B1 incident the booking reads CONFIRMED, and `VALID_TRANSITIONS`
// deliberately has no CONFIRMED → CONFIRMED edge, so the 422 below fired BEFORE
// the approval branch and `approveBooking` was never called. The owner's only
// route to the convergence path was the Discord card — which is delivered
// best-effort, so the very infra incident that causes the failure can also
// remove the only route to the cure.
//
// This is a NAMED ACTION, not a status change: the transition table is
// untouched (an ordinary CONFIRMED → CONFIRMED is still refused), and the
// branch runs BEFORE the table is consulted so the 422 can no longer swallow
// it. `checkRetryApproval` keeps it to the one state the convergence path can
// answer for, and `booking.approve` (OWNER-only — approving moves money) is
// checked here as well as inside approveBooking.
const RetryActionSchema = z.object({
  action: z.literal('retry_approval'),
})

// ── B7/B8 — THE POST-MOVE RECOVERY, made reachable the same way ─────────────
//
// `VALID_TRANSITIONS['COMPLETED'] = ['ARCHIVED']` is CORRECT and stays exactly
// as it is: a COMPLETED → COMPLETED edge would reopen the transition guard for a
// retry it was never designed for. But it also means that once a job is
// complete, the completion workflow is permanently unreachable — which is how
// every job completed on the Discord move-day card (the way jobs are ACTUALLY
// completed) lost its customer email, balance reminder, review request,
// referral ask and repeat-customer follow-up with no way to send them.
//
// So the recovery is a NAMED ACTION, not a status change, and it is idempotent
// end to end: the completion email rides the send guard's per-booking
// idempotency key, the follow-ups ride the FollowUpLedger unique key, and the
// balance reminder rides a stable BullMQ job id. Running it when everything
// already fired changes nothing.
const ReplayCompletionSchema = z.object({
  action: z.literal('replay_completion'),
})

const RequestSchema = z.union([RetryActionSchema, ReplayCompletionSchema, StatusSchema])

/** ONE mapping from an approval failure to an HTTP status, shared by the
 *  approve branch and the retry action so the two can never drift.
 *  'migration_missing' is a REFUSAL BEFORE the capture: no claim taken, no
 *  money moved, and the message names the migration. 503 (not 409) so the
 *  workspace shows it as "the server can't do this yet" rather than "somebody
 *  else already handled it". */
function approvalHttpStatus(code: ApprovalErrorCode): number {
  if (code === 'forbidden') return 403
  if (code === 'capture_failed') return 502
  if (code === 'migration_missing') return 503
  return 409
}

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

// ── The cancellation email, HONEST BY PROVEN PAYMENT STATE (item C1/C2) ─────
//   A not-yet-captured booking is a "declined" (there is an authorization and
//   no charge); a CAPTURED one is a "cancellation" (the owner follows up about
//   the deposit — NO automatic refund is issued here, so nothing here may claim
//   one). That SPLIT is right and is kept; what it asked was wrong:
//
//     const amount = String(Math.round(booking.depositAmount / 100))
//     const label  = booking.depositPaid ? 'booking-cancellation' : 'booking-declined'
//
//   `depositPaid` is written by the approval CLAIM before Stripe is called, so
//   the exact B1 failure state (flagged paid, capture never recorded) sent the
//   CAPTURED copy about money the system cannot show; and `depositAmount` is
//   what the booking was SUPPOSED to be charged, so a drifted value put a figure
//   nobody took into a customer's inbox. Both now come from the evidence reader.
//
//   The winning copy is otherwise unchanged: the B2 findings verified the
//   "our team will follow up about your deposit" wording as correct, and it is
//   reproduced here with a PROVEN figure in place of the column's.
async function sendCancellationEmail(booking: StatusRouteBooking, bookingId: string): Promise<void> {
  if (!booking.customer.email) return
  const appBase = (process.env.APP_URL ?? 'https://moveitclearit.com').replace(/\/+$/, '')
  const es = booking.customer.locale === 'es'

  const evidence = await readDepositEvidence(bookingId, { stripePaymentIntentId: booking.stripePaymentIntentId })
  const deposit = evidence.money
  const captured = deposit.state !== 'none'
  // Only ever a proven figure. Captured ⇒ what the ledger says was taken;
  // otherwise ⇒ what Stripe reported it authorized, or nothing at all.
  const amount = deposit.state !== 'none' ? provenDollars(deposit.cents) : null
  const holdAmount = provenDollars(evidence.authorizedCents)
  const label: 'booking-cancellation' | 'booking-declined' = captured ? 'booking-cancellation' : 'booking-declined'
  // A deposit whose refund IS recorded must not be described as still held.
  const refunded = deposit.state === 'refunded' || deposit.state === 'partially_refunded'
  const depositPhrase = amount ? (es ? `tu depósito de $${amount}` : `your $${amount} deposit`) : es ? 'tu depósito' : 'your deposit'

  const payload = captured
    ? {
        customerName: booking.customer.name,
        displayId: booking.displayId,
        date: (booking.scheduledStart ?? booking.confirmedDate ?? booking.requestedDate)?.toISOString(),
        ...(amount ? { amount } : {}),
        refundStatus: 'custom' as const,
        statusText: refunded
          ? es
            ? `Registramos un reembolso de ${depositPhrase}. Puede tardar unos días hábiles en aparecer en tu estado de cuenta.`
            : `A refund of ${depositPhrase} is recorded. It can take a few business days to appear on your statement.`
          : es
            ? `Nuestro equipo se comunicará contigo sobre ${depositPhrase}. Si tienes preguntas, escríbenos cuando quieras.`
            : `Our team will follow up with you about ${depositPhrase}. If you have any questions, reach out any time.`,
        rebookUrl: `${appBase}/book`,
        locale: booking.customer.locale,
      }
    : {
        customerName: booking.customer.name,
        displayId: booking.displayId,
        requestedDate: booking.requestedDate?.toISOString(),
        ...(holdAmount ? { amountHold: holdAmount } : {}),
        // ITEM C2 — THIS PATH NEVER CALLS STRIPE. It cancels a DRAFT /
        // PENDING_PAYMENT / SCHEDULED booking, so the only honest release claim
        // is one an earlier decline actually recorded. Unproven ⇒ the template
        // renders the variant that promises the release rather than asserting it.
        holdReleased: evidence.release === 'released',
        holdEverExisted: !!booking.stripePaymentIntentId && evidence.release !== 'no_hold',
        rebookUrl: `${appBase}/book`,
        locale: booking.customer.locale,
      }
  await withDeadline(
    emailQueue.add(label, { template: label, to: booking.customer.email, bookingId, payload })
  ).catch((err) => apiLogger.error({ err: err instanceof Error ? err.message : String(err), bookingId }, `${label} email enqueue failed (non-fatal)`))
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
  const parsed = RequestSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 422 })

  // ── ITEM R2 — THE REPAIR ACTION, BEFORE THE TRANSITION TABLE ─────────────
  //    Deliberately ahead of the VALID_TRANSITIONS check: that 422 is exactly
  //    what made this unreachable. It routes to the SAME convergence path the
  //    Discord card reaches (approveBooking → convergeConfirmed), which asks
  //    the Payment row and then Stripe before it reports anything, captures
  //    nothing that is already captured, and cannot double-send.
  if ('action' in parsed.data) {
    if (parsed.data.action === 'replay_completion') {
      // Authorization is the OWNER/MANAGER gate at the top of this handler: a
      // replay moves no money and can only re-drive customer messages that are
      // already deduped. It refuses any booking that is not actually complete,
      // so it can never announce a job that did not happen.
      const replay = await replayCompletion(params.id, { timeoutMs: 12_000 })
      if (!replay.ok) return NextResponse.json({ error: replay.message }, { status: replay.code === 'not_found' ? 404 : 422 })
      apiLogger.info(
        { bookingId: params.id, by: session.name, effects: replay.effects },
        'admin replayed the post-move messages',
      )
      const row = await readBookingResponse(params.id)
      return NextResponse.json({
        ...(row as Record<string, unknown>),
        effects: replay.effects,
        message: replayCompletionMessage(replay.effects),
      })
    }
    if (!can(session.role as Role, 'booking.approve')) {
      return NextResponse.json({ error: 'You do not have permission to approve bookings.' }, { status: 403 })
    }
    const retryGuard = checkRetryApproval(booking.status)
    if (!retryGuard.ok) return NextResponse.json({ error: retryGuard.message }, { status: 422 })

    const result = await approveBooking({
      bookingId: params.id,
      actor: { name: session.name, userId: session.userId, role: session.role },
      source: 'admin',
    })
    if (!result.ok) {
      return NextResponse.json({ error: result.message }, { status: approvalHttpStatus(result.code) })
    }
    apiLogger.info(
      { bookingId: params.id, outcome: result.outcome, by: session.name },
      'admin ran the approval repair action',
    )
    const repaired = await readBookingResponse(params.id)
    return NextResponse.json({
      ...(repaired as Record<string, unknown>),
      approvalOutcome: result.outcome,
      // Only ever a figure approveBooking could PROVE (a COMPLETED Payment row,
      // or a capture it performed). Null means "not proven here" — the message
      // built from it then prints no amount at all.
      capturedCents: result.capturedCents,
      message: retryApprovalMessage(result),
    })
  }

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
      // ITEM P0-E — see approvalHttpStatus: 'migration_missing' is a refusal
      // BEFORE the capture and answers 503, not 409.
      return NextResponse.json({ error: result.message }, { status: approvalHttpStatus(result.code) })
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
    // ── B7 — the crew half of a decline ──────────────────────────────────
    //   `declineBooking` owns the $49 hold release and the CANCELLED claim on a
    //   not-yet-captured booking; it does NOT know about the Job. A Job row CAN
    //   exist by now (POST /api/admin/jobs/[id]/crew calls ensureJobForBooking
    //   with no status check, so crew can be attached before approval), and a
    //   Job left SCHEDULED keeps the move in the worker's "upcoming" list and
    //   keeps the ASSIGNMENT_ON_CANCELLED_JOB hard block from firing. This
    //   refuses to act unless the booking really is CANCELLED, and is
    //   idempotent, so re-declining changes nothing.
    //   ── C3-2 — AND ITS RESULT IS READ. `failed` was added to tell "there was
    //   nothing live" apart from "the live crew of a cancelled move is STILL
    //   live", and this call site threw the answer away, so the failure was
    //   recorded and surfaced nowhere. It is not fatal (the booking is
    //   cancelled and the hold is released either way) and it never changes
    //   the HTTP status, but it is logged as the failure it is and returned to
    //   the caller. The service raises it to the owner independently.
    const crew = await cancelJobForBooking({
      bookingId: params.id,
      actor: { name: session.name, userId: session.userId },
      source: 'admin',
      reason: 'Booking declined',
    })
    if (crew.failed) {
      apiLogger.error(
        { bookingId: params.id, err: crew.failed },
        'decline: the booking is CANCELLED but its job/crew could not be cancelled — crew may still be live on a dead move',
      )
    }
    // ── ITEM C2 — AND THE HOLD RELEASE IS REPORTED, not discarded. This call
    //   site threw `holdReleased` away exactly like the Discord one did, so a
    //   Stripe release that failed answered 200 with a healthy-looking booking
    //   and the owner had nothing anywhere that said otherwise.
    if (!result.holdReleased && result.release.state !== 'no_hold') {
      apiLogger.error(
        { bookingId: params.id, releaseState: result.release.state, detail: result.release.detail },
        'decline: the booking is CANCELLED but the Stripe authorization was NOT released — the customer may still have a pending hold. Re-run Cancel to retry, or void it in Stripe',
      )
    }
    const updated = await readBookingResponse(params.id)
    return NextResponse.json({
      ...(updated as Record<string, unknown>),
      jobCancelled: crew.jobCancelled,
      crewCancelled: crew.crewCancelled,
      ...(crew.failed ? { jobCancelFailed: crew.failed } : {}),
      holdReleased: result.holdReleased,
      holdReleaseState: result.release.state,
      ...(result.holdReleased || result.release.state === 'no_hold'
        ? {}
        : {
            warning:
              'The booking is cancelled, but the $ authorization release was not confirmed. Press Cancel again to retry the release, or void it in Stripe.',
          }),
    })
  }

  // ── B7/B8 — COMPLETION goes through the ONE shared lifecycle service ──────
  //   Booking (status AND `completedAt`) + Job + AuditLog commit in a single
  //   transaction, and only then are the post-move messages emitted. Before
  //   this, the route wrote three rows as three separate awaits and stamped
  //   `completedAt` LAST, outside any transaction, with its failure swallowed —
  //   so a request that died in between left status = COMPLETED with
  //   completedAt = NULL, invisible to all six post-move templates forever and
  //   impossible to retry (COMPLETED → COMPLETED is not a legal transition).
  //   The Discord move-day card now calls the SAME function.
  if (newStatus === 'COMPLETED') {
    const result = await completeBooking({
      bookingId: params.id,
      actor: { name: session.name, userId: session.userId },
      source: 'admin',
    })
    if (!result.ok) {
      return NextResponse.json({ error: result.message }, { status: result.code === 'not_found' ? 404 : 422 })
    }
    apiLogger.info(
      { bookingId: params.id, outcome: result.outcome, by: session.name, effects: result.effects },
      'admin completed the job',
    )
    const completed = await readBookingResponse(params.id)
    return NextResponse.json({
      ...(completed as Record<string, unknown>),
      completionOutcome: result.outcome,
      effects: result.effects,
      // ── D3 — the owner reads the RESULT, not an intention. The same string
      //    the replay action returns, built only from what each handoff
      //    reported: a sequence that was skipped (flag off, no promotional
      //    consent) says so instead of reading "scheduled".
      ...(result.effects ? { message: replayCompletionMessage(result.effects) } : {}),
    })
  }

  // ── B7 — CANCELLATION of an approved move, likewise ───────────────────────
  //   The Job stayed SCHEDULED forever and the crew assignments stayed live:
  //   `JobStatus.CANCELLED` was written by NOTHING in this repository, so the
  //   conflict engine's ASSIGNMENT_ON_CANCELLED_JOB hard block was unreachable
  //   dead code and the server would happily let more crew be assigned to a
  //   cancelled move. The service cancels Booking + Job + live assignments +
  //   audit together, then stops the journeys.
  //   (PENDING_APPROVAL → CANCELLED is handled above — that path must release
  //    the $49 hold, which is declineBooking's job, not this one's.)
  if (newStatus === 'CANCELLED') {
    const result = await cancelBooking({
      bookingId: params.id,
      actor: { name: session.name, userId: session.userId },
      source: 'admin',
      reason: 'Cancelled by admin',
    })
    if (!result.ok) {
      return NextResponse.json({ error: result.message }, { status: result.code === 'not_found' ? 404 : 422 })
    }
    await sendCancellationEmail(booking, params.id)
    apiLogger.info(
      { bookingId: params.id, by: session.name, jobCancelled: result.jobCancelled, crewCancelled: result.crewCancelled },
      'admin cancelled the booking',
    )
    const cancelled = await readBookingResponse(params.id)
    return NextResponse.json({
      ...(cancelled as Record<string, unknown>),
      jobCancelled: result.jobCancelled,
      crewCancelled: result.crewCancelled,
    })
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

  // Set timestamps on the linked Job record if it exists.
  // (COMPLETED and CANCELLED are NOT here any more — both return above through
  //  the shared lifecycle service, which writes the Job in the SAME transaction
  //  as the booking. This `updateMany` shape is why an admin completion on a
  //  booking with no Job row silently created none.)
  if (newStatus === 'IN_PROGRESS') {
    await prisma.job.updateMany({
      where: { bookingId: params.id },
      data: { status: 'IN_PROGRESS', startedAt: new Date() },
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

  // The COMPLETED and CANCELLED fan-outs are GONE from here on purpose: both
  // transitions return above through the shared lifecycle service, which emits
  // them AFTER its transaction commits. Keeping a second copy here is how the
  // two surfaces drifted apart in the first place.

  return NextResponse.json(updated)
}
