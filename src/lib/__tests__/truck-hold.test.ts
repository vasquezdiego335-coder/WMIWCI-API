// ============================================================================
// R2-2 / R3-4 — THE TRUCK GUARANTEE, ON THE ROW THE SHIPPED WRITER PERSISTS.
//
// Round 1 shipped a green truck-race test over a live defect: it injected
// CONFIRMED candidate rows by hand, so it proved the guard refuses what it is
// GIVEN — never that the create can SEE what it just wrote. Round 2 fixed the
// statuses and then made the same class of mistake one level down: its fixture
// stamped `scheduledStart` on a PENDING_PAYMENT row, which
// `buildBookingCreateData` NEVER writes (the schedule columns ride the
// CONFIRMED branch only). That invented column is what let the file assert
// `time_overlap` where production yields `same_day_unknown_times`, and it is
// exactly what concealed R3-4: an unknown-time hold whose 6h window runs past
// midnight was only ever compared on ONE ET day.
//
// THE ROUND-3 RULE, mechanised: every stored row here comes out of
// `buildBookingCreateData` (fed by the REAL zod schema + the REAL
// resolveMoveSchedule), and `persistedRow` ASSERTS that a non-CONFIRMED create
// carries no schedule columns. A fixture can no longer describe a row the route
// cannot produce — if the writer changes, these rows change with it.
//
// The rest is the route, step for step: the fast pre-check
// (findAdminTruckConflicts over truckCandidateWhere/TRUCK_CANDIDATE_SELECT/
// toTruckBookingShapes against a fake table) and the locked re-check
// (assertTruckFreeUnderLock). Nothing is hand-fed: create #1 commits a row,
// create #2 has to find it.
//
// ── P0-A: THE LAST HAND-TYPED INPUT WAS THE ONE HIDING THE DEFECT ───────────
// Round 3 took every row from the shipped writer and then fed that writer a
// typed-in `ESTIMATED_HOURS = 4`, under a comment claiming it was "what the
// Book Move assistant recommends for this payload". The payload is a 2BR and
// `recommendEstimate('2br').estimatedHoursMax` is 6 — so the ONE input this
// file invented was also the one that made the defect unreachable: 4h + the
// 60-minute buffer is 5h, SHORTER than the 6h fallback, so no fixture here
// could ever produce a hold the flat fallback did not already cover. A green
// 56-check suite over a live cross-midnight double-booking.
//
// The hours now come from `recommendEstimate` over the SAME parsed payload the
// route calls it with (route.ts step 3 → step 8's `estimatedHours`), so the
// fixture cannot disagree with production about how long a job is.
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  TRUCK_CANDIDATE_SELECT,
  TRUCK_FALLBACK_HOURS,
  TRUCK_HOLD_STATUSES,
  TRUCK_PENDING_HOLD_STATUSES,
  etDayKey,
  holdsTruck,
  isPendingTruckHold,
  toTruckBookingShapes,
  truckCandidateWhere,
  truckConflictBetween,
  truckHoldHours,
  truckOccupiedEtDays,
  type TruckBookingShape,
} from '../truck-conflicts'
import {
  AdminBookingSchema,
  buildBookingCreateData,
  findAdminTruckConflicts,
  resolveMoveSchedule,
  type AdminBookingInput,
  type DepositMode,
} from '../admin-booking'
import {
  TruckDoubleBookedError,
  assertTruckFreeUnderLock,
  truckConflictMessage,
  truckConflictResponseBody,
  truckDayLockKey,
  truckDayLockKeys,
  truckWindowDayKeys,
  type TruckLockTx,
} from '../truck-lock'
import { calculateEndTime, etDateTimeToInstant, etDayRange } from '../scheduling'
import { computeEstimate } from '../estimate'
import { recommendEstimate } from '../estimate-assistant'
import { evaluateBooking, evaluateTruckOverlaps, type RuleBooking } from '../reminder-rules'

const TRUCK = 'truck_16ft'
const TRUCK_NAME = 'Truck 1'
const REPO_ROOT = join(__dirname, '..', '..', '..')

// ── A fake bookings table that honours the REAL `where` object ───────────────
//
// It implements exactly the operators truckCandidateWhere emits: equality on
// truckId/isInternalTest, `status: { in: [...] }`, and the OR of three
// coalescing date-range clauses. That is what makes this a test of the QUERY —
// a narrowed status list silently drops rows here, just as Postgres would.

interface DbRow {
  id: string
  displayId: string
  truckId: string | null
  isInternalTest: boolean
  scheduledStart: Date | null
  scheduledEnd: Date | null
  confirmedDate: Date | null
  requestedDate: Date | null
  status: string
  /** Persisted on EVERY deposit mode (buildBookingCreateData). A column the
   *  candidate `select` does not name is a column the guard cannot read — the
   *  projection below models exactly that. */
  estimatedHours: number | null
}

type RangeCond = { gte: Date; lte: Date }
type Clause = Record<string, null | RangeCond>

function clauseMatches(row: DbRow, clause: Clause): boolean {
  for (const [field, cond] of Object.entries(clause)) {
    const value = row[field as keyof DbRow] as Date | null
    if (cond === null) {
      if (value !== null) return false
      continue
    }
    if (!value) return false
    if (value.getTime() < cond.gte.getTime() || value.getTime() > cond.lte.getTime()) return false
  }
  return true
}

class FakeBookings {
  readonly rows: DbRow[] = []

  insert(row: DbRow): void {
    this.rows.push(row)
  }

  /** The `select` projection matters: displayId is what names the clashing
   *  booking in the refusal, so the test only ever sees selected columns. */
  findMany(where: ReturnType<typeof truckCandidateWhere>): Array<Record<string, unknown>> {
    const keys = Object.keys(TRUCK_CANDIDATE_SELECT)
    return this.rows
      .filter((r) => {
        if (r.truckId !== where.truckId) return false
        if (r.isInternalTest !== where.isInternalTest) return false
        if (!(where.status.in as readonly string[]).includes(r.status)) return false
        return (where.OR as Clause[]).some((c) => clauseMatches(r, c))
      })
      .map((r) => Object.fromEntries(keys.map((k) => [k, r[k as keyof DbRow]])))
  }
}

const fakeTx = (lockKeys: bigint[]): TruckLockTx => ({
  $queryRaw(_query: TemplateStringsArray, ...values: unknown[]) {
    lockKeys.push(values[0] as bigint)
    return Promise.resolve([{ pg_advisory_xact_lock: '' }])
  },
})

// ── The SHIPPED WRITER builds every row (the round-3 rule) ───────────────────

const HELPERS = { toInstant: etDateTimeToInstant, endTime: calculateEndTime }
// EDT (UTC-4). MoveSchema refuses a past date, so these are deliberately in the
// future — the same convention day-level-scheduling.test.ts uses.
const MOVE_DAY = '2027-08-15'
const NEXT_DAY = '2027-08-16'
const TWO_DAYS_LATER = '2027-08-17'
const DAY_ANCHOR = new Date('2027-08-15T00:00:00-04:00')
const NINE_AM = new Date('2027-08-15T09:00:00-04:00')
const NINE_PM = new Date('2027-08-15T21:00:00-04:00')

/** The hours the SHIPPED assistant recommends for a package — the number
 *  route.ts step 3 computes and step 8 persists as `Booking.estimatedHours`.
 *  Never typed in here (that constant is what hid P0-A). */
const hoursFor = (serviceType: string): number =>
  recommendEstimate({ serviceType, inventory: [] }).estimatedHoursMax

interface CreateSpec {
  id: string
  /** WMIC-#### — the reference the atomic counter handed the route. */
  reference?: string
  moveDate?: string
  /** MOVE_SIZES key. Drives the assistant's recommended hours, which is what
   *  makes one job's truck hold longer than another's. */
  serviceType?: string
  /** 'HH:MM' ET. OMITTED = the owner took the job without a crew hour, which is
   *  the default on the phone → day-level scheduling. */
  startTime?: string
  /** stripe_link (THE default) → PENDING_PAYMENT; collect_on_day/waived →
   *  CONFIRMED. decideStatus owns this — the test never picks a status. */
  deposit?: DepositMode
  truckId?: string | null
  override?: boolean
  /** NOT written by this route at all (only the owner rehearsal path sets it),
   *  so a test that wants it has to say so out loud. */
  isInternalTest?: boolean
  /** Runs between the pre-check and the transaction — how a concurrent create
   *  commits "in between" without any real threads. */
  onAfterPrecheck?: () => Promise<void>
}

