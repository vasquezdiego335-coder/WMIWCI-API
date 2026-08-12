import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { z } from 'zod'
import { normalizeBookingReference, nextBookingReference } from '@/lib/booking-reference'
import { apiLogger } from '@/lib/logger'
import { can, type Role } from '@/lib/permissions'
import { LeadLifecycle, LeadStatus } from '@prisma/client'
import {
  AdminBookingSchema,
  adminPortalTokenExpiry,
  buildBookingCreateData,
  buildStaffingRequirementData,
  collectBookingWarnings,
  decideStatus,
  requiresOverrideReason,
  resolveInventorySnapshots,
  synthesizePlaceholderEmail,
  type CatalogSnapshotSource,
} from '@/lib/admin-booking'
import { recommendEstimate } from '@/lib/estimate-assistant'
import { computeEstimate, MOVE_SIZES } from '@/lib/estimate'
import { checkServiceArea } from '@/lib/service-area'
import { confirmationScheduleData, etDateTimeToInstant, etDayRange } from '@/lib/scheduling'
import { findTruckConflictsIn, TRUCK_CONFLICT_STATUSES, type TruckBookingShape } from '@/lib/truck-conflicts'
import { createBookingCheckout } from '@/lib/stripe'
import { markLeadConverted } from '@/lib/leads'
import { syncReminders } from '@/lib/reminder-sync'

const QuerySchema = z.object({
  status: z.string().optional(),
  crew: z.string().optional(),
  customer: z.string().optional(),
  date: z.string().optional(),
  page: z.string().default('1'),
  limit: z.string().default('20'),
})

