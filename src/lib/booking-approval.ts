// ════════════════════════════════════════════════════════════════════════
//  booking-approval.ts — THE ONE booking-approval + Stripe-capture path.
//
//  Both approval surfaces call approveBooking():
//     • Discord card "Approve"  (app/api/discord/interactions/route.ts)
//     • Admin portal "Confirm"   (app/api/admin/bookings/[id]/status/route.ts)
//
//  Before this existed, the admin "Confirm" only flipped the status — it never
//  captured the $49 authorization, so an admin-confirmed booking could look
//  confirmed while the hold silently expired (~7 days) and the money was lost.
//  The Discord path already did this correctly; this module hoists that proven
//  logic out so there is exactly ONE implementation and the admin path is fixed.
//
//  SAFETY MODEL (unchanged from the proven Discord flow, verified in repo):
//    1. Guard the transition (status + a payment intent must exist).
//    2. ATOMIC CLAIM: UPDATE ... WHERE status='PENDING_APPROVAL'. Postgres
//       serializes this, so of N simultaneous approvals exactly ONE wins the
//       claim and proceeds to capture — the others short-circuit. No SELECT is
//       trusted before the claim.
//    3. Capture the hold with a Stripe idempotency key `capture:<pi>` so even a
//       pathological double-run collapses to a single charge at Stripe.
//    4. On capture failure, roll the claim back to PENDING_APPROVAL (guarded on
//       status='CONFIRMED') so the booking can be approved again once healthy.
//    5. Record the money in a $transaction. Payment is UPSERTED on the unique
//       stripePaymentIntentId, so a retried commit after a partial failure can
//       never create a duplicate Payment (the "capture-succeeded / DB-failed"
//       recovery the architecture review flagged).
//    6. Notify the customer ONLY after capture + DB are truthful. Notification
//       failure is non-fatal and NEVER rolls back a successful capture.
//
//  No long-running DB transaction is held across the Stripe network call — the
//  claim, the capture, and the commit are three separate, short steps.
//
//  Dependency-injected (ApprovalDeps) so the orchestration is unit-tested
//  offline with in-memory fakes (src/lib/__tests__/booking-approval.test.ts);
//  defaultApprovalDeps() wires the real prisma / Stripe / queues in production.
// ════════════════════════════════════════════════════════════════════════
import type { BookingStatus, Prisma } from '@prisma/client'
import { prisma } from './db'
import { captureDeposit, cancelDeposit, retrieveChargeForIntent } from './stripe'
import { emailQueue, smsQueue } from './queues'
import { confirmationScheduleData, formatMoveWhen, type ConfirmationScheduleData } from './scheduling'
import { t } from './i18n'
import { outboxEnabled, emitApproved } from '../outbox/integration'
import { can, type Role } from './permissions'
import { apiLogger } from './logger'
import { ensureStaffingRequirement, type EnsureStaffingResult, type StaffingBookingRow } from './staffing-plan'
import { moveTimeKnown } from './booking-display'
import { isMigrationMissing as isMigrationMissingShared, MIGRATION_MISSING_MESSAGE } from './migration-window'

// ── Public types ────────────────────────────────────────────────────────────

export type ApprovalSource = 'discord' | 'admin'

export type ApprovalActor = {
  /** Human-readable approver name for the audit trail + receipt metadata. */
  name: string
  /** Real User.id — set on the admin path; null/undefined for Discord. */
  userId?: string | null
  /** Discord user id — set on the Discord path; goes into audit details only. */
  discordUserId?: string | null
  /** When set, the actor's role is permission-checked (`booking.approve`). The
   *  Discord path is already gated to owners by discord-auth, so it passes
   *  role: 'OWNER'. Omitting role skips the check (caller vouches for authz). */
  role?: Role | null
}

export type ApprovalErrorCode =
  | 'not_found'
  | 'forbidden'
  | 'invalid_status'
  | 'no_payment_intent'
  | 'capture_failed'
  | 'raced'
  /** ITEM P0-E — the migrations this job's crew plan needs are not applied, so
   *  approving would capture $49 and leave the job unstaffed. Refused BEFORE
   *  the claim and BEFORE the capture: nothing moved, nothing to undo. */
  | 'migration_missing'

export type ApprovalResult =
  | {
      ok: true
      /** 'captured' = we performed the capture now. 'already_confirmed' = the
       *  booking was already CONFIRMED (idempotent replay), no capture done. */
      outcome: 'captured' | 'already_confirmed'
      booking: ApprovableBooking
      capturedCents: number | null
      receiptUrl: string | null
    }
  | { ok: false; code: ApprovalErrorCode; message: string; booking?: ApprovableBooking | null }

export type ApproveInput = {
  bookingId?: string
  /** Discord loads the booking by the clicked card's message id. */
  discordMessageId?: string
  actor: ApprovalActor
  source: ApprovalSource
  /** Send the customer confirmation email/SMS after capture (default true). */
  notify?: boolean
  /** Cap on how long we wait for notification enqueue (Discord's 3s window). */
  notifyTimeoutMs?: number
}

/** The subset of Booking (+ customer) the approval flow reads. Prisma returns a
 *  superset; this documents exactly what is used. */
export type ApprovableBooking = {
  id: string
  status: BookingStatus
  stripePaymentIntentId: string | null
  depositAmount: number
  displayId: string
  customerToken: string
  /** Optional so offline-test fakes need not set it; prisma always returns it. */
  customerTokenExpiry?: Date | null
  itemsDescription: string | null
  arrivalWindow: string | null
  totalEstimate: number | null
  originAddress: string | null
  destAddress: string | null
  serviceAreaZone: string | null
  travelFee: number | null
  manualReviewRequired: boolean | null
  requestedDate: Date | null
  confirmedDate: Date | null
  scheduledStart: Date | null
  scheduledEnd: Date | null
  /** Booking.startTimeKnown (item R2-1). FALSE = the owner committed to a DATE,
   *  not an hour: approval must not fabricate a `scheduledStart` from the 00:00
   *  ET day anchor, and the notification says the date without a time. Optional
   *  so offline fakes and a caller running before migration
   *  20260812010000_start_time_known is applied keep compiling and keep the
   *  legacy behavior (only an explicit `false` changes anything). */
  startTimeKnown?: boolean | null
  estimatedHours: number | null
  customer: { name: string; email: string; phone: string | null; locale: string }
}

// ── Injectable dependencies (real impls in defaultApprovalDeps) ───────────────

export type CapturedIntent = {
  id: string
  amount_received?: number | null
  amount?: number | null
  latest_charge?: string | { id?: string | null } | null
  customer?: string | { id?: string | null } | null
  metadata?: Record<string, string> | null
}

export type ChargeInfo = {
  id?: string | null
  receipt_url?: string | null
  payment_method_details?: { type?: string | null } | null
}

export type CommitArgs = {
  bookingId: string
  paymentIntentId: string
  capturedCents: number
  stripeChargeId: string | null
  receiptUrl: string | null
  paymentMeta: Record<string, string>
  isInternalTest: boolean
  auditUserId: string | null
  auditDetails: Record<string, unknown>
}