function adminPayload(spec: CreateSpec): AdminBookingInput {
  const truckId = spec.truckId === undefined ? TRUCK : spec.truckId
  const body = {
    customer: { name: 'Maria Lopez', phone: '(973) 555-0100' },
    move: {
      serviceType: spec.serviceType ?? '2br',
      moveDate: spec.moveDate ?? MOVE_DAY,
      ...(spec.startTime ? { startTime: spec.startTime } : {}),
      originAddress: { street: '12 Main St', city: 'Newark', state: 'NJ', zip: '07102' },
      destAddress: { street: '99 Oak Ave', city: 'Montclair', state: 'NJ', zip: '07042' },
    },
    services: { serviceMode: 'full_service' },
    inventory: [],
    ...(truckId ? { truckId } : {}),
    ...(spec.override ? { truckConflictOverride: true } : {}),
    deposit: { mode: spec.deposit ?? 'stripe_link' },
    pricing: { ownerTotal: 700, overrideReason: 'phone quote' },
  }
  const parsed = AdminBookingSchema.safeParse(body)
  assert.ok(parsed.success, `fixture must satisfy the real schema: ${JSON.stringify(parsed.error?.flatten())}`)
  return parsed.data
}

/** What POST /api/admin/bookings computes for this payload: the resolved
 *  schedule it checks the truck against, and the Booking.create data it
 *  persists. Both from the shipped functions — nothing reimplemented. */
function shippedWrite(spec: CreateSpec) {
  const input = adminPayload(spec)
  // Step 3 of the route: the assistant's recommendation for THIS payload. Its
  // estimatedHoursMax is both what resolveMoveSchedule turns into scheduledEnd
  // and what buildBookingCreateData persists as Booking.estimatedHours.
  const estimatedHours = hoursFor(input.move.serviceType ?? '2br')
  const schedule = resolveMoveSchedule(input.move, { estimatedHours, helpers: HELPERS })
  assert.ok(schedule.requestedDate, 'the move date must resolve')
  const data = buildBookingCreateData(
    input,
    {
      estimate: computeEstimate({ serviceType: input.move.serviceType, travelFeeCents: 0 }),
      travel: { zone: 'primary', travelFeeCents: 0 },
      reference: spec.reference ?? 'WMIC-1042',
      tokenExpiry: new Date('2027-12-31T00:00:00.000Z'),
      requestedDate: schedule.requestedDate,
      schedule,
      estimatedHours,
    },
    [],
  )
  return { input, schedule, data, estimatedHours }
}

const asDate = (v: unknown): Date | null => (v instanceof Date ? v : typeof v === 'string' ? new Date(v) : null)

/** The stored row, read off buildBookingCreateData's output — plus the columns
 *  the route does not set, which stay at their schema defaults.
 *
 *  THE ASSERTIONS ARE THE POINT (R3-4 fix 2): a create that is not CONFIRMED
 *  persists NO schedule columns, so a hold's move instant lives in
 *  `requestedDate` alone. Round 2's fixture wrote a scheduledStart there and
 *  every classification downstream was fiction. */
function persistedRow(spec: CreateSpec, data: ReturnType<typeof shippedWrite>['data']): DbRow {
  const row: DbRow = {
    id: spec.id,
    displayId: String(data.displayId),
    truckId: (data.truckId as string | null | undefined) ?? null,
    isInternalTest: spec.isInternalTest ?? false,
    scheduledStart: asDate(data.scheduledStart),
    scheduledEnd: asDate(data.scheduledEnd),
    confirmedDate: asDate(data.confirmedDate),
    requestedDate: asDate(data.requestedDate),
    status: String(data.status),
    estimatedHours: (data.estimatedHours as number | null | undefined) ?? null,
  }
  assert.ok(row.requestedDate, 'every admin create persists a requestedDate')
  // P0-A: the length of the job IS stored on the unpaid hold — the guard's
  // problem was never a missing column, it was four layers that dropped it.
  assert.ok(row.estimatedHours && row.estimatedHours > 0, 'every admin create persists estimatedHours')
  if (row.status !== 'CONFIRMED') {
    assert.equal(row.scheduledStart, null, 'the writer persists no scheduledStart outside the CONFIRMED branch')
    assert.equal(row.scheduledEnd, null, 'the writer persists no scheduledEnd outside the CONFIRMED branch')
    assert.equal(row.confirmedDate, null, 'the writer persists no confirmedDate outside the CONFIRMED branch')
  }
  return row
}

const writtenRow = (spec: CreateSpec): DbRow => persistedRow(spec, shippedWrite(spec).data)

type CreateResult =
  | { ok: true; lockKeys: bigint[]; row: DbRow }
  | { ok: false; status: number; body: ReturnType<typeof truckConflictResponseBody>; phase: 'pre_check' | 'locked' }

/**
 * The truck-relevant slice of POST /api/admin/bookings, step for step:
 *   6b  fast pre-check (a read, refuses with 409, writes nothing)
 *   9a  advisory lock + re-check INSIDE the transaction
 *   9c  the booking row commits
 * Same helpers, same order, same 409 body builder as the route — including the
 * asymmetry that matters: the checks use the IN-MEMORY schedule (which knows
 * the start time on every deposit mode), while the row that COMMITS keeps a
 * start time only when it is created CONFIRMED.
 */
async function createBooking(db: FakeBookings, spec: CreateSpec): Promise<CreateResult> {
  const { schedule, data, estimatedHours } = shippedWrite(spec)
  const row = persistedRow(spec, data)
  const lockKeys: bigint[] = []
  const truckId = row.truckId
  const requestedDate = row.requestedDate!

  if (truckId) {
    const query = truckCandidateWhere(truckId, etDayRange(0, requestedDate))
    const candidates = () => toTruckBookingShapes(db.findMany(query) as never)

    // ── step 6b: the fast pre-check
    const conflicts = findAdminTruckConflicts(candidates(), {
      truckId,
      scheduledStart: schedule.scheduledStart,
      scheduledEnd: schedule.scheduledEnd,
      moveDay: requestedDate,
      estimatedHours,
    })
    if (conflicts.length && !spec.override) {
      return { ok: false, status: 409, body: truckConflictResponseBody(conflicts, { truckLabel: TRUCK_NAME }), phase: 'pre_check' }
    }

    if (spec.onAfterPrecheck) await spec.onAfterPrecheck()

    // ── step 9a: the locked re-check
    try {
      await assertTruckFreeUnderLock(fakeTx(lockKeys), {
        truckId,
        moveDay: requestedDate,
        scheduledStart: schedule.scheduledStart,
        scheduledEnd: schedule.scheduledEnd,
        estimatedHours,
        override: !!spec.override,
        truckLabel: TRUCK_NAME,
        loadCandidates: async () => candidates(),
      })
    } catch (err) {
      if (err instanceof TruckDoubleBookedError) {
        // The transaction rolls back — NOTHING is written.
        return { ok: false, status: 409, body: truckConflictResponseBody(err.conflicts, { truckLabel: err.truckLabel }), phase: 'locked' }
      }
      throw err
    }
  }

  db.insert(row)
  return { ok: true, lockKeys, row }
}

/** A LATER lifecycle move (deposit paid, approved, completed, cancelled). Only
 *  the status column changes — the schedule columns stay exactly as the writer
 *  left them, which is what those rows really look like in the database. */
function transition(db: FakeBookings, id: string, status: string): void {
  const row = db.rows.find((r) => r.id === id)
  assert.ok(row, `no such booking: ${id}`)
  row.status = status
}

const SECOND = { id: 'bk_2', reference: 'WMIC-1043' } as const

// ── THE DEFECT ───────────────────────────────────────────────────────────────

test('R2-2 DEFECT: a PENDING_PAYMENT booking holding a truck refuses the SECOND create on that truck+day', async () => {
  const db = new FakeBookings()

  // Create #1 — the default owner path. The truck is assigned; the customer
  // has not paid the $49 hold yet, so the row is PENDING_PAYMENT.
  const first = await createBooking(db, { id: 'bk_1', startTime: '09:00' })
  assert.equal(first.ok, true, 'the first booking takes the truck')
  assert.equal(db.rows.length, 1)
  assert.equal(db.rows[0].status, 'PENDING_PAYMENT')
  assert.equal(db.rows[0].truckId, TRUCK)
  // The row production actually holds the truck with: a move instant in
  // requestedDate and NO start column. Round 2's fixture invented one here.
  assert.equal(db.rows[0].scheduledStart, null)
  assert.equal(db.rows[0].requestedDate?.getTime(), NINE_AM.getTime())

  // Create #2 — SEQUENTIAL, minutes later, same truck, same ET day, an
  // overlapping window. Round 1 let this through: the candidate query could
  // not see a PENDING_PAYMENT row, so both bookings took truck 1 and nothing
  // noticed until both were approved.
  const second = await createBooking(db, { ...SECOND, startTime: '12:00' })
  assert.equal(second.ok, false, 'the second create MUST be refused — the truck is held')
  if (second.ok) return
  assert.equal(second.status, 409)
  assert.equal(second.phase, 'pre_check', 'the fast path should already refuse it')
  assert.equal(second.body.conflicts.length, 1)
  assert.equal(second.body.conflicts[0].bookingId, 'bk_1')
  assert.equal(second.body.conflicts[0].hold, 'pending')
  // THE HONEST CLASSIFICATION (R3-4 fix 2): the held row has no persisted start
  // time, so this is the conservative whole-day rule, not an interval overlap.
  // Round 2 asserted 'time_overlap' — only reachable with its invented column.
  assert.equal(second.body.conflicts[0].reason, 'same_day_unknown_times')
  // …and nothing was written.
  assert.equal(db.rows.length, 1, 'a refused create writes nothing')
})

