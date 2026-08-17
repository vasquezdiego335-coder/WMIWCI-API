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
//  ── ITEM B1 (release blocker, 2026-08-14) — THE REPLAY CONVERGES ────────────
//  Steps 1-3 above are ordered correctly but they are not atomic, and step 3
//  was the ONE unprotected throw between "Stripe took the money" and "we told
//  anybody". One failed Postgres transaction (Neon autosuspend, a dropped
//  connection, a serverless timeout) left: booking CONFIRMED + depositPaid,
//  $49 captured at Stripe, NO Payment / Job / audit row, and no customer
//  notification — ever. Re-approving (the only repair an owner has) returned
//  `already_confirmed` WITHOUT looking at the money, so the owner saw a green
//  card, the customer heard nothing, and `bookingPricing` then billed the same
//  $49 again because it derives the balance from COMPLETED Payment rows.
//
//  So the CONFIRMED early-returns no longer assume. They ASK:
//    a. Is a COMPLETED Payment recorded for this intent? (store.findPaymentForIntent)
//       Yes → ordinary idempotent replay, report it with the amount we can prove.
//    b. No → what does Stripe say about the intent? (stripe.retrieveIntent)
//       CAPTURED   → re-drive the SAME commitApproval (Payment upsert keyed on
//                    stripePaymentIntentId, Job upsert keyed on bookingId — both
//                    already exactly-once), then staffing, then the notification
//                    the customer never got → outcome 'repaired'.
//       UNCAPTURED → the MIRROR case (the process died between the claim and the
//                    capture, so the compensating rollback never ran and the row
//                    reads CONFIRMED over an authorization that expires in ~7
//                    days). Capture it with the SAME `capture:<pi>` key, or roll
//                    the claim back if that capture fails.
//       UNKNOWN    → report `commit_failed`. Never `ok:true` over money we
//                    cannot see.
//  The AuditLog write and the customer notification are both guarded on ONE
//  atomic database claim (see `approvalAuditId` below), so a repeated — or a
//  CONCURRENT — repair can neither double-log nor double-send. And commitApproval
//  itself now gets a bounded retry, because most of these blips heal in well
//  under a second.
//
//  ── ITEM R1 (2026-08-15) — THE GUARD IS THE DATABASE, NOT A COUNT ──────────
//  Round 1 read `countApprovalAudits()` BEFORE `commitApprovalWithRetry` and
//  gated both the audit and the notification on it. Two concurrent repairs both
//  read 0: `await Promise.all([approve(), approve()])` on an incident booking
//  produced payments 1, paymentAudits 2, notified 2 — two "your booking is
//  approved" emails and two SMS for one $49, and two PAYMENT_RECEIVED rows in
//  the ledger. A guard two callers can both pass is not a guard.
//  See `approvalAuditId` for the replacement and why it needs no migration.
//
//  ── ITEM T1 (2026-08-15) — THE CLAIM IS KEYED TO THE MONEY ─────────────────
//  Round 2's claim id was `pyrcv_<bookingId>`: keyed to the BOOKING, and
//  PERMANENT. The money it guards is keyed to the INTENT (Payment is unique on
//  `stripePaymentIntentId`), and that misalignment produced two failures:
//
//    • A customer reschedules through the portal. That sets the booking back to
//      PENDING_APPROVAL for the NEW date with the SAME $49 hold attached, and
//      the owner re-approves. The commit hit the permanent booking-scoped key,
//      the unique violation was (correctly) non-retryable, and the re-approval
//      reported `already_confirmed` while saying NOTHING to the customer — so
//      the person who moved their move never heard that the new date is
//      confirmed.
//    • A booking approved against a DIFFERENT intent (a second authorization)
//      could NEVER have its Payment row written: the transaction always rolled
//      back on the booking-scoped key, the conflict was non-retryable, and
//      `recordedByAnotherCaller` then asked about the NEW intent and found
//      nothing — a permanent `commit_failed` loop whose only visible remedy is
//      charging the customer $49 a second time.
//
//  So the claim id is now a function of the booking AND the payment intent
//  (`approvalAuditId(bookingId, paymentIntentId)`), and `countApprovalAudits`
//  asks the same intent-scoped question. Two concurrent approvals of the SAME
//  intent still collide in Postgres exactly as before; a legitimate approval of
//  a NEW intent gets its own claim, its own Payment row and its own customer
//  confirmation. Nothing else about the mechanism moves: the claim is still the
//  AuditLog insert INSIDE the money transaction, a unique violation is still
//  non-retryable, and the loser still asks the database before it reports.
//
//  ONE MORE ALIGNMENT FALLS OUT OF IT. The customer announcement is gated on a
//  CLAIM, and on the ordinary approval path that claim is not the audit row —
//  it is the atomic `PENDING_APPROVAL → CONFIRMED` UPDATE, which exactly one
//  caller can ever win. So a caller holding the status claim announces even
//  when the money was already recorded (the reschedule above: same $49, same
//  ledger row, NEW confirmed date the customer must hear about), while the
//  repair path — which runs on an already-CONFIRMED row and holds no status
//  claim — still announces only if it won the audit insert. See
//  `heldStatusClaim` in recordCapturedApproval.
//
//  Dependency-injected (ApprovalDeps) so the orchestration is unit-tested
//  offline with in-memory fakes (src/lib/__tests__/booking-approval.test.ts);
//  defaultApprovalDeps() wires the real prisma / Stripe / queues in production.
// ════════════════════════════════════════════════════════════════════════
import type { BookingStatus, Prisma } from '@prisma/client'
import { prisma } from './db'
import { captureDeposit, cancelDeposit, retrieveChargeForIntent, stripe as stripeClient } from './stripe'
import { postOpsAlert } from './ops-alert'
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
  /** ITEM B1 — the money is (or may be) AT STRIPE and the local record did not
   *  save. This is NOT "try again with a fresh charge": nothing here ever
   *  re-authorizes, and the replay path repairs the record idempotently. The
   *  message says so in the owner's words. */
  | 'commit_failed'

export type ApprovalResult =
  | {
      ok: true
      /** 'captured' = we performed the capture now. 'already_confirmed' = the
       *  booking was already CONFIRMED AND the money is recorded (idempotent
       *  replay), no capture done. 'repaired' (item B1) = the booking was
       *  already CONFIRMED but the money was not recorded, and THIS call
       *  converged it — recording the Payment/Job/audit and sending the
       *  confirmation the customer never received. */
      outcome: 'captured' | 'already_confirmed' | 'repaired'
      booking: ApprovableBooking
      /** Only ever a figure this call can PROVE: what Stripe just captured, or
       *  what the local COMPLETED Payment row records. Null means "not proven
       *  here" — never a default the caller should print. */
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
  /** PaymentIntent.status. Only READ on the item-B1 convergence path, where it
   *  is the difference between "Stripe has the money" and "the authorization is
   *  still uncaptured". A capture response always carries 'succeeded'. */
  status?: string | null
  latest_charge?: string | { id?: string | null } | null
  customer?: string | { id?: string | null } | null
  metadata?: Record<string, string> | null
}

/** The local money record for a payment intent, as the convergence path reads
 *  it (item B1). `status === 'COMPLETED'` is the ONLY proof that a captured
 *  deposit reached the database — `Booking.depositPaid` is written by the claim
 *  BEFORE any money moves, so it proves nothing. */
export type RecordedPayment = {
  id: string
  status: string
  amount: number
  receiptUrl?: string | null
}

export type ChargeInfo = {
  id?: string | null
  receipt_url?: string | null
  payment_method_details?: { type?: string | null } | null
}

export type CommitArgs = {
  bookingId: string
  paymentIntentId: string
  /** ITEM M1 — WHAT STRIPE REPORTED, or NULL when Stripe reported nothing.
   *  NEVER a figure from `Booking.depositAmount`: that column is what the
   *  booking was SUPPOSED to be charged, and printing it as the captured amount
   *  is a claim about money the database cannot support. `null` means the
   *  captured amount is UNKNOWN, and the store must not invent one — see
   *  prismaApprovalStore.commitApproval, which then writes NO Payment row
   *  (rather than a made-up amount) and leaves the deposit visibly unrecorded
   *  for reconciliation, the repair action and the owner alert. */
  capturedCents: number | null
  stripeChargeId: string | null
  receiptUrl: string | null
  paymentMeta: Record<string, string>
  isInternalTest: boolean
  auditUserId: string | null
  auditDetails: Record<string, unknown>
  /** ITEM B1 — omit the PAYMENT_RECEIVED AuditLog row because this booking
   *  already has one. The Payment upsert (keyed on stripePaymentIntentId) and
   *  the Job upsert (keyed on bookingId) are exactly-once by construction;
   *  `auditLog.create` is not, so a repair that re-drives this commit would
   *  otherwise stack a second "payment received" entry on one $49. Set ONLY by
   *  the convergence path — the ordinary approval never sets it. */
  skipAudit?: boolean
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
  /** ITEM B1 — THE question both CONFIRMED early-returns must ask before they
   *  report success: is the deposit actually RECORDED? Returns the Payment row
   *  for this intent (any status) or null. Optional so existing fakes stay
   *  valid — absent means the caller vouches and the replay keeps its historical
   *  behaviour; production always wires it. */
  findPaymentForIntent?(paymentIntentId: string): Promise<RecordedPayment | null>
  /** ITEM B1 — has THIS approval (this booking, THIS payment intent) already
   *  been recorded and announced? Guards BOTH the repair's audit write and the
   *  repair's customer notification, so replaying a repair can never double-log
   *  or double-send.
   *
   *  ITEM T1 — the intent is part of the question, exactly as it is part of
   *  `approvalAuditId`. A booking-scoped count answers "has this booking ever
   *  been approved", which on a SECOND authorization suppresses the new
   *  capture's audit row and the customer's confirmation for money that has
   *  never been recorded. */
  countApprovalAudits?(bookingId: string, paymentIntentId: string): Promise<number>
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
  /** Cancel (release) an uncaptured authorization. Tolerates an already-void PI.
   *
   *  ITEM C2 — MAY return the cancelled PaymentIntent (the production gateway
   *  does: `paymentIntents.cancel` answers with it). Its `amount` is Stripe's
   *  own figure for the authorization, which is the only number a surface may
   *  print as "the hold" — `Booking.depositAmount` is what the booking was
   *  SUPPOSED to be charged. `void` stays valid so existing fakes are unchanged;
   *  it simply means "no figure", which every consumer renders as unknown. */
  releaseHold(paymentIntentId: string): Promise<CapturedIntent | void>
  /** ITEM B1 — read the intent WITHOUT changing it, to learn whether the money
   *  actually moved. Only the convergence path calls it, and only when the
   *  local Payment row is missing. Optional so existing fakes stay valid; when
   *  it is absent the convergence reports `commit_failed` rather than guessing
   *  (a blind capture is unsafe: Stripe's idempotency keys expire after 24h, so
   *  re-capturing an already-captured intent errors instead of deduping). */
  retrieveIntent?(paymentIntentId: string): Promise<CapturedIntent | null>
}