export interface ApprovalStore {
  loadBooking(sel: { bookingId?: string; discordMessageId?: string }): Promise<ApprovableBooking | null>
  /** Atomic conditional UPDATE; returns rows changed (1 = won the claim).
   *  `portalExpiry` rides the same UPDATE (see extendedPortalExpiry).
   *  `sched.scheduledStart/End` are NULLABLE (item R2-1): a day-level booking
   *  is confirmed for a DATE and this write must not invent an hour for it. */
  claimConfirm(
    bookingId: string,
    sched: ConfirmationScheduleData | null,
    portalExpiry: Date,
  ): Promise<number>
  rollbackClaim(bookingId: string): Promise<void>
  reloadStatus(bookingId: string): Promise<ApprovableBooking | null>
  /** Payment upsert + Job upsert + AuditLog in ONE transaction. */
  commitApproval(args: CommitArgs): Promise<void>
  /** Give the just-confirmed job its ONE staffing requirement (correctness pass
   *  item 1). Optional so existing callers/fakes stay valid; production wires
   *  it in prismaApprovalStore. NEVER part of the money transaction — see the
   *  call site in approveBooking for why. */
  ensureStaffing?(args: { bookingId: string }): Promise<StaffingEnsureOutcome>
  /** ITEM P0-E — can this job be staffed AT ALL right now? Asked BEFORE the
   *  claim and BEFORE the capture, because `ensureStaffing` is deliberately
   *  fail-soft and runs AFTER the money has moved. Optional so existing fakes
   *  stay valid (absent ⇒ the caller vouches); production wires it. */
  staffingReadiness?(args: { bookingId: string }): Promise<StaffingReadiness>
  /** Atomic claim of a deny-able booking → CANCELLED; returns rows changed. */
  claimCancel(bookingId: string): Promise<number>
  /** AuditLog for a decline (BOOKING_STATE_CHANGED). */
  recordDecline(args: DeclineCommitArgs): Promise<void>
}

export interface ApprovalStripeGateway {
  capture(paymentIntentId: string, idempotencyKey: string): Promise<CapturedIntent>
  retrieveCharge(intent: CapturedIntent): Promise<ChargeInfo | null>
  /** Cancel (release) an uncaptured authorization. Tolerates an already-void PI. */
  releaseHold(paymentIntentId: string): Promise<void>
}

export interface ApprovalNotifier {
  sendApproved(booking: ApprovableBooking, capturedCents: number, approvedBy: string): Promise<void>
  /** Booking-declined email: hold released, customer not charged. */
  sendDeclined(booking: ApprovableBooking): Promise<void>
}

/** ITEM P0-E — the pre-capture verdict. `ready:false` means a MIGRATION is
 *  missing and the crew requirement provably cannot be written; the approval is
 *  refused before anything moves. Anything else is `ready:true` (a flaky probe
 *  must not block the owner — `commitApproval` would fail loudly anyway). */
export type StaffingReadiness = { ready: boolean; reason?: string }

/** What the staffing ensure did — reported in the approval log, never fatal. */
export type StaffingEnsureOutcome = {
  ensured: boolean
  /** 'admin_book_move' (the owner's captured plan) | 'derived' (rebuilt from
   *  the booking's own inventory/access columns). */
  planSource?: string
  /** 'created' | 'filled' (null columns only) | 'unchanged' (the owner's row
   *  was already there and is left alone). */
  action?: string
  requiredWorkers?: number
  requiredDrivers?: number
  /** TRUE when the booking had to be re-read WITHOUT the newest columns because
   *  their migration is not applied yet (item R2-3): the requirement was still
   *  created, from a DERIVED plan, instead of nothing being created at all. */
  degraded?: boolean
  /** Why nothing was written (no job row yet, tables missing, …) or why the
   *  read was degraded. */
  reason?: string
}

export type DeclineCommitArgs = {
  bookingId: string
  auditUserId: string | null
  auditDetails: Record<string, unknown>
}

export interface ApprovalLogger {
  info(obj: unknown, msg?: string): void
  warn(obj: unknown, msg?: string): void
  error(obj: unknown, msg?: string): void
}

export type ApprovalDeps = {
  store: ApprovalStore
  stripe: ApprovalStripeGateway
  notifier: ApprovalNotifier
  logger: ApprovalLogger
}

// ── Pure guard (unit-tested directly) ─────────────────────────────────────────

/** Whether a booking in `status` with/without a payment intent may be approved.
 *  CONFIRMED is handled by the caller as an idempotent replay, so it is not a
 *  failure here. Pure — no I/O. */
export function checkApprovable(
  status: BookingStatus | string,
  hasPaymentIntent: boolean,
): { ok: true } | { ok: false; code: ApprovalErrorCode; message: string } {
  if (status !== 'PENDING_APPROVAL') {
    return { ok: false, code: 'invalid_status', message: `Can't approve a booking in ${status}.` }
  }
  if (!hasPaymentIntent) {
    return { ok: false, code: 'no_payment_intent', message: 'No payment hold attached — nothing to capture.' }
  }
  return { ok: true }
}

/** Portal-token expiry after approval. Tokens are minted with a ~7-day life at
 *  booking creation, so a move approved a week+ out had a DEAD portal link by
 *  move day (audit finding). On approval, extend to the greatest of the
 *  existing expiry and (scheduled move date + 3 days); with no known date,
 *  fall back to now + 30 days. Never shrinks an already-later expiry.
 *  Pure — no I/O — unit-tested directly. */
export function extendedPortalExpiry(current: Date | null, moveDate: Date | null, now: Date): Date {
  const DAY_MS = 24 * 60 * 60 * 1000
  const candidate = moveDate ? new Date(moveDate.getTime() + 3 * DAY_MS) : new Date(now.getTime() + 30 * DAY_MS)
  return current && current.getTime() > candidate.getTime() ? current : candidate
}

// ── ITEM R2-3(a) / R3-2 — EVERY read on this path survives an unapplied
//    migration ──────────────────────────────────────────────────────────────
//
// Migrations here are applied BY HAND, so "code deployed, SQL not yet run" is a
// NORMAL state that can last hours. The staffing read used to select
// `staffingPlan` unconditionally: with migration 20260812000000_staffing_plan
// unapplied, Prisma raised P2022 and the WHOLE ensure died — including the
// DERIVED path, which needs no new column at all. The result was the original
// defect on the default path: booking CONFIRMED, $49 captured, Job created, no
// staffing requirement, for the entire deploy window.
//
// ITEM R3-2 — round 2 built that ladder and wired it to the STAFFING read only.
// The FIRST read of the whole flow, `store.loadBooking`, was still
// `prisma.booking.findFirst({ include: { customer: true } })`. An `include`
// (like an omitted `select`) makes Prisma request `$scalars` FROM THE GENERATED
// SCHEMA — which now declares `startTimeKnown` and `staffingPlan` — so in the
// same deploy window that read raised P2022 and approveBooking threw on its
// first statement. Neither approval surface wraps it, so EVERY approval 500'd
// and NO deposit was captured: strictly worse than the bug the ladder fixed.
//
// So: EXPLICIT SELECT LISTS everywhere (a column nobody asked for can never
// break an old deploy) plus the same two-tier ladder for the columns that DO
// need the newest migrations. A booking read without `staffingPlan` simply has
// no captured plan — exactly the public-booking case the spine already handles
// by deriving one — and one read without `startTimeKnown` falls back to the
// anchor-shape rule in scheduling.moveIsDayLevel.

/** Unapplied-migration signature. THE implementation lives in
 *  `src/lib/migration-window.ts` (one detector, shared by the approval path,
 *  the Stripe fulfillment, the customer portal and the email renderers);
 *  re-exported here because this is where its importers found it. */
export const isMigrationMissing = isMigrationMissingShared