test('R2-2 DEFECT (day-level): the default admin booking has no start time and still holds the whole ET day', async () => {
  const db = new FakeBookings()
  // Day-level + stripe_link — the two defaults together. requestedDate is the
  // 00:00 ET anchor and scheduledStart stays null (R2-1).
  const first = await createBooking(db, { id: 'bk_1' })
  assert.equal(first.ok, true)
  if (!first.ok) return
  assert.equal(first.row.requestedDate?.getTime(), DAY_ANCHOR.getTime())

  // A timed 9 AM job on the same truck that day: unknown times are held
  // conservatively for the whole day.
  const second = await createBooking(db, { ...SECOND, startTime: '09:00' })
  assert.equal(second.ok, false)
  if (second.ok) return
  assert.equal(second.body.conflicts[0].reason, 'same_day_unknown_times')
  assert.equal(second.body.conflicts[0].hold, 'pending')
  assert.equal(db.rows.length, 1)
})

test('a CONFIRMED create DOES persist its hour — and clashes as a real interval overlap', async () => {
  const db = new FakeBookings()
  // collect_on_day → decideStatus says CONFIRMED → the schedule columns ride
  // along, so this is the one shape where the precise interval rule applies.
  const first = await createBooking(db, { id: 'bk_1', startTime: '09:00', deposit: 'collect_on_day' })
  assert.equal(first.ok, true)
  if (!first.ok) return
  assert.equal(first.row.status, 'CONFIRMED')
  assert.equal(first.row.scheduledStart?.getTime(), NINE_AM.getTime())
  // The assistant's hours for a 2BR (6) + the 60-minute house buffer → 16:00.
  // Computed by the shipped calculateEndTime, not typed in.
  assert.equal(first.row.scheduledEnd?.getTime(), calculateEndTime(NINE_AM, hoursFor('2br')).getTime())
  assert.equal(first.row.scheduledEnd?.getTime(), new Date('2027-08-15T16:00:00-04:00').getTime())

  const second = await createBooking(db, { ...SECOND, startTime: '12:00' })
  assert.equal(second.ok, false)
  if (second.ok) return
  assert.equal(second.body.conflicts[0].reason, 'time_overlap')
  assert.equal(second.body.conflicts[0].hold, 'confirmed')

  // A job that starts after this one's window is genuinely free.
  const later = await createBooking(db, { id: 'bk_3', reference: 'WMIC-1044', startTime: '17:00', deposit: 'collect_on_day' })
  assert.equal(later.ok, true, 'a non-overlapping timed job on a timed day is not a conflict')
})

test('R2-2 concurrency: two creates that BOTH pass the pre-check — only one commits', async () => {
  const db = new FakeBookings()
  let winner: CreateResult | null = null

  // B pre-checks against an empty table (free truck), then A commits in the
  // gap, then B's locked re-check runs. This is the race the advisory lock
  // exists for — and it only bites because the candidate query can now SEE A's
  // PENDING_PAYMENT row.
  const loser = await createBooking(db, {
    id: 'bk_b',
    reference: 'WMIC-2002',
    startTime: '12:00',
    onAfterPrecheck: async () => {
      winner = await createBooking(db, { id: 'bk_a', reference: 'WMIC-2001', startTime: '09:00' })
    },
  })

  assert.ok(winner && (winner as CreateResult).ok, 'the winner commits')
  assert.equal(loser.ok, false, 'the loser must be refused under the lock')
  if (loser.ok) return
  assert.equal(loser.status, 409)
  assert.equal(loser.phase, 'locked', 'the pre-check saw a free truck; the LOCK caught it')
  assert.equal(loser.body.conflicts[0].bookingId, 'bk_a')
  assert.equal(db.rows.length, 1, 'exactly one booking holds the truck')
  assert.equal(db.rows[0].id, 'bk_a')
})

test('R2-2: PENDING_APPROVAL (paid, awaiting the owner) holds the truck too', async () => {
  const db = new FakeBookings()
  await createBooking(db, { id: 'bk_1', startTime: '09:00' })
  // The $49 hold is paid: the row moves to PENDING_APPROVAL and NOTHING else
  // changes — approveBooking writes the schedule columns later.
  transition(db, 'bk_1', 'PENDING_APPROVAL')
  assert.equal(db.rows[0].scheduledStart, null)

  const second = await createBooking(db, { ...SECOND, startTime: '12:00' })
  assert.equal(second.ok, false)
  if (second.ok) return
  assert.equal(second.body.conflicts[0].hold, 'pending')
})

test('R2-2: a finished or abandoned booking never holds a truck', async () => {
  // Each gets a fresh table so the second create is only ever arguing with
  // that one row. (DRAFT is not reachable from this writer — the predicate
  // test below covers it.)
  for (const status of ['COMPLETED', 'CANCELLED', 'ARCHIVED']) {
    const db = new FakeBookings()
    await createBooking(db, { id: 'bk_1', startTime: '09:00' })
    transition(db, 'bk_1', status)
    const second = await createBooking(db, { ...SECOND, startTime: '12:00' })
    assert.equal(second.ok, true, `${status} must not hold the truck`)
    assert.equal(db.rows.length, 2)
  }
})

test('R2-2: an internal test booking never holds a real truck', async () => {
  const db = new FakeBookings()
  await createBooking(db, { id: 'bk_1', startTime: '09:00', isInternalTest: true })
  const second = await createBooking(db, { ...SECOND, startTime: '12:00' })
  assert.equal(second.ok, true)
})

test('R2-2: a different truck, and the same truck the next day, stay free', async () => {
  const db = new FakeBookings()
  await createBooking(db, { id: 'bk_1', startTime: '09:00' })
  const otherTruck = await createBooking(db, { ...SECOND, startTime: '09:00', truckId: 'truck_26ft' })
  assert.equal(otherTruck.ok, true)
  const tomorrow = await createBooking(db, { id: 'bk_3', reference: 'WMIC-1044', moveDate: NEXT_DAY, startTime: '09:00' })
  assert.equal(tomorrow.ok, true)
})

test('R2-2: the owner can still deliberately double-book — and it is reported', async () => {
  const db = new FakeBookings()
  await createBooking(db, { id: 'bk_1', startTime: '09:00' })
  const second = await createBooking(db, { ...SECOND, startTime: '12:00', override: true })
  assert.equal(second.ok, true, 'truckConflictOverride is the explicit, audited escape hatch')
  assert.equal(db.rows.length, 2)
})

// ── R3-4: THE UNKNOWN-TIME SIDE ALSO CROSSES MIDNIGHT ────────────────────────
//
// A 9 PM 2BR hold runs to 4 AM the next ET day (6 estimated hours + the house
// buffer; before P0-A it was the flat 6h fallback, to 3 AM). The LOCKING
// half always knew that (truckWindowDayKeys walks the window); the DETECTION
// half compared one ET day per side, so the guard silently weakened for exactly
// the rows the default path writes — and round 2's invented scheduledStart hid
// it, because with a start column the interval rule caught the clash anyway.

test('R3-4: a 9 PM unpaid hold refuses a 00:30 create the NEXT ET day', async () => {
  const db = new FakeBookings()
  const first = await createBooking(db, { id: 'bk_1', startTime: '21:00' })
  assert.equal(first.ok, true)
  if (!first.ok) return
  // Production's row: no start column, the evening instant in requestedDate.
  assert.equal(first.row.scheduledStart, null)
  assert.equal(first.row.requestedDate?.getTime(), NINE_PM.getTime())

  const second = await createBooking(db, { ...SECOND, moveDate: NEXT_DAY, startTime: '00:30' })
  assert.equal(second.ok, false, 'the hold runs to 4 AM — 00:30 the next day is inside it')
  if (second.ok) return
  assert.equal(second.body.conflicts[0].bookingId, 'bk_1')
  assert.equal(second.body.conflicts[0].reason, 'same_day_unknown_times')
  assert.equal(second.body.conflicts[0].hold, 'pending')
  assert.equal(db.rows.length, 1, 'nothing was written')
})

test('R3-4: the unpaid hold and its CONFIRMED twin now give the SAME answer', async () => {
  // The defect in one assertion: byte-identical jobs, different deposit modes.
  // The CONFIRMED one persists scheduledStart and was refused by the interval
  // check; the PENDING_PAYMENT one keyed to a single ET day and was waved
  // through. Both must refuse — the classification may differ (a hold has no
  // known hour), the ANSWER may not.
  const results: Record<string, CreateResult> = {}
  for (const deposit of ['stripe_link', 'collect_on_day'] as DepositMode[]) {
    const db = new FakeBookings()
    const first = await createBooking(db, { id: 'bk_1', startTime: '21:00', deposit })
    assert.equal(first.ok, true)
    results[deposit] = await createBooking(db, { ...SECOND, moveDate: NEXT_DAY, startTime: '00:30' })
    assert.equal(db.rows.length, 1, `${deposit}: the second create must write nothing`)
  }
  for (const [deposit, res] of Object.entries(results)) {
    assert.equal(res.ok, false, `${deposit} must refuse the cross-midnight create`)
    if (res.ok) continue
    assert.equal(res.status, 409)
    assert.equal(res.body.conflicts[0].bookingId, 'bk_1')
  }
  const pending = results.stripe_link
  const confirmed = results.collect_on_day
  assert.ok(!pending.ok && !confirmed.ok)
  if (pending.ok || confirmed.ok) return
  assert.equal(pending.body.conflicts[0].reason, 'same_day_unknown_times')
  assert.equal(confirmed.body.conflicts[0].reason, 'time_overlap')
})