/** ITEM B1 — where a money-integrity incident goes so a human sees it. Injected
 *  (and optional) so the offline tests observe the alert instead of posting it;
 *  production wires `ops-alert.postOpsAlert`, which never throws. */
export type ApprovalAlerter = (title: string, lines: Array<{ message: string; action?: string }>) => Promise<unknown>

export interface ApprovalNotifier {
  /** ITEM T1 — `paymentIntentId` is the money this confirmation is about. It is
   *  part of the deterministic queue-job id (see `approvalEmailJobId`), so a
   *  duplicated handoff for the SAME capture still collapses while a genuinely
   *  new one is not silently swallowed by a booking-scoped key. Optional at the
   *  implementation site: a notifier that does not queue can ignore it. */
  /** ITEM M1 — `capturedCents` is NULL when Stripe did not report an amount for
   *  this capture. An implementation must then say nothing about a figure: the
   *  customer's confirmation carries no dollar amount rather than the deposit
   *  the booking column happens to hold. */
  sendApproved(
    booking: ApprovableBooking,
    capturedCents: number | null,
    approvedBy: string,
    paymentIntentId: string | null,
  ): Promise<void>
  /**
   * Booking-declined email.
   *
   * ITEM C2 (release blocker B2) — `release` is REQUIRED, because the copy this
   * sends is a claim about the customer's card. It used to take the booking
   * alone, so the template's hardcoded "Your $49 hold was released. You were not
   * charged." shipped even when the Stripe release had just THROWN and the $49
   * was still pending on their statement. An implementation must say the hold
   * was released only when `release.released` is true, and may print
   * `release.authorizedCents` (Stripe's own figure for the authorization) —
   * never `booking.depositAmount`, which is what the booking was SUPPOSED to be
   * charged.
   */
  sendDeclined(booking: ApprovableBooking, release: HoldReleaseOutcome): Promise<void>
}

/** ITEM C2 — what the decline could PROVE about the authorization.
 *   released:false + state 'release_failed' ⇒ the hold may still be live; no
 *   surface may tell the customer they were not charged. */
export type HoldReleaseOutcome = {
  released: boolean
  state: 'hold_released' | 'no_hold' | 'release_failed' | 'already_released' | 'captured' | 'unknown'
  /** CENTS Stripe reported for the authorization, when the release/read told us.
   *  Null = unknown, and unknown prints no figure. */
  authorizedCents: number | null
  /** Short reason for the audit row / owner card when the release did not
   *  happen. Never shown to a customer. */
  detail?: string
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
  /** ITEM B1 — optional so every existing dependency object still type-checks. */
  alerter?: ApprovalAlerter
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

/** PaymentIntent statuses that mean the money has NOT been taken. `canceled` is
 *  here deliberately: a released/expired authorization is uncaptured, and the
 *  capture attempt that follows will fail honestly rather than being guessed at. */
const UNCAPTURED_INTENT_STATES = new Set([
  'requires_payment_method',
  'requires_confirmation',
  'requires_action',
  'processing',
  'requires_capture',
  'canceled',
])

/**
 * ITEM B1 — what a PaymentIntent proves about the money. Pure; no I/O.
 *
 * 'captured'   — Stripe HAS the money (status succeeded, or a non-zero
 *                amount_received). Safe to record and to tell the customer.
 * 'uncaptured' — Stripe does NOT have the money and says so in a status we
 *                recognise. Safe to capture with the existing idempotency key.
 * 'unknown'    — no intent, or a status this code has never seen. NEVER guess:
 *                the caller reports `commit_failed` instead of claiming either
 *                way, because both wrong answers cost the customer $49.
 */
export function intentCaptureState(intent: CapturedIntent | null | undefined): 'captured' | 'uncaptured' | 'unknown' {
  if (!intent) return 'unknown'
  const status = typeof intent.status === 'string' ? intent.status : null
  const received = intent.amount_received
  if (status === 'succeeded') return 'captured'
  if (typeof received === 'number' && received > 0) return 'captured'
  if (status) return UNCAPTURED_INTENT_STATES.has(status) ? 'uncaptured' : 'unknown'
  // No status at all: a zero amount_received is the only remaining evidence.
  return typeof received === 'number' ? 'uncaptured' : 'unknown'
}

/**
 * ITEM M1 — THE CAPTURED AMOUNT HAS EXACTLY ONE SOURCE: STRIPE. Pure; no I/O.
 *
 * This replaces `intent.amount_received ?? intent.amount ?? booking.depositAmount`,
 * which survived three repair rounds. That last term is a BOOKING COLUMN — what
 * the booking was supposed to be charged — and it flowed into the Payment row,
 * the audit row, the customer's confirmation email, the owner's ops alert, the
 * Discord card and the admin retry message, every one of which then stated a
 * dollar figure nothing had verified. Set `depositAmount = 12345` and 12345 was
 * recorded as captured.
 *
 * `intentCaptureState` returns 'captured' for `status === 'succeeded'` with no
 * amount at all, so "captured, amount unknown" is REACHABLE and gets an answer
 * rather than an assumption: null. Every consumer renders null as unknown.
 *
 * WHY `amount` IS STILL CONSULTED: it is Stripe's own figure for this intent,
 * not the booking's. It is read ONLY when Stripe did not report `amount_received`
 * at all, and this module always captures IN FULL (`stripe.ts captureDeposit`
 * passes no `amount_to_capture`), so on a succeeded intent the two are the same
 * number. A PRESENT `amount_received` always wins — including a present zero,
 * which is Stripe saying the money did NOT arrive and must never be rounded up
 * to the authorized figure.
 */
export function capturedAmountFromIntent(intent: CapturedIntent | null | undefined): number | null {
  if (!intent) return null
  const received = intent.amount_received
  if (typeof received === 'number') return Number.isFinite(received) && received > 0 ? received : null
  const amount = intent.amount
  if (typeof amount === 'number' && Number.isFinite(amount) && amount > 0) return amount
  return null
}

/** ITEM M1 — the one place a captured amount becomes owner/customer-facing
 *  text. `null` never becomes "$0.00" and never becomes the standard fee. */
export const capturedDollars = (cents: number | null): string | null =>
  typeof cents === 'number' && Number.isFinite(cents) ? `$${(cents / 100).toFixed(2)}` : null

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

// ── ITEM R1 — EXACTLY-ONCE IS A DATABASE PROPERTY ────────────────────────────
//
// The claim IS the AuditLog row, inserted with a DETERMINISTIC PRIMARY KEY.
// `audit_logs.id` is that table's primary key on every database this code can
// be deployed against, so Postgres serialises two concurrent inserts of the
// same id: the first commits, the second raises a unique violation and its
// WHOLE transaction — the Payment upsert included — rolls back. Exactly one
// caller can ever have written that row, and that caller (and only that caller)
// tells the customer. No lease to expire, no claim to release, and nothing that
// a crash between two statements can strand: the claim and the money write are
// the SAME transaction.
//
// WHY NOT A NEW UNIQUE INDEX. A partial unique index on
// `audit_logs (booking_id) WHERE action = 'PAYMENT_RECEIVED'` was considered
// and rejected on evidence: `app/api/admin/payments/route.ts` writes a
// PAYMENT_RECEIVED row for every manual move-day payment and
// `src/lib/fulfillment.ts` writes one for the $49 AUTHORIZATION at checkout, so
// that index would refuse legitimate rows — and it would only start protecting
// anything once someone applied the migration, leaving the race live until
// then. The primary key scopes the guarantee to exactly the one row this module
// owns, and it is already applied everywhere.
//
// ITEM T1 — AND IT IS KEYED TO THE MONEY, NOT ONLY THE BOOKING. Round 2's id
// was `pyrcv_<bookingId>`: ONE PERMANENT claim per booking, for a ledger row
// that records ONE CAPTURE of ONE payment intent. A booking can legitimately
// carry a second intent (a re-authorization, a second checkout), and it is then
// entitled to a second Payment row and a second confirmation — but under the
// booking-scoped key that transaction rolled back FOREVER, so the $49 sitting
// at Stripe could never be recorded and the only remedy the product offered was
// charging the customer again. The intent is the key the money already uses
// (`Payment.stripePaymentIntentId` is unique), so the claim uses it too: SAME
// intent ⇒ same id ⇒ the concurrent collision is exactly as it was; NEW intent
// ⇒ new id ⇒ its own claim, its own row, its own confirmation.
//
// STILL NO MIGRATION: this is the same `audit_logs.id` primary key, already
// applied on every database this code can be deployed against. And it cannot
// collide with the checkout-side AUTHORIZATION claim in src/lib/fulfillment.ts
// (`pyauth__…`) — different prefix, different event.
export function approvalAuditId(bookingId: string, paymentIntentId: string): string {
  return `pyrcv__${bookingId}__${paymentIntentId}`
}

/** A UNIQUE-constraint failure — the signature of a claim somebody else won.
 *  Prisma reports P2002; the message forms are the raw Postgres text, kept for
 *  a driver-level error that never reaches Prisma's error mapper. */
export function isUniqueViolation(e: unknown): boolean {
  const code = (e as { code?: unknown } | null | undefined)?.code
  if (code === 'P2002') return true
  const message = e instanceof Error ? e.message : String(e)
  return /unique constraint|duplicate key value/i.test(message)
}

/** ITEM R1 — deterministic BullMQ ids for the approval fan-out, so a duplicated
 *  handoff (a repair that raced, a re-driven enqueue, a retried route) collapses
 *  onto the same queue job instead of reaching the customer twice. This is the
 *  SECOND line of defence — the audit claim above is the first — because a queue
 *  add can be duplicated by infrastructure the approval code never sees.
 *
 *  NO COLONS: BullMQ uses ':' as its internal Redis key separator and REJECTS a
 *  custom job id containing one (queue-jobid-safety.test.ts pins this after a
 *  production incident that silently killed every journey enqueue).
 *
 *  ITEM T1 — THE ID NAMES THE ANNOUNCEMENT, NOT THE BOOKING. A booking-scoped
 *  id is a permanent claim in Redis (`removeOnComplete: {count: 500}` keeps a
 *  completed job for weeks at this volume), so it silently DROPPED every later
 *  confirmation for the same booking — the new-intent capture, and the
 *  rescheduled move date. It now carries the three things a confirmation is
 *  about: which booking, which money, and which move date it states. Every
 *  duplicate this guard was built for (a raced repair, a re-driven enqueue, a
 *  retried route) still shares all three and still collapses; a genuinely
 *  different message no longer collides with an old one. */
const announcementKey = (bookingId: string, paymentIntentId: string | null, moveDate: Date | null | undefined): string => {
  const money = paymentIntentId ?? 'nointent'
  const when = moveDate instanceof Date && Number.isFinite(moveDate.getTime()) ? String(moveDate.getTime()) : 'nodate'
  // Belt and braces: none of these three values can contain a colon (cuid,
  // Stripe id, digits), but the id must be REJECTION-proof, and a value this
  // module does not mint is not a value it gets to assume about.
  return `${bookingId}__${money}__${when}`.replace(/:/g, '-')
}
export const approvalEmailJobId = (
  bookingId: string,
  paymentIntentId: string | null,
  moveDate: Date | null | undefined,
): string => `approval__final-confirmation__${announcementKey(bookingId, paymentIntentId, moveDate)}`
export const approvalSmsJobId = (
  bookingId: string,
  paymentIntentId: string | null,
  moveDate: Date | null | undefined,
): string => `approval__pre-approval-sms__${announcementKey(bookingId, paymentIntentId, moveDate)}`

// ── ITEM B1 — the commit retry, the owner messages, the alert ────────────────

/** Backoff between commitApproval attempts. Three attempts total (two delays).
 *  Deliberately short: a Neon autosuspend wake or a dropped-connection retry
 *  heals in well under a second, and the owner may be inside Discord's 3s
 *  interaction window. Longer than this and we would trade one silent failure
 *  for a different one. */
export const COMMIT_RETRY_DELAYS_MS = [150, 500] as const

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * ITEM B1 — commitApproval with a bounded retry.
 *
 * This is the ONE statement that runs after Stripe already has the money, so a
 * transient Postgres failure here is the whole blocker. Two extra attempts
 * remove the majority of real occurrences at a cost of at most ~650ms on a path
 * that is otherwise about to fail outright.
 *
 * A MIGRATION-shaped failure is not retried: it is deterministic, so retrying
 * only delays an honest answer.
 *
 * ITEM R1 — nor is a UNIQUE violation. That is another caller having won the
 * approval claim for this booking's capture (`approvalAuditId`, item T1: keyed
 * to the booking AND the payment intent), which is equally deterministic: every
 * retry would conflict with the same committed row. It is
 * reported as `conflict` so the caller can ask the database what actually
 * happened instead of announcing a failure over money that IS recorded.
 */