/** ITEM P0-E — columns that predate the ENTIRE Moving OS migration set
 *  (20260811000000_moving_os_phase1 and everything after it). This is the rung
 *  that must never fail: on a database with none of the three applied, this is
 *  still a valid projection, and `derivePlanFromBooking` builds an honest
 *  requirement from exactly these columns.
 *
 *  WHY IT WAS SPLIT OUT (the round-4 defect): STAFFING_BOOKING_SELECT called
 *  itself "columns that exist independently of the round-2 migrations" — true
 *  of round 2, FALSE of phase 1, because it named `truckId`, `serviceMode` and
 *  the `truck` / `inventoryItems` relations, all created by
 *  20260811000000_moving_os_phase1. So on a deploy where none of the three had
 *  been run, BOTH rungs raised P2022/P2021, the throw escaped
 *  `ensureStaffingForBooking`, and `repairStaffing` swallowed it — after the
 *  $49 was already captured. Money taken, job unstaffed, nothing said. */
export const STAFFING_BOOKING_SELECT_BASE = {
  id: true,
  bedrooms: true,
  originStairCount: true,
  destStairCount: true,
  originHasElevator: true,
  destHasElevator: true,
  needsPacking: true,
  needsAssembly: true,
  needsDisassembly: true,
  crewInstructions: true,
  estimatedHours: true,
  scheduledStart: true,
  scheduledEnd: true,
  confirmedDate: true,
  // ITEM R2-4 — who is actually driving on a booking with no serviceMode.
  // These are the ORIGINAL truck columns (deposit_paid_and_truck_addon and
  // earlier), not the Phase 1 fleet ones, so they belong on the base rung:
  // `deriveTransportFromBooking` reads only these plus itemsDescription.
  truckProvider: true,
  truckSize: true,
  truckReservationStatus: true,
  truckReturnResponsibility: true,
  truckAddonDueOnMoveDay: true,
  itemsDescription: true,
} satisfies Prisma.BookingSelect

/** Columns + relations created by 20260811000000_moving_os_phase1. Losing them
 *  costs the fleet-truck source and the structured inventory: the plan is still
 *  built, from the booking's own legacy truck columns and bedroom count. */
export const STAFFING_BOOKING_SELECT_PHASE1 = {
  truckId: true,
  serviceMode: true,
  truck: { select: { source: true } },
  inventoryItems: {
    select: {
      name: true,
      quantity: true,
      isHeavy: true,
      needsDisassembly: true,
      catalogItem: { select: { recommendedMovers: true } },
    },
  },
} satisfies Prisma.BookingSelect

/** Kept as the historical name (base + phase 1) so existing importers and tests
 *  keep compiling. Prefer the two halves above when building a ladder. */
export const STAFFING_BOOKING_SELECT = {
  ...STAFFING_BOOKING_SELECT_BASE,
  ...STAFFING_BOOKING_SELECT_PHASE1,
} satisfies Prisma.BookingSelect

/** Columns added by the round-2 migrations: the owner's captured plan
 *  (20260812000000_staffing_plan) and the day-level flag
 *  (20260812010000_start_time_known). Selecting these is what can fail. */
export const STAFFING_BOOKING_SELECT_NEW = {
  staffingPlan: true,
  startTimeKnown: true,
} satisfies Prisma.BookingSelect

/** Booking columns the APPROVAL flow itself reads (everything `ApprovableBooking`
 *  declares), all of which predate the round-2/3 migrations. Explicit, so a
 *  column added to schema.prisma tomorrow cannot break today's deploy. */
export const APPROVAL_BOOKING_SELECT = {
  id: true,
  status: true,
  stripePaymentIntentId: true,
  depositAmount: true,
  displayId: true,
  customerToken: true,
  customerTokenExpiry: true,
  itemsDescription: true,
  arrivalWindow: true,
  totalEstimate: true,
  originAddress: true,
  destAddress: true,
  serviceAreaZone: true,
  travelFee: true,
  manualReviewRequired: true,
  requestedDate: true,
  confirmedDate: true,
  scheduledStart: true,
  scheduledEnd: true,
  estimatedHours: true,
  customer: { select: { name: true, email: true, phone: true, locale: true } },
} satisfies Prisma.BookingSelect

/** The approval read's newest column (migration 20260812010000). Selecting this
 *  is what can fail; losing it degrades the day-level determination to
 *  `scheduling.moveIsDayLevel`'s anchor-shape rule, nothing else. */
export const APPROVAL_BOOKING_SELECT_NEW = { startTimeKnown: true } satisfies Prisma.BookingSelect

/** One step of a degraded read: the select to try, and — for every rung after
 *  the first — what was lost by getting here. */
export type ReadRung = { select: Prisma.BookingSelect; degradedReason?: string }

/**
 * THE degraded read. Tries each rung in order; a MIGRATION-shaped failure
 * (P2021/P2022/"does not exist" — never a real outage) falls to the next one.
 * Only the LAST rung's failure propagates, so a ladder is honest about the
 * point at which nothing is left to try.
 *
 * `read` performs exactly ONE findFirst/findUnique with the select it is given,
 * and is injected so every ladder here is unit-tested with no database.
 *
 * ITEM P0-E: this generalises the old two-rung helper. The two-rung version had
 * its fallback call UNWRAPPED, so a second migration-shaped failure escaped —
 * which is exactly what happened when the "safe" staffing rung turned out to
 * name Phase 1 columns.
 */
export async function readBookingThroughRungs<T>(
  read: (select: Prisma.BookingSelect) => Promise<unknown>,
  rungs: readonly ReadRung[],
): Promise<{ row: T | null; degraded: boolean; reason?: string }> {
  if (rungs.length === 0) throw new Error('readBookingThroughRungs: at least one rung is required')
  for (let i = 0; i < rungs.length; i++) {
    const rung = rungs[i]
    const isLast = i === rungs.length - 1
    try {
      const row = (await read(rung.select)) as T | null
      return i === 0
        ? { row, degraded: false }
        : { row, degraded: true, ...(rung.degradedReason ? { reason: rung.degradedReason } : {}) }
    } catch (e) {
      if (isLast || !isMigrationMissing(e)) throw e
    }
  }
  /* istanbul ignore next — unreachable: the last rung either returns or throws */
  throw new Error('readBookingThroughRungs: no rung produced a row')
}

/**
 * ONE degraded read, two rungs. Kept as the published two-rung shape (the
 * approval read uses it); implemented on `readBookingThroughRungs` so there is
 * exactly one ladder.
 */
export async function readBookingWithFallback<T>(
  read: (select: Prisma.BookingSelect) => Promise<unknown>,
  base: Prisma.BookingSelect,
  newColumns: Prisma.BookingSelect,
  degradedReason: string,
): Promise<{ row: T | null; degraded: boolean; reason?: string }> {
  return readBookingThroughRungs<T>(read, [
    { select: { ...base, ...newColumns } },
    { select: base, degradedReason },
  ])
}

/** Reads a booking row for the staffing spine, degrading to the pre-migration
 *  column set rather than failing.
 *
 *  THREE rungs, because there are three independent migrations to be ahead of:
 *    1. everything            — the owner's captured plan + the day-level flag
 *    2. minus round 2/3       — plan DERIVED, day-level inferred from the anchor
 *    3. minus Phase 1 as well — no fleet-truck source, no structured inventory;
 *                               the plan comes from the booking's own legacy
 *                               truck columns and bedroom count
 *  Rung 3 names ONLY columns that predate the whole Moving OS set, so on any
 *  database this codebase can be deployed against, staffing still happens. */