test('R3-4: a DAY-LEVEL create the next day is refused by the evening hold too', async () => {
  // The other branch of findAdminTruckConflicts: with no start time the create
  // is compared as unknown-times against the candidate, so BOTH sides of that
  // comparison have to know the hold reaches into Aug 16. Before R3-4 the
  // candidate collapsed to Aug 15 and this create — the single most common
  // shape the owner produces on the phone — was waved through.
  const db = new FakeBookings()
  await createBooking(db, { id: 'bk_1', startTime: '21:00' })
  const dayLevelNextDay = await createBooking(db, { ...SECOND, moveDate: NEXT_DAY })
  assert.equal(dayLevelNextDay.ok, false, 'a day-level create must see the hold that runs into its day')
  if (dayLevelNextDay.ok) return
  assert.equal(dayLevelNextDay.body.conflicts[0].bookingId, 'bk_1')
  assert.equal(dayLevelNextDay.body.conflicts[0].reason, 'same_day_unknown_times')
  assert.equal(db.rows.length, 1)
})

test('R3-4: the widened window is BOUNDED — a hold does not reach a day it cannot touch', async () => {
  const db = new FakeBookings()
  await createBooking(db, { id: 'bk_1', startTime: '21:00' })
  // Two days on: a 7h hold cannot possibly reach it.
  const far = await createBooking(db, { id: 'bk_2', reference: 'WMIC-1043', moveDate: TWO_DAYS_LATER, startTime: '09:00' })
  assert.equal(far.ok, true, 'a bounded window, not "any nearby day"')
  // Same ET day, but the morning after an evening hold that ended at 4 AM…
  const db2 = new FakeBookings()
  await createBooking(db2, { id: 'bk_1', startTime: '21:00' })
  const morningAfter = await createBooking(db2, { ...SECOND, moveDate: NEXT_DAY, startTime: '09:00' })
  // …is STILL refused: the hold has no known hour, so the whole ET day it
  // touches is held. Conservative by design — the same rule R2-2 pinned.
  assert.equal(morningAfter.ok, false)
})

test('R3-4: a basis-only row occupies exactly the days its timed twin does', () => {
  const timed = { scheduledStart: NINE_PM, scheduledEnd: null, confirmedDate: null }
  const basisOnly = { scheduledStart: null, scheduledEnd: null, confirmedDate: NINE_PM }
  assert.deepEqual(truckOccupiedEtDays(basisOnly), ['2027-08-15', '2027-08-16'])
  assert.deepEqual(truckOccupiedEtDays(basisOnly), truckOccupiedEtDays(timed))
  // DETECTION now derives the span from the same walk the LOCK uses, so the
  // days a booking is checked against are the days it is locked on.
  assert.deepEqual(
    truckWindowDayKeys({ moveDay: NINE_PM, scheduledStart: NINE_PM, scheduledEnd: null }),
    truckOccupiedEtDays(basisOnly),
  )
  // A 00:00 ET day anchor still occupies exactly one day (00:00–06:00).
  assert.deepEqual(truckOccupiedEtDays({ scheduledStart: null, scheduledEnd: null, confirmedDate: DAY_ANCHOR }), ['2027-08-15'])
  // No date at all → nothing to collide with.
  assert.deepEqual(truckOccupiedEtDays({ scheduledStart: null, scheduledEnd: null, confirmedDate: null }), [])
  // …and the pairwise rule agrees: a 00:30 job the next day hits the hold.
  const nextMorning = new Date('2027-08-16T00:30:00-04:00')
  assert.equal(
    truckConflictBetween(basisOnly, { scheduledStart: nextMorning, scheduledEnd: null, confirmedDate: null }),
    'same_day_unknown_times',
  )
  // A day-level anchor cannot reach the next day.
  assert.equal(
    truckConflictBetween({ scheduledStart: null, scheduledEnd: null, confirmedDate: DAY_ANCHOR }, { scheduledStart: nextMorning, scheduledEnd: null, confirmedDate: null }),
    null,
  )
})

// ── P0-A: THE HOLD IS AS LONG AS THE JOB ─────────────────────────────────────
//
// R3-4 made a hold's DAY SPAN honest; its LENGTH was still a flat 6 hours for
// every row without a stored scheduledEnd — i.e. for every row the default
// `stripe_link` create writes. An 18:00 4BR runs to 03:00 and a 20:00 studio
// does not, and the guard could not tell them apart. 18:00 + 6h lands exactly
// on 00:00, and etDaysCovered is half-open, so the 4BR collapsed to ONE ET day
// and the 01:00 create the next morning was waved through — while its
// byte-identical `collect_on_day` twin (which stores scheduledEnd) was refused.

test('P0-A: an 18:00 4BR unpaid hold refuses the 01:00 create the NEXT ET day', async () => {
  const db = new FakeBookings()
  const first = await createBooking(db, { id: 'bk_1', serviceType: '4br', startTime: '18:00' })
  assert.equal(first.ok, true)
  if (!first.ok) return
  // The row production actually writes: the move instant in requestedDate, no
  // schedule columns — and the job's real length in estimatedHours.
  assert.equal(first.row.status, 'PENDING_PAYMENT')
  assert.equal(first.row.scheduledStart, null)
  assert.equal(first.row.scheduledEnd, null)
  assert.equal(first.row.estimatedHours, hoursFor('4br'))
  assert.equal(first.row.requestedDate?.getTime(), new Date('2027-08-15T18:00:00-04:00').getTime())
  // 8h + the 60-minute buffer = 9h > the 6h fallback, so the hold reaches 03:00.
  assert.ok(truckHoldHours({ estimatedHours: first.row.estimatedHours }) > TRUCK_FALLBACK_HOURS)
  assert.deepEqual(truckOccupiedEtDays(toTruckBookingShapes([first.row] as never)[0]), ['2027-08-15', '2027-08-16'])

  const second = await createBooking(db, { ...SECOND, moveDate: NEXT_DAY, startTime: '01:00' })
  assert.equal(second.ok, false, 'the 4BR runs to 03:00 — a 01:00 create the next day is inside its hold')
  if (second.ok) return
  assert.equal(second.status, 409)
  assert.equal(second.body.conflicts[0].bookingId, 'bk_1')
  assert.equal(second.body.conflicts[0].hold, 'pending')
  assert.equal(db.rows.length, 1, 'a refused create writes nothing')
})

test('P0-A: an unpaid hold is never WEAKER than its confirmed twin, over the whole grid', async () => {
  // THE DEFECT, as the owner described it: byte-identical jobs, opposite
  // answers. Only `deposit.mode` differs — which decides whether the schedule
  // columns are persisted, and therefore (before P0-A) whether the guard knew
  // how long the job was. Every package × every start hour, second create at
  // 01:00 the next ET day.
  //
  // THE INVARIANT, measured rather than assumed: an unpaid hold may never
  // ACCEPT what its confirmed twin REFUSES. That is the direction that costs
  // money — it is exactly what an 18:00 4BR did before this fix (pending
  // accepted, confirmed refused). The reverse IS allowed and does occur:
  // a stored scheduledEnd is a precise window, while a hold has no committed
  // hour and falls under the conservative whole-ET-day rule (R2-2/R3-4), so at
  // the exact boundary — e.g. a 2BR 18:00 whose confirmed window ends at 01:00
  // — the hold refuses and the confirmed job does not. Stricter for the row we
  // know less about is the safe asymmetry.
  const violations: string[] = []
  const answersFor = async (job: { serviceType: string; startTime: string }, deposit: DepositMode) => {
    const db = new FakeBookings()
    const first = await createBooking(db, { id: 'bk_1', ...job, deposit })
    assert.equal(first.ok, true, `${JSON.stringify(job)}/${deposit}: the first create takes the truck`)
    const second = await createBooking(db, { ...SECOND, moveDate: NEXT_DAY, startTime: '01:00' })
    assert.equal(db.rows.length, second.ok ? 2 : 1, 'a refused create writes nothing')
    return second.ok
  }
  for (const serviceType of ['little-studio', '1br', '2br', '3br', '4br', '5br']) {
    for (const startTime of ['09:00', '15:00', '17:00', '18:00', '20:00', '21:00']) {
      const job = { serviceType, startTime }
      const pending = await answersFor(job, 'stripe_link')
      const confirmed = await answersFor(job, 'collect_on_day')
      if (pending && !confirmed) {
        violations.push(`${serviceType} @ ${startTime}: unpaid hold ACCEPTED what the confirmed twin REFUSED`)
      }
    }
  }
  assert.deepEqual(violations, [], violations.join('\n'))
})