export async function commitApprovalWithRetry(
  store: Pick<ApprovalStore, 'commitApproval'>,
  args: CommitArgs,
  logger: ApprovalLogger,
  delays: readonly number[] = COMMIT_RETRY_DELAYS_MS,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<{ ok: true; attempts: number } | { ok: false; attempts: number; error: string; conflict: boolean }> {
  const attempts = delays.length + 1
  let last = 'unknown error'
  for (let i = 0; i < attempts; i++) {
    try {
      await store.commitApproval(args)
      return { ok: true, attempts: i + 1 }
    } catch (e) {
      last = asMessage(e)
      const conflict = isUniqueViolation(e)
      if (conflict || isMigrationMissing(e) || i === attempts - 1) {
        return { ok: false, attempts: i + 1, error: last, conflict }
      }
      logger.warn(
        { bookingId: args.bookingId, paymentIntentId: args.paymentIntentId, attempt: i + 1, err: last },
        'approval commit failed after a successful capture — retrying',
      )
      await wait(delays[i])
    }
  }
  /* istanbul ignore next — the loop always returns */
  return { ok: false, attempts, error: last, conflict: false }
}

/**
 * ITEM R2 — the exact label of the admin repair button, in ONE place.
 *
 * Round 1 told the owner "Click Approve again". On the admin surface that was
 * impossible: after the failure the booking reads CONFIRMED, and the status
 * route's VALID_TRANSITIONS has no CONFIRMED→CONFIRMED edge, so the 422 fired
 * BEFORE the approval branch and `approveBooking` was never called. Only the
 * Discord card could execute the repair — and that card is delivered
 * best-effort, so the very infra incident that causes the failure can also
 * remove the only route to the cure.
 *
 * The admin now has an explicit action with this label (rendered by
 * `app/(admin)/admin/(dashboard)/jobs/[id]/BookingActions.tsx`, routed by
 * `app/api/admin/bookings/[id]/status/route.ts`), and every owner-facing
 * message names it. The client component cannot import this constant — it would
 * drag Prisma and Stripe into the browser bundle — so the string is duplicated
 * there and pinned by a test that reads both files.
 */
export const ADMIN_RETRY_ACTION_LABEL = 'Retry payment record'

/** The one sentence that names the repair, per surface. Nothing here may name
 *  an action the reader cannot see from where they are standing. */
const repairInstruction = (source: ApprovalSource): string =>
  source === 'admin'
    ? `Open the booking in the admin workspace and click "${ADMIN_RETRY_ACTION_LABEL}" — it finishes the same record and cannot capture twice.`
    : 'Click Approve on this booking card again — it finishes the same record and cannot capture twice.'

/** What the OWNER is told when the money moved and the record did not save.
 *  Every clause is provable at the call site: the capture returned successfully
 *  (or Stripe reported the intent captured), and the commit threw.
 *
 *  ITEM M1 — the AMOUNT is whatever Stripe reported for this capture, and when
 *  Stripe reported none the sentence says so instead of printing the standard
 *  fee. "The $49 …" was a constant, not a measurement. */
const commitFailedMessage = (
  displayId: string,
  paymentIntentId: string,
  source: ApprovalSource,
  capturedCents: number | null,
): string => {
  const dollars = capturedDollars(capturedCents)
  const money = dollars
    ? `The ${dollars} for ${displayId} WAS captured at Stripe (${paymentIntentId})`
    : `The deposit for ${displayId} WAS captured at Stripe (${paymentIntentId}), though Stripe did not report the amount`
  return `${money}, but the booking's payment record did not save. ${repairInstruction(source)} Do NOT charge the customer again.`
}

/** What the OWNER is told when the booking reads CONFIRMED, no payment is
 *  recorded, and we could not establish what Stripe holds. Claims nothing about
 *  the money in either direction. */
const unverifiedMessage = (displayId: string, paymentIntentId: string, source: ApprovalSource): string =>
  `${displayId} is CONFIRMED but has no recorded $49 payment, and Stripe could not be checked just now (${paymentIntentId}). ` +
  `Nothing was captured by this click. ${repairInstruction(source)} Check Stripe before charging the customer anything.`

/**
 * ITEM R2 — may this booking be sent through the convergence path by the
 * admin's explicit repair action? Pure; no I/O; the route's gate.
 *
 * CONFIRMED only. That is the state the B1 incident leaves behind, and it is
 * the state `convergeConfirmed` knows how to answer for. PENDING_APPROVAL is
 * refused BY NAME rather than quietly approved: a button labelled "retry" must
 * never be the thing that first captures $49.
 */
export function checkRetryApproval(
  status: BookingStatus | string,
): { ok: true } | { ok: false; code: 'invalid_status'; message: string } {
  if (status === 'CONFIRMED') return { ok: true }
  if (status === 'PENDING_APPROVAL') {
    return {
      ok: false,
      code: 'invalid_status',
      message: 'This booking has not been approved yet — use "Confirm booking", which captures the $49 hold.',
    }
  }
  return {
    ok: false,
    code: 'invalid_status',
    message:
      `There is nothing to finish on a booking in ${status}. ` +
      'This action only repairs a CONFIRMED booking whose $49 was captured but never recorded.',
  }
}

/** ITEM R2 — what the owner reads after the repair action returns. Says only
 *  what the result PROVES: `capturedCents` is null unless a COMPLETED Payment
 *  row (or this call's own capture) established the figure, so no amount is
 *  printed when none is proven, and nothing here claims a capture happened. */
export function retryApprovalMessage(result: Extract<ApprovalResult, { ok: true }>): string {
  const dollars = capturedDollars(result.capturedCents)
  if (result.outcome !== 'already_confirmed') {
    // ITEM M1 — no amount means no Payment row was written (the store refuses to
    // record a figure Stripe did not report), so "payment record completed" is
    // exactly the claim this must not make. Nor does the no-amount branch claim
    // a capture: the RESULT alone does not prove one (item R2's rule), and this
    // function only ever sees the result.
    return dollars
      ? `Payment record completed — ${dollars} is now recorded for this booking.`
      : 'No payment amount was recorded — Stripe did not report one for this booking. ' +
          'Check the payment in Stripe and record it by hand before charging the customer anything.'
  }
  return dollars
    ? `Nothing to repair — ${dollars} is already recorded for this booking.`
    : 'Nothing to repair — this booking has no unrecorded deposit for this action to finish.'
}

/** Put a money-integrity incident somewhere a human looks. Never throws, and is
 *  time-boxed so it cannot blow Discord's 3s interaction window. */
async function raiseCommitAlert(
  deps: ApprovalDeps,
  booking: ApprovableBooking,
  paymentIntentId: string,
  capturedCents: number | null,
  error: string,
): Promise<void> {
  if (!deps.alerter) return
  // ITEM M1 — the alert is the owner's only record of this money in this failure
  // mode, so it prints the amount STRIPE reported and, when Stripe reported
  // none, says that rather than the standard fee.
  const dollars = capturedDollars(capturedCents)
  try {
    await withTimeout(
      deps.alerter(
        dollars
          ? 'DEPOSIT CAPTURED but the booking record did NOT save'
          : 'DEPOSIT CAPTURED (amount NOT reported by Stripe) and the booking record did NOT save',
        [
        {
          message:
            `${booking.displayId}: Stripe captured ${dollars ?? 'the deposit (no amount reported)'} on ${paymentIntentId}, ` +
            `and the Payment/Job/audit write failed (${error.slice(0, 140)}).`,
          action:
            `Open the booking in the admin workspace and click "${ADMIN_RETRY_ACTION_LABEL}" (or press Approve again on the ` +
            'Discord card) — it re-drives the same idempotent record and sends the customer their confirmation. ' +
            'Do NOT charge the customer again.',
        },
      ],
      ),
      1500,
    )
  } catch (e) {
    deps.logger.error(
      { bookingId: booking.id, paymentIntentId, err: asMessage(e) },
      'ops alert for the failed approval commit could not be delivered',
    )
  }
}

/**
 * ITEM M1 — the money moved and the AMOUNT is unknown, so nothing may print one.
 *
 * Reached when Stripe reports a capture with no `amount_received` and no
 * `amount` (legal per `CapturedIntent`, and exactly what `intentCaptureState`
 * calls 'captured' for a `succeeded` intent with no amounts). The commit still
 * writes the Job and the audit — the booking really is confirmed — but the
 * store writes NO Payment row, because a Payment row cannot hold "unknown": its
 * `amount` column is NOT NULL, so any row at all would be a figure.
 *
 * That leaves the deposit visibly UNRECORDED, which is the truth and is already
 * the state the whole B1 machinery is built around: `reconciliation.ts` reports
 * `captured_no_payment_row`, the admin's "Retry payment record" action and the
 * Discord card both re-drive `convergeConfirmed`, and if Stripe ever reports the
 * amount that repair records it properly. This alert is what puts a human on it
 * in the meantime.
 */
async function raiseUnknownAmountAlert(
  deps: ApprovalDeps,
  booking: ApprovableBooking,
  paymentIntentId: string,
): Promise<void> {
  if (!deps.alerter) return
  try {
    await withTimeout(
      deps.alerter('DEPOSIT CAPTURED but Stripe did not report the amount', [
        {
          message:
            `${booking.displayId}: the deposit on ${paymentIntentId} is captured, and Stripe reported no amount for it. ` +
            'No Payment row was written, because this system will not record a captured figure it cannot prove — ' +
            "the booking's balance therefore still shows the deposit as uncollected.",
          action:
            `Open ${paymentIntentId} in Stripe, read the captured amount, and record that payment on the booking by hand. ` +
            'Do NOT charge the customer again.',
        },
      ]),
      1500,
    )
  } catch (e) {
    deps.logger.error(
      { bookingId: booking.id, paymentIntentId, err: asMessage(e) },
      'ops alert for the unknown captured amount could not be delivered',
    )
  }
}

// ── The one approval operation ────────────────────────────────────────────────

export async function approveBooking(
  input: ApproveInput,
  deps: ApprovalDeps = defaultApprovalDeps(),
): Promise<ApprovalResult> {
  // `notifier` is deliberately not destructured here: everything after a
  // successful capture — commit, staffing, notification — lives in
  // `recordCapturedApproval`, which the item-B1 repair path shares.
  const { store, stripe, logger } = deps
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
  //
  // ITEM B1: it also no longer ASSUMES the money is recorded. `convergeConfirmed`
  // checks the Payment row (and, when that is missing, Stripe itself) before
  // reporting anything — "CONFIRMED" is written by the claim BEFORE the capture,
  // so on its own it proves nothing about $49.
  if (booking.status === 'CONFIRMED') {
    return convergeConfirmed(deps, input, booking, 'already_confirmed')
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
      // ITEM B1: and by the retry of a run whose commit died, which is why it
      // goes through the same convergence instead of assuming success.
      return convergeConfirmed(deps, input, fresh, 'claim_lost_already_confirmed')
    }
    return errResult('raced', 'This booking was just handled by someone else — no action taken.', fresh ?? booking)
  }

  // ── 2) CAPTURE — ITEM M2: NEVER BLIND ────────────────────────────────────
  //
  // A capture of an ALREADY-CAPTURED intent is not a no-op. Stripe's idempotency
  // keys expire after 24 HOURS, so `capture:<pi>` only replays the original
  // response inside that window; outside it Stripe ERRORS ("this PaymentIntent
  // could not be captured because it has a status of succeeded"). This module
  // already knew that — see the comment on `ApprovalStripeGateway.retrieveIntent`,
  // and `convergeConfirmed`, which refuses to blind-capture for exactly this
  // reason — while THIS path blind-captured on the one flow that re-approves an
  // intent the system has already captured:
  //
  //   the customer reschedules through the portal → the booking goes back to
  //   PENDING_APPROVAL with the SAME $49 hold attached → the owner re-approves.
  //
  // Inside 24h that replayed and looked fine. A day later it threw, the claim
  // was rolled back, and the reschedule could never be confirmed — over money
  // Stripe had already taken. So when the DATABASE proves this intent's deposit
  // was already captured (a COMPLETED Payment row for it), this asks Stripe what
  // it actually holds and captures only if the money is genuinely still on hold.
  //
  // The ordinary approval is untouched: a first approval has no COMPLETED
  // Payment row for its intent, so it costs no extra Stripe call.
  const pi = booking.stripePaymentIntentId as string // guaranteed by checkApprovable
  const recordedRow = await readRecordedPayment(deps, pi)
  const recorded = recordedRow?.status === 'COMPLETED' ? recordedRow : null

  let intent: CapturedIntent | null = null
  if (recorded) {
    const seen = await readIntentBeforeCapture(deps, booking, pi)
    if (seen.state === 'captured' && seen.intent) {
      logger.warn(
        { bookingId: booking.id, paymentIntentId: pi, source, paymentId: recorded.id },
        'this hold is ALREADY captured at Stripe and already recorded (a reschedule re-approval) — ' +
          'confirming without a second capture, which Stripe would refuse outside its 24h idempotency window',
      )
      intent = seen.intent
    } else if (seen.state === 'uncaptured') {
      // Stripe is the authority on the money: a COMPLETED row over an uncaptured
      // intent is a local record that does not match, and the honest resolution
      // is to take the deposit that was never taken. Falls through to capture.
      logger.error(
        { bookingId: booking.id, paymentIntentId: pi, source, paymentId: recorded.id },
        'a COMPLETED Payment row exists for an intent Stripe says is NOT captured — capturing it now',
      )
    } else {
      // Stripe could not be read, or answered in a state this code will not
      // classify. The database proves this deposit was captured and recorded, so
      // a blind capture here is precisely the call that errors. Confirm the
      // booking over the money already on the ledger and say only that.
      logger.error(
        { bookingId: booking.id, paymentIntentId: pi, source, paymentId: recorded.id },
        'could not establish this intent\'s state at Stripe, and its deposit is already recorded — ' +
          'confirming without attempting a capture',
      )
      return alreadyRecordedApproval(deps, input, booking, recorded, pi)
    }
  }

  /** Did THIS call move the money? False when the pre-check found it already
   *  captured — nothing below may then describe itself as a capture. */
  let capturedHere = false
  if (!intent) {
    try {
      intent = await stripe.capture(pi, `capture:${pi}`)
      capturedHere = true
    } catch (e) {
      const message = asMessage(e)
      // ITEM M2 — a refused capture can mean STRIPE ALREADY HAS THE MONEY (the
      // expired-idempotency-window case above, on a booking whose earlier
      // approval never recorded anything). Rolling the claim back there would
      // hide a real capture behind a pending booking, so ask before deciding.
      const seen = await readIntentBeforeCapture(deps, booking, pi)
      if (seen.state === 'captured' && seen.intent) {
        const settled = await readRecordedPayment(deps, pi)
        if (settled?.status === 'COMPLETED') {
          logger.error(
            { bookingId: booking.id, paymentIntentId: pi, source, err: message, paymentId: settled.id },
            'the capture was refused because this deposit is already captured, and it is already recorded — ' +
              'confirming over the existing ledger row',
          )
          return alreadyRecordedApproval(deps, input, booking, settled, pi)
        }
        if (settled) {
          // A Payment row exists for this intent and is NOT COMPLETED (refunded,
          // partially refunded, failed, or written by hand). Recording over it
          // would overwrite a recorded refund with 'COMPLETED' — a claim about
          // money that would be false — so the booking goes back to pending and
          // a human decides.
          await store.rollbackClaim(booking.id).catch((rbErr) =>
            logger.error(
              { bookingId: booking.id, err: asMessage(rbErr) },
              'CRITICAL: failed to roll back approval claim after Stripe error — booking may be CONFIRMED without capture',
            ),
          )
          logger.error(
            { bookingId: booking.id, paymentIntentId: pi, source, err: message, paymentId: settled.id, paymentStatus: settled.status },
            'the capture was refused because this deposit is already captured, and its payment record is not COMPLETED — ' +
              'the approval was rolled back rather than overwriting that record',
          )
          return errResult(
            'capture_failed',
            `${booking.displayId}: Stripe refused the capture because this hold is already captured (${pi}), and its ` +
              `payment record is ${settled.status}. The customer was NOT charged again and the booking is back to pending ` +
              'approval — review this payment in Stripe before approving it.',
            booking,
          )
        }
        logger.error(
          { bookingId: booking.id, paymentIntentId: pi, source, err: message },
          'the capture was refused because Stripe has ALREADY captured this deposit — recording the money ' +
            'instead of rolling the approval back',
        )
        return recordCapturedApproval(deps, input, booking, seen.intent, {
          phase: 'capture_refused_already_captured',
          outcome: 'repaired',
          guardAudit: false,
          // This call won the atomic PENDING_APPROVAL → CONFIRMED update.
          heldStatusClaim: true,
        })
      }

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
  }

  // 3) RECORD MONEY — Payment (idempotent upsert) + Job + AuditLog, atomically;
  //    then staffing, then the customer. Shared with the item-B1 convergence
  //    path so the repair can never drift from the ordinary approval.
  //
  //    ITEM M2 — `capturedThisCall` is false when the money was ALREADY at
  //    Stripe and this call only confirmed the booking over it (the reschedule).
  //    The outcome must not then say "we captured": the ordinary case reports
  //    `already_confirmed` from the conflict branch (the audit claim for this
  //    capture already exists), and the rare case where no audit row exists is
  //    a repair of that missing record, not a capture.
  const capturedThisCall = capturedHere
  return recordCapturedApproval(deps, input, booking, intent, {
    phase: capturedThisCall ? 'captured' : 'already_captured_confirmed',
    outcome: capturedThisCall ? 'captured' : 'repaired',
    guardAudit: false,
    // This call won the atomic PENDING_APPROVAL → CONFIRMED update above, which
    // exactly one caller can do. See `heldStatusClaim`.
    heldStatusClaim: true,
  })
}

/**
 * ITEM M2 — what the LOCAL LEDGER says about this intent's deposit. Any status,
 * or null when there is no row / no wired reader / the read failed. A read
 * failure is deliberately indistinguishable from "no row": it only ever
 * downgrades the caller to the ordinary capture path, which is what this module
 * did before this item — it never upgrades a guess into a claim.
 */
async function readRecordedPayment(deps: ApprovalDeps, paymentIntentId: string): Promise<RecordedPayment | null> {
  const { store, logger } = deps
  if (!store.findPaymentForIntent) return null
  try {
    return await store.findPaymentForIntent(paymentIntentId)
  } catch (e) {
    logger.error(
      { paymentIntentId, err: asMessage(e) },
      'could not read the Payment row before capturing — continuing as if none is recorded',
    )
    return null
  }
}

/**
 * ITEM M2 — ASK STRIPE WHAT IT HOLDS. The same discipline `convergeConfirmed`
 * applies, hoisted so the capture path can use it too. Never throws: an
 * unreadable intent is reported as 'unknown' and the caller decides, because
 * "we could not check" must never become "so we assumed".
 */
async function readIntentBeforeCapture(
  deps: ApprovalDeps,
  booking: ApprovableBooking,
  paymentIntentId: string,
): Promise<{ state: 'captured' | 'uncaptured' | 'unknown'; intent: CapturedIntent | null }> {
  const { stripe, logger } = deps
  if (!stripe.retrieveIntent) return { state: 'unknown', intent: null }
  try {
    const intent = await stripe.retrieveIntent(paymentIntentId)
    return { state: intentCaptureState(intent), intent: intent ?? null }
  } catch (e) {
    logger.error(
      { bookingId: booking.id, paymentIntentId, err: asMessage(e) },
      'could not read the payment intent before capturing — refusing to assume either way',
    )
    return { state: 'unknown', intent: null }
  }
}

/**
 * ITEM M2 — this approval's money is ALREADY captured and ALREADY on the ledger,
 * so there is nothing to capture and nothing new to record: the only thing that
 * changed is the booking (a reschedule's new date), and the customer has to hear
 * about it.
 *
 * The announcement is authorised by the STATUS claim this caller just won — the
 * atomic PENDING_APPROVAL → CONFIRMED update exactly one caller can win (item
 * T1). The amount reported is the one the DATABASE holds, never a default.
 */
async function alreadyRecordedApproval(
  deps: ApprovalDeps,
  input: ApproveInput,
  booking: ApprovableBooking,
  recorded: RecordedPayment,
  paymentIntentId: string,
): Promise<ApprovalResult> {
  await repairStaffing(deps, booking.id, 'already_captured_not_recaptured')
  await announceApproval(deps, input, booking, recorded.amount, paymentIntentId)
  return {
    ok: true,
    outcome: 'already_confirmed',
    booking,
    capturedCents: recorded.amount,
    receiptUrl: recorded.receiptUrl ?? null,
  }
}

/**
 * ITEM B1 — everything that happens AFTER Stripe has the money, in one place.
 *
 * Called by the ordinary approval (right after its capture) and by the
 * convergence path (after it establishes that the money is at Stripe). Sharing
 * it is the point: the repair writes the SAME Payment, the SAME Job, the SAME
 * audit and sends the SAME confirmation, so a repaired booking is
 * indistinguishable from one that never failed.
 *
 * `guardAudit` is set only by the repair: the ordinary approval has just won an
 * atomic claim from PENDING_APPROVAL, so it is the only writer by construction
 * and needs no count.
 *
 * ITEM T1 — `heldStatusClaim` says WHICH claim authorises this call to speak to
 * the customer:
 *   • true  — this call won the atomic `PENDING_APPROVAL → CONFIRMED` UPDATE.
 *             Postgres allows exactly one winner, so it is the single announcer
 *             of THIS confirmation even if the money it names was recorded by
 *             an earlier approval of the same intent (a rescheduled booking:
 *             same $49, same ledger row, a NEW confirmed date the customer has
 *             not been told about). Round 2 swallowed that message and the
 *             customer never learned their new date was confirmed.
 *   • false — the repair path, which runs on an already-CONFIRMED row and holds
 *             NO status claim. Its only claim is the audit insert, so it speaks
 *             only if it won that insert. This is the property the round-2
 *             `Promise.all([approve(), approve()])` reproduction rests on and
 *             it is unchanged.
 *
 * THE ONE INTERLEAVING THIS DOES NOT SERIALISE, stated rather than hidden: a
 * repair already in flight against a CONFIRMED booking, while a capture failure
 * rolls that same booking back to PENDING_APPROVAL and a fresh approval wins the
 * new status claim. Both then hold a claim and both would speak. It needs a
 * rollback to land inside another caller's repair, and the SECOND line of
 * defence catches it: both messages carry the same deterministic queue-job id
 * (same booking, same intent, same date), so BullMQ admits one of them.
 */
async function recordCapturedApproval(
  deps: ApprovalDeps,
  input: ApproveInput,
  booking: ApprovableBooking,
  intent: CapturedIntent,
  opts: { phase: string; outcome: 'captured' | 'repaired'; guardAudit: boolean; heldStatusClaim: boolean },
): Promise<ApprovalResult> {
  // `notifier` is reached through `announceApproval`, which owns the timeout and
  // the never-throw contract for BOTH of this function's announcement paths.
  const { store, stripe, logger } = deps
  const { actor, source } = input

  // ── ITEM M1 — THE AMOUNT COMES FROM STRIPE, OR IT IS UNKNOWN ──────────────
  // This line used to end `?? booking.depositAmount`. That is a BOOKING COLUMN
  // (what the booking was supposed to be charged), and it reached the Payment
  // row, the audit row, the customer's confirmation email, the owner's ops
  // alert, the Discord card and the admin retry message — every one of them
  // then stating a dollar figure nothing had verified. `null` is now carried
  // end to end and every consumer renders it as unknown.
  const capturedCents = capturedAmountFromIntent(intent)

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

  // ITEM B1 — has THIS MODULE already recorded and announced this approval?
  //
  // ITEM R1 — this is a CHEAP PRE-CHECK, no longer the guard. It exists to skip
  // a pointless write on the ordinary "somebody already approved this last
  // week" replay; the thing that makes a second announcement IMPOSSIBLE is the
  // deterministic primary key the commit below inserts under. So a count we
  // cannot read is still treated as ZERO — the database refuses the duplicate
  // either way, and a customer who is never told their $49 was taken is the
  // defect this whole item exists to close.
  //
  // ITEM R1 — and it counts only the audit THIS MODULE writes
  // (`details.event = 'approve_booking'`). Round 1 counted every
  // PAYMENT_RECEIVED row for the booking, but `src/lib/fulfillment.ts` writes
  // one for the $49 AUTHORIZATION on every paid checkout and
  // `app/api/admin/payments/route.ts` writes one for every manual move-day
  // payment — so on a real booking the count was already ≥ 1 before the owner
  // ever clicked Approve, and the repair path suppressed BOTH its audit and the
  // customer's confirmation. The B1 silence, reintroduced by its own fix.
  //
  // ITEM T1 — and it is asked about THIS PAYMENT INTENT, the same scope as the
  // claim id it stands in front of. A booking-scoped count is the count-side
  // twin of the booking-scoped key: on a SECOND authorization it reports "1"
  // for money it has never seen, sets `skipAudit`, and silences the customer
  // whose new $49 was just captured.
  let alreadyAnnounced = false
  if (opts.guardAudit && store.countApprovalAudits) {
    try {
      alreadyAnnounced = (await store.countApprovalAudits(booking.id, intent.id)) > 0
    } catch (e) {
      logger.warn(
        { bookingId: booking.id, err: asMessage(e) },
        'could not count this approval\'s PAYMENT_RECEIVED audits — the repair proceeds and lets the database decide',
      )
    }
  }

  const commit = await commitApprovalWithRetry(
    store,
    {
      bookingId: booking.id,
      paymentIntentId: intent.id,
      capturedCents,
      stripeChargeId,
      receiptUrl,
      paymentMeta,
      isInternalTest,
      auditUserId: actor.userId ?? null,
      ...(alreadyAnnounced ? { skipAudit: true } : {}),
      auditDetails: {
        event: 'approve_booking',
        source,
        approvedBy: actor.name,
        discordUserId: actor.discordUserId ?? null,
        userId: actor.userId ?? null,
        previousStatus: 'PENDING_APPROVAL',
        newStatus: 'CONFIRMED',
        // ITEM M1 — null when Stripe reported no amount. The audit row is a
        // permanent record: it says "unknown" rather than the standard fee, and
        // carries the flag that makes the gap searchable.
        captured: capturedCents,
        ...(capturedCents == null ? { capturedAmountUnknown: true } : {}),
        paymentIntentId: intent.id,
        stripeResult: capturedCents == null ? 'captured_amount_not_reported' : 'captured',
        result: 'success',
        ...(opts.outcome === 'repaired' ? { repairedFrom: opts.phase } : {}),
      },
    },
    logger,
  )

  if (!commit.ok) {
    // ITEM R1 — DID SOMEBODY ELSE WIN THE CLAIM? A unique violation on this
    // commit is the signature of another caller having inserted the
    // PAYMENT_RECEIVED row for this booking's capture, which rolled THIS
    // transaction back in full. That is not a failure: the money is recorded, by
    // them. Ask the database rather than assuming in either direction — an
    // unreadable answer falls through to the honest B1 report below.
    //
    // ITEM T1 — and the question is now the RIGHT one. The claim is keyed to
    // this booking AND this intent, so a conflict can only mean "this exact
    // capture is already recorded" — which is precisely what
    // `recordedByAnotherCaller(intent.id)` looks for. Under the booking-scoped
    // key a SECOND intent conflicted with the FIRST intent's row, so this lookup
    // asked about money nobody had recorded, found nothing, and fell through to
    // a `commit_failed` that no retry could ever clear.
    if (commit.conflict) {
      const settled = await recordedByAnotherCaller(deps, intent.id)
      if (settled) {
        // ITEM T1 — WHO GETS TO SPEAK. If this call won the atomic
        // PENDING_APPROVAL → CONFIRMED update, it is the single author of THIS
        // confirmation and says so, even though the $49 it names was recorded
        // earlier: that is the rescheduled booking (same hold, new date), and
        // round 2 left that customer in silence. If it holds no status claim it
        // is a concurrent repair that lost the insert — it wrote nothing and it
        // tells nobody, which is the property the Promise.all reproduction pins.
        logger.warn(
          {
            bookingId: booking.id,
            paymentIntentId: intent.id,
            source,
            phase: opts.phase,
            paymentId: settled.id,
            heldStatusClaim: opts.heldStatusClaim,
          },
          opts.heldStatusClaim
            ? 'this deposit was already recorded — no second ledger row, and this call announces the confirmation it just claimed'
            : 'a concurrent approval won the record claim for this capture — this call wrote nothing and told nobody',
        )
        await repairStaffing(deps, booking.id, opts.phase)
        if (opts.heldStatusClaim) {
          await announceApproval(deps, input, booking, settled.amount, intent.id)
        }
        return {
          ok: true,
          outcome: 'already_confirmed',
          booking,
          capturedCents: settled.amount,
          receiptUrl: settled.receiptUrl ?? null,
        }
      }
    }

    // THE B1 STATE. The money IS at Stripe and the record is not. Do NOT roll
    // the claim back (that would hide a real capture behind a PENDING booking),
    // and do NOT throw (a bare 500 reads as "try again" and invites a second
    // charge). Say exactly what happened, alert, and let the replay converge.
    logger.error(
      {
        bookingId: booking.id,
        paymentIntentId: intent.id,
        captured: capturedCents,
        source,
        phase: opts.phase,
        attempts: commit.attempts,
        err: commit.error,
      },
      'CRITICAL: the deposit IS captured at Stripe but the approval commit did not save — no Payment/Job/audit row',
    )
    await raiseCommitAlert(deps, booking, intent.id, capturedCents, commit.error)
    return errResult('commit_failed', commitFailedMessage(booking.displayId, intent.id, source, capturedCents), booking)
  }

  // ITEM R1 — THE WINNING CLAIM, and the only thing that unlocks a customer
  // message. The commit above either inserted this capture's PAYMENT_RECEIVED
  // row under its deterministic primary key (so Postgres has certified this call
  // as the single announcer) or it deliberately omitted that row because this
  // capture was already announced. There is no third possibility: a duplicate
  // insert rolls the whole transaction back and is handled above.
  //
  // ITEM T1 — `alreadyAnnounced` is now intent-scoped, so "already announced"
  // means "this $49 was", not "this booking has been approved at some point".
  const wonAnnouncement = !alreadyAnnounced

  logger.info(
    {
      bookingId: booking.id,
      captured: capturedCents,
      capturedAmountUnknown: capturedCents == null,
      source,
      approvedBy: actor.name,
      attempts: commit.attempts,
    },
    // ITEM M1 — the log line no longer says "$49" over money nobody measured.
    capturedCents == null
      ? 'Booking approved → deposit captured, amount NOT reported by Stripe → CONFIRMED (no Payment row written)'
      : opts.outcome === 'repaired'
        ? 'Approval REPAIRED → captured deposit recorded → CONFIRMED'
        : 'Booking approved → deposit captured → CONFIRMED',
  )

  // ITEM M1 — a capture whose amount Stripe never reported leaves the deposit
  // unrecorded ON PURPOSE (see raiseUnknownAmountAlert). That is a money gap a
  // human has to close, so it is alerted the same way a failed commit is.
  if (capturedCents == null) {
    logger.error(
      { bookingId: booking.id, paymentIntentId: intent.id, source, phase: opts.phase },
      'CRITICAL: the deposit is captured at Stripe and Stripe reported NO amount — no Payment row was written, ' +
        'because this system does not record a captured figure it cannot prove',
    )
    await raiseUnknownAmountAlert(deps, booking, intent.id)
  }

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
  await repairStaffing(deps, booking.id, opts.phase)

  // 4) NOTIFY — only now, after the state is truthful. Non-fatal + time-boxed
  //    so a Redis stall can't blow Discord's 3s interaction window or undo the
  //    capture. A failed notification leaves the money + booking intact.
  //
  //    ITEM B1/R1: gated on the SAME winning claim as the audit row — the
  //    transaction that inserted `approvalAuditId(booking.id, intent.id)`. A
  //    repair sends the confirmation the customer never got, exactly once,
  //    however many owners click at the same moment: the loser's transaction
  //    rolled back, so it never reaches here with `wonAnnouncement` true.
  if (wonAnnouncement) {
    await announceApproval(deps, input, booking, capturedCents, intent.id)
  } else {
    logger.info(
      { bookingId: booking.id, paymentIntentId: intent.id },
      'repair did not re-send the customer confirmation — this capture was already recorded and announced',
    )
  }

  return { ok: true, outcome: opts.outcome, booking, capturedCents, receiptUrl }
}

/**
 * Send the customer their confirmation. ONE place, because two call sites now
 * reach it (the recorded commit, and the T1 status-claim holder whose money was
 * already on the ledger) and they must not drift.
 *
 * Never throws and never blocks the money: the deposit is captured and recorded
 * before this runs, so a Redis stall costs a message, not a record. Time-boxed
 * because the Discord path is inside a 3s interaction window.
 */
async function announceApproval(
  deps: ApprovalDeps,
  input: ApproveInput,
  booking: ApprovableBooking,
  /** ITEM M1 — null = Stripe reported no amount. Passed through as null; the
   *  notifier omits the figure rather than substituting one. */
  capturedCents: number | null,
  paymentIntentId: string,
): Promise<void> {
  if (input.notify === false) return
  try {
    await withTimeout(
      deps.notifier.sendApproved(booking, capturedCents, input.actor.name, paymentIntentId),
      input.notifyTimeoutMs ?? 2500,
    )
  } catch (e) {
    deps.logger.error(
      { bookingId: booking.id, paymentIntentId, err: asMessage(e) },
      'approval notifications failed/timeout (non-fatal)',
    )
  }
}

/**
 * ITEM R1 — "did another caller already record this deposit?", asked of the
 * DATABASE. Only ever called after a unique violation, and only to decide
 * whether a rolled-back commit was a failure or a lost race. A COMPLETED
 * Payment row on this intent is the same proof `convergeConfirmed` uses; null
 * (including an unreadable answer) keeps the honest commit_failed report.
 */
async function recordedByAnotherCaller(
  deps: ApprovalDeps,
  paymentIntentId: string,
): Promise<RecordedPayment | null> {
  const { store, logger } = deps
  if (!store.findPaymentForIntent) return null
  try {
    const recorded = await store.findPaymentForIntent(paymentIntentId)
    return recorded && recorded.status === 'COMPLETED' ? recorded : null
  } catch (e) {
    logger.error(
      { paymentIntentId, err: asMessage(e) },
      'could not read the Payment row after a claim conflict — reporting the commit failure rather than guessing',
    )
    return null
  }
}

/**
 * ITEM B1 — the CONFIRMED replay, converged instead of assumed.
 *
 * Reached from both early-returns in `approveBooking`. The booking already
 * reads CONFIRMED; the question this answers is whether the MONEY matches, and
 * it never reports success over a $49 it cannot see.
 *
 * Ordering note: the Payment row is checked FIRST and Stripe only when it is
 * missing, so the ordinary replay (by far the common case) costs one indexed
 * lookup and no network call.
 */
async function convergeConfirmed(
  deps: ApprovalDeps,
  input: ApproveInput,
  booking: ApprovableBooking,
  phase: string,
): Promise<ApprovalResult> {
  const { store, stripe, logger } = deps
  const pi = booking.stripePaymentIntentId

  // A store from before this item (every offline fake, and any caller that
  // vouches for its own convergence) keeps the historical behaviour rather than
  // being broken by a capability it never had. Production always wires it.
  if (!pi || !store.findPaymentForIntent) {
    await repairStaffing(deps, booking.id, phase)
    return { ok: true, outcome: 'already_confirmed', booking, capturedCents: null, receiptUrl: null }
  }

  let recorded: RecordedPayment | null
  try {
    recorded = await store.findPaymentForIntent(pi)
  } catch (e) {
    logger.error(
      { bookingId: booking.id, phase, paymentIntentId: pi, err: asMessage(e) },
      'CONFIRMED replay could not read the Payment row — refusing to report success over money it cannot see',
    )
    return errResult('commit_failed', unverifiedMessage(booking.displayId, pi, input.source), booking)
  }

  // The healthy replay: the deposit is recorded. Report the amount the DATABASE
  // proves, so a caller never has to fall back to a hardcoded $49.
  if (recorded && recorded.status === 'COMPLETED') {
    await repairStaffing(deps, booking.id, phase)
    return {
      ok: true,
      outcome: 'already_confirmed',
      booking,
      capturedCents: recorded.amount,
      receiptUrl: recorded.receiptUrl ?? null,
    }
  }

  // A Payment row EXISTS for this intent but is not COMPLETED — refunded,
  // partially refunded, failed, or written by hand. `commitApproval` demonstrably
  // ran for this intent, so this is NOT the B1 defect (which leaves NO row at
  // all), and re-driving the commit here would overwrite a recorded refund with
  // 'COMPLETED' — a claim about money that would be false. Report the replay,
  // prove no amount, and leave the row alone; reconciliation's
  // `confirmed_no_payment` is what surfaces this shape.
  if (recorded) {
    logger.error(
      { bookingId: booking.id, phase, paymentIntentId: pi, paymentId: recorded.id, paymentStatus: recorded.status },
      'CONFIRMED booking whose deposit record is not COMPLETED — left untouched, and no amount is claimed for it',
    )
    await repairStaffing(deps, booking.id, phase)
    return { ok: true, outcome: 'already_confirmed', booking, capturedCents: null, receiptUrl: null }
  }

  // ── The blocker state. CONFIRMED + depositPaid, and NO Payment row at all.
  //    Stripe is the only authority on which of the two shapes this is.
  logger.error(
    { bookingId: booking.id, phase, paymentIntentId: pi },
    'CONFIRMED booking has NO recorded deposit — converging against Stripe before answering',
  )

  if (!stripe.retrieveIntent) {
    logger.error(
      { bookingId: booking.id, phase, paymentIntentId: pi },
      'no Stripe intent read is wired — cannot establish whether the deposit was captured',
    )
    return errResult('commit_failed', unverifiedMessage(booking.displayId, pi, input.source), booking)
  }

  let intent: CapturedIntent | null = null
  let state: 'captured' | 'uncaptured' | 'unknown'
  try {
    intent = await stripe.retrieveIntent(pi)
    state = intentCaptureState(intent)
  } catch (e) {
    logger.error(
      { bookingId: booking.id, phase, paymentIntentId: pi, err: asMessage(e) },
      'could not retrieve the payment intent — refusing to claim the deposit either way',
    )
    return errResult('commit_failed', unverifiedMessage(booking.displayId, pi, input.source), booking)
  }

  if (state === 'unknown') {
    logger.error(
      { bookingId: booking.id, phase, paymentIntentId: pi, intentStatus: intent?.status ?? null },
      'the payment intent is in a state this code cannot classify — refusing to guess',
    )
    return errResult('commit_failed', unverifiedMessage(booking.displayId, pi, input.source), booking)
  }

  if (state === 'uncaptured') {
    // THE MIRROR CASE: the process died between the atomic claim and the
    // capture, so the compensating rollback never ran. The row reads CONFIRMED
    // over an authorization that Stripe expires in ~7 days. Capture it with the
    // SAME idempotency key the ordinary path uses (so a genuine race still
    // collapses to one charge); if that fails, the row must not go on saying
    // CONFIRMED.
    logger.warn(
      { bookingId: booking.id, phase, paymentIntentId: pi, intentStatus: intent?.status ?? null },
      'CONFIRMED booking whose authorization was never captured — capturing it now',
    )
    try {
      intent = await stripe.capture(pi, `capture:${pi}`)
    } catch (e) {
      const message = asMessage(e)
      await store.rollbackClaim(booking.id).catch((rbErr) =>
        logger.error(
          { bookingId: booking.id, err: asMessage(rbErr) },
          'CRITICAL: failed to roll back approval claim after Stripe error — booking may be CONFIRMED without capture',
        ),
      )
      logger.error(
        { bookingId: booking.id, phase, paymentIntentId: pi, err: message },
        'the uncaptured authorization on a CONFIRMED booking could not be captured — claim rolled back',
      )
      return errResult(
        'capture_failed',
        `${booking.displayId} read CONFIRMED but its $49 was never captured, and capturing it now failed: ${message}. ` +
          'The booking is back to pending approval and the customer has NOT been charged.',
        booking,
      )
    }
  }

  // Money is at Stripe (verified, or captured a moment ago) and is not recorded
  // locally. Re-drive the SAME idempotent commit, then staffing, then the
  // confirmation the customer never received.
  return recordCapturedApproval(deps, input, booking, intent as CapturedIntent, {
    phase,
    outcome: 'repaired',
    guardAudit: true,
    // The repair runs on an already-CONFIRMED row: there is no status claim to
    // win here, so the audit insert is the only thing that authorises it to
    // speak to the customer (item T1).
    heldStatusClaim: false,
  })
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
  | {
      ok: true
      outcome: 'declined' | 'already_cancelled'
      booking: ApprovableBooking
      holdReleased: boolean
      /** ITEM C2 — WHY `holdReleased` is what it is, so a caller can render the
       *  difference between "nothing was ever held" and "the release FAILED and
       *  the customer's $49 may still be pending". Both used to be `false`. */
      release: HoldReleaseOutcome
    }
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

  // ── ITEM C2 (blocker B2) — A DECLINE THAT COULD NOT RELEASE MUST BE RETRYABLE.
  //    This early return used to answer `{ok:true, holdReleased:false}` and stop
  //    BEFORE the release block below, so the ONLY repair available to the owner
  //    (click Deny again) did nothing at all: the $49 stayed on the customer's
  //    card until Stripe's ~7-day expiry while every surface said it was
  //    released. Re-declining now re-drives the RELEASE (never the email, never
  //    the status — the booking is already cancelled and the customer already
  //    heard from us), and it asks Stripe first so it can tell an authorization
  //    that is genuinely gone from one that is still live.
  if (booking.status === 'CANCELLED') {
    const retry = await retryHoldRelease(deps, booking, { actor, source })
    return { ok: true, outcome: 'already_cancelled', booking, holdReleased: retry.released, release: retry }
  }

  const guard = checkDeclinable(booking.status)
  if (!guard.ok) return { ok: false, code: guard.code, message: guard.message, booking }

  // Atomic claim of the transition to CANCELLED among the deny-able statuses.
  const claimed = await store.claimCancel(booking.id)
  if (claimed === 0) {
    const fresh = await store.reloadStatus(booking.id)
    if (fresh?.status === 'CANCELLED') {
      const retry = await retryHoldRelease(deps, fresh, { actor, source })
      return { ok: true, outcome: 'already_cancelled', booking: fresh, holdReleased: retry.released, release: retry }
    }
    return { ok: false, code: 'raced', message: 'This booking was just handled by someone else — no action taken.', booking: fresh ?? booking }
  }

  // Release the authorization (no money moves). Non-fatal — the hold may already
  // be void; the decline still stands. ITEM C2: the OUTCOME is now carried out
  // of here instead of being flattened into one boolean and a log line.
  const release = await releaseAuthorization(deps, booking)
  const holdReleased = release.released

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
      // ITEM C2 — this string is the ONLY durable record of what happened to the
      // authorization (there is no Booking column for it), and the customer
      // portal reads it back as its release evidence. It must be the truth.
      stripeResult: releaseAuditResult(release),
      // ITEM C2 — was `result: 'success'` unconditionally, sitting in the same
      // row as `stripeResult: 'release_failed: …'`. The audit contradicted
      // itself, and the contradiction is what nobody noticed.
      result: holdReleased || release.state === 'no_hold' ? 'success' : 'release_failed',
    },
  })

  logger.info(
    { bookingId: booking.id, source, deniedBy: actor.name, holdReleased, releaseState: release.state },
    holdReleased
      ? 'Booking declined → hold released → CANCELLED'
      : release.state === 'no_hold'
        ? 'Booking declined → CANCELLED (no authorization to release)'
        : 'Booking declined → CANCELLED, but the Stripe hold release FAILED — the customer may still have a pending authorization',
  )

  if (input.notify !== false) {
    try {
      await withTimeout(notifier.sendDeclined(booking, release), input.notifyTimeoutMs ?? 2500)
    } catch (e) {
      logger.error({ bookingId: booking.id, err: asMessage(e) }, 'declined notification failed/timeout (non-fatal)')
    }
  }

  return { ok: true, outcome: 'declined', booking, holdReleased, release }
}