export async function loadStaffingBookingRow(
  read: (select: Prisma.BookingSelect) => Promise<unknown>,
): Promise<{ booking: StaffingBookingRow | null; degraded: boolean; reason?: string }> {
  const { row, degraded, reason } = await readBookingThroughRungs<StaffingBookingRow>(read, [
    { select: { ...STAFFING_BOOKING_SELECT, ...STAFFING_BOOKING_SELECT_NEW } },
    {
      select: STAFFING_BOOKING_SELECT,
      degradedReason: 'staffingPlan/startTimeKnown not in the database yet — plan derived from the booking',
    },
    {
      select: STAFFING_BOOKING_SELECT_BASE,
      degradedReason:
        'truck/inventory columns from 20260811000000_moving_os_phase1 not in the database yet — plan derived from the booking without fleet-truck or structured-inventory evidence',
    },
  ])
  return { booking: row, degraded, ...(reason ? { reason } : {}) }
}

/**
 * ITEM R3-2 — the read `approveBooking`/`declineBooking` start from, and the one
 * the admin status route gates on. Same ladder, explicit columns.
 *
 * `extraColumns` lets a caller add columns it needs on top of the approval set
 * (the status route adds `depositPaid`) WITHOUT reopening the include-everything
 * hole. The degraded row simply has no `startTimeKnown`, which every consumer
 * already treats as "unknown" rather than "timed".
 */
export async function loadApprovableBooking<T extends ApprovableBooking = ApprovableBooking>(
  read: (select: Prisma.BookingSelect) => Promise<unknown>,
  extraColumns: Prisma.BookingSelect = {},
): Promise<{ booking: T | null; degraded: boolean; reason?: string }> {
  const { row, degraded, reason } = await readBookingWithFallback<T>(
    read,
    { ...APPROVAL_BOOKING_SELECT, ...extraColumns },
    APPROVAL_BOOKING_SELECT_NEW,
    'startTimeKnown not in the database yet — day-level scheduling inferred from the 00:00 ET day anchor',
  )
  return { booking: row, degraded, ...(reason ? { reason } : {}) }
}

/** The status route's read: the approval columns plus `depositPaid` (which
 *  decides declined-vs-cancellation copy). */
export type StatusRouteBooking = ApprovableBooking & { depositPaid: boolean }
export const STATUS_ROUTE_EXTRA_COLUMNS = { depositPaid: true } satisfies Prisma.BookingSelect
/** The same columns as one object, for a write that must RETURN a row without
 *  naming the newest ones (`prisma.booking.update` returns `$scalars` too). */
export const STATUS_ROUTE_BOOKING_SELECT = {
  ...APPROVAL_BOOKING_SELECT,
  ...STATUS_ROUTE_EXTRA_COLUMNS,
} satisfies Prisma.BookingSelect

// ── ITEM R3-5 — ONE staffing ensure, reachable from every owner action ───────
//
// `ensureStaffingRequirement` is create-if-missing, which makes it a REPAIR
// mechanism: run it again and a job whose approval-time staffing write failed
// (transient DB error, unapplied migration) finally gets its requirement. Round
// 2 wired that repair to the already-confirmed approval REPLAY only — and no
// production surface can reach a replay: the admin route's VALID_TRANSITIONS
// has no CONFIRMED→CONFIRMED edge, the admin UI offers only Mark-scheduled and
// Cancel, Discord's /approve refuses a non-PENDING_APPROVAL booking, and the
// Approve button is removed after success. So the job stayed unstaffed forever.
//
// This is the shared implementation the reachable triggers call:
//   • approval (capture + replay)          — prismaApprovalStore.ensureStaffing
//   • CONFIRMED → SCHEDULED                — the admin status route
//   • the first crew assignment            — labor-service.ensureJobForBooking
// All three are things the owner already does, all of them idempotent.

/** The database surface `ensureStaffingForBooking` needs. Injected so the
 *  ensure — including its degraded read — is unit-tested with no database. */
export type StaffingEnsureDeps = {
  /** The Job row for this booking, or null when none exists yet. */
  findJobId(bookingId: string): Promise<string | null>
  /** ONE booking findUnique with the given select (the ladder drives it). */
  readBooking(select: Prisma.BookingSelect): Promise<unknown>
  /** Run the spine's create-if-missing ensure in a transaction. */
  ensure(args: { jobId: string; booking: StaffingBookingRow; createdById: string | null }): Promise<EnsureStaffingResult>
}

/** The database surface the PRE-CAPTURE readiness probe needs. Injected so the
 *  probe is unit-tested with no database. */
export type StaffingReadinessDeps = {
  /** ONE booking findUnique with the given select (the ladder drives it). */
  readBooking(select: Prisma.BookingSelect): Promise<unknown>
  /** Touch the crew-requirement table. Any projection will do — the point is to
   *  learn NOW whether the table is readable, not to read a row. */
  probeRequirements(): Promise<void>
}

/**
 * ITEM P0-E — "either both, or an honest failure BEFORE the capture."
 *
 * `ensureStaffingForBooking` runs after `commitApproval` and is deliberately
 * fail-soft, so before this existed a missing migration produced: $49 captured,
 * booking CONFIRMED, NO staffing requirement, and one log line nobody reads.
 * This asks the same questions first, and answers `ready:false` ONLY for a
 * migration-shaped failure — the one condition that is certain to still be
 * true a second later, and the one an owner can actually fix.
 *
 * A NON-migration failure returns `ready:true`: a flaky probe must not stand
 * between the owner and a booking they are approving on the phone, and a real
 * outage will surface loudly in `commitApproval` (which is inside a
 * transaction) rather than silently.
 */
export async function checkStaffingReadiness(deps: StaffingReadinessDeps): Promise<StaffingReadiness> {
  try {
    await loadStaffingBookingRow(deps.readBooking)
  } catch (e) {
    if (!isMigrationMissing(e)) return { ready: true, reason: `staffing readiness probe inconclusive: ${asMessage(e)}` }
    return { ready: false, reason: `the booking cannot be read for staffing (${asMessage(e)})` }
  }
  try {
    await deps.probeRequirements()
  } catch (e) {
    if (!isMigrationMissing(e)) return { ready: true, reason: `staffing readiness probe inconclusive: ${asMessage(e)}` }
    return { ready: false, reason: `the crew-requirement table cannot be read (${asMessage(e)})` }
  }
  return { ready: true }
}

function prismaStaffingReadinessDeps(bookingId: string): StaffingReadinessDeps {
  return {
    readBooking: (select) => prisma.booking.findUnique({ where: { id: bookingId }, select }),
    probeRequirements: async () => {
      // Explicit select: an unqualified read here would ask for `$scalars` and
      // break on a column this table does not have yet — turning the probe
      // itself into the false alarm it exists to prevent.
      await prisma.jobStaffingRequirement.findFirst({ select: { id: true } })
    },
  }
}

function prismaStaffingEnsureDeps(bookingId: string): StaffingEnsureDeps {
  return {
    async findJobId(id) {
      const job = await prisma.job.findUnique({ where: { bookingId: id }, select: { id: true } })
      return job?.id ?? null
    },
    readBooking: (select) => prisma.booking.findUnique({ where: { id: bookingId }, select }),
    ensure: ({ jobId, booking, createdById }) =>
      prisma.$transaction((tx) => ensureStaffingRequirement(tx, { jobId, booking, createdById })),
  }
}

