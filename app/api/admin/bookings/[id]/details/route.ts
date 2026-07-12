import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { z } from 'zod'
import { computeWaitingFee } from '@/lib/waiting-time'

// PATCH /api/admin/bookings/:id/details
// Staff-editable operational + logistics fields for the admin dashboard. Kept
// separate from the status-transition route (which owns the state machine + Job
// side effects). Every field is optional; only provided keys are written.
const str = (max: number) => z.string().max(max).optional().nullable()
const cents = z.coerce.number().int().min(0).max(10_000_000).optional().nullable()

const DetailsSchema = z.object({
  // Internal operations
  arrivalWindow: str(80),
  assignedDispatcher: str(120),
  dispatcherNotes: str(4000),
  crewNotes: str(4000),
  driverNotes: str(4000),
  officeNotes: str(4000),
  schedulingNotes: str(4000),
  travelNotes: str(4000),
  problemFlags: str(1000),
  outstandingTasks: str(4000),
  internalNotes: str(4000),
  completionProgress: z.coerce.number().int().min(0).max(100).optional().nullable(),
  // Truck operations
  truckProvider: str(80),
  truckSize: str(40),
  truckReservationNumber: str(80),
  truckReservationStatus: str(40),
  truckPickupTime: str(80),
  truckPickupLocation: str(200),
  truckReturnAddress: str(200),
  driverName: str(120),
  driverPhone: str(40),
  driverLicense: str(60),
  truckFuelPolicy: str(80),
  additionalTruckFees: cents,
  // Itemized fees (cents)
  stairFee: cents, longCarryFee: cents, heavyItemFee: cents, packingFee: cents,
  assemblyFee: cents, disassemblyFee: cents, taxAmount: cents, processingFee: cents,
  // Waiting time (Late Arrival & Delay Policy). Timestamps are normally set by
  // the crew's Discord buttons; staff may correct minutes, override/waive the
  // fee, and mark it collected on move day.
  waitingMinutes: z.coerce.number().int().min(0).max(1440).optional().nullable(),
  waitingFeeOverride: cents,
  waitingFeeWaived: z.coerce.boolean().optional(),
  waitingWaiverReason: str(500),
  waitingFeeCollected: z.coerce.boolean().optional(),
})

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const session = await getSession()
  if (!session || !['OWNER', 'MANAGER'].includes(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const booking = await prisma.booking.findUnique({ where: { id: params.id }, select: { id: true } })
  if (!booking) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const parsed = DetailsSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 422 })
  }

  // Only write keys that were actually present in the payload (undefined = leave
  // as-is; explicit null = clear the field).
  const data: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(parsed.data)) {
    if (v !== undefined) data[k] = v === '' ? null : v
  }
  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: 'No fields to update' }, { status: 422 })
  }

  // If staff corrected the waiting minutes, keep the derived fee in sync (a
  // manual waitingFeeOverride still wins at display time; this is the baseline).
  if (data.waitingMinutes != null) {
    data.waitingFee = computeWaitingFee(Number(data.waitingMinutes)).feeCents
  }

  const updated = await prisma.booking.update({ where: { id: params.id }, data })

  // Non-fatal: a details save must never fail because the audit enum value is
  // missing on an un-migrated database. Best-effort record.
  try {
    await prisma.auditLog.create({
      data: {
        action: 'BOOKING_DETAILS_UPDATED',
        userId: session.userId,
        bookingId: params.id,
        details: { fields: Object.keys(data), changedBy: session.name },
      },
    })
  } catch {
    /* enum value not present yet — ignore */
  }

  return NextResponse.json(updated)
}