/** ITEM C2 — the audit's `stripeResult`, in the exact vocabulary
 *  `captured-amount.provenHoldRelease` reads back on the customer portal. */
function releaseAuditResult(r: HoldReleaseOutcome): string {
  if (r.state === 'hold_released' || r.state === 'already_released') return 'hold_released'
  if (r.state === 'no_hold') return 'no_hold'
  return `release_failed: ${(r.detail ?? r.state).slice(0, 80)}`
}

/**
 * ITEM C2 — cancel the uncaptured authorization, and REPORT what happened.
 *
 * Never throws: a decline is a decision the owner already made, and a Stripe
 * outage may not block it. What changes is that the failure now leaves the
 * building — as a state a caller can render and a retry can act on — instead of
 * being reduced to one `logger.warn` nobody reads.
 */
async function releaseAuthorization(deps: ApprovalDeps, booking: ApprovableBooking): Promise<HoldReleaseOutcome> {
  const { stripe, logger } = deps
  if (!booking.stripePaymentIntentId) {
    return { released: false, state: 'no_hold', authorizedCents: null }
  }
  try {
    const intent = await stripe.releaseHold(booking.stripePaymentIntentId)
    // `releaseHold` may return the cancelled PaymentIntent (the production
    // gateway does — `paymentIntents.cancel` answers with it). When it does,
    // Stripe's own `amount` is the authorized figure, which is the only number
    // any surface may call "the hold".
    return { released: true, state: 'hold_released', authorizedCents: authorizedAmountFromIntent(intent) }
  } catch (e) {
    const detail = asMessage(e)
    logger.warn(
      { bookingId: booking.id, err: detail },
      'releaseHold FAILED — the booking is cancelled, but the authorization may still be live on the customer card',
    )
    return { released: false, state: 'release_failed', authorizedCents: null, detail }
  }
}