/**
 * Give a booking's job THE staffing requirement it must have. Create-if-missing
 * (an owner-edited row is never overwritten — see staffing-plan.ts), fail-soft
 * on an unapplied migration, and honest about what it did.
 *
 * MAY THROW on a real database error — every caller wraps it, because a
 * staffing gap must never fail an approval, a status change or a crew
 * assignment. `tryEnsureStaffingForBooking` is that wrapper.
 */
export async function ensureStaffingForBooking(
  args: { bookingId: string; jobId?: string | null; createdById?: string | null },
  deps: StaffingEnsureDeps = prismaStaffingEnsureDeps(args.bookingId),
): Promise<StaffingEnsureOutcome> {
  let jobId = args.jobId ?? null
  if (!jobId) {
    try {
      jobId = await deps.findJobId(args.bookingId)
    } catch (e) {
      // House rule: fail SOFT on an unapplied migration, with an honest
      // message, instead of a 500 nobody can act on.
      if (!isMigrationMissing(e)) throw e
      return { ensured: false, reason: 'jobs table not in the database yet (migration not applied)' }
    }
  }
  if (!jobId) return { ensured: false, reason: 'no job row for this booking' }

  // ITEM R2-3(a) — degrade to the pre-migration column set rather than losing
  // the whole ensure. The plan the owner captured in Book Move is null on
  // public bookings and legacy rows anyway, and staffing-plan.ts DERIVES one
  // from the booking's own inventory / access / truck columns.
  const { booking, degraded, reason } = await loadStaffingBookingRow(deps.readBooking)
  if (!booking) return { ensured: false, reason: 'booking not found' }
  const res = await deps.ensure({ jobId, booking, createdById: args.createdById ?? null })
  return {
    ensured: true,
    action: res.outcome,
    planSource: res.plan.source,
    requiredWorkers: res.data.requiredWorkers,
    requiredDrivers: res.data.requiredDrivers,
    ...(degraded ? { degraded, reason } : {}),
  }
}

/**
 * `ensureStaffingForBooking` that NEVER throws — for the repair triggers, where
 * the owner's actual action (marking a job scheduled, assigning a crew member)
 * must succeed whatever staffing does. Logs both outcomes.
 *
 * ITEM P0-E — HONEST ABOUT THE BACKSTOP. This comment used to say "the Action
 * Center surfaces a still-missing requirement". It does not: there is no
 * staffing rule in reminder-rules.ts. The only surfacing is
 * conflict-engine.ts's INFORMATIONAL NO_STAFFING_REQUIREMENT on the
 * scheduling/dispatch views — and during the migration window that creates the
 * gap, the Action Center scan cannot run at all (reminder-sync loads bookings
 * with an `include`). The real guarantee is upstream: `approveBooking` refuses
 * BEFORE the capture when the requirement provably cannot be written, so a
 * fail-soft here is a genuine edge case, not the normal deploy window.
 */
export async function tryEnsureStaffingForBooking(
  args: { bookingId: string; jobId?: string | null; createdById?: string | null; trigger: string },
  deps?: StaffingEnsureDeps,
): Promise<StaffingEnsureOutcome> {
  try {
    const outcome = await ensureStaffingForBooking(args, deps)
    apiLogger.info({ bookingId: args.bookingId, trigger: args.trigger, ...outcome }, 'staffing requirement ensured')
    return outcome
  } catch (e) {
    const message = asMessage(e)
    apiLogger.error(
      { bookingId: args.bookingId, trigger: args.trigger, err: message },
      'staffing requirement could not be ensured (non-fatal — the owner action still stands)',
    )
    return { ensured: false, reason: message }
  }
}

const errResult = (
  code: ApprovalErrorCode,
  message: string,
  booking?: ApprovableBooking | null,
): ApprovalResult => ({ ok: false, code, message, booking })

const asMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e))

// ── The one approval operation ────────────────────────────────────────────────