test('P0-A: the owner\'s cases — long evening jobs refuse in BOTH deposit modes', async () => {
  // The headline scenario and its neighbours, where the estimated window runs
  // strictly past 01:00 so both modes must refuse. (Named explicitly so the
  // grid above cannot go quietly all-permissive and still pass.)
  for (const job of [
    { serviceType: '4br', startTime: '18:00' }, // the owner's case: 18:00 → 03:00
    { serviceType: '5br', startTime: '18:00' }, // 18:00 → 05:00
    { serviceType: '4br', startTime: '17:00' }, // 17:00 → 02:00
    { serviceType: '5br', startTime: '15:00' }, // 15:00 → 02:00
    { serviceType: '3br', startTime: '18:00' }, // an ORDINARY three-bedroom
  ]) {
    for (const deposit of ['stripe_link', 'collect_on_day'] as DepositMode[]) {
      const db = new FakeBookings()
      await createBooking(db, { id: 'bk_1', ...job, deposit })
      const second = await createBooking(db, { ...SECOND, moveDate: NEXT_DAY, startTime: '01:00' })
      assert.equal(second.ok, false, `${job.serviceType} @ ${job.startTime} (${deposit}) must refuse the 01:00 create`)
      assert.equal(db.rows.length, 1, 'a refused create writes nothing')
    }
  }
  // …and the widened hold must not swallow the next day whole: a MORNING job
  // frees its truck long before midnight, in both modes.
  for (const deposit of ['stripe_link', 'collect_on_day'] as DepositMode[]) {
    const db = new FakeBookings()
    await createBooking(db, { id: 'bk_1', serviceType: '4br', startTime: '09:00', deposit })
    const second = await createBooking(db, { ...SECOND, moveDate: NEXT_DAY, startTime: '01:00' })
    assert.equal(second.ok, true, `a 09:00 job (${deposit}) does not hold the next ET day`)
  }
})

test('P0-A: the estimate can only LENGTHEN a hold, never shrink one', async () => {
  // max(), not "replace": a little-studio's 3h estimate + the 1h buffer is 4h,
  // SHORTER than the fallback. A hold that occupies two ET days today must
  // still occupy them — this is the assertion that fails if someone swaps the
  // fallback out for the estimate instead of taking the larger.
  const db = new FakeBookings()
  const first = await createBooking(db, { id: 'bk_1', serviceType: 'little-studio', startTime: '20:00' })
  assert.equal(first.ok, true)
  if (!first.ok) return
  assert.ok(hoursFor('little-studio') + 1 < TRUCK_FALLBACK_HOURS, 'the fixture must be a job SHORTER than the fallback')
  assert.equal(truckHoldHours({ estimatedHours: first.row.estimatedHours }), TRUCK_FALLBACK_HOURS)
  assert.deepEqual(truckOccupiedEtDays(toTruckBookingShapes([first.row] as never)[0]), ['2027-08-15', '2027-08-16'])
  const nextMorning = await createBooking(db, { ...SECOND, moveDate: NEXT_DAY, startTime: '01:00' })
  assert.equal(nextMorning.ok, false, 'the 6h floor still holds the next ET day')
  assert.equal(db.rows.length, 1)
})

test('P0-A: the days a booking is LOCKED on are the days it is DETECTED on', async () => {
  // The acceptance in one assertion. The lock is taken from the create's
  // IN-MEMORY schedule; detection reads the STORED row. They derive their day
  // spans from one function (truckHoldHours → etDaysCovered), so the lock can
  // never serialize a narrower window than the check can find a conflict in.
  const specs: CreateSpec[] = [
    { id: 'l1', serviceType: '4br', startTime: '18:00' },
    { id: 'l2', serviceType: '4br', startTime: '18:00', deposit: 'collect_on_day' },
    { id: 'l3', serviceType: '5br', startTime: '15:00' },
    { id: 'l4', serviceType: 'little-studio', startTime: '20:00' },
    { id: 'l5', serviceType: '2br', startTime: '09:00' },
    { id: 'l6', serviceType: '2br' }, // day-level — the phone default
    { id: 'l7', serviceType: '5br' },
  ]
  for (const spec of specs) {
    const { schedule, data, estimatedHours } = shippedWrite(spec)
    const row = persistedRow(spec, data)
    const locked = truckWindowDayKeys({
      moveDay: row.requestedDate,
      scheduledStart: schedule.scheduledStart,
      scheduledEnd: schedule.scheduledEnd,
      estimatedHours,
    })
    const detected = truckOccupiedEtDays(toTruckBookingShapes([row] as never)[0])
    for (const day of detected) {
      assert.ok(
        locked.includes(day),
        `${spec.id}: detection claims ${day} but the lock does not cover it (locked=${locked}, detected=${detected})`,
      )
    }
    // On the DEFAULT path (the row with no stored schedule columns) the two are
    // exactly equal — same start, same derived length.
    if (row.status !== 'CONFIRMED') {
      assert.deepEqual(locked, detected, `${spec.id}: lock and detection must agree on the default path`)
    }
  }
})

test('P0-A: findAdminTruckConflicts measures the BOOKING BEING CREATED by its own length too', () => {
  // Both branches of the admin wrapper, driven directly — the route always
  // hands it a scheduledEnd for a timed create, so these are the exported
  // contract's own callers (an edit flow, a future caller) rather than the
  // create path. Without the parameter each falls back to the flat 6h window.
  const candidate: TruckBookingShape = {
    id: 'bk_night', displayId: 'WMIC-2001', truckId: TRUCK,
    scheduledStart: new Date('2027-08-16T01:00:00-04:00'),
    scheduledEnd: new Date('2027-08-16T08:00:00-04:00'),
    confirmedDate: null, status: 'CONFIRMED', estimatedHours: 6,
  }
  const evening = new Date('2027-08-15T18:00:00-04:00')
  // TIMED branch, no end supplied: an 8h job runs to 03:00 and hits the 01:00
  // booking; the same call with no hours stops at midnight and does not.
  assert.equal(
    findAdminTruckConflicts([candidate], { truckId: TRUCK, scheduledStart: evening, scheduledEnd: null, moveDay: evening, estimatedHours: 8 }).length,
    1,
  )
  assert.equal(
    findAdminTruckConflicts([candidate], { truckId: TRUCK, scheduledStart: evening, scheduledEnd: null, moveDay: evening }).length,
    0,
  )
  // DAY-LEVEL branch. Within the assistant's real ceiling (HOURS_MAX 12) the
  // answer here can never depend on the hours — the anchor is 00:00 ET, so a
  // 13h hold ends at 13:00 the same day and the conservative whole-day rule
  // already covers it. What IS observable is that the number is threaded
  // through at all, and that MAX_TRUCK_HOLD_HOURS bounds a data-error value
  // instead of letting it run away across the calendar.
  const anchor = new Date('2027-08-15T00:00:00-04:00')
  const dayLevel = (estimatedHours?: number) =>
    findAdminTruckConflicts([candidate], { truckId: TRUCK, scheduledStart: null, scheduledEnd: null, moveDay: anchor, estimatedHours })
  assert.equal(dayLevel(12).length, 0, 'a real day-level job does not reach the next ET day')
  assert.equal(dayLevel(30).length, 1, 'a 30h data-error estimate is clamped to 24h + the buffer — one day over, not four')
  assert.equal(dayLevel().length, 0)
})

test('P0-A: the candidate query carries the column the window needs', () => {
  // The column was saved and then dropped four times over between the database
  // and the guard. Two of those four are structural and worth pinning: a
  // `select` that does not name it, and a mapper that does not carry it.
  assert.equal((TRUCK_CANDIDATE_SELECT as Record<string, boolean>).estimatedHours, true)
  const [shape] = toTruckBookingShapes([
    {
      id: 'bk_x', displayId: 'WMIC-9', truckId: TRUCK,
      scheduledStart: null, scheduledEnd: null, confirmedDate: null,
      requestedDate: new Date('2027-08-15T18:00:00-04:00'), status: 'PENDING_PAYMENT', estimatedHours: 8,
    },
  ])
  assert.equal(shape.estimatedHours, 8)
  // A row read WITHOUT the column (an older caller, a partial select) degrades
  // to the pre-P0-A behaviour rather than throwing or inventing a length.
  const [legacy] = toTruckBookingShapes([
    { id: 'bk_y', truckId: TRUCK, scheduledStart: null, scheduledEnd: null, confirmedDate: null, requestedDate: NINE_PM, status: 'CONFIRMED' },
  ])
  assert.equal(legacy.estimatedHours, null)
  assert.equal(truckHoldHours(legacy), TRUCK_FALLBACK_HOURS)
})

// ── R3-3 fix 2: the Action Center rule reads the same row ────────────────────
//
// The truck-double-booked rule maps RuleBookings through `toTruckShape`, which
// dropped `requestedDate` while `basisOf` coalesced only scheduledStart →
// confirmedDate. A PENDING_PAYMENT hold has neither, so every pending row was
// discarded at the `!!basis` filter — the rule could not have fired even once
// the loader started supplying them (R3-3 fix 1).