/**
 * ITEM C2 — the retry, for a booking that is ALREADY cancelled.
 *
 * Reads Stripe before acting, exactly as the reschedule/convergence paths do:
 *  • intent already `canceled`  ⇒ the hold IS gone. Proven, nothing to do.
 *  • intent captured            ⇒ money moved; a release is not the answer and
 *                                 must not be attempted or claimed.
 *  • intent uncaptured          ⇒ THIS is the failed release. Release it now and
 *                                 record the new outcome.
 *  • cannot read                ⇒ report `unknown`. "We could not check" never
 *                                 becomes "so we assumed" — and it never
 *                                 becomes a customer-facing "you were not
 *                                 charged" either.
 * The customer is NOT re-emailed and the audit is written only when this call
 * actually changed something, so re-clicking Deny cannot double-send.
 */
async function retryHoldRelease(
  deps: ApprovalDeps,
  booking: ApprovableBooking,
  ctx: { actor: ApprovalActor; source: ApprovalSource },
): Promise<HoldReleaseOutcome> {
  const { store, stripe, logger } = deps
  if (!booking.stripePaymentIntentId) return { released: false, state: 'no_hold', authorizedCents: null }
  if (!stripe.retrieveIntent) {
    return { released: false, state: 'unknown', authorizedCents: null, detail: 'no Stripe read available' }
  }

  let intent: CapturedIntent | null = null
  try {
    intent = (await stripe.retrieveIntent(booking.stripePaymentIntentId)) ?? null
  } catch (e) {
    logger.error(
      { bookingId: booking.id, err: asMessage(e) },
      'could not read the payment intent while retrying a hold release — refusing to claim either way',
    )
    return { released: false, state: 'unknown', authorizedCents: null, detail: asMessage(e) }
  }

  if (!intent) return { released: false, state: 'unknown', authorizedCents: null, detail: 'intent not found' }
  if (intent.status === 'canceled') {
    return { released: true, state: 'already_released', authorizedCents: authorizedAmountFromIntent(intent) }
  }
  if (intentCaptureState(intent) === 'captured') {
    logger.error(
      { bookingId: booking.id, paymentIntentId: booking.stripePaymentIntentId },
      'a CANCELLED booking has a CAPTURED payment intent — releasing is not the repair; this needs a refund decision',
    )
    return { released: false, state: 'captured', authorizedCents: capturedAmountFromIntent(intent), detail: 'intent is captured' }
  }

  const outcome = await releaseAuthorization(deps, booking)
  // Record the RETRY so the trail (and the portal, which reads it) reflects the
  // newest known state. Non-fatal: the money outcome is what matters.
  await store
    .recordDecline({
      bookingId: booking.id,
      auditUserId: ctx.actor.userId ?? null,
      auditDetails: {
        event: 'decline_booking_release_retry',
        source: ctx.source,
        deniedBy: ctx.actor.name,
        previousStatus: 'CANCELLED',
        newStatus: 'CANCELLED',
        stripeResult: releaseAuditResult(outcome),
        result: outcome.released ? 'success' : 'release_failed',
      },
    })
    .catch((e) => logger.error({ bookingId: booking.id, err: asMessage(e) }, 'could not record the hold-release retry (non-fatal)'))

  logger.info(
    { bookingId: booking.id, released: outcome.released },
    outcome.released
      ? 'hold-release RETRY succeeded — the authorization is now released'
      : 'hold-release RETRY failed — the authorization may still be live',
  )
  return outcome
}

