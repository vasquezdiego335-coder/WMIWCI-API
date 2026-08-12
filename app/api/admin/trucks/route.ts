import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { apiLogger } from '@/lib/logger'
import { TruckSource, TruckStatus } from '@prisma/client'
import { can, type Role } from '@/lib/permissions'
import { etDateTimeToInstant, etDayRange, moveDateInRange } from '@/lib/scheduling'
import { TRUCK_CONFLICT_STATUSES } from '@/lib/truck-conflicts'
import { z } from 'zod'

// Moving OS Phase 1 — fleet trucks (owner spec 2026-08-11).
// GET lists the fleet; with ?date=YYYY-MM-DD (an America/New_York calendar
// day) each truck also carries that day's live booking assignments, so the
// Book Move workspace can show per-truck busy state before the owner assigns
// one. POST creates a truck (truck.manage) — create + TRUCK_CREATED audit in
// one transaction, the house pattern from /api/admin/expenses.
//
// Fail-soft: migrations are applied manually, so a missing `trucks` table
// (P2021) answers honestly with an empty fleet + migrationMissing flag
// instead of a 500 — the Book Move truck select degrades to "no trucks yet".

const CreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  size: z.string().trim().min(1).max(40), // "10ft" | "15ft" | "26ft" | free text
  source: z.nativeEnum(TruckSource).optional(), // defaults to RENTAL in schema
  status: z.nativeEnum(TruckStatus).optional(), // defaults to AVAILABLE
  capacityNotes: z.string().trim().max(1000).optional(),
  active: z.boolean().optional(),
})

/** The signature of an unapplied migration (same detection email-diagnostics
 *  uses): Prisma P2021 or Postgres "relation ... does not exist". */
function isTableMissing(err: unknown): boolean {
  const code = (err as { code?: string })?.code
  const msg = err instanceof Error ? err.message : String(err)
  return code === 'P2021' || /does not exist/i.test(msg)
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  if (!can(session.role as Role, 'truck.manage')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const dateParam = req.nextUrl.searchParams.get('date')
  if (dateParam && !/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
    return NextResponse.json({ error: 'date must be YYYY-MM-DD' }, { status: 422 })
  }

  try {
    const trucks = await prisma.truck.findMany({ orderBy: [{ active: 'desc' }, { name: 'asc' }] })

    // ?date= → that ET day's live assignments per truck (busy state).
    type DayBooking = { id: string; displayId: string; customerName: string; scheduledStart: Date | null; scheduledEnd: Date | null; status: string }
    const byTruck = new Map<string, DayBooking[]>()
    if (dateParam) {
      // Noon anchor: etDayRange derives the exact ET day bounds DST-safely.
      const noon = etDateTimeToInstant(dateParam, '12:00')
      if (!noon) return NextResponse.json({ error: 'Invalid date' }, { status: 422 })
      const { start, end } = etDayRange(0, noon)
      const dayBookings = await prisma.booking.findMany({
        where: {
          truckId: { not: null },
          isInternalTest: false,
          status: { in: [...TRUCK_CONFLICT_STATUSES] },
          ...moveDateInRange(start, end),
        },
        select: {
          id: true, displayId: true, truckId: true, scheduledStart: true, scheduledEnd: true, status: true,
          customer: { select: { name: true } },
        },
        orderBy: { scheduledStart: 'asc' },
      })
      for (const b of dayBookings) {
        const list = byTruck.get(b.truckId!) ?? []
        list.push({ id: b.id, displayId: b.displayId, customerName: b.customer.name, scheduledStart: b.scheduledStart, scheduledEnd: b.scheduledEnd, status: b.status })
        byTruck.set(b.truckId!, list)
      }
    }

    return NextResponse.json({
      date: dateParam ?? null,
      trucks: trucks.map((t) => {
        const bookings = byTruck.get(t.id) ?? []
        return { ...t, bookings, busy: bookings.length > 0 }
      }),
    })
  } catch (err) {
    if (isTableMissing(err)) {
      return NextResponse.json({
        date: dateParam ?? null,
        trucks: [],
        migrationMissing: true,
        error: 'Trucks table missing — migration 20260811000000_moving_os_phase1 not applied',
      })
    }
    apiLogger.error({ err: err instanceof Error ? err.message : String(err) }, 'Truck list failed')
    return NextResponse.json({ error: 'Failed to load trucks' }, { status: 500 })
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  if (!can(session.role as Role, 'truck.manage')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const parsed = CreateSchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', issues: parsed.error.flatten() }, { status: 422 })
  }
  const d = parsed.data

  try {
    // Create + audit atomically: the log can never record a create that rolled
    // back, and vice versa (house rule).
    const truck = await prisma.$transaction(async (tx) => {
      const t = await tx.truck.create({
        data: {
          name: d.name,
          size: d.size,
          source: d.source ?? TruckSource.RENTAL,
          status: d.status ?? TruckStatus.AVAILABLE,
          capacityNotes: d.capacityNotes || null,
          active: d.active ?? true,
        },
      })
      await tx.auditLog.create({
        data: {
          action: 'TRUCK_CREATED',
          userId: session.userId,
          details: { truckId: t.id, name: t.name, size: t.size, source: t.source, status: t.status, by: session.name },
        },
      })
      return t
    })

    apiLogger.info({ truckId: truck.id, name: truck.name }, 'Truck created')
    return NextResponse.json(truck, { status: 201 })
  } catch (err) {
    if (isTableMissing(err)) {
      return NextResponse.json({ error: 'Trucks table missing — migration 20260811000000_moving_os_phase1 not applied' }, { status: 503 })
    }
    apiLogger.error({ err: err instanceof Error ? err.message : String(err) }, 'Truck create failed')
    return NextResponse.json({ error: 'Failed to create truck' }, { status: 500 })
  }
}