export async function approveBooking(
  input: ApproveInput,
  deps: ApprovalDeps = defaultApprovalDeps(),
): Promise<ApprovalResult> {
  const { store, stripe, notifier, logger } = deps
  const { actor, source } = input

  const booking = await store.loadBooking({ bookingId: input.bookingId, discordMessageId: input.discordMessageId })
  if (!booking) return errResult('not_found', 'Booking not found.')

  // Authorization (admin path supplies a role; Discord is pre-gated to owners).
  if (actor.role && !can(actor.role, 'booking.approve')) {
    return errResult('forbidden', 'You do not have permission to approve bookings.', booking)
  }

  // Idempotent replay: already approved → report success without re-capturing.
  //
  // ITEM R2-3(b): the replay STILL ensures staffing. This early return used to
  // sit in front of the staffing block, so once an ensure had failed — a
  // transient DB error, or the unapplied migration above — nothing could ever
  // create that requirement again: the booking was CONFIRMED, so every later
  // approval returned right here. Re-approving is the ONLY repair the owner has,
  // and the ensure is create-if-missing, so running it on an already-confirmed
  // booking either heals the gap or reports 'unchanged'. Never fatal.
  if (booking.status === 'CONFIRMED') {
    await repairStaffing(deps, booking.id, 'already_confirmed')
    return { ok: true, outcome: 'already_confirmed', booking, capturedCents: null, receiptUrl: null }
  }

  const guard = checkApprovable(booking.status, !!booking.stripePaymentIntentId)
  if (!guard.ok) return errResult(guard.code, guard.message, booking)

  // 0) ITEM P0-E — CAN THIS JOB BE STAFFED AT ALL? Asked here, before the claim
  //    and before the capture, because the staffing write (3b) is fail-soft by
  //    design and runs AFTER the money has moved. During the code-before-SQL
  //    window that combination produced the exact outcome the owner's rule
  //    forbids: $49 captured, booking CONFIRMED, no crew requirement, and a log
  //    line saying "non-fatal". Either BOTH happen, or the approval refuses
  //    here — having claimed nothing, captured nothing and told the owner
  //    precisely which migration to apply.
  //
  //    Only a MIGRATION-shaped failure refuses (see checkStaffingReadiness); a
  //    flaky probe never stands between the owner and an approval.
  if (store.staffingReadiness) {
    let readiness: StaffingReadiness
    try {
      readiness = await store.staffingReadiness({ bookingId: booking.id })
    } catch (e) {
      logger.warn(
        { bookingId: booking.id, err: asMessage(e) },
        'staffing readiness probe threw — approval continues (the money transaction will surface a real outage)',
      )
      readiness = { ready: true }
    }
    if (!readiness.ready) {
      logger.error(
        { bookingId: booking.id, source, reason: readiness.reason },
        'approval REFUSED before capture — migrations not applied, so the job could not be staffed',
      )
      return errResult(
        'migration_missing',
        `${MIGRATION_MISSING_MESSAGE}. Approving now would capture the $49 and leave this job with no crew plan, so NOTHING was captured — apply the migration, then approve again.` +
          (readiness.reason ? ` (${readiness.reason})` : ''),
        booking,
      )
    }
  }

  // 1) ATOMIC CLAIM — win the PENDING_APPROVAL → CONFIRMED transition before
  //    touching Stripe. Exactly one concurrent approver gets rows-changed === 1.
  const sched = confirmationScheduleData(booking)
  // Extend the portal token so the link the customer already has survives to
  // move day (+3d buffer). Rides the claim UPDATE as one extra field — no
  // extra write. Not undone by rollbackClaim: a longer-lived token on a
  // still-pending booking is harmless (it was valid before approval too).
  const portalExpiry = extendedPortalExpiry(booking.customerTokenExpiry ?? null, sched?.confirmedDate ?? null, new Date())
  const claimed = await store.claimConfirm(booking.id, sched, portalExpiry)
  if (claimed === 0) {
    const fresh = await store.reloadStatus(booking.id)
    if (fresh?.status === 'CONFIRMED') {
      // Same replay repair as above (item R2-3(b)) — this branch is reached both
      // by a genuine race and by a retry of a booking somebody already approved.
      await repairStaffing(deps, booking.id, 'claim_lost_already_confirmed')
      return { ok: true, outcome: 'already_confirmed', booking: fresh, capturedCents: null, receiptUrl: null }
    }
    return errResult('raced', 'This booking was just handled by someone else — no action taken.', fresh ?? booking)
  }

  // 2) CAPTURE — idempotency key keyed on the payment intent.
  const pi = booking.stripePaymentIntentId as string // guaranteed by checkApprovable
  let intent: CapturedIntent
  try {
    intent = await stripe.capture(pi, `capture:${pi}`)
  } catch (e) {
    const message = asMessage(e)
    // Roll the claim back so a healthy retry can approve again. Guarded on
    // status='CONFIRMED' so we never stomp a later legitimate change.
    await store.rollbackClaim(booking.id).catch((rbErr) =>
      logger.error(
        { bookingId: booking.id, err: asMessage(rbErr) },
        'CRITICAL: failed to roll back approval claim after Stripe error — booking may be CONFIRMED without capture',
      ),
    )
    logger.error({ bookingId: booking.id, source, err: message }, 'captureDeposit failed — rolled back approval claim')
    return errResult('capture_failed', `Stripe capture failed: ${message}. The hold was NOT captured — try again.`, booking)
  }

  const capturedCents = intent.amount_received ?? intent.amount ?? booking.depositAmount

  // 2b) Best-effort charge details (receipt URL / charge id / method). Never
  //     blocks approval — the money is already captured.
  const charge = await stripe.retrieveCharge(intent).catch(() => null)
  const receiptUrl = charge?.receipt_url ?? null
  const stripeChargeId =
    charge?.id ?? (typeof intent.latest_charge === 'string' ? intent.latest_charge : intent.latest_charge?.id) ?? null
  const paymentMethodType = charge?.payment_method_details?.type ?? null
  const stripeCustomerId = typeof intent.customer === 'string' ? intent.customer : intent.customer?.id ?? null

  const paymentMeta: Record<string, string> = { capturedBy: actor.name, approvalSource: source }
  if (paymentMethodType) paymentMeta.paymentMethodType = paymentMethodType
  if (stripeCustomerId) paymentMeta.stripeCustomerId = stripeCustomerId
  // Mirror the intent's metadata (esp. internal_test) so revenue reporting
  // classifies owner checkout tests without a manual backfill.
  for (const [k, v] of Object.entries(intent.metadata ?? {})) {
    if (typeof v === 'string' && paymentMeta[k] == null) paymentMeta[k] = v
  }
  const isInternalTest = (intent.metadata?.internal_test ?? '') === 'true'

  // 3) RECORD MONEY — Payment (idempotent upsert) + Job + AuditLog, atomically.
  await store.commitApproval({
    bookingId: booking.id,
    paymentIntentId: intent.id,
    capturedCents,
    stripeChargeId,
    receiptUrl,
    paymentMeta,
    isInternalTest,
    auditUserId: actor.userId ?? null,
    auditDetails: {
      event: 'approve_booking',
      source,
      approvedBy: actor.name,
      discordUserId: actor.discordUserId ?? null,
      userId: actor.userId ?? null,
      previousStatus: 'PENDING_APPROVAL',
      newStatus: 'CONFIRMED',
      captured: capturedCents,
      paymentIntentId: intent.id,
      stripeResult: 'captured',
      result: 'success',
    },
  })

  logger.info(
    { bookingId: booking.id, captured: capturedCents, source, approvedBy: actor.name },
    'Booking approved → $49 captured → CONFIRMED',
  )

  // 3b) STAFFING — the job created above gets its ONE staffing requirement
  //     (correctness pass item 1). This is the path the DEFAULT admin deposit
  //     mode (stripe_link) and every public booking take: booking →
  //     PENDING_PAYMENT → $49 hold → PENDING_APPROVAL → here. Before this,
  //     only bookings created CONFIRMED by the admin route ever got a
  //     requirement, so the most-used path landed a confirmed job with no
  //     staffing plan and dispatch could not warn about anything.
  //
  //     FAIL-SOFT, AND DELIBERATELY OUTSIDE THE MONEY TRANSACTION: the deposit
  //     is already captured at Stripe. A staffing write that throws INSIDE
  //     commitApproval's transaction would abort that transaction in Postgres
  //     (catching the JS error does not un-abort it — the following COMMIT
  //     degrades to ROLLBACK), silently discarding the Payment/Job/AuditLog for
  //     money that really moved. So it runs in its own short transaction right
  //     after the commit, and a failure is logged, never raised: a missing
  //     staffing row is a dispatch gap the Action Center can surface, while a
  //     lost capture is unrecoverable.
  await repairStaffing(deps, booking.id, 'captured')

  // 4) NOTIFY — only now, after the state is truthful. Non-fatal + time-boxed
  //    so a Redis stall can't blow Discord's 3s interaction window or undo the
  //    capture. A failed notification leaves the money + booking intact.
  if (input.notify !== false) {
    try {
      await withTimeout(notifier.sendApproved(booking, capturedCents, actor.name), input.notifyTimeoutMs ?? 2500)
    } catch (e) {
      logger.error({ bookingId: booking.id, err: asMessage(e) }, 'approval notifications failed/timeout (non-fatal)')
    }
  }

  return { ok: true, outcome: 'captured', booking, capturedCents, receiptUrl }
}

/**
 * Run the staffing ensure for a confirmed booking. Called from BOTH the capture
 * path and the idempotent-replay paths (item R2-3(b)) — a replay is the only
 * repair mechanism after a failed ensure, and the ensure is create-if-missing so
 * replaying it can never disturb an owner-edited requirement.
 *
 * NEVER THROWS: an exception here would turn a successful $49 capture into an
 * error the caller reports as a failure, and invite a double-approve.
 *
 * ITEM P0-E — a gap here has NO automatic backstop (there is no staffing rule
 * in the Action Center; see tryEnsureStaffingForBooking's note), which is why
 * approveBooking now refuses BEFORE the capture when the requirement cannot be
 * written. Anything that still lands here is logged at ERROR, including the
 * "ran but wrote nothing" case, which used to be logged as an info line.
 */
async function repairStaffing(deps: ApprovalDeps, bookingId: string, phase: string): Promise<void> {
  const { store, logger } = deps
  if (!store.ensureStaffing) return
  try {
    const staffing = await store.ensureStaffing({ bookingId })
    if (staffing.ensured) {
      logger.info({ bookingId, phase, ...staffing }, 'Approval staffing requirement ensured')
    } else {
      logger.error(
        { bookingId, phase, ...staffing },
        'NO staffing requirement was written for this booking — dispatch cannot warn about crew for it',
      )
    }
  } catch (e) {
    logger.error(
      { bookingId, phase, err: asMessage(e) },
      'staffing requirement could not be created after approval (non-fatal — booking IS confirmed and captured)',
    )
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)),
  ])
}

