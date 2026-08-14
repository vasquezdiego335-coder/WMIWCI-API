import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { z } from 'zod'
import { normalizeBookingReference, nextBookingReference } from '@/lib/booking-reference'
import { apiLogger } from '@/lib/logger'
import { can, type Role } from '@/lib/permissions'
import { LeadLifecycle, LeadStatus, type Prisma } from '@prisma/client'
import {
  AdminBookingSchema,
  adminPortalTokenExpiry,
  buildAdminStaffingPlan,
  buildBookingCreateData,
  collectBookingWarnings,
  composeAddress,
  decideStatus,
  findAdminTruckConflicts,
  requiresOverrideReason,
  resolveCustomerMutation,
  resolveInventorySnapshots,
  resolveMoveSchedule,
  synthesizePlaceholderEmail,
  type CatalogSnapshotSource,
} from '@/lib/admin-booking'
import { recommendEstimate } from '@/lib/estimate-assistant'
import { ensureStaffingRequirement, planOpsWarnings } from '@/lib/staffing-plan'
import { computeEstimate, MOVE_SIZES } from '@/lib/estimate'
import { checkServiceArea } from '@/lib/service-area'
import { verifyAddress, type VerifiedAddress } from '@/lib/address-verify'
import { calculateEndTime, etDateTimeToInstant, etDayRange } from '@/lib/scheduling'
import {
  TRUCK_CANDIDATE_SELECT,
  toTruckBookingShapes,
  truckCandidateWhere,
  type TruckBookingShape,
} from '@/lib/truck-conflicts'
import {
  assertTruckFreeUnderLock,
  truckConflictResponseBody,
  TruckDoubleBookedError,
} from '@/lib/truck-lock'
import {
  checkBookingCreateReady,
  MIGRATION_MISSING_MESSAGE,
  readBookingWithMigrationFallback,
} from '@/lib/migration-window'
import { createBookingCheckout } from '@/lib/stripe'
import { markLeadConverted } from '@/lib/leads'
import { runScan } from '@/lib/reminder-sync'
import { describeScanOutcome, type ScanKickReport } from '@/lib/scan-lock'

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

  // ── ITEM P0-E — the GET was the one unguarded read on this file ───────────
  //    The POST below answers an honest 503 naming all three migrations, while
  //    this `include:` (which asks Postgres for `$scalars` from the GENERATED
  //    schema) 500'd the whole admin bookings list for the same window. Same
  //    ladder as everywhere else: full row, then every column that certainly
  //    exists. `degraded` is reported in the payload so a caller is never told
  //    a partial row is a whole one.
  const listRead = await readBookingWithMigrationFallback<unknown[]>(
    (args) =>
      prisma.booking.findMany({
        where,
        ...(args as object),
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
    {
      customer: { select: { name: true, email: true, phone: true } },
      payments: { select: { status: true, amount: true } },
      job: { select: { status: true } },
    },
  )
  const total = await prisma.booking.count({ where })

  return NextResponse.json({
    bookings: listRead.row ?? [],
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    ...(listRead.degraded
      ? { degraded: true, degradedReason: MIGRATION_MISSING_MESSAGE }
      : {}),
  })
}

// ════════════════════════════════════════════════════════════════════════════
//  POST /api/admin/bookings — the BOOK MOVE cascade (Moving OS Phase 1,
//  owner spec 2026-08-11). One decision on the phone → everything downstream:
//
//    Customer (the PICKED record, or an email match, or a new one) → Booking
//    (structured columns + owner price + audit) → inventory snapshots → Job +
//    JobStaffingRequirement (CONFIRMED only — fixes the dispatch blind spot at
//    the source) → lead auto-converted → optional Stripe $49 hold link →
//    Action Center scan (awaited, and reported for what it actually did).
//
//  HARD RULES honored here:
//    • Truck conflicts REFUSE (409) unless truckConflictOverride is explicit —
//      a silent double-booking never happens; an override is audited. The
//      refusal is enforced TWICE: a fast pre-check for the UI, and a re-check
//      under a (truck, ET day) advisory lock inside the transaction.
//    • Owner pricing is per-booking (totalEstimate + priceOverrideReason +
//      PRICE_CHANGED audit). The price book is never touched.
//    • NO customer emails. The response surfaces the portal link + (stripe_link
//      mode) the checkout URL for the owner to send manually.
//
//  CORRECTNESS PASS 2026-08-12:
//    • item 2 — the crew start time is CAPTURED, never defaulted to 07:00; with
//      no time the booking is day-level and the truck check holds the whole day.
//    • item 3 — customer.id is authoritative; a submitted email owned by a
//      DIFFERENT customer is a 409, never a silent merge. The customer write
//      happens inside the booking transaction.
//    • item 6 — structured columns, service-area outputs, the shared review
//      verdict and the REAL address-verification result are all persisted.
//    • item 7 — the Action Center kick is awaited with a short timeout and its
//      REAL outcome is returned; a silent scan failure no longer reads as
//      success. A scan failure never fails the booking.
//    • item 9 — the truck conflict check is re-run INSIDE the transaction under
//      a pg_advisory_xact_lock on (truck, ET day), so two near-simultaneous
//      creates can never both take the same truck (src/lib/truck-lock.ts).
//    • R2-2 — that guarantee was VACUOUS on the default path: the candidate
//      query only saw CONFIRMED/SCHEDULED/IN_PROGRESS while this route assigns
//      `truckId` on a PENDING_PAYMENT row (stripe_link, the default deposit
//      mode). Two creates — racing OR minutes apart — both took the same truck.
//      Candidates are now TRUCK_HOLD_STATUSES (unpaid holds included), the
//      transaction carries an explicit timeout so the lock loser gets its 409
//      instead of a P2028 500, and a cross-midnight window takes both day locks.
//    • R2-5 — an admin booking is review-gated exactly like the identical
//      public one. The estimate this route computes carries no heavy/specialty
//      input, so a piano used to land hasPiano=true with reviewReasons=[]; the
//      captured inventory's own verdict is now folded in inside
//      buildBookingCreateData (admin-booking.specialtyReviewReasons), where no
//      future call site can forget it and where it cannot move the price.
//    • R2-6 — the scan kick FORCES (the cooldown used to swallow it, and the
//      panel then claimed a coverage the code cannot know), the skip/timeout
//      copy says only what is knowable, and markLeadConverted — the last
//      unguarded post-commit step — can no longer turn a saved booking into a
//      500 the owner would answer by booking it twice.
//    • R2-7 — `customer.locale` is written only when the owner actually stated
//      a language, so converting a Spanish-speaking repeat customer's lead no
//      longer flips their emails to English.
// ════════════════════════════════════════════════════════════════════════════

/** Unapplied-migration signature (house detection, same as /api/admin/trucks):
 *  Prisma P2021/P2022 or Postgres "does not exist". Migrations are applied
 *  manually, so this answers 503 with the migration name instead of a 500. */
function isMigrationMissing(err: unknown): boolean {
  const code = (err as { code?: string })?.code
  const msg = err instanceof Error ? err.message : String(err)
  return code === 'P2021' || code === 'P2022' || /does not exist/i.test(msg)
}

/** Thrown INSIDE the booking transaction when the submitted email belongs to a
 *  different customer than the one the owner picked (correctness pass item 3).
 *  Throwing rolls the whole create back — nothing is written — and the catch
 *  below maps it to a 409 the workspace can explain. Never a silent merge of
 *  two CRM records. Route files may export only handlers, so it lives here. */
class CustomerEmailConflictError extends Error {
  readonly conflictingCustomerId: string
  constructor(message: string, conflictingCustomerId: string) {
    super(message)
    this.name = 'CustomerEmailConflictError'
    this.conflictingCustomerId = conflictingCustomerId
  }
}

// ── Truck conflict candidates: ONE query, two callers (correctness pass item 9,
//    hold statuses fixed in R2-2). The fast pre-check (before the write, for
//    the UI) and the locked re-check (inside the transaction, for the truth)
//    MUST read the same rows the same way or they could disagree about the same
//    truck — which is exactly how round 1 shipped a vacuous guarantee.
//
//    `truckCandidateWhere` / `TRUCK_CANDIDATE_SELECT` / `toTruckBookingShapes`
//    now live in src/lib/truck-conflicts.ts next to TRUCK_HOLD_STATUSES, so the
//    status list cannot be re-narrowed per caller and the query itself is
//    offline-testable (src/lib/__tests__/truck-hold.test.ts drives the real
//    two-create sequence through it).

/** Prisma interactive-transaction budget for the create below (R2-2 fix 3).
 *
 *  Prisma's defaults are maxWait 2s / timeout 5s. The FIRST statement inside
 *  this transaction is `pg_advisory_xact_lock`, which BLOCKS until the winner
 *  of a truck race commits — so under contention the loser can easily burn more
 *  than 5s and die P2028 → 500, instead of the 409 it is owed. Sized for the
 *  work actually inside: one blocking lock wait + ~8 statements (customer
 *  lookup/write, booking, inventory createMany, job + staffing upsert, 1-2
 *  audits). 20s leaves room for one full competing create to finish and still
 *  fails fast enough that a genuinely wedged connection is not held all day;
 *  10s maxWait is for pool starvation before the transaction even starts.
 *  Stripe, the lead conversion and the Action Center scan are all OUTSIDE. */
const BOOKING_TX_TIMEOUT_MS = 20_000
const BOOKING_TX_MAX_WAIT_MS = 10_000

// ── Action Center kick (correctness pass item 7 / R2-6) ──────────────────────
//
// Phase 1 fired the scan and forgot it, while the success panel claimed "scan
// kicked" unconditionally — a silent failure read as success. Now the kick is
// AWAITED (briefly) and its real ending is reported. A scan is a convenience,
// never a precondition: every failure mode here returns a report, none of them
// throws, and the booking is already committed by this point regardless.
//
// R2-6, FORCE. The kick used to run with `force: false`, so the 3-minute
// cooldown silently swallowed it — and the panel then claimed the list was
// already current, which is false for the booking that just committed (that
// earlier scan ran before this row existed). There is no cron scan yet, so
// cooldown skips are the common case, not the rare one. `force` bypasses the
// COOLDOWN only; runScan's already-running guard is untouched by it
// (decideClaim checks liveRunningExists first, whatever force says), so a
// forced kick can never start a second concurrent scan or break the advisory
// lock. Cooldown exists to stop scan STORMS from page loads; an owner-created
// booking is a real event that deserves a pass, and the already-running guard
// still bounds concurrency to one.

/** How long the create waits for the scan before answering the owner.
 *
 *  Deliberately UNCHANGED at 6s (R2-6 asked for this number to be justified or
 *  raised): the owner is on the phone with the customer when they press Book
 *  Move, and a longer block would be paid on EVERY booking to improve the copy
 *  on a slow minority. The fix for the slow case is honesty instead — a scan
 *  that outlives this keeps running server-side, is reported with reason
 *  'timeout', and the panel says "still running", not "did not run" (a red
 *  "failed" banner on every healthy-but-slow scan is what trains an owner to
 *  ignore the banner). Raise this only with evidence that healthy scans on the
 *  real dataset routinely exceed it. */
const SCAN_KICK_TIMEOUT_MS = 6000

/** @param bookingStatus the status the create actually persisted. It decides
 *  whether the success line may say this booking is covered (R3-3): the scan
 *  loads SCANNED_BOOKING_STATUSES, and both deposit modes now write a status in
 *  that list — but the claim is derived from the row, never assumed.
 *  @param bookingIsInternalTest the OTHER half of performSync's filter (P0-B).
 *  Read off the committed row rather than assumed from "this route never writes
 *  the flag": an owner checkout-test booking is excluded from every scan, so a
 *  coverage claim about one would be false however good its status looked. */
async function kickActionCenterScan(
  bookingStatus: string | null,
  bookingIsInternalTest: boolean | null,
): Promise<ScanKickReport> {
  // Settle-either-way wrapper: the scan promise is never left unhandled, so a
  // late rejection after the timeout cannot become an unhandled rejection.
  const scan = runScan({ trigger: 'API', force: true }).then(
    (outcome) => outcome as unknown,
    (err: unknown) => {
      apiLogger.warn(
        { err: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200) },
        'Admin booking: reminder scan kick failed (non-fatal)',
      )
      return err instanceof Error ? err : new Error(String(err))
    },
  )
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    const t: ReturnType<typeof setTimeout> = setTimeout(() => resolve({ timedOut: true }), SCAN_KICK_TIMEOUT_MS)
    // Do not hold the process open for the timer alone (worker/CLI contexts).
    if (typeof (t as { unref?: () => void }).unref === 'function') (t as { unref: () => void }).unref()
  })
  return describeScanOutcome(await Promise.race([scan, timeout]), { bookingStatus, bookingIsInternalTest })
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
          select: {
            id: true,
            name: true,
            isHeavy: true,
            needsDisassembly: true,
            recommendedMovers: true,
            // Category + volume drive numBoxes / estimatedCubicFeet / the
            // specialty flags on the booking (item 6) — never guessed.
            category: true,
            typicalVolumeCuFt: true,
          },
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

    // ── 5. The move schedule from the REAL start time the owner captured
    //    (correctness pass item 2). Phase 1 hardcoded 07:00 here, so Calendar,
    //    staffing times and truck conflicts all keyed off an hour nobody chose.
    //    No start time → scheduledStart/End stay null and the booking is
    //    day-level; the arrival-window text is never parsed into a timestamp.
    const schedule = resolveMoveSchedule(d.move, {
      estimatedHours: recommendation.estimatedHoursMax,
      helpers: { toInstant: etDateTimeToInstant, endTime: calculateEndTime },
    })
    const requestedDate = schedule.requestedDate
    if (!requestedDate) return NextResponse.json({ error: 'Invalid move date' }, { status: 422 })

    // ── 5b. SERVER-side address verification — the SAME call the public route
    //    makes (item 6). Degrade-safe by construction: no provider key or a
    //    timeout returns status 'skipped', which is persisted honestly. An
    //    address is NEVER recorded as verified unless the provider said so.
    //    Unlike the public form, a bad verdict never REFUSES an admin booking:
    //    the owner is on the phone and is the reviewer. It becomes a review
    //    reason on the booking (and a warning below) instead.
    let verification: { origin: VerifiedAddress | null; dest: VerifiedAddress | null } | null = null
    try {
      const [originV, destV] = await Promise.all([
        verifyAddress([composeAddress(d.move.originAddress)]),
        verifyAddress([composeAddress(d.move.destAddress)]),
      ])
      verification = { origin: originV, dest: destV }
    } catch (err) {
      // verifyAddress already swallows provider failures; this only guards an
      // unexpected throw. Unverified columns + an honest review reason beat a
      // lost booking.
      apiLogger.warn({ err: String(err).slice(0, 200) }, 'Admin booking: address verification failed (non-fatal)')
      verification = null
    }

    // ── 6. The assigned truck's row: SOURCE (RENTAL → somebody of ours picks
    //    it up and returns it, which the staffing plan records) and NAME (so a
    //    refusal can say "Truck 1 is held by…" instead of "This truck"). Read
    //    BEFORE the conflict check because the refusal below uses the name.
    //    Fail-soft: an unreadable trucks table leaves both null instead of
    //    failing the booking.
    const truckId = d.truckId ?? null
    let truckSource: string | null = null
    let truckLabel: string | null = null
    if (truckId) {
      try {
        const truck = await prisma.truck.findUnique({ where: { id: truckId }, select: { source: true, name: true } })
        truckSource = truck?.source ?? null
        truckLabel = truck?.name ?? null
      } catch (err) {
        if (!isMigrationMissing(err)) throw err
      }
    }

    // ── 6b. Truck conflict check BEFORE anything is written — the FAST path.
    //    It refuses instantly (409) with the clashing bookings so the owner can
    //    pick another truck while still on the phone, and it writes nothing.
    //    It is NOT the guarantee: a read cannot know what commits next, so the
    //    same check runs again under a (truck, ET day) advisory lock inside the
    //    transaction (step 9a, correctness pass item 9). Never a silent
    //    double-booking, before or after (hard rule).
    //
    //    R2-2: candidates are TRUCK_HOLD_STATUSES rows — which now INCLUDE the
    //    unpaid PENDING_PAYMENT hold this very route writes in the default
    //    deposit mode. Before that, this check could not see the truck it had
    //    just assigned, so the second booking of the day took it as well.
    const moveDayRange = etDayRange(0, requestedDate)
    let truckOverrideUsed = false
    if (truckId) {
      let candidates: TruckBookingShape[] = []
      try {
        const rows = await prisma.booking.findMany({
          where: truckCandidateWhere(truckId, moveDayRange),
          select: TRUCK_CANDIDATE_SELECT,
        })
        candidates = toTruckBookingShapes(rows)
      } catch (err) {
        if (!isMigrationMissing(err)) throw err
      }
      // Timed booking → interval overlap. Day-level booking → the conflict
      // lib's conservative same-ET-day rule (item 2.4): an unknown time could
      // be any time that day, so the whole day is held.
      // P0-A: the recommendation's hours are what step 8 persists as
      // Booking.estimatedHours, so the booking being created is measured by the
      // same length the stored rows it is compared against are.
      const conflicts = findAdminTruckConflicts(candidates, {
        truckId,
        scheduledStart: schedule.scheduledStart,
        scheduledEnd: schedule.scheduledEnd,
        moveDay: requestedDate,
        estimatedHours: recommendation.estimatedHoursMax,
      })
      if (conflicts.length && !d.truckConflictOverride) {
        // The message distinguishes an unpaid hold (the owner may legitimately
        // break it) from a confirmed job (a promise) — both are refusals.
        return NextResponse.json(truckConflictResponseBody(conflicts, { truckLabel }), { status: 409 })
      }
      truckOverrideUsed = conflicts.length > 0
    }

    // ── 6c. THE staffing plan (correctness pass items 1 + 4). Built ONCE from
    //    the recommendation already computed above, persisted on the booking in
    //    EVERY deposit mode, and replayed onto the requirement either here
    //    (CONFIRMED) or by approveBooking after the $49 hold is captured
    //    (stripe_link — the default, which previously produced a confirmed job
    //    with no staffing plan at all). Service-mode aware: a labor-only or
    //    customer-truck job is not staffed with a driver we are not sending.
    const staffingPlan = buildAdminStaffingPlan(d, snapshots, { recommendation, truckSource })

    // ── 7. The email a customer is looked up / created under. No email → a
    //    synthesized placeholder on the reserved `.invalid` TLD: deliberately
    //    never-deliverable, and guardedSend's validation refuses it — the
    //    HONEST behavior for a customer who never gave an address (no email can
    //    ever be claimed sent). See admin-booking.synthesizePlaceholderEmail.
    //    The customer WRITE itself happens inside the transaction below (item 3).
    const lookupEmail = d.customer.email ?? synthesizePlaceholderEmail(d.customer.phone ?? '')

    // ── 8. Build the booking data (pure). Schedule columns come from the
    //    resolved schedule; a day-level booking gets confirmedDate only.
    const status = decideStatus(d.deposit.mode)

    // ── 8a. ITEM P0-E — CREATE PREFLIGHT: fail BEFORE anything is consumed ───
    //    `buildBookingCreateData` ALWAYS writes the Moving OS columns
    //    (startTimeKnown, truckId, serviceMode, originPropertyType,
    //    destPropertyType, coiRequired, priceOverrideReason, staffingPlan), so
    //    with the SQL unapplied `tx.booking.create` fails and the interactive
    //    transaction rolls the customer write back — no booking ROW is ever
    //    written, and the catch below answers an honest 503.
    //
    //    ONE thing escaped that guarantee: `nextBookingReference()` runs
    //    OUTSIDE the transaction and is a `SELECT nextval(...)`, which Postgres
    //    never rolls back — so every refused create permanently burned a
    //    WMIC-#### number and the sequence grew with each retry.
    //
    //    This probe is a pure READ of exactly the at-risk columns (plus the
    //    tables this create would write into). It writes nothing, consumes
    //    nothing, and runs before the sequence is touched. The column list is
    //    the SHARED constant, so a future migration cannot leave it stale.
    //
    //    H1: the probe itself now lives in migration-window.checkBookingCreateReady
    //    — the SAME call the public create makes, so the two paths cannot drift
    //    into one being protected and the other not (which is exactly what had
    //    happened). Its ORDER is what makes it a guarantee, and that order is
    //    pinned by src/lib/__tests__/migration-window.test.ts § 6: this call
    //    must precede `nextBookingReference()` and every write in this file.
    //    A real outage is rethrown by the helper and handled by the catch below
    //    — only a migration-shaped failure refuses.
    const preflight = await checkBookingCreateReady({
      booking: (select) => prisma.booking.findFirst({ select: select as Prisma.BookingSelect }),
      inventoryItems: snapshots.length
        ? () => prisma.bookingInventoryItem.findFirst({ select: { id: true } })
        : null,
      staffingRequirement:
        status === 'CONFIRMED' ? () => prisma.jobStaffingRequirement.findFirst({ select: { id: true } }) : null,
    })
    if (!preflight.ready) {
      apiLogger.warn(
        { by: session.name, truckId: d.truckId ?? null, reason: preflight.reason },
        'Admin booking refused before any write: Moving OS migrations not applied (no row, no booking reference consumed)',
      )
      return NextResponse.json({ error: MIGRATION_MISSING_MESSAGE }, { status: 503 })
    }

    const reference = await nextBookingReference()
    const tokenExpiry = adminPortalTokenExpiry(requestedDate)
    const createData = buildBookingCreateData(
      d,
      {
        estimate,
        travel: {
          zone: sa.zone,
          travelFeeCents: sa.travelFeeCents,
          message: sa.message,
          manualReviewRequired: sa.manualReviewRequired,
          distanceFromWestOrangeMiles: sa.distanceFromWestOrangeMiles,
          estimatedDriveTimeMinutes: sa.estimatedDriveTimeMinutes,
          evaluatedAddresses: sa.evaluatedAddresses,
        },
        reference,
        tokenExpiry,
        requestedDate,
        schedule,
        verification,
        estimatedHours: recommendation.estimatedHoursMax,
        staffingPlan,
      },
      snapshots,
    )

    // ── 9. THE transaction: customer + booking + inventory + job + staffing +
    //    audits commit or roll back together (house rule).
    const { booking, jobId, customer, customerMode, customerWarning } = await prisma.$transaction(async (tx) => {
      // ── 9a. TRUCK LOCK (item 9). FIRST thing in the transaction, before any
      //    write: take the (truck, ET day) advisory lock and re-run the
      //    conflict check under it. The pre-check above is a read — it cannot
      //    know what commits next, so two near-simultaneous creates could both
      //    pass it and both write. Here the loser waits for the winner's
      //    transaction to end, then SEES the winner's booking and aborts with
      //    TruckDoubleBookedError → the whole create rolls back and the catch
      //    below returns the same 409 the pre-check returns.
      //    Lock scope is per (truck, ET day): unrelated bookings never wait. A
      //    window that crosses midnight ET takes BOTH day locks, in ascending
      //    key order so two such creates can never deadlock (R2-2 fix 4).
      if (truckId) {
        const lockedConflicts = await assertTruckFreeUnderLock(tx, {
          truckId,
          moveDay: requestedDate,
          scheduledStart: schedule.scheduledStart,
          scheduledEnd: schedule.scheduledEnd,
          // P0-A: the same length the pre-check used and the row will persist,
          // so the days this create LOCKS are the days its stored row is later
          // DETECTED on.
          estimatedHours: recommendation.estimatedHoursMax,
          override: !!d.truckConflictOverride,
          truckLabel,
          loadCandidates: async () => {
            try {
              const rows = await tx.booking.findMany({
                where: truckCandidateWhere(truckId, moveDayRange),
                select: TRUCK_CANDIDATE_SELECT,
              })
              return toTruckBookingShapes(rows)
            } catch (err) {
              // Unapplied migration → the same fail-soft answer the pre-check
              // gives (no candidates), so a missing column can never be
              // reported as a truck conflict. Postgres aborts a transaction on
              // a failed statement, so the create below is what actually
              // surfaces it — as the honest 503 with the migration name.
              if (isMigrationMissing(err)) return []
              throw err
            }
          },
        })
        // Conflicts survived the lock only because the owner overrode them —
        // record that on the audit even when the pre-check saw a free truck.
        if (lockedConflicts.length > 0) truckOverrideUsed = true
      }

      // ── 9b. The customer (item 3). The record the owner PICKED is
      //    authoritative: upserting by email turned every corrected or added
      //    email on a repeat customer into a second CRM record, which broke
      //    their history, lifetime value and the first-time discount logic.
      //    Blank fields never erase stored contact info; isFirstTime and the
      //    consent columns are never touched here.
      const select = { id: true, name: true, email: true, phone: true, locale: true } as const
      const pickedRow = d.customer.id
        ? await tx.customer.findUnique({ where: { id: d.customer.id }, select })
        : null
      const emailOwner = await tx.customer.findUnique({ where: { email: lookupEmail }, select })
      const mutation = resolveCustomerMutation({
        pickedId: d.customer.id,
        existing: pickedRow,
        emailOwner,
        submitted: d.customer,
        fallbackEmail: lookupEmail,
      })
      if (mutation.mode === 'conflict') {
        throw new CustomerEmailConflictError(mutation.message, mutation.conflictingCustomerId)
      }
      const customer =
        mutation.mode === 'create'
          ? await tx.customer.create({ data: mutation.data, select })
          : mutation.mode === 'update'
            ? await tx.customer.update({ where: { id: mutation.customerId }, data: mutation.data, select })
            : // 'use' — the picked/matched row already says what the owner typed.
              (pickedRow ?? emailOwner)!
      // What was written to the CRM, before and after, in this transaction.
      const customerAudit: Prisma.InputJsonObject = {
        mode: mutation.mode,
        customerId: customer.id,
        ...(mutation.mode === 'update' ? { before: mutation.before, after: mutation.data } : {}),
        ...(mutation.warning ? { warning: mutation.warning } : {}),
        ...(d.customer.id ? { pickedCustomerId: d.customer.id } : {}),
      }
      const customerWarning = mutation.warning ?? null
      const customerMode = mutation.mode

      const booking = await tx.booking.create({
        data: { customerId: customer.id, ...createData },
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
        // UNDERSTAFFED / MISSING_DRIVER can actually fire for this job. Through
        // the SHARED spine (staffing-plan.ts) — the same call approveBooking
        // makes — so this path and the stripe_link path can never diverge, and
        // it is an upsert on the unique jobId, so it stays exactly one row.
        await ensureStaffingRequirement(tx, {
          jobId: job.id,
          booking: { ...booking, inventoryItems: [] },
          plan: staffingPlan,
          createdById: session.userId,
          // Day-level scheduling stays honest: no scheduled start → no invented
          // estimatedStartAt on the requirement.
          estimatedStartAt: schedule.scheduledStart,
          estimatedEndAt: schedule.scheduledEnd,
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
            // The schedule the owner actually chose — or the honest absence of
            // one (item 2). A reader can tell a 9 AM booking from a day-level
            // one without re-deriving it from the columns.
            scheduling: schedule.dayLevel ? 'day_level' : 'timed',
            crewStartTime: schedule.startTime,
            // The CRM write this booking performed, before → after (item 3).
            // There is no CUSTOMER_* AuditAction value, and adding one needs an
            // enum migration; the mutation belongs to this booking's creation,
            // so it is recorded here, in the same transaction that made it.
            customer: customerAudit,
            ...(truckOverrideUsed
              ? { truckConflictOverride: true, truckId }
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
      return { booking, jobId, customer, customerMode, customerWarning }
    // R2-2 fix 3: explicit budget — the first statement in here BLOCKS on the
    // truck advisory lock, and Prisma's 5s default turned the race loser's
    // promised 409 into a P2028 500. See BOOKING_TX_TIMEOUT_MS.
    }, { timeout: BOOKING_TX_TIMEOUT_MS, maxWait: BOOKING_TX_MAX_WAIT_MS })

    // ── 10. Stripe hold link (stripe_link mode). OUTSIDE the tx (network) and
    //    non-fatal: the booking stands; a failed link is a warning the owner
    //    can retry, never a lost booking.
    let stripeUrl: string | null = null
    const extraWarnings: string[] = []
    if (customerWarning) extraWarnings.push(customerWarning)
    // The same review verdict that is now stored on the booking (item 6) —
    // said out loud while the owner is still on the call.
    const reviewReasons = (createData.reviewReasons as string[] | undefined) ?? []
    if (reviewReasons.length) {
      extraWarnings.push(`Flagged for owner review: ${reviewReasons.join('; ')}`)
    }
    // The resolved customer's OWN address decides reachability — picking an
    // existing customer without retyping their email is normal, and their
    // stored address is real. Only the .invalid placeholder means "no email".
    const hasRealEmail = !customer.email.endsWith('@placeholder.invalid')
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
        // ITEM P0-E — `select` on a write whose result is discarded. Without it
        // Prisma's UPDATE ... RETURNING asks for every generated column, so a
        // column the database does not have yet would throw AFTER the booking
        // was committed — and the outer catch would answer 503 for a booking
        // that exists, which is how an owner ends up booking the same job twice.
        await prisma.booking.update({
          where: { id: booking.id },
          data: { stripeCheckoutId: checkout.id },
          select: { id: true },
        })
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
      // R2-6: the ONE unguarded post-commit step. The booking is already
      // committed by here, so a lead-writer failure (unapplied lead migration,
      // a dropped connection) would have thrown out of the try and been
      // reported as a 500 — the workspace would show "failed to create the
      // booking" for a booking that exists, and the owner would book it twice.
      // Every other post-commit step (Stripe, lead-by-id, the scan) is already
      // wrapped; this one now matches. leadConverted stays false and the owner
      // is told, which is the honest degradation.
      try {
        const converted = await markLeadConverted(customer.email, booking.id)
        leadConverted = leadConverted || !!converted
      } catch (err) {
        apiLogger.warn(
          { err: String(err).slice(0, 200), bookingId: booking.id },
          'Admin booking: lead conversion by email failed (non-fatal)',
        )
        extraWarnings.push(
          'The booking is saved, but the matching lead could not be marked converted — close it by hand on /admin/leads.',
        )
      }
    }

    // ── 12. Action Center scan (item 7). AWAITED with a short timeout and
    //    REPORTED: 'completed' | 'skipped_cooldown' | 'failed'. Phase 1 fired
    //    and forgot it while the panel claimed success, so a silent failure
    //    looked identical to a healthy scan. The booking is already committed
    //    above — a scan failure can never fail the booking, it only changes
    //    what the panel truthfully says.
    //    R3-3: the COMMITTED row's status decides whether the success line may
    //    claim this booking is covered — read off the write, not assumed from
    //    the deposit mode. P0-B: and its isInternalTest flag, the other half of
    //    what performSync loads.
    const actionCenterScan = await kickActionCenterScan(booking.status, booking.isInternalTest)

    const appUrl = process.env.APP_URL ?? 'https://wmiwci-api.vercel.app'
    const warnings = [
      ...collectBookingWarnings({
        inventoryCount: snapshots.length,
        zone: sa.zone,
        serviceType: d.move.serviceType,
        truckOverrideUsed,
        dayLevelScheduling: schedule.dayLevel,
      }),
      // What the staffing plan needs the owner to know NOW (no truck on a
      // full-service move; nobody driving on a customer-truck job).
      ...planOpsWarnings(staffingPlan),
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
        // Which customer record this booking landed on, and what happened to
        // it — the workspace shows "linked to the existing customer" instead of
        // leaving the owner to wonder whether a duplicate was made (item 3).
        customerId: customer.id,
        customerMode,
        // Say plainly whether a real start time was captured (item 2).
        scheduling: schedule.dayLevel ? 'day_level' : 'timed',
        crewStartTime: schedule.startTime,
        scheduledStart: schedule.scheduledStart ? schedule.scheduledStart.toISOString() : null,
        // Surfaced for the OWNER to send manually — Phase 1 sends no customer
        // email from this flow, by design.
        portalUrl: `${appUrl}/my-booking/${booking.customerToken}`,
        stripeUrl,
        leadConverted,
        // What the Action Center kick ACTUALLY did (item 7). `state` drives the
        // panel; `reason` keeps the real ending (cooldown vs already-running vs
        // timeout vs error) instead of flattening it into a claim of success.
        actionCenterScan: actionCenterScan.state,
        actionCenterScanReason: actionCenterScan.reason,
        actionCenterScanMessage: actionCenterScan.message,
        warnings,
      },
      { status: 201 },
    )
  } catch (err) {
    // A truck that got double-booked between the pre-check and the commit —
    // caught under the advisory lock inside the transaction (item 9). The whole
    // create rolled back; the answer is the SAME 409 contract the pre-check
    // returns, so the workspace handles both identically.
    if (err instanceof TruckDoubleBookedError) {
      apiLogger.warn(
        { conflicts: err.conflicts.length },
        'Admin booking: truck conflict detected under the lock (create rolled back)',
      )
      return NextResponse.json(
        truckConflictResponseBody(err.conflicts, { truckLabel: err.truckLabel }),
        { status: 409 },
      )
    }
    // The transaction ran out of budget (P2028) — with the truck lock inside,
    // the likeliest cause is a create ahead of us holding this truck's day lock
    // for an unusually long time. NOTHING was written (the transaction rolled
    // back), so say that plainly and let the owner retry, instead of a bare 500
    // that reads as "your booking may or may not exist" (R2-2 fix 3).
    if ((err as { code?: string })?.code === 'P2028') {
      apiLogger.warn({ truckId: d.truckId ?? null }, 'Admin booking: transaction budget exceeded (create rolled back)')
      return NextResponse.json(
        { error: 'The booking could not be completed in time — nothing was saved. Another booking may be holding this truck; try again.' },
        { status: 503 },
      )
    }
    // The picked customer vs a different customer's email — the owner decides.
    if (err instanceof CustomerEmailConflictError) {
      return NextResponse.json(
        { error: err.message, conflictingCustomerId: err.conflictingCustomerId },
        { status: 409 },
      )
    }
    if (isMigrationMissing(err)) {
      return NextResponse.json(
        {
          error:
            'Moving OS tables/columns missing — apply migrations 20260811000000_moving_os_phase1, 20260812000000_staffing_plan and 20260812010000_start_time_known',
        },
        { status: 503 },
      )
    }
    apiLogger.error({ err: err instanceof Error ? err.message : String(err) }, 'Admin booking create failed')
    return NextResponse.json({ error: 'Failed to create the booking' }, { status: 500 })
  }
}