/** ITEM C2 — Stripe's figure for an AUTHORIZED (not captured) intent. `amount`
 *  is what was authorized; `amount_received` is what was taken, which is 0 on a
 *  hold. Null when Stripe told us nothing usable. */
function authorizedAmountFromIntent(intent: CapturedIntent | void | null): number | null {
  if (!intent || typeof intent !== 'object') return null
  const amount = (intent as CapturedIntent).amount
  return typeof amount === 'number' && Number.isFinite(amount) && amount > 0 ? amount : null
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
      // ITEM C2 — the cancelled PaymentIntent is RETURNED, not discarded: it is
      // Stripe confirming the release AND reporting the authorized amount.
      releaseHold: async (pi) => (await cancelDeposit(pi)) as unknown as CapturedIntent,
      // ITEM B1 — a plain read, used only when a CONFIRMED booking has no
      // recorded Payment. `stripeClient` is the lazy Proxy from ./stripe, so
      // naming it here opens no connection.
      retrieveIntent: async (pi) =>
        (await stripeClient.paymentIntents.retrieve(pi)) as unknown as CapturedIntent,
    },
    notifier: queueApprovalNotifier(),
    logger: apiLogger,
    // ITEM B1 — postOpsAlert is a bare HTTPS POST (no discord.js), never throws,
    // and reports whether a channel actually accepted the message.
    alerter: (title, lines) => postOpsAlert(title, lines),
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
    async findPaymentForIntent(paymentIntentId) {
      // Explicit select (house rule): a column added to Payment tomorrow must
      // not be able to break this read on a database that lacks it. The unique
      // key is the same one commitApproval upserts on, so this and the write
      // can never disagree about which row "the deposit" is.
      const p = await prisma.payment.findUnique({
        where: { stripePaymentIntentId: paymentIntentId },
        select: { id: true, status: true, amount: true, receiptUrl: true },
      })
      return p ? { id: p.id, status: String(p.status), amount: p.amount, receiptUrl: p.receiptUrl ?? null } : null
    },
    async countApprovalAudits(bookingId, paymentIntentId) {
      // ITEM R1 — count ONLY the row this module writes. `action` alone is far
      // too wide: src/lib/fulfillment.ts writes a PAYMENT_RECEIVED audit for the
      // $49 AUTHORIZATION on every paid checkout, and
      // app/api/admin/payments/route.ts writes one for every manual move-day
      // payment. Counting those made the round-1 guard fire on essentially every
      // real booking, so the repair path skipped its own audit AND suppressed
      // the customer's confirmation — the exact silence B1 exists to close.
      // `details.event` is the discriminator every row this module has ever
      // written carries (see auditDetails in recordCapturedApproval).
      //
      // ITEM T1 — and ONLY the row for THIS payment intent. `details.paymentIntentId`
      // is carried by every row this module has ever written too (same
      // auditDetails), including the pre-R1 rows that exist in a live database,
      // so this scoping loses nothing historical. Without it the count is the
      // booking-scoped guard again by another name: a second authorization would
      // be told "already recorded" for money that has no Payment row, and the
      // customer would be silenced over a $49 that really was captured.
      return prisma.auditLog.count({
        where: {
          bookingId,
          action: 'PAYMENT_RECEIVED',
          AND: [
            { details: { path: ['event'], equals: 'approve_booking' } },
            { details: { path: ['paymentIntentId'], equals: paymentIntentId } },
          ],
        },
      })
    },
    async commitApproval(a) {
      // ITEM B1 — the ONLY change to this transaction is that the AuditLog row
      // can be omitted when the booking already has one (a repair re-driving
      // the same commit). The Payment upsert (keyed on stripePaymentIntentId)
      // and the Job upsert (keyed on bookingId) are untouched: both are already
      // exactly-once, which is what makes the repair safe to run repeatedly.
      //
      // ITEM R1 — and the AuditLog row now carries a DETERMINISTIC PRIMARY KEY.
      // That single `id:` is the whole exactly-once guarantee: two concurrent
      // repairs both reach this transaction, Postgres lets exactly one insert
      // commit, and the loser's ENTIRE transaction (Payment upsert included)
      // rolls back with a unique violation that recordCapturedApproval reads as
      // "somebody else recorded it". No count, no lease, nothing to release.
      //
      // ITEM T1 — that key names the BOOKING AND THE PAYMENT INTENT, the same
      // scope as the Payment row this transaction upserts. One capture, one
      // ledger row; a different capture is different money and gets its own.
      //
      // ITEM M1 — AND THERE IS NO PAYMENT ROW FOR AN AMOUNT NOBODY REPORTED.
      // `payments.amount` is NOT NULL, so every row states a figure; when Stripe
      // reported none, any figure this code could put there would be invented
      // (the removed `?? booking.depositAmount` is exactly that mistake). So the
      // Job and the audit are still written — the booking IS confirmed and the
      // capture IS on the record — and the DEPOSIT stays visibly unrecorded,
      // which is both true and already actionable: `reconciliation.ts` reports
      // `captured_no_payment_row`, and the admin's "Retry payment record" /
      // the Discord card re-drive `convergeConfirmed`, which records the
      // payment properly the moment Stripe does report an amount.
      const ops: Prisma.PrismaPromise<unknown>[] = []
      if (a.capturedCents != null) {
        ops.push(
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
        )
      }
      ops.push(
        prisma.job.upsert({
          where: { bookingId: a.bookingId },
          update: { status: 'SCHEDULED' },
          create: { bookingId: a.bookingId, status: 'SCHEDULED' },
        }),
      )
      if (!a.skipAudit) {
        ops.push(
          prisma.auditLog.create({
            data: {
              id: approvalAuditId(a.bookingId, a.paymentIntentId),
              action: 'PAYMENT_RECEIVED',
              bookingId: a.bookingId,
              userId: a.auditUserId,
              details: a.auditDetails as never,
            },
          }),
        )
      }
      await prisma.$transaction(ops)
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
    async sendApproved(booking, capturedCents, approvedBy, paymentIntentId) {
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
          // ── ITEM C1 — THE PROVEN AMOUNT TRAVELS ON THE EVENT.
          //    OUTBOX_ENABLED is the LIVE email path (EMAIL-REGISTRY.md), and
          //    this call omitted the amount entirely — so `ApprovedPayload
          //    .capturedAmountCents` (added for exactly this) was always null
          //    and `premiumEmails.renderFinalConfirmation` fell through to its
          //    ledger re-read, and, before that existed, to
          //    `booking.depositAmount`. The whole D2 chain was wired and had
          //    nothing feeding it. `capturedCents` here is
          //    `capturedAmountFromIntent` — Stripe's figure or null, never the
          //    booking column — so null still means "name no amount".
          capturedAmountCents: capturedCents,
        })
      } else {
        // ITEM R1 — deterministic jobId. `final-confirmation` is transactional,
        // so it is exempt from the send caps: if a duplicated handoff ever
        // reaches the queue it would reach the CUSTOMER. BullMQ drops an add
        // whose custom id is already present, so a duplicate collapses here
        // instead of arriving in their inbox.
        //
        // ITEM T1 — the id names this ANNOUNCEMENT (booking + money + the move
        // date it states), not the booking. Keyed to the booking alone it was a
        // permanent claim in Redis, and it silently ate the two confirmations
        // this repair exists to deliver: the one for a second $49 capture, and
        // the one telling a customer their RESCHEDULED date is confirmed.
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
            // ITEM M1 — the deposit figure is included ONLY when Stripe reported
            // one. It used to be `booking.depositAmount` in disguise, so the
            // customer read "Your $49 deposit is applied to your move" over a
            // capture nothing had measured. Absent ⇒ the template omits the
            // payment row and the deposit sentence names no amount (see
            // src/emails/final-confirmation.tsx); the confirmation itself — the
            // message that matters — still goes out.
            ...(capturedCents != null ? { amountPaid: String(Math.round(capturedCents / 100)) } : {}),
            originAddress: booking.originAddress ?? undefined,
            destAddress: booking.destAddress ?? undefined,
            estimate: booking.totalEstimate != null ? `$${Math.round(booking.totalEstimate).toLocaleString('en-US')}` : undefined,
            portalUrl,
            serviceAreaZone: booking.serviceAreaZone ?? undefined,
            travelFee: booking.travelFee ? booking.travelFee / 100 : undefined,
            manualReviewRequired: booking.manualReviewRequired ?? undefined,
            locale,
          },
        }, { jobId: approvalEmailJobId(booking.id, paymentIntentId, when) })
      }

      if (booking.customer.phone) {
        // ITEM R1 — same deterministic id, same reason: one approval, one text.
        // ITEM T1 — and the same announcement scope as the email above.
        await smsQueue.add('pre-approval-sms', {
          to: booking.customer.phone,
          message: t(locale, 'preApproval', { name: booking.customer.name, displayId: booking.displayId, date: dateStr }),
          bookingId: booking.id,
        }, { jobId: approvalSmsJobId(booking.id, paymentIntentId, when) })
      }
    },
    async sendDeclined(booking, release) {
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
          // ── ITEM C1 — was `String(Math.round(booking.depositAmount / 100))`.
          //    That column is what the booking was SUPPOSED to be charged; the
          //    authorization is created for BOOKING_FEE_CENTS (stripe.ts
          //    createBookingCheckout). Now: Stripe's own figure for this
          //    authorization when the release reported one, and NOTHING when it
          //    did not — the template then names no amount rather than one
          //    nobody authorized.
          ...(release.authorizedCents != null
            ? { amountHold: (release.authorizedCents / 100).toFixed(2) }
            : {}),
          // ── ITEM C2 — the template's release copy is now GATED on this.
          //    `false` (a Stripe release that threw) sends the honest variant:
          //    the booking is cancelled, and we are still releasing the
          //    authorization. `true` keeps the existing released wording.
          holdReleased: release.released,
          holdEverExisted: release.state !== 'no_hold',
          rebookUrl: `${appBase}/book`,
          locale: booking.customer.locale,
        },
      })
    },
  }
}