// ── Decline (release the uncaptured hold) ─────────────────────────────────────
//    The mirror of approveBooking. Both the Discord "Deny" button and the admin
//    portal's cancel-of-a-pending-booking call this so a declined booking ALWAYS
//    releases the Stripe authorization instead of leaving the customer's card on
//    hold for ~7 days. A CONFIRMED (already-captured) booking is NOT declinable
//    here — that needs a refund, not a hold release.

export type DeclineErrorCode = 'not_found' | 'forbidden' | 'invalid_status' | 'raced'

export type DeclineResult =
  | { ok: true; outcome: 'declined' | 'already_cancelled'; booking: ApprovableBooking; holdReleased: boolean }
  | { ok: false; code: DeclineErrorCode; message: string; booking?: ApprovableBooking | null }

export type DeclineInput = {
  bookingId?: string
  discordMessageId?: string
  actor: ApprovalActor
  source: ApprovalSource
  notify?: boolean
  notifyTimeoutMs?: number
}

const DENYABLE = ['PENDING_APPROVAL', 'PENDING_PAYMENT', 'DRAFT']

/** Pure guard: may a booking in `status` be declined (hold released)? CANCELLED
 *  is handled by the caller as an idempotent replay. CONFIRMED = already captured
 *  → refund, not decline. */
export function checkDeclinable(
  status: BookingStatus | string,
): { ok: true } | { ok: false; code: DeclineErrorCode; message: string } {
  if (status === 'CONFIRMED') {
    return { ok: false, code: 'invalid_status', message: 'Already approved & captured — issue a refund instead of declining.' }
  }
  if (!DENYABLE.includes(status)) {
    return { ok: false, code: 'invalid_status', message: `Can't decline a booking in ${status}.` }
  }
  return { ok: true }
}

export async function declineBooking(
  input: DeclineInput,
  deps: ApprovalDeps = defaultApprovalDeps(),
): Promise<DeclineResult> {
  const { store, stripe, notifier, logger } = deps
  const { actor, source } = input

  const booking = await store.loadBooking({ bookingId: input.bookingId, discordMessageId: input.discordMessageId })
  if (!booking) return { ok: false, code: 'not_found', message: 'Booking not found.' }

  if (actor.role && !can(actor.role, 'booking.decline')) {
    return { ok: false, code: 'forbidden', message: 'You do not have permission to decline bookings.', booking }
  }

  if (booking.status === 'CANCELLED') {
    return { ok: true, outcome: 'already_cancelled', booking, holdReleased: false }
  }

  const guard = checkDeclinable(booking.status)
  if (!guard.ok) return { ok: false, code: guard.code, message: guard.message, booking }

  // Atomic claim of the transition to CANCELLED among the deny-able statuses.
  const claimed = await store.claimCancel(booking.id)
  if (claimed === 0) {
    const fresh = await store.reloadStatus(booking.id)
    if (fresh?.status === 'CANCELLED') return { ok: true, outcome: 'already_cancelled', booking: fresh, holdReleased: false }
    return { ok: false, code: 'raced', message: 'This booking was just handled by someone else — no action taken.', booking: fresh ?? booking }
  }

  // Release the authorization (no money moves). Non-fatal — the hold may already
  // be void; the decline still stands.
  let holdReleased = false
  let stripeResult = 'no_hold'
  if (booking.stripePaymentIntentId) {
    try {
      await stripe.releaseHold(booking.stripePaymentIntentId)
      holdReleased = true
      stripeResult = 'hold_released'
    } catch (e) {
      stripeResult = `release_failed: ${asMessage(e).slice(0, 80)}`
      logger.warn({ bookingId: booking.id, err: asMessage(e) }, 'releaseHold failed (continuing — hold may already be void)')
    }
  }

  await store.recordDecline({
    bookingId: booking.id,
    auditUserId: actor.userId ?? null,
    auditDetails: {
      event: 'decline_booking',
      source,
      deniedBy: actor.name,
      discordUserId: actor.discordUserId ?? null,
      userId: actor.userId ?? null,
      previousStatus: booking.status,
      newStatus: 'CANCELLED',
      stripeResult,
      result: 'success',
    },
  })

  logger.info({ bookingId: booking.id, source, deniedBy: actor.name, holdReleased }, 'Booking declined → hold released → CANCELLED')

  if (input.notify !== false) {
    try {
      await withTimeout(notifier.sendDeclined(booking), input.notifyTimeoutMs ?? 2500)
    } catch (e) {
      logger.error({ bookingId: booking.id, err: asMessage(e) }, 'declined notification failed/timeout (non-fatal)')
    }
  }

  return { ok: true, outcome: 'declined', booking, holdReleased }
}

// ── Production wiring (never imported by the offline unit test) ────────────────

let _cachedDeps: ApprovalDeps | undefined

/** Real prisma / Stripe / BullMQ dependencies. Cached after first build. The
 *  imported queue/Stripe/prisma singletons are all lazy, so constructing this
 *  opens no connections — the offline test never calls it (it injects fakes). */
export function defaultApprovalDeps(): ApprovalDeps {
  if (_cachedDeps) return _cachedDeps
  _cachedDeps = {
    store: prismaApprovalStore(),
    stripe: {
      capture: (pi, key) => captureDeposit(pi, key) as unknown as Promise<CapturedIntent>,
      retrieveCharge: (intent) => retrieveChargeForIntent(intent as never) as unknown as Promise<ChargeInfo | null>,
      releaseHold: async (pi) => {
        await cancelDeposit(pi)
      },
    },
    notifier: queueApprovalNotifier(),
    logger: apiLogger,
  }
  return _cachedDeps
}

