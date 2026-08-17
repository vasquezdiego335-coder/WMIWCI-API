import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { apiLogger } from '@/lib/logger'
import { can, type Role } from '@/lib/permissions'
import { releaseTruckHoldByOwner, type ReleaseHoldRefusalCode } from '@/lib/checkout-expiry'
import { z } from 'zod'

// ════════════════════════════════════════════════════════════════════════
//  POST /api/admin/bookings/[id]/release-hold   — D1
//
//  THE OWNER'S EXIT FROM AN UNPAID CHECKOUT HOLD, and the ONLY one.
//
//  A booking left in PENDING_PAYMENT holds its assigned truck (R2-2: a truck
//  the owner assigned to an unpaid booking IS held) and, before this route,
//  nothing could end it: the status route's VALID_TRANSITIONS has no key for
//  PENDING_PAYMENT, and `truckId` is not editable anywhere.
//
//  B6 filled that gap AUTOMATICALLY — a webhook and an hourly sweep that
//  cancelled the booking. Verified reproductions showed the sweep cancelling
//  bookings whose customers were at that moment being redirected into a fresh
//  Stripe session (the resume route retires the recorded session BEFORE minting
//  its replacement, so a live booking routinely carries a dead session id), and
//  CANCELLED is terminal — nobody could undo it. D1 removed that path. What is
//  left is this: a human, looking at the booking, deciding.
//
//  WHY A NAMED ROUTE AND NOT A STATUS TRANSITION. Adding PENDING_PAYMENT →
//  CANCELLED to VALID_TRANSITIONS would make the terminal cancellation of an
//  unpaid booking reachable from anything that can post a status, with none of
//  the checks below. This route is the only caller of
//  `releaseTruckHoldByOwner`, which refuses outright when Stripe says money may
//  exist and demands an explicit acknowledgement when the session is still
//  payable or Stripe cannot be asked at all.
//
//  Auth: the admin middleware gates /api/admin/* (session + CSRF double-submit);
//  `booking.decline` is checked here AND inside the service. That is the same
//  right that ends any pre-capture booking (booking-approval.DENYABLE already
//  lists PENDING_PAYMENT), so no new permission was invented for it.
// ════════════════════════════════════════════════════════════════════════

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ReleaseSchema = z.object({
  /** The owner has read the risk the server named and wants to proceed. */
  acknowledgeRisk: z.boolean().optional(),
})

/** ONE mapping from a refusal to an HTTP status, so the UI can branch on the
 *  code rather than on prose. 409 for "the booking is not what you think it
 *  is"; 428 for "you must confirm the named risk first" — a precondition the
 *  caller can satisfy and retry. */
function refusalStatus(code: ReleaseHoldRefusalCode): number {
  if (code === 'forbidden') return 403
  if (code === 'not_found') return 404
  if (code === 'needs_acknowledgement') return 428
  return 409
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const session = await getSession()
  if (!session || !can(session.role as Role, 'booking.decline')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const parsed = ReleaseSchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 422 })
  }

  try {
    const result = await releaseTruckHoldByOwner({
      bookingId: params.id,
      actor: { userId: session.userId, name: session.name, role: session.role as Role },
      acknowledgeRisk: parsed.data.acknowledgeRisk === true,
    })

    if (!result.ok) {
      return NextResponse.json(
        {
          error: result.message,
          code: result.code,
          needsAcknowledgement: result.needsAcknowledgement ?? false,
          sessionVerdict: result.sessionVerdict ?? null,
        },
        { status: refusalStatus(result.code) },
      )
    }

    apiLogger.warn(
      {
        bookingId: params.id,
        outcome: result.outcome,
        sessionVerdict: result.sessionVerdict,
        sessionRetired: result.sessionRetired ?? 'not-attempted',
        jobCancelled: result.aftermath?.jobCancelled ?? null,
        crewCancelled: result.aftermath?.crewCancelled ?? null,
        // C4/C3-2: a failed job/crew half is the owner's to finish by hand, so
        // it is logged as a failure here as well as raised by the service.
        jobCancelFailed: result.aftermath?.jobCancelFailed ?? null,
        journeys: result.aftermath?.journeys ?? null,
        by: session.name,
        userId: session.userId,
      },
      'admin released an unpaid checkout truck hold',
    )

    // The message comes from the service, which composes it from what it
    // actually did. This route never writes a claim of its own.
    return NextResponse.json({
      ok: true,
      outcome: result.outcome,
      bookingId: result.bookingId,
      truckId: result.truckId,
      sessionVerdict: result.sessionVerdict,
      // C4 — the cancellation's other half, reported rather than assumed: what
      // the shared lifecycle service did with the job, the crew and the
      // journeys, and whether the checkout session was actually retired.
      sessionRetired: result.sessionRetired ?? 'not-attempted',
      jobCancelled: result.aftermath?.jobCancelled ?? false,
      crewCancelled: result.aftermath?.crewCancelled ?? 0,
      ...(result.aftermath?.jobCancelFailed ? { jobCancelFailed: result.aftermath.jobCancelFailed } : {}),
      journeys: result.aftermath?.journeys ?? 'not-run',
      message: result.message,
    })
  } catch (err) {
    apiLogger.error(
      { err: err instanceof Error ? err.message : String(err), bookingId: params.id },
      'release truck hold failed',
    )
    return NextResponse.json({ error: 'Failed to release the truck hold' }, { status: 500 })
  }
}