/** reminder-sync.performSync's mapping for the columns this rule reads; every
 *  other RuleBooking field is neutral filler no truck rule looks at. */
function ruleBookingFrom(row: DbRow, customerName: string): RuleBooking {
  return {
    id: row.id,
    displayId: row.displayId,
    status: row.status,
    customerName,
    customerPhone: '+19735550100',
    customerEmail: 'maria@example.com',
    originAddress: '12 Main St, Newark, NJ 07102',
    destAddress: '99 Oak Ave, Montclair, NJ 07042',
    originVerification: null,
    destVerification: null,
    manualReviewRequired: false,
    agreementAccepted: true,
    totalEstimate: 700,
    scheduledStart: row.scheduledStart,
    scheduledEnd: row.scheduledEnd,
    requestedDate: row.requestedDate,
    completedAt: null,
    truckAddonDueOnMoveDay: false,
    truckProvider: null,
    truckReservationStatus: null,
    truckReservationNumber: null,
    jobStartedAt: null,
    truckId: row.truckId,
    confirmedDate: row.confirmedDate,
    // P0-A: the scan's booking query is an `include` (every scalar is already
    // loaded), so the rule shape can carry the job's real length — without it
    // the Action Center inherits the same 6h collapse the create-time guard had.
    estimatedHours: row.estimatedHours,
    startTimeKnown: !!row.scheduledStart,
    crew: [],
    hasFailedPayment: false,
    hasWorkerPayExpense: false,
    outstandingBalanceCents: 0,
    netRevenueCents: 0,
    netProfitCents: 0,
  }
}

test('R3-3: the truck rule fires on two PENDING_PAYMENT holds (the rows the loader now supplies)', () => {
  const now = new Date('2027-08-14T12:00:00-04:00')
  const a = ruleBookingFrom(writtenRow({ id: 'bk_1', startTime: '09:00' }), 'Maria Lopez')
  const b = ruleBookingFrom(writtenRow({ id: 'bk_2', reference: 'WMIC-1043', startTime: '12:00' }), 'Sam Ortiz')
  assert.equal(a.scheduledStart, null, 'the fixture is the shipped row: no start column')
  assert.equal(a.confirmedDate, null)

  const candidates = evaluateTruckOverlaps([a, b], now)
  assert.equal(candidates.length, 1, 'a pending hold must not be discarded for having no scheduledStart')
  assert.equal(candidates[0].reminderType, 'truck-double-booked')
  assert.equal(candidates[0].severity, 'CRITICAL')
  assert.match(candidates[0].title, /2027-08-15/)
  assert.match(candidates[0].description, /Maria Lopez \(unpaid hold\)/)
  assert.match(candidates[0].description, /Sam Ortiz \(unpaid hold\)/)
  assert.match(candidates[0].description, /None of them is paid or approved yet/)
  assert.equal(candidates[0].dueAt?.getTime(), NINE_AM.getTime(), 'due at the earliest move instant we know')
  // The day bucket comes from the SAME basis chain, so one truck-day is one
  // reminder however many rows collide on it.
  assert.equal(candidates[0].dedupeKey, `truck-double-booked:truck:${TRUCK}:2027-08-15`)
})

test('R3-3: widening the loader to PENDING_PAYMENT does not add booking-rule noise', () => {
  // The loader change (SCANNED_BOOKING_STATUSES gained PENDING_PAYMENT) feeds
  // unpaid holds to EVERY rule, not just the truck one. reminder-sync's comment
  // claims the other booking rules skip them; this is that claim, checked
  // against the row the writer actually persists instead of asserted in prose.
  const now = new Date('2027-08-14T12:00:00-04:00')
  const hold = ruleBookingFrom(writtenRow({ id: 'bk_1', startTime: '09:00' }), 'Maria Lopez')
  assert.equal(hold.status, 'PENDING_PAYMENT', 'the default create is an unpaid hold')

  // A clean unpaid hold is SILENT: no missing-address nag, no approval-overdue,
  // no no-crew alarm — none of that is true or actionable before the deposit.
  assert.deepEqual(evaluateBooking(hold, now), [])

  // The two rules that are NOT status-gated only speak when a real defect
  // exists, and then they are right to.
  const failed = evaluateBooking({ ...hold, hasFailedPayment: true }, now)
  assert.deepEqual(failed.map((c) => c.reminderType), ['payment-failed'], 'a failed deposit IS the owner\'s business')
  const doubleCount = evaluateBooking(
    { ...hold, hasWorkerPayExpense: true, crew: [{ userId: 'u1', userName: 'Ana', payStatus: 'PENDING', payMethod: null, flatPay: 200, payRate: null, userPayRate: null, actualHours: null, scheduledHours: null }] },
    now,
  )
  assert.deepEqual(doubleCount.map((c) => c.reminderType), ['worker-pay-double-count'])

  // The whole point of the widening: the truck rule DOES see it.
  const other = ruleBookingFrom(writtenRow({ id: 'bk_2', reference: 'WMIC-1043', startTime: '12:00' }), 'Sam Ortiz')
  assert.equal(evaluateTruckOverlaps([hold, other], now).length, 1)
})

test('R3-3: a pending hold and a confirmed job on one truck are still one reminder', () => {
  const now = new Date('2027-08-14T12:00:00-04:00')
  const hold = ruleBookingFrom(writtenRow({ id: 'bk_1', startTime: '09:00' }), 'Maria Lopez')
  const job = ruleBookingFrom(
    writtenRow({ id: 'bk_2', reference: 'WMIC-1043', startTime: '12:00', deposit: 'collect_on_day' }),
    'Sam Ortiz',
  )
  assert.ok(job.scheduledStart, 'the CONFIRMED row does carry its hour')
  const candidates = evaluateTruckOverlaps([hold, job], now)
  assert.equal(candidates.length, 1)
  assert.match(candidates[0].description, /One of them is only an unpaid hold/)
  // Two bookings on DIFFERENT trucks never collide, whatever their dates.
  assert.equal(evaluateTruckOverlaps([hold, { ...job, truckId: 'truck_26ft' }], now).length, 0)
})

test('P0-A: the Action Center still catches a cross-midnight pair that got committed', () => {
  // THE BACKSTOP. The create-time guard is what PREVENTS this pair; the rule is
  // what finds it when it got there another way (an audited override, a truck
  // reassignment, a hand-edited status). Before P0-A the rule inherited the
  // same flat 6h hold, so nothing anywhere noticed the double-booking — not at
  // create time, not afterwards, right up to move day.
  const now = new Date('2027-08-14T12:00:00-04:00')
  const evening = ruleBookingFrom(writtenRow({ id: 'bk_1', serviceType: '4br', startTime: '18:00' }), 'Maria Lopez')
  const nextMorning = ruleBookingFrom(
    writtenRow({ id: 'bk_2', reference: 'WMIC-1043', moveDate: NEXT_DAY, startTime: '01:00' }),
    'Sam Ortiz',
  )
  assert.equal(evening.scheduledStart, null, 'both are the rows the writer really persists')
  assert.equal(evening.estimatedHours, hoursFor('4br'))

  const candidates = evaluateTruckOverlaps([evening, nextMorning], now)
  assert.equal(candidates.length, 1, 'two unpaid holds sharing one truck across midnight IS a double-booking')
  assert.equal(candidates[0].reminderType, 'truck-double-booked')
  assert.equal(candidates[0].severity, 'CRITICAL')
  assert.match(candidates[0].description, /Maria Lopez \(unpaid hold\)/)
  assert.match(candidates[0].description, /Sam Ortiz \(unpaid hold\)/)

  // …and the widened hold does NOT invent alarms where the real times are
  // known: two CONFIRMED rows carry their windows, so the 4BR's 18:00–03:00 job
  // clashes with a 02:00 job the next morning and not with the 09:00 one.
  const confirmedEvening = ruleBookingFrom(
    writtenRow({ id: 'bk_4', serviceType: '4br', startTime: '18:00', deposit: 'collect_on_day' }),
    'Maria Lopez',
  )
  assert.ok(confirmedEvening.scheduledEnd, 'a CONFIRMED create stores its real window')
  const early = ruleBookingFrom(
    writtenRow({ id: 'bk_5', reference: 'WMIC-1044', moveDate: NEXT_DAY, startTime: '02:00', deposit: 'collect_on_day' }),
    'Dana Reed',
  )
  const midMorning = ruleBookingFrom(
    writtenRow({ id: 'bk_6', reference: 'WMIC-1045', moveDate: NEXT_DAY, startTime: '09:00', deposit: 'collect_on_day' }),
    'Dana Reed',
  )
  assert.equal(evaluateTruckOverlaps([confirmedEvening, early], now).length, 1)
  assert.equal(evaluateTruckOverlaps([confirmedEvening, midMorning], now).length, 0)
})

// ── The candidate query itself ───────────────────────────────────────────────