function prismaApprovalStore(): ApprovalStore {
  return {
    async loadBooking(sel) {
      const or: Array<Record<string, string>> = []
      if (sel.discordMessageId) or.push({ discordApprovalMessageId: sel.discordMessageId })
      if (sel.bookingId) or.push({ id: sel.bookingId })
      if (or.length === 0) return null
      // ITEM R3-2 — the FIRST statement of approveBooking. It used to be
      // `include: { customer: true }`, which asks Postgres for every column the
      // GENERATED client knows about: during the code-before-SQL window that
      // read raised P2022 and every approval 500'd with no deposit captured.
      // Explicit columns + the degraded ladder instead.
      const { booking, degraded, reason } = await loadApprovableBooking((select) =>
        prisma.booking.findFirst({ where: { OR: or }, select }),
      )
      if (degraded) apiLogger.warn({ bookingId: booking?.id ?? null, reason }, 'approval read degraded (unapplied migration) — approval continues')
      return booking
    },
    async claimConfirm(bookingId, sched, portalExpiry) {
      const res = await prisma.booking.updateMany({
        where: { id: bookingId, status: 'PENDING_APPROVAL' },
        // customerTokenExpiry: tokens die ~7 days after creation, so week-out
        // moves had dead portal links on move day — extend (never shrink) to
        // move date + 3d / now + 30d. Computed pure in extendedPortalExpiry.
        //
        // ITEM R2-1: `sched` is the ONLY source of the schedule columns, and
        // confirmationScheduleData now returns scheduledStart/End = null for a
        // day-level booking (startTimeKnown = false). Spreading it therefore
        // writes explicit NULLs instead of the 00:00 ET day anchor this claim
        // used to promote into scheduledStart — no fabricated crew hour ever
        // reaches the row, so `truck-conflicts` keeps treating the booking as
        // "unknown time ⇒ the whole ET day is held".
        data: { status: 'CONFIRMED', depositPaid: true, customerTokenExpiry: portalExpiry, ...(sched ?? {}) },
      })
      return res.count
    },
    async rollbackClaim(bookingId) {
      await prisma.booking.updateMany({
        where: { id: bookingId, status: 'CONFIRMED' },
        data: { status: 'PENDING_APPROVAL', depositPaid: false, confirmedDate: null, scheduledStart: null, scheduledEnd: null },
      })
    },
    async reloadStatus(bookingId) {
      // Same ladder (item R3-2): this read decides whether a lost claim is an
      // idempotent replay or a real race, so it must not die on a new column.
      const { booking } = await loadApprovableBooking((select) =>
        prisma.booking.findUnique({ where: { id: bookingId }, select }),
      )
      return booking
    },
    async commitApproval(a) {
      await prisma.$transaction([
        prisma.payment.upsert({
          where: { stripePaymentIntentId: a.paymentIntentId },
          update: {
            status: 'COMPLETED',
            stripeChargeId: a.stripeChargeId,
            amount: a.capturedCents,
            receiptUrl: a.receiptUrl,
            metadata: a.paymentMeta,
            isInternalTest: a.isInternalTest,
          },
          create: {
            bookingId: a.bookingId,
            stripePaymentIntentId: a.paymentIntentId,
            stripeChargeId: a.stripeChargeId,
            amount: a.capturedCents,
            status: 'COMPLETED',
            description: 'Booking deposit captured on approval',
            receiptUrl: a.receiptUrl,
            metadata: a.paymentMeta,
            isInternalTest: a.isInternalTest,
          },
        }),
        prisma.job.upsert({
          where: { bookingId: a.bookingId },
          update: { status: 'SCHEDULED' },
          create: { bookingId: a.bookingId, status: 'SCHEDULED' },
        }),
        prisma.auditLog.create({
          data: { action: 'PAYMENT_RECEIVED', bookingId: a.bookingId, userId: a.auditUserId, details: a.auditDetails as never },
        }),
      ])
    },
    async ensureStaffing({ bookingId }) {
      // Runs AFTER commitApproval's transaction (see the call site): the Job
      // upsert has committed, so the job row is readable here. THE shared
      // implementation lives in ensureStaffingForBooking so the approval, the
      // CONFIRMED→SCHEDULED transition and the first crew assignment (item
      // R3-5) all create the same row the same way.
      return ensureStaffingForBooking({ bookingId })
    },
    async staffingReadiness({ bookingId }) {
      // ITEM P0-E — asked BEFORE the claim/capture (see approveBooking step 0).
      return checkStaffingReadiness(prismaStaffingReadinessDeps(bookingId))
    },
    async claimCancel(bookingId) {
      const res = await prisma.booking.updateMany({
        where: { id: bookingId, status: { in: DENYABLE as BookingStatus[] } },
        data: { status: 'CANCELLED' },
      })
      return res.count
    },
    async recordDecline(a) {
      await prisma.auditLog.create({
        data: { action: 'BOOKING_STATE_CHANGED', bookingId: a.bookingId, userId: a.auditUserId, details: a.auditDetails as never },
      })
    },
  }
}

function queueApprovalNotifier(): ApprovalNotifier {
  return {
    async sendApproved(booking, capturedCents, approvedBy) {
      const locale = booking.customer.locale
      const when = booking.requestedDate
      // ITEM R2-1 — no midnight in the approval notification. A day-level
      // booking's requestedDate IS the 00:00 ET day anchor, so formatEastern
      // rendered a confident "Thursday, January 15, 2026 at 12:00 AM" for a job
      // whose hour nobody has chosen. formatMoveWhen drops the time when
      // startTimeKnown === false and is identical otherwise.
      // ITEM R3-2 — the SHARED rule (booking-display.moveTimeKnown), not
      // `startTimeKnown !== false`: during the code-before-SQL window the flag
      // is unreadable, and the old test would then have printed "12:00 AM" for
      // exactly the day-level bookings this guard exists for. A stored
      // scheduledStart still proves a real hour.
      const timeKnown = moveTimeKnown({
        date: when,
        scheduledStart: booking.scheduledStart,
        startTimeKnown: booking.startTimeKnown,
      })
      const dateStr = when ? formatMoveWhen(when, booking.startTimeKnown) : 'your move date'
      // The templates fall back to formatting the hour out of `date` when no
      // timeLabel is given — the same midnight, one layer down. An arrival
      // window the owner typed always wins; otherwise say the time is still to
      // be confirmed rather than printing one.
      const timeLabel =
        booking.arrivalWindow ?? (timeKnown ? undefined : locale === 'es' ? 'Hora por confirmar' : 'Time to be confirmed')
      const appUrl = process.env.APP_URL ?? 'https://wmiwci-api.vercel.app'
      const portalUrl = `${appUrl}/my-booking/${booking.customerToken}`

      // OUTBOX_ENABLED → emit APPROVED to the outbox (which sends the email) and
      // SKIP the legacy email so the customer never gets both.
      if (outboxEnabled()) {
        await emitApproved({
          bookingId: booking.id,
          approvedBy,
          customerName: booking.customer.name,
          customerEmail: booking.customer.email,
          requestedDate: when?.toISOString() ?? null,
          items: booking.itemsDescription ?? undefined,
        })
      } else {
        await emailQueue.add('final-confirmation', {
          template: 'final-confirmation',
          to: booking.customer.email,
          bookingId: booking.id,
          payload: {
            // Phase-4 status gate: this path runs only after a successful
            // capture+confirm, so the booking is definitively CONFIRMED. Passed
            // as a literal (not the possibly-stale in-memory booking.status) so
            // the send-gate can enforce "confirmation only for a confirmed job".
            bookingStatus: 'CONFIRMED',
            customerName: booking.customer.name,
            displayId: booking.displayId,
            date: when?.toISOString(),
            timeLabel,
            amountPaid: String(Math.round(capturedCents / 100)),
            originAddress: booking.originAddress ?? undefined,
            destAddress: booking.destAddress ?? undefined,
            estimate: booking.totalEstimate != null ? `$${Math.round(booking.totalEstimate).toLocaleString('en-US')}` : undefined,
            portalUrl,
            serviceAreaZone: booking.serviceAreaZone ?? undefined,
            travelFee: booking.travelFee ? booking.travelFee / 100 : undefined,
            manualReviewRequired: booking.manualReviewRequired ?? undefined,
            locale,
          },
        })
      }

      if (booking.customer.phone) {
        await smsQueue.add('pre-approval-sms', {
          to: booking.customer.phone,
          message: t(locale, 'preApproval', { name: booking.customer.name, displayId: booking.displayId, date: dateStr }),
          bookingId: booking.id,
        })
      }
    },
    async sendDeclined(booking) {
      if (!booking.customer.email) return
      const appBase = (process.env.APP_URL ?? 'https://moveitclearit.com').replace(/\/+$/, '')
      await emailQueue.add('booking-declined', {
        template: 'booking-declined',
        to: booking.customer.email,
        bookingId: booking.id,
        payload: {
          customerName: booking.customer.name,
          displayId: booking.displayId,
          requestedDate: booking.requestedDate?.toISOString(),
          amountHold: String(Math.round(booking.depositAmount / 100)),
          rebookUrl: `${appBase}/book`,
          locale: booking.customer.locale,
        },
      })
    },
  }
}