export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await getSession()
  if (!session || !['OWNER', 'MANAGER'].includes(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { searchParams } = req.nextUrl
  const q = QuerySchema.parse(Object.fromEntries(searchParams.entries()))

  const page = parseInt(q.page, 10)
  const limit = Math.min(parseInt(q.limit, 10), 100)
  const skip = (page - 1) * limit

  // Build where clause
  const where: any = {}
  if (q.status) where.status = q.status
  if (q.customer) {
    // One search box → matches customer name/email/phone, the public reference
    // (WMIC-####, with or without dash/case/prefix), the legacy display id, and
    // the internal cuid. Reference match is exact; a bare number like "1042" is
    // normalised to WMIC-1042 before lookup.
    const term = q.customer.trim()
    const ref = normalizeBookingReference(term)
    const or: any[] = [
      { customer: { name: { contains: term, mode: 'insensitive' } } },
      { customer: { email: { contains: term, mode: 'insensitive' } } },
      { customer: { phone: { contains: term } } },
      { displayId: { equals: term } },
      { id: { equals: term } },
    ]
    if (ref) {
      or.push({ bookingReference: { equals: ref } }, { displayId: { equals: ref } })
    } else if (/wmic/i.test(term)) {
      or.push({ bookingReference: { contains: term.toUpperCase() } })
    }
    where.OR = or
  }
  if (q.date) {
    const d = new Date(q.date)
    const start = new Date(d); start.setHours(0, 0, 0, 0)
    const end = new Date(d); end.setHours(23, 59, 59, 999)
    where.scheduledStart = { gte: start, lte: end }
  }

  const [bookings, total] = await Promise.all([
    prisma.booking.findMany({
      where,
      include: {
        customer: { select: { name: true, email: true, phone: true } },
        payments: { select: { status: true, amount: true } },
        job: { select: { status: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.booking.count({ where }),
  ])

  return NextResponse.json({
    bookings,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  })
}

// ════════════════════════════════════════════════════════════════════════════
//  POST /api/admin/bookings — the BOOK MOVE cascade (Moving OS Phase 1,
//  owner spec 2026-08-11). One decision on the phone → everything downstream:
//
//    Customer upsert → Booking (structured columns + owner price + audit) →
//    inventory snapshots → Job + JobStaffingRequirement (CONFIRMED only —
//    fixes the dispatch blind spot at the source) → lead auto-converted →
//    optional Stripe $49 hold link → Action Center scan kicked.
//
//  HARD RULES honored here:
//    • Truck conflicts REFUSE (409) unless truckConflictOverride is explicit —
//      a silent double-booking never happens; an override is audited.
//    • Owner pricing is per-booking (totalEstimate + priceOverrideReason +
//      PRICE_CHANGED audit). The price book is never touched.
//    • NO customer emails. The response surfaces the portal link + (stripe_link
//      mode) the checkout URL for the owner to send manually.
// ════════════════════════════════════════════════════════════════════════════

const DAY_MS = 24 * 60 * 60 * 1000

/** Unapplied-migration signature (house detection, same as /api/admin/trucks):
 *  Prisma P2021/P2022 or Postgres "does not exist". Migrations are applied
 *  manually, so this answers 503 with the migration name instead of a 500. */
function isMigrationMissing(err: unknown): boolean {
  const code = (err as { code?: string })?.code
  const msg = err instanceof Error ? err.message : String(err)
  return code === 'P2021' || code === 'P2022' || /does not exist/i.test(msg)
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  if (!can(session.role as Role, 'booking.create_admin')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const parsed = AdminBookingSchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', issues: parsed.error.flatten() }, { status: 422 })
  }
  const d = parsed.data

  try {
    // ── 1. Service area — SERVER-side source of truth (public-route rule).
    //    manual_review zones are ALLOWED for admin creates (the owner is the
    //    reviewer, deciding live on the phone) but recorded + warned.
    const sa = checkServiceArea([{ ...d.move.originAddress }], { ...d.move.destAddress })
    const travelFeeCents = sa.travelFeeCents ?? 0

    // ── 2. Catalog lookup → immutable inventory snapshots. Fail-soft: with the
    //    migration unapplied the picker never offered catalog ids, so an empty
    //    map is the honest degradation, not an error.
    const catalogIds = d.inventory.map((i) => i.catalogItemId).filter((id): id is string => !!id)
    const catalogById = new Map<string, CatalogSnapshotSource>()
    if (catalogIds.length) {
      try {
        const rows = await prisma.inventoryCatalogItem.findMany({
          where: { id: { in: catalogIds } },
          select: { id: true, name: true, isHeavy: true, needsDisassembly: true, recommendedMovers: true },
        })
        for (const r of rows) catalogById.set(r.id, r)
      } catch (err) {
        if (!isMigrationMissing(err)) throw err
      }
    }
    const snapshots = resolveInventorySnapshots(d.inventory, catalogById)

    // ── 3. The recommendation (advisory) + the canonical estimate (the number
    //    the owner's price is compared against — includes the travel fee, same
    //    as the public route).
    const recommendation = recommendEstimate({
      serviceType: d.move.serviceType,
      inventory: snapshots,
      originStairFlights: d.move.originStairFlights,
      destStairFlights: d.move.destStairFlights,
      originHasElevator: d.move.originHasElevator,
      destHasElevator: d.move.destHasElevator,
      longCarry: d.move.longCarry,
      needsPacking: d.services.needsPacking,
      needsAssembly: d.services.needsAssembly,
      needsDisassembly: d.services.needsDisassembly,
      additionalStops: d.move.additionalStopsCount,
    })
    const estimate = computeEstimate({
      serviceType: d.move.serviceType,
      pickupStairFlights: d.move.originStairFlights,
      dropoffStairFlights: d.move.destStairFlights,
      longWalk: d.move.longCarry,
      additionalStops: d.move.additionalStopsCount
        ? Array.from({ length: d.move.additionalStopsCount }, (_, n) => ({ label: `Additional stop ${n + 1}` }))
        : null,
      travelFeeCents,
    })

    // ── 4. Owner price away from the recommendation needs a WRITTEN reason
    //    (pairs with the PRICE_CHANGED audit below).
    const overridden = requiresOverrideReason(d.pricing.ownerTotal, estimate)
    if (overridden && !d.pricing.overrideReason) {
      return NextResponse.json(
        {
          error: `Owner price ($${d.pricing.ownerTotal}) differs from the recommended estimate ($${estimate.estimatedTotal}) — a reason is required.`,
          recommendedTotal: estimate.estimatedTotal,
        },
        { status: 422 },
      )
    }

    // ── 5. Move instant (ET wall clock, 7:00 default like the public route).
    const requestedDate = etDateTimeToInstant(d.move.moveDate, '07:00')
    if (!requestedDate) return NextResponse.json({ error: 'Invalid move date' }, { status: 422 })

    // ── 6. Truck conflict check BEFORE anything is written. Refuse unless the
    //    override is explicit — never a silent double-booking (hard rule).
    let truckOverrideUsed = false
    if (d.truckId) {
      const { start: dayStart, end: dayEnd } = etDayRange(0, requestedDate)
      let candidates: TruckBookingShape[] = []
      try {
        const rows = await prisma.booking.findMany({
          where: {
            truckId: d.truckId,
            isInternalTest: false,
            status: { in: [...TRUCK_CONFLICT_STATUSES] },
            // Generous ±1-day window: an overnight overlap still gets caught.
            OR: [
              { scheduledStart: { gte: new Date(dayStart.getTime() - DAY_MS), lte: new Date(dayEnd.getTime() + DAY_MS) } },
              { scheduledStart: null, confirmedDate: { gte: new Date(dayStart.getTime() - DAY_MS), lte: new Date(dayEnd.getTime() + DAY_MS) } },
              { scheduledStart: null, confirmedDate: null, requestedDate: { gte: new Date(dayStart.getTime() - DAY_MS), lte: new Date(dayEnd.getTime() + DAY_MS) } },
            ],
          },
          select: { id: true, displayId: true, truckId: true, scheduledStart: true, scheduledEnd: true, confirmedDate: true, requestedDate: true, status: true },
        })
        candidates = rows.map((b) => ({
          id: b.id,
          truckId: b.truckId,
          scheduledStart: b.scheduledStart,
          scheduledEnd: b.scheduledEnd,
          // Date-only rows fall back through the same chain the schedule uses.
          confirmedDate: b.confirmedDate ?? b.requestedDate,
          status: b.status,
        }))
      } catch (err) {
        if (!isMigrationMissing(err)) throw err
      }
      const conflicts = findTruckConflictsIn(candidates, { truckId: d.truckId, start: requestedDate, end: null })
      if (conflicts.length && !d.truckConflictOverride) {
        return NextResponse.json(
          {
            error: 'Truck is already booked in this window. Pick another truck, or set truckConflictOverride to double-book deliberately.',
            conflicts: conflicts.map((c) => ({ bookingId: c.booking.id, reason: c.reason })),
          },
          { status: 409 },
        )
      }
      truckOverrideUsed = conflicts.length > 0
    }

    // ── 7. Customer upsert. No email → a synthesized placeholder on the
    //    reserved `.invalid` TLD: deliberately never-deliverable, and
    //    guardedSend's validation refuses it — the HONEST behavior for a
    //    customer who never gave an address (no email can ever be claimed
    //    sent). See admin-booking.synthesizePlaceholderEmail.
    const email = d.customer.email ?? synthesizePlaceholderEmail(d.customer.phone ?? '')
    const hasRealEmail = !!d.customer.email
    // Customer.phone is a required column — an email-only customer stores ''
    // (honest "not provided"), never a fabricated number.
    const customer = await prisma.customer.upsert({
      where: { email },
      update: { name: d.customer.name, phone: d.customer.phone ?? '', locale: d.customer.locale },
      create: {
        email,
        name: d.customer.name,
        phone: d.customer.phone ?? '',
        locale: d.customer.locale,
        isFirstTime: true,
      },
    })

    // ── 8. Build the booking data (pure) + CONFIRMED schedule stamping.
    const status = decideStatus(d.deposit.mode)
    const reference = await nextBookingReference()
    const tokenExpiry = adminPortalTokenExpiry(requestedDate)
    const createData = buildBookingCreateData(
      d,
      {
        estimate,
        travel: { zone: sa.zone, travelFeeCents: sa.travelFeeCents, message: sa.message },
        reference,
        tokenExpiry,
        requestedDate,
        estimatedHours: recommendation.estimatedHoursMax,
      },
      snapshots,
    )
    // Same stamping approveBooking uses — without scheduledStart a CONFIRMED
    // booking is invisible to every schedule view.
    const sched =
      status === 'CONFIRMED'
        ? confirmationScheduleData({ requestedDate, estimatedHours: recommendation.estimatedHoursMax })
        : null

    // ── 9. THE transaction: booking + inventory + job + staffing + audits
    //    commit or roll back together (house rule).
    const { booking, jobId } = await prisma.$transaction(async (tx) => {
      const booking = await tx.booking.create({
        data: { customerId: customer.id, ...createData, ...(sched ?? {}) },
      })
      if (snapshots.length) {
        await tx.bookingInventoryItem.createMany({
          data: snapshots.map((s) => ({
            bookingId: booking.id,
            catalogItemId: s.catalogItemId,
            name: s.name,
            quantity: s.quantity,
            isHeavy: s.isHeavy,
            needsDisassembly: s.needsDisassembly,
            notes: s.notes,
          })),
        })
      }
      let jobId: string | null = null
      if (status === 'CONFIRMED') {
        const job = await tx.job.upsert({
          where: { bookingId: booking.id },
          update: { status: 'SCHEDULED' },
          create: { bookingId: booking.id, status: 'SCHEDULED' },
        })
        jobId = job.id
        // The dispatch blind-spot fix: the requirement exists from birth, so
        // UNDERSTAFFED / MISSING_DRIVER can actually fire for this job.
        await tx.jobStaffingRequirement.create({
          data: {
            jobId: job.id,
            createdById: session.userId,
            ...buildStaffingRequirementData(recommendation, d, snapshots, sched?.scheduledStart ?? requestedDate),
          },
        })
      }
      await tx.auditLog.create({
        data: {
          action: 'BOOKING_CREATED',
          userId: session.userId,
          bookingId: booking.id,
          details: {
            source: 'admin',
            by: session.name,
            depositMode: d.deposit.mode,
            bookingReference: reference,
            ownerTotal: d.pricing.ownerTotal,
            recommendedTotal: estimate.hasService ? estimate.estimatedTotal : null,
            serviceAreaZone: sa.zone,
            ...(truckOverrideUsed
              ? { truckConflictOverride: true, truckId: d.truckId }
              : {}),
          },
        },
      })
      if (overridden) {
        await tx.auditLog.create({
          data: {
            action: 'PRICE_CHANGED',
            userId: session.userId,
            bookingId: booking.id,
            details: {
              recommended: estimate.estimatedTotal,
              ownerTotal: d.pricing.ownerTotal,
              reason: d.pricing.overrideReason,
              by: session.name,
            },
          },
        })
      }
      return { booking, jobId }
    })

    // ── 10. Stripe hold link (stripe_link mode). OUTSIDE the tx (network) and
    //    non-fatal: the booking stands; a failed link is a warning the owner
    //    can retry, never a lost booking.
    let stripeUrl: string | null = null
    const extraWarnings: string[] = []
    if (d.deposit.mode === 'stripe_link') {
      const appUrl = process.env.APP_URL ?? 'https://wmiwci-api.vercel.app'
      const marketingUrl = process.env.MARKETING_SITE_URL ?? 'https://www.moveitclearit.com'
      try {
        const svcLabel = MOVE_SIZES[d.move.serviceType]?.label ?? d.move.serviceType
        const checkout = await createBookingCheckout({
          bookingId: booking.id,
          customerEmail: customer.email,
          customerName: customer.name,
          description: `${svcLabel} move - ${d.move.moveDate}`,
          successUrl: `${appUrl}/api/stripe/checkout/success?session_id={CHECKOUT_SESSION_ID}&booking=${booking.id}`,
          cancelUrl: `${marketingUrl}/contact.html?cancelled=1`,
          extraMetadata: {
            bookingReference: reference,
            createdBy: 'admin',
            ownerTotal: String(d.pricing.ownerTotal),
          },
        })
        await prisma.booking.update({ where: { id: booking.id }, data: { stripeCheckoutId: checkout.id } })
        stripeUrl = checkout.url
        if (!hasRealEmail) {
          extraWarnings.push('No customer email — the Stripe page will show the placeholder address; send the link by text.')
        }
      } catch (err) {
        apiLogger.error({ err, bookingId: booking.id }, 'Admin booking: Stripe hold link failed (non-fatal)')
        extraWarnings.push('Stripe hold link could not be created — the booking stands; retry the link or collect on move day.')
      }
    }

    // ── 11. Lead conversion (fail-soft, never blocks the booking). The exact
    //    lead from ?leadId= first, then the email-matched open lead via the
    //    ONE lead writer (markLeadConverted).
    let leadConverted = false
    if (d.leadId) {
      try {
        const res = await prisma.lead.updateMany({
          where: {
            id: d.leadId,
            status: { in: [LeadStatus.NEW, LeadStatus.CONTACTED, LeadStatus.QUOTE_SENT, LeadStatus.FOLLOW_UP] },
          },
          data: {
            status: LeadStatus.BOOKED,
            bookedAt: new Date(),
            convertedBookingId: booking.id,
            lastActivityAt: new Date(),
            lifecycle: LeadLifecycle.CONVERTED,
          },
        })
        leadConverted = res.count > 0
      } catch (err) {
        apiLogger.warn({ err: String(err).slice(0, 200), leadId: d.leadId }, 'Admin booking: lead conversion by id failed (non-fatal)')
      }
    }
    if (hasRealEmail) {
      const converted = await markLeadConverted(customer.email, booking.id)
      leadConverted = leadConverted || !!converted
    }

    // ── 12. Action Center scan — fire and forget (its own lock/cooldown make
    //    a concurrent kick harmless).
    void syncReminders().catch((err) =>
      apiLogger.warn({ err: String(err).slice(0, 200) }, 'Admin booking: reminder scan kick failed (non-fatal)'),
    )

    const appUrl = process.env.APP_URL ?? 'https://wmiwci-api.vercel.app'
    const warnings = [
      ...collectBookingWarnings({
        inventoryCount: snapshots.length,
        zone: sa.zone,
        serviceType: d.move.serviceType,
        truckOverrideUsed,
      }),
      ...extraWarnings,
    ]

    apiLogger.info(
      { bookingId: booking.id, bookingReference: reference, status, jobId, by: session.name },
      'Admin booking created',
    )

    return NextResponse.json(
      {
        bookingId: booking.id,
        bookingReference: reference,
        status,
        jobId,
        // Surfaced for the OWNER to send manually — Phase 1 sends no customer
        // email from this flow, by design.
        portalUrl: `${appUrl}/my-booking/${booking.customerToken}`,
        stripeUrl,
        leadConverted,
        warnings,
      },
      { status: 201 },
    )
  } catch (err) {
    if (isMigrationMissing(err)) {
      return NextResponse.json(
        { error: 'Moving OS tables missing — migration 20260811000000_moving_os_phase1 not applied' },
        { status: 503 },
      )
    }
    apiLogger.error({ err: err instanceof Error ? err.message : String(err) }, 'Admin booking create failed')
    return NextResponse.json({ error: 'Failed to create the booking' }, { status: 500 })
  }
}