test('the candidate query filters on TRUCK_HOLD_STATUSES — the one list', () => {
  const where = truckCandidateWhere(TRUCK, etDayRange(0, NINE_AM))
  assert.deepEqual(where.status.in, [...TRUCK_HOLD_STATUSES])
  // The exact statuses round 1 was missing.
  assert.ok(where.status.in.includes('PENDING_PAYMENT'))
  assert.ok(where.status.in.includes('PENDING_APPROVAL'))
  for (const dead of ['DRAFT', 'COMPLETED', 'CANCELLED', 'ARCHIVED']) {
    assert.ok(!(where.status.in as readonly string[]).includes(dead), `${dead} must not hold a truck`)
  }
  assert.equal(where.truckId, TRUCK)
  assert.equal(where.isInternalTest, false)
  // ±1 ET day so an overnight job on either side is still a candidate.
  const { start, end } = etDayRange(0, NINE_AM)
  const first = where.OR[0] as { scheduledStart: { gte: Date; lte: Date } }
  assert.equal(first.scheduledStart.gte.getTime(), start.getTime() - 86_400_000)
  assert.equal(first.scheduledStart.lte.getTime(), end.getTime() + 86_400_000)
  // The third clause is the one a PENDING_PAYMENT hold matches — no
  // scheduledStart, no confirmedDate, only a requestedDate.
  const third = where.OR[2] as { scheduledStart: null; confirmedDate: null; requestedDate: { gte: Date; lte: Date } }
  assert.equal(third.scheduledStart, null)
  assert.equal(third.confirmedDate, null)
  assert.ok(third.requestedDate.gte instanceof Date)
})

test('hold predicates agree with the constant, and pending ⊂ hold', () => {
  for (const s of TRUCK_HOLD_STATUSES) assert.equal(holdsTruck(s), true)
  for (const s of TRUCK_PENDING_HOLD_STATUSES) {
    assert.equal(isPendingTruckHold(s), true)
    assert.ok((TRUCK_HOLD_STATUSES as readonly string[]).includes(s), 'a pending hold must be a hold')
  }
  for (const s of ['DRAFT', 'COMPLETED', 'CANCELLED', 'ARCHIVED', 'NONSENSE']) {
    assert.equal(holdsTruck(s), false)
    assert.equal(isPendingTruckHold(s), false)
  }
  // Live statuses are holds but not PENDING ones (they drive the firmer copy).
  for (const s of ['CONFIRMED', 'SCHEDULED', 'IN_PROGRESS']) {
    assert.equal(holdsTruck(s), true)
    assert.equal(isPendingTruckHold(s), false)
  }
})

test('every truck caller reads the shared constant (no per-caller status copies)', () => {
  // The defect was a SECOND copy of the status list living next to a caller.
  // These are code lines, not prose: the trucks busy indicator and the trucks
  // page both spread TRUCK_HOLD_STATUSES, and the booking route builds its
  // candidate query with the shared builder.
  const trucksRoute = readFileSync(join(REPO_ROOT, 'app', 'api', 'admin', 'trucks', 'route.ts'), 'utf8')
  assert.ok(trucksRoute.includes('status: { in: [...TRUCK_HOLD_STATUSES] }'), 'the busy indicator must use TRUCK_HOLD_STATUSES')
  const trucksPage = readFileSync(join(REPO_ROOT, 'app', '(admin)', 'admin', '(dashboard)', 'trucks', 'page.tsx'), 'utf8')
  assert.ok(trucksPage.includes('status: { in: [...TRUCK_HOLD_STATUSES] }'), 'the trucks page must use TRUCK_HOLD_STATUSES')
  const bookingsRoute = readFileSync(join(REPO_ROOT, 'app', 'api', 'admin', 'bookings', 'route.ts'), 'utf8')
  assert.ok(bookingsRoute.includes('where: truckCandidateWhere(truckId, moveDayRange)'), 'the booking route must use the shared candidate query')
})

test('P0-A: the two truck surfaces this file cannot execute still carry the length', () => {
  // Neither of these can be driven offline (one needs Prisma + a session, the
  // other is performSync's loader), so they get SOURCE guards — with a
  // stripper that is PROVEN to work first, because a guard satisfied by a
  // comment is how round 3 shipped three green ones over a live defect.
  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

  // 1. The scan's row mapper. `ruleBookingFrom` above claims to mirror it; this
  //    is what stops that claim from drifting into fiction.
  const syncRaw = readFileSync(join(REPO_ROOT, 'src', 'lib', 'reminder-sync.ts'), 'utf8')
  const syncCode = strip(syncRaw)
  const SYNC_COMMENT = 'The truck-double-booked rule derives'
  assert.ok(syncRaw.includes(SYNC_COMMENT), 'fixture check: the comment is in the raw file')
  assert.ok(!syncCode.includes(SYNC_COMMENT), 'the stripper must strip')
  assert.ok(syncCode.includes('const ruleBookings'), 'the stripper must keep the code')
  assert.match(syncCode, /estimatedHours: b\.estimatedHours/, 'the Action Center loader must carry estimatedHours')

  // 2. The Book Move workspace busy indicator. It must decide which trucks are
  //    busy on a day with the SAME window derivation the create refuses on —
  //    otherwise it offers the owner a truck the create will reject.
  const trucksCode = strip(readFileSync(join(REPO_ROOT, 'app', 'api', 'admin', 'trucks', 'route.ts'), 'utf8'))
  assert.match(trucksCode, /estimatedHours: true/, 'the busy indicator must select the hours')
  assert.match(trucksCode, /truckOccupiedEtDays\(/, 'the busy indicator must use the shared day derivation')
})

test('P0-A: the ROUTE hands both truck checks the job\'s estimated hours', () => {
  // Everything above drives the shipped LIBRARY functions; this is the wiring
  // in between, which no behavioural test in this file can reach. The two call
  // sites are the fast pre-check (step 6b) and the locked re-check (step 9a) —
  // if either one stops passing the hours, its half of the guard silently goes
  // back to the flat 6h hold.
  const raw = readFileSync(join(REPO_ROOT, 'app', 'api', 'admin', 'bookings', 'route.ts'), 'utf8')
  // Line-start comment stripper (so `https://` inside a string survives), and
  // then PROVE it worked before asserting anything with it: a stripper that is
  // a silent no-op is how round 3 shipped source guards satisfied by comments.
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  assert.ok(raw.includes('P0-A: the recommendation'), 'fixture check: the comment exists in the raw file')
  assert.ok(!code.includes('P0-A: the recommendation'), 'the comment stripper must actually strip comments')
  assert.ok(code.includes('findAdminTruckConflicts'), 'the stripper must keep the code')

  const argsOf = (marker: string, chars = 500): string => {
    const i = code.indexOf(marker)
    assert.ok(i >= 0, `${marker} not found in the route`)
    return code.slice(i, i + chars)
  }
  for (const marker of ['findAdminTruckConflicts(candidates, {', 'assertTruckFreeUnderLock(tx, {']) {
    assert.match(
      argsOf(marker),
      /estimatedHours: recommendation\.estimatedHoursMax/,
      `${marker} must pass the estimated hours the create persists`,
    )
  }
  // …and it must be the SAME number the row is written with (step 8), not a
  // second opinion computed for the guard alone.
  assert.match(argsOf('const createData = buildBookingCreateData(', 1200), /estimatedHours: recommendation\.estimatedHoursMax/)
})

// ── The pending-vs-confirmed message (R2-2 fix 2) ────────────────────────────

test('the refusal names the truck, the booking and the day — and says WHICH kind of hold', async () => {
  const pendingDb = new FakeBookings()
  await createBooking(pendingDb, { id: 'bk_1', startTime: '09:00' })
  const vsPending = await createBooking(pendingDb, { ...SECOND, startTime: '12:00' })
  assert.equal(vsPending.ok, false)
  if (vsPending.ok) return

  const confirmedDb = new FakeBookings()
  await createBooking(confirmedDb, { id: 'bk_1', startTime: '09:00', deposit: 'collect_on_day' })
  const vsConfirmed = await createBooking(confirmedDb, { ...SECOND, startTime: '12:00' })
  assert.equal(vsConfirmed.ok, false)
  if (vsConfirmed.ok) return

  // Both refuse…
  assert.equal(vsPending.status, 409)
  assert.equal(vsConfirmed.status, 409)
  // …but they do NOT say the same thing.
  assert.notEqual(vsPending.body.error, vsConfirmed.body.error)
  assert.match(vsPending.body.error, /held by an unpaid booking/i)
  assert.match(vsPending.body.error, /not paid or approved yet/i)
  assert.match(vsConfirmed.body.error, /already booked/i)
  assert.doesNotMatch(vsConfirmed.body.error, /unpaid/i)
  // Both name the truck, the clashing booking (from the selected displayId)
  // and the ET day, and both offer the same way out. The day is named from the
  // basis chain, so a hold with no start column still says "Aug 15".
  for (const body of [vsPending.body, vsConfirmed.body]) {
    assert.match(body.error, /Truck 1/)
    assert.match(body.error, /WMIC-1042/)
    assert.match(body.error, /Aug 15/)
    assert.match(body.error, /truckConflictOverride/)
  }
  assert.equal(vsPending.body.conflicts[0].hold, 'pending')
  assert.equal(vsConfirmed.body.conflicts[0].hold, 'confirmed')
})

test('P0-A: a refusal that blocks TOMORROW says why', async () => {
  // With a hold as long as the job, an 18:00 4BR legitimately blocks the next
  // ET morning. Naming only the clashing job's own day would read as a non
  // sequitur to an owner who is booking Aug 16 — and an owner who does not
  // understand a refusal overrides it.
  const db = new FakeBookings()
  await createBooking(db, { id: 'bk_1', serviceType: '4br', startTime: '18:00' })
  const nextMorning = await createBooking(db, { ...SECOND, moveDate: NEXT_DAY, startTime: '01:00' })
  assert.equal(nextMorning.ok, false)
  if (nextMorning.ok) return
  assert.match(nextMorning.body.error, /on Aug 15, running into Aug 16/)
  assert.match(nextMorning.body.error, /WMIC-1042/)

  // A same-day refusal keeps the exact wording it has today: the clause appears
  // only when the window really does cross midnight.
  const sameDay = new FakeBookings()
  await createBooking(sameDay, { id: 'bk_1', startTime: '09:00' })
  const noon = await createBooking(sameDay, { ...SECOND, startTime: '12:00' })
  assert.equal(noon.ok, false)
  if (noon.ok) return
  assert.doesNotMatch(noon.body.error, /running into/)
  assert.match(noon.body.error, /on Aug 15 — not paid or approved yet/)
})

test('a mixed clash (one unpaid hold + one confirmed job) uses the firmer copy', () => {
  const shape = (over: Partial<TruckBookingShape>): TruckBookingShape => ({
    id: 'bk_x', displayId: 'WMIC-9', truckId: TRUCK,
    scheduledStart: NINE_AM, scheduledEnd: null, confirmedDate: null, status: 'CONFIRMED', ...over,
  })
  const msg = truckConflictMessage(
    [
      { booking: shape({ id: 'a', displayId: 'WMIC-1', status: 'PENDING_PAYMENT' }), reason: 'time_overlap', hold: 'pending' },
      { booking: shape({ id: 'b', displayId: 'WMIC-2', status: 'CONFIRMED' }), reason: 'time_overlap', hold: 'confirmed' },
    ],
    { truckLabel: TRUCK_NAME },
  )
  assert.match(msg, /already booked/i)
  assert.match(msg, /WMIC-1, WMIC-2/)
  // Without a truck name the copy still reads: "This truck is …".
  assert.match(truckConflictMessage([{ booking: shape({ status: 'PENDING_PAYMENT' }), reason: 'time_overlap', hold: 'pending' }]), /^This truck is held by an unpaid booking/)
  // A row with no displayId falls back to the id — never a blank.
  assert.match(truckConflictMessage([{ booking: shape({ displayId: null, id: 'ckabc' }), reason: 'time_overlap', hold: 'confirmed' }]), /ckabc/)
})

// ── Cross-midnight: two locks, deterministic order (R2-2 fix 4) ──────────────

test('a window crossing midnight ET takes BOTH day locks, lowest key first', async () => {
  const db = new FakeBookings()
  // 9 PM ET start → the hold (6 estimated hours + the house buffer) runs to
  // 4 AM the next day. (The create knows the hour even though a stripe_link row
  // does not persist it — the lock is taken from the in-memory schedule.)
  const res = await createBooking(db, { id: 'bk_1', startTime: '21:00' })
  assert.equal(res.ok, true)
  if (!res.ok) return

  const expected = [truckDayLockKey(TRUCK, '2027-08-15'), truckDayLockKey(TRUCK, '2027-08-16')].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  assert.equal(res.lockKeys.length, 2, 'both ET days must be locked')
  assert.deepEqual(res.lockKeys, expected)
  // ASCENDING key order is the deadlock proof: every transaction asks in the
  // same global order, so two cross-midnight creates can never hold half of
  // each other's pair.
  assert.ok(res.lockKeys[0] < res.lockKeys[1])
})

test('a same-day window takes exactly ONE lock (nothing extra serializes)', async () => {
  const db = new FakeBookings()
  const res = await createBooking(db, { id: 'bk_1', startTime: '09:00' })
  assert.equal(res.ok, true)
  if (!res.ok) return
  assert.deepEqual(res.lockKeys, [truckDayLockKey(TRUCK, '2027-08-15')])
})

test('truckWindowDayKeys: half-open windows, day-level bookings and DST', () => {
  const day = (s: string) => new Date(s)
  // Ends exactly at midnight ET → does NOT reach into the next day. (18:00 with
  // the 6h fallback lands exactly on 00:00, so neither the stored window nor
  // the derived hold crosses.)
  assert.deepEqual(
    truckWindowDayKeys({ moveDay: day('2027-08-15T18:00:00-04:00'), scheduledStart: day('2027-08-15T18:00:00-04:00'), scheduledEnd: day('2027-08-16T00:00:00-04:00') }),
    ['2027-08-15'],
  )
  // One millisecond past midnight → both days.
  assert.deepEqual(
    truckWindowDayKeys({ moveDay: day('2027-08-15T18:00:00-04:00'), scheduledStart: day('2027-08-15T18:00:00-04:00'), scheduledEnd: day('2027-08-16T00:00:00.001-04:00') }),
    ['2027-08-15', '2027-08-16'],
  )
  // P0-A: the lock takes the LATER of the stored window and the derived hold,
  // so it can never be narrower than the span detection derives from the stored
  // row. A 20:00 start with a 4h in-memory window still locks both ET days,
  // because the same row — persisted as an unpaid hold with no scheduledEnd —
  // is DETECTED over the 6h floor (20:00 → 02:00).
  assert.deepEqual(
    truckWindowDayKeys({ moveDay: day('2027-08-15T20:00:00-04:00'), scheduledStart: day('2027-08-15T20:00:00-04:00'), scheduledEnd: day('2027-08-16T00:00:00-04:00') }),
    ['2027-08-15', '2027-08-16'],
  )
  // …and a long job's own estimate widens it the same way with no stored end
  // at all: an 18:00 4BR (8h + the 1h buffer) runs to 03:00.
  assert.deepEqual(
    truckWindowDayKeys({ moveDay: day('2027-08-15T18:00:00-04:00'), scheduledStart: day('2027-08-15T18:00:00-04:00'), scheduledEnd: null, estimatedHours: 8 }),
    ['2027-08-15', '2027-08-16'],
  )
  // Day-level (no start time): just the move day — the conservative same-day
  // rule already holds all of it. The longest job the assistant will recommend
  // (12h + the buffer) still ends at 13:00 ET, so a real estimate never widens
  // it; only a data-error value could, and then the lock follows detection
  // instead of lagging behind it.
  assert.deepEqual(truckWindowDayKeys({ moveDay: DAY_ANCHOR, scheduledStart: null }), ['2027-08-15'])
  assert.deepEqual(truckWindowDayKeys({ moveDay: DAY_ANCHOR, scheduledStart: null, estimatedHours: 12 }), ['2027-08-15'])
  assert.deepEqual(
    truckWindowDayKeys({ moveDay: DAY_ANCHOR, scheduledStart: null, estimatedHours: 30 }),
    truckOccupiedEtDays({ scheduledStart: null, scheduledEnd: null, confirmedDate: DAY_ANCHOR, estimatedHours: 30 }),
  )
  // A window longer than a day never skips the middle day.
  assert.deepEqual(
    truckWindowDayKeys({ moveDay: day('2027-08-15T08:00:00-04:00'), scheduledStart: day('2027-08-15T08:00:00-04:00'), scheduledEnd: day('2027-08-17T10:00:00-04:00') }),
    ['2027-08-15', '2027-08-16', '2027-08-17'],
  )
  // DST: 1 AM EST on the spring-forward day belongs to that ET day, and the
  // 6h hold that crosses the 02:00 jump still lands on the same day.
  const springForward = new Date('2027-03-14T01:00:00-05:00')
  assert.deepEqual(truckWindowDayKeys({ moveDay: springForward, scheduledStart: springForward, scheduledEnd: null }), ['2027-03-14'])
  assert.equal(etDayKey(springForward), '2027-03-14')
})

test('truckDayLockKeys is deterministic and deduplicated across a midnight window', () => {
  const opts = { truckId: TRUCK, moveDay: NINE_PM, scheduledStart: NINE_PM, scheduledEnd: null }
  const a = truckDayLockKeys(opts)
  const b = truckDayLockKeys({ ...opts, moveDay: new Date('2027-08-15T23:30:00-04:00') })
  assert.deepEqual(a, b, 'any instant inside the same ET day derives the same keys')
  assert.equal(new Set(a.map(String)).size, a.length, 'no duplicate keys')
  // Two different trucks sort into ONE global order — that is what makes the
  // ordering rule deadlock-free system-wide, not just per truck.
  const sorted = [...a].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0))
  assert.deepEqual(a, sorted)
})
