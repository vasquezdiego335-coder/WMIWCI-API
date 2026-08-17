import type { Prisma } from '@prisma/client'
import { prisma } from './db'
import { onBookingPaid } from './journeys'
import { emailQueue, smsQueue, discordQueue, marketingQueue } from './queues'
import type { EmailJobData, SmsJobData, DiscordJobData, MarketingJobData } from './queues'
import { webhookLogger } from './logger'
import { t } from './i18n'
import { ingestBookingToTracker } from './tracker'
import { outboxEnabled, emitPaymentCompleted } from '../outbox/integration'
import { smsMoveWhen } from './booking-display'
import { isMigrationMissing, MIGRATION_MISSING_MESSAGE, readBookingWithMigrationFallback } from './migration-window'
import { postToChannels, type AlertLine, type AlertResult } from './ops-alert'

// ════════════════════════════════════════════════════════════════════════
//  Checkout fulfillment — the single source of truth for "a $49 hold was
//  authorized; move the booking to PENDING_APPROVAL and fan out notifications".
//
//  WHY THIS EXISTS (the bug it fixes):
//  The whole downstream pipeline (Discord approval card, emails, SMS) used to
//  live INSIDE the Stripe webhook handler. If the webhook never arrived —
//  stale ngrok URL, a Dashboard endpoint pointed at the wrong host, `stripe
//  listen` not forwarding, a test/live mode mismatch — NOTHING happened even
//  though the customer paid. "Payment succeeds but nothing triggers."
//
//  Fix: pull fulfillment into this shared, IDEMPOTENT function and call it from
//  TWO independent triggers:
//    1. POST /api/stripe/webhook       (checkout.session.completed) — primary
//    2. GET  /api/stripe/checkout/success (browser redirect)        — backup
//  The browser ALWAYS hits the success URL after paying, so even with a broken
//  webhook the card still posts. Whichever fires first wins; the other no-ops.
// ════════════════════════════════════════════════════════════════════════

/** One notification handoff and whether it ACTUALLY reached a durable place.
 *  `ok:true` means the queue (or the direct Discord REST post) accepted it —
 *  not that it was delivered to the human, which only the worker can know. */
export type HandoffOutcome = { label: string; ok: boolean; error?: string }

export type FulfillResult = {
  processed: boolean
  bookingId: string
  reason?: string
  /** Every handoff attempted BY THIS RUN, in completion order. Present whenever
   *  the claim was taken, so a caller can never read `processed` as "everything
   *  was sent". On a resume this is only the outstanding subset — the ones that
   *  already succeeded are in `alreadyDelivered`, not re-attempted. */
  handoffs?: HandoffOutcome[]
  /** The Discord approval card was queued, or the plain-text notice was posted. */
  ownerNotified?: boolean
  /** The customer's pre-approval email was queued (or written to the outbox). */
  customerNotified?: boolean
  /** ITEM R4 — true when this run picked up a fan-out an earlier run left
   *  incomplete, instead of starting one. */
  resumed?: boolean
  /** ITEM R4 — labels the durable ledger already recorded as delivered before
   *  this run started. These are NEVER re-attempted. */
  alreadyDelivered?: string[]
}

/** ITEM B4 — returned when a run reached NOBODY: every notification handoff
 *  failed and the direct owner notice could not be delivered either.
 *
 *  ITEM R4 — the claim is KEPT. It used to be released, on the theory that the
 *  next trigger should redo the whole fulfilment; with a PARTIAL fan-out (the
 *  common shape — SMS and marketing accepted, email and card refused) that made
 *  the forced Stripe retry re-run the handoffs that had already succeeded, so
 *  the customer got two texts and two marketing enrolments. The claim is now
 *  kept and the durable ledger records which handoffs are still outstanding, so
 *  the retry resumes exactly those. Callers must still NOT record the Stripe
 *  event as processed on this reason — see src/lib/stripe-events.ts. */
export const NO_DURABLE_HANDOFF = 'no-durable-handoff'

/** ITEM R4 — returned when another runner is already re-driving the outstanding
 *  handoffs for this booking. This delivery did NOTHING, so it must not be
 *  reported as finished; the caller retries and finds it complete. */
export const RESUME_IN_PROGRESS = 'fulfilment-resume-in-progress'

/** ITEM R4 — thrown (after releasing the claim) when the durable handoff ledger
 *  could not be written. Without it a retry cannot know what already went out,
 *  so the fan-out must not start at all. Nothing has been sent at this point. */
export const LEDGER_UNAVAILABLE = 'fulfilment-ledger-unavailable'

/** ITEM T3 — the ledger could not be READ (the query failed) or could not be
 *  UNDERSTOOD (the payload is not a ledger). Both mean the same thing: this run
 *  does not know what has already been sent, so it may neither fan out nor
 *  report the work finished.
 *
 *  This used to be `already-fulfilled-or-not-pending` — a reason the caller does
 *  NOT throw on — with the lease still held: the webhook was recorded
 *  'processed', the Stripe event was retired, the outstanding customer email and
 *  Discord card never happened, and nothing was left to release the lease. A
 *  read failure is not a state. The lease is released before this returns, and
 *  src/lib/stripe-events.ts throws on it so Stripe re-delivers. */
export const LEDGER_UNREADABLE = 'fulfilment-ledger-unreadable'

/** ITEM T2 — the DETERMINISTIC primary key of this checkout's PAYMENT_RECEIVED
 *  row, so "one $49 authorization ⇒ one audit row" is a DATABASE property and
 *  not merely a property of one run's in-memory bookkeeping.
 *
 *  KEYED TO THE MONEY, NOT ONLY THE BOOKING (the T1 lesson): a booking that goes
 *  through checkout a second time authorizes a NEW payment intent and is
 *  entitled to its own record, while two runs of the SAME fan-out collide as
 *  they must. When Stripe reported no intent id the key falls back to the
 *  booking alone — one authorization per booking is the only thing that can be
 *  asserted without one.
 *
 *  It cannot collide with the approval-side claim in src/lib/booking-approval.ts
 *  (`pyrcv_…`, the CAPTURE): different prefix, different event. */
export function fulfillmentAuditId(bookingId: string, paymentIntentId: string | null): string {
  return paymentIntentId ? `pyauth__${bookingId}__${paymentIntentId}` : `pyauth__${bookingId}`
}

/** A UNIQUE-constraint failure. Prisma reports P2002; the raw Postgres text is
 *  matched too, for a driver-level error that never reaches Prisma's mapper.
 *  (Same predicate as src/lib/booking-approval.ts `isUniqueViolation` — repeated
 *  rather than imported so this module, which the webhook loads on every event,
 *  does not pull in the whole approval/Stripe surface.) */
function isUniqueViolation(e: unknown): boolean {
  const code = (e as { code?: unknown } | null | undefined)?.code
  if (code === 'P2002') return true
  const message = e instanceof Error ? e.message : String(e)
  return /unique constraint|duplicate key value/i.test(message)
}

/** Handoff labels — the tally, the fallback trigger and the tests all key off
 *  these, so they are named once. */
const EMAIL_LABEL = 'email:pre-approval'
const OUTBOX_EMAIL_LABEL = 'outbox:payment-completed'
const SMS_LABEL = 'sms:final-confirmation'
const CARD_LABEL = 'discord:booking-created'
const DIRECT_NOTICE_LABEL = 'discord:owner-notice-direct'
const MARKETING_LABEL = 'marketing:enroll'
const JOB_CHANNELS_LABEL = 'discord:create-job-channels'
/** Not handoffs — the two once-per-booking side effects that must also survive
 *  a resume. The PAYMENT_RECEIVED row in particular is counted as a
 *  one-per-booking marker by src/lib/booking-approval.ts, so a second one would
 *  corrupt that guard. */
const AUDIT_LABEL = 'audit:payment-received'
const JOURNEY_LABEL = 'journey:booking-paid'

/** THE fan-out sentence. One place turns handoff outcomes into the line the
 *  owner reads in the logs, so "all jobs queued" cannot drift away from what
 *  was actually queued — that drift IS item B4. Exported so the claim itself is
 *  testable, and used by the single log call site below. */
export function summarizeHandoffs(handoffs: HandoffOutcome[]): {
  allQueued: boolean
  queued: number
  failed: string[]
  message: string
} {
  const failed = handoffs.filter((h) => !h.ok).map((h) => h.label)
  const queued = handoffs.length - failed.length
  const allQueued = failed.length === 0
  return {
    allQueued,
    queued,
    failed,
    message: allQueued
      ? `Checkout fulfilled — booking → PENDING_APPROVAL, all ${handoffs.length} jobs queued`
      : `Checkout fulfilled — booking → PENDING_APPROVAL, but ${failed.length} of ${handoffs.length} handoffs FAILED ` +
        '(the claim is kept: re-running would duplicate the ones that succeeded)',
  }
}

/** Where the plain-text approval notice goes when the card cannot be queued.
 *  DISCORD_CHANNEL_JOBS first — that is where the real card posts
 *  (src/bot/discord-rest.ts:268) — then somewhere the owner still looks. */
const OWNER_NOTICE_CHANNELS = ['DISCORD_CHANNEL_JOBS', 'DISCORD_CHANNEL_OPERATIONS', 'DISCORD_CHANNEL_ALERTS']

/** The booking row this module fans out from. */
type PaidBooking = Prisma.BookingGetPayload<{ include: { customer: true } }>

/** ITEM R4 — one handoff, DESCRIBED rather than fired. Describing it is what
 *  lets a resume execute exactly the outstanding subset; firing it at
 *  construction time (the previous shape) meant the only unit of retry was the
 *  whole fan-out. */
type PlannedHandoff = { label: string; run: () => Promise<unknown> }

// ════════════════════════════════════════════════════════════════════════
//  Injectable edge (ITEM B4). Same pattern as ApprovalDeps in
//  src/lib/booking-approval.ts: production wires the real queues, the tests
//  wire fakes. Without this seam the fan-out could only be exercised with a
//  live Redis, which is exactly why it shipped untested — see the scope note
//  in src/lib/__tests__/migration-window.test.ts.
// ════════════════════════════════════════════════════════════════════════
/** ITEM R4 — the only job option this module sets. A DETERMINISTIC `jobId` is
 *  what makes a re-driven handoff collapse instead of duplicating: BullMQ
 *  refuses to create a second job under an id it already holds. It is the
 *  second layer under the durable ledger, and it is the ONLY thing that covers
 *  the documented Upstash failure — `queue.add()` HANGS, the 5s race abandons
 *  it WITHOUT CANCELLING, so a handoff recorded `ok:false` can still land
 *  afterwards, and the retry of that handoff must not become a second send. */
export type QueueAddOptions = { jobId?: string }

/** Only what this module uses of a BullMQ Queue. */
export type JobQueue<T> = { add: (name: string, data: T, opts?: QueueAddOptions) => Promise<unknown> }

/** The deterministic id for one booking's one handoff.
 *  BullMQ REJECTS a custom job id containing ':' (it is the Redis key
 *  separator — see src/lib/__tests__/queue-jobid-safety.test.ts, where that bug
 *  silently killed every journey enqueue in production), and every handoff
 *  label here is colon-shaped. So the separator is '__' and the label's colons
 *  become '-'. Exported because a test that rebuilds this id by hand cannot
 *  prove the shipped ids collapse. */
export function fulfillmentJobId(bookingId: string, label: string): string {
  return `fulfill__${bookingId}__${label.replace(/:/g, '-')}`
}

export type FulfillDeps = {
  emailQueue: JobQueue<EmailJobData>
  smsQueue: JobQueue<SmsJobData>
  discordQueue: JobQueue<DiscordJobData>
  marketingQueue: JobQueue<MarketingJobData>
  outboxEnabled: () => boolean
  emitPaymentCompleted: (p: Parameters<typeof emitPaymentCompleted>[0]) => Promise<boolean>
  ingestBookingToTracker: (input: Parameters<typeof ingestBookingToTracker>[0]) => Promise<void>
  onBookingPaid: (bookingId: string) => Promise<unknown>
  /** Bare Discord REST post — no Redis, no discord.js. Never throws. */
  postOwnerNotice: (title: string, lines: AlertLine[]) => Promise<AlertResult>
}

export function defaultFulfillDeps(): FulfillDeps {
  return {
    emailQueue,
    smsQueue,
    discordQueue,
    marketingQueue,
    outboxEnabled,
    emitPaymentCompleted,
    ingestBookingToTracker,
    onBookingPaid,
    postOwnerNotice: (title, lines) => postToChannels(OWNER_NOTICE_CHANNELS, title, lines, 'booking approval notice'),
  }
}

/** ITEM P0-E — the reason returned when the deposit was authorized but the
 *  MIGRATIONS ARE NOT APPLIED, so the row cannot be read. Nothing is claimed,
 *  nothing is consumed: the booking stays PENDING_PAYMENT and the next trigger
 *  (webhook retry / success redirect / a manual replay) does the WHOLE
 *  fulfillment once the SQL lands. Callers must NOT record the Stripe event as
 *  processed on this reason — see src/lib/stripe-events.ts. */
export const MIGRATION_NOT_APPLIED = 'migration-not-applied'

// ════════════════════════════════════════════════════════════════════════
//  ITEM R4 — THE DURABLE HANDOFF LEDGER
//  ────────────────────────────────────────────────────────────────────
//  "Never re-run work that already succeeded" cannot be a property of a single
//  run: the run that succeeded partially is a DIFFERENT process from the one
//  that retries. So what went out is written down, per handoff, in Postgres —
//  the one dependency that is up in this failure mode (the whole point is that
//  REDIS is down; the booking claim one line earlier is a Postgres write).
//
//  WHERE: `webhook_logs`, keyed `fulfillment__<bookingId>`. That table already
//  exists in the deployed database (no migration — a new table could not be
//  relied on here, because migrations in this project are applied BY HAND after
//  the code ships, which is the exact window src/lib/migration-window.ts
//  exists for), its `eventId` is @unique so the row is atomic to claim, and it
//  is read/written by nothing but this file and src/lib/stripe-events.ts. A
//  Stripe event id (`evt_…`) can never collide with this key.
//
//  THE ROW'S `status` IS ALSO THE RESUME LOCK, because the booking-status claim
//  no longer covers a resume (the claim is already consumed by then, and a
//  guard two callers can both pass is not a guard):
//     'in-progress' — a runner owns the fan-out; `processedAt` is its lease
//     'outstanding' — nobody owns it and handoffs remain: resumable
//     'complete'    — every planned handoff plus both once-per-booking steps
//
//  ITEM T2 — PROGRESS IS WRITTEN AS IT HAPPENS, NOT AT THE END.
//  `done` used to grow only in memory and be flushed ONCE, after the fan-out,
//  the audit and the journey cleanup. A runner killed anywhere in that window —
//  a serverless timeout, a deploy, the process being reaped — left the durable
//  row saying `done: []`, so the resume re-drove EVERY handoff: a second SMS, a
//  second email, a second marketing enrolment, two Discord cards, and TWO
//  PAYMENT_RECEIVED rows for one $49. Every completion is now its own durable
//  write (`markDone` below), issued the moment it is proven, so a resume can
//  never re-run a handoff that finished. Three layers, in order of strength:
//     1. this incremental ledger write        (covers every handoff + step)
//     2. the deterministic BullMQ job id      (covers a write that itself failed)
//     3. the deterministic PAYMENT_RECEIVED primary key (fulfillmentAuditId)
//  A progress write NEVER settles the row: it keeps 'in-progress' and the same
//  lease token, because writing a terminal status mid-fan-out would hand this
//  run's own lease to somebody else.
// ════════════════════════════════════════════════════════════════════════

/** How long a runner may own a fan-out before another may take it over. The
 *  fan-out's worst case is ~10s (five concurrent 5s enqueue guards plus the
 *  direct owner notice, measured with Redis dead), so 60s never steals a live
 *  run, and a process killed mid-fan-out is resumable a minute later rather
 *  than never. */
export const FULFILMENT_LEASE_MS = 60 * 1000

const LEDGER_SOURCE = 'fulfillment'
const LEDGER_EVENT_TYPE = 'checkout-fanout'

export function fulfillmentLedgerKey(bookingId: string): string {
  return `fulfillment__${bookingId}`
}

/** ITEM M3 — the status the atomic claim WRITES. A booking sitting in it with no
 *  ledger row at all is a fan-out that was claimed and never recorded: the claim
 *  is one statement, the ledger is written a few statements later, and a runner
 *  killed in between leaves exactly this. Named once so the check below and the
 *  claim itself cannot drift apart. */
const CLAIMED_STATUS = 'PENDING_APPROVAL'

/**
 * ITEM M3 — did a fan-out for this booking ever reach its END?
 *
 * The PAYMENT_RECEIVED row this module writes is the LAST durable step of a
 * completed fan-out (after every handoff), so its presence proves a fan-out ran
 * even when no ledger row does — which is precisely the "booking fulfilled
 * before this ledger existed" case. Matching is deliberately two-pronged: the
 * deterministic id for rows written since ITEM T2, and the `authorized: true`
 * detail every row this module has ever written carries, for the older ones.
 *
 * Returns null when the question could not be ANSWERED. Unknown is not done
 * (ITEM T3) — the caller must not report the checkout finished on a failed read.
 */
async function authorizationAlreadyRecorded(
  bookingId: string,
  paymentIntentId: string | null,
  log: { error: (obj: unknown, msg?: string) => void },
): Promise<boolean | null> {
  try {
    const rows = await prisma.auditLog.findMany({
      where: { bookingId, action: 'PAYMENT_RECEIVED' },
      select: { id: true, details: true },
      take: 25,
    })
    const mine = fulfillmentAuditId(bookingId, paymentIntentId)
    return rows.some(
      (r) => r.id === mine || (r.details as { authorized?: unknown } | null)?.authorized === true,
    )
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), bookingId },
      'could not read this booking\'s PAYMENT_RECEIVED rows',
    )
    return null
  }
}

/** `planned` is what this booking's fan-out intends to deliver; `done` is what
 *  is PROVEN delivered (handoff labels plus the once-per-booking steps). `done`
 *  only ever grows — a label in it is never attempted again. */
export type HandoffLedger = { version: 1; planned: string[]; done: string[]; attempts: number }

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [])

function parseLedger(payload: unknown): HandoffLedger | null {
  if (!payload || typeof payload !== 'object') return null
  const p = payload as Record<string, unknown>
  if (!Array.isArray(p.planned) || !Array.isArray(p.done)) return null
  return {
    version: 1,
    planned: strings(p.planned),
    done: strings(p.done),
    attempts: typeof p.attempts === 'number' && p.attempts > 0 ? p.attempts : 1,
  }
}

function ledgerStatus(ledger: HandoffLedger): 'outstanding' | 'complete' {
  const settled = (label: string): boolean => ledger.done.includes(label)
  return ledger.planned.every(settled) && settled(AUDIT_LABEL) && settled(JOURNEY_LABEL) ? 'complete' : 'outstanding'
}

// Guard a single queue.add() so a Redis stall can't hang the caller.
// BullMQ uses maxRetriesPerRequest:null, so when Upstash drops the idle
// connection, queue.add() HANGS FOREVER (it never rejects). On the webhook
// that means no 200 → Stripe retries → duplicates; on the success redirect it
// means the customer's browser hangs. Promise.race converts the hang into a
// logged skip. Never throws.
//
// ITEM B4 — it RECORDS the outcome now. It used to return void, so a fan-out
// where all five handoffs failed was indistinguishable from one where all five
// succeeded: the caller logged "all jobs queued" and returned processed:true
// either way. The result is what makes the tally, the owner-notice fallback and
// the "no durable work" release below possible.
//
// ITEM T2 — and it records that outcome DURABLY, before it returns. The label
// used to be added to an in-memory list that was flushed once at the very end,
// so a run killed after the fan-out re-sent every message it had already sent.
// `markDone` is awaited here so a handoff is never "delivered but unrecorded"
// for longer than the write itself takes.
async function enqueue(
  handoffs: HandoffOutcome[],
  label: string,
  fn: () => Promise<unknown>,
  markDone: (label: string) => Promise<void>,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let delivered = false
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('queue add timed out after 5s (Redis unreachable?)')), 5000)
      }),
    ])
    delivered = true
    handoffs.push({ label, ok: true })
    webhookLogger.debug({ label }, 'fulfillment job enqueued')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    handoffs.push({ label, ok: false, error: message })
    webhookLogger.error(
      { label, err: message },
      'fulfillment enqueue failed/timed out — this handoff was NOT delivered'
    )
  } finally {
    if (timer) clearTimeout(timer)
  }
  // Outside the try: a failure of the durable write must not turn a delivered
  // handoff into a failed one (markDone never throws — it logs and reports).
  if (delivered) await markDone(label)
}

/**
 * Move a paid (authorized) booking to PENDING_APPROVAL and queue every
 * side-effect. Safe to call multiple times and from multiple processes — the
 * atomic status claim below guarantees the work runs exactly once.
 */
export async function fulfillPaidCheckout(
  params: {
    bookingId: string
    paymentIntentId: string | null
    amountTotalCents: number | null
    source: 'webhook' | 'success_redirect'
  },
  deps: FulfillDeps = defaultFulfillDeps()
): Promise<FulfillResult> {
  const { bookingId, paymentIntentId, amountTotalCents, source } = params
  const log = webhookLogger.child({ bookingId, source })

  // ── ITEM P0-E — READ FIRST, CLAIM SECOND ────────────────────────────────
  //
  // This read used to sit immediately AFTER the atomic claim, as an
  // `include: { customer: true }` with no guard. An `include` makes Prisma ask
  // Postgres for `$scalars` FROM THE GENERATED SCHEMA, so during the normal
  // code-before-SQL window (migrations here are applied by hand) it raised
  // P2022 — one statement after the claim had already flipped the booking to
  // PENDING_APPROVAL. Nothing downstream ran: no Discord approval card, no
  // pre-approval email, no SMS, no tracker ingest.
  //
  // And it was UNRECOVERABLE, because the claim IS the idempotency guard: the
  // retry re-entered, matched 0 rows, returned `processed:false` without
  // throwing, and the webhook was then recorded as processed. A customer who
  // paid $49 in that window would never have been contacted, and applying the
  // SQL later replayed nothing.
  //
  // So the row is read BEFORE anything is consumed. A migration-shaped failure
  // now leaves the booking PENDING_PAYMENT — the honest state, from which the
  // very next trigger fulfills completely. A real outage still throws, before
  // the claim, so the queue retries it.
  let booking: PaidBooking | null
  let degradedRead = false
  try {
    const read = await readBookingWithMigrationFallback<PaidBooking>(
      (args) => prisma.booking.findUnique({ where: { id: bookingId }, ...(args as object) }),
      { customer: true },
    )
    booking = read.row
    degradedRead = read.degraded
  } catch (err) {
    // A REAL failure (outage, timeout, a broken generated client) is NOT a
    // migration window: rethrow it, before the claim, so the webhook queue
    // retries the whole event. Downgrading an outage into "deferred" would
    // quietly stop the retry that is the actual recovery.
    if (!isMigrationMissing(err)) throw err
    // Both rungs failed the same migration-shaped way. NOTHING has been claimed.
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      `fulfillment cannot read the booking — ${MIGRATION_MISSING_MESSAGE}. The $49 is authorized and the booking stays PENDING_PAYMENT; re-run this event after the migration.`,
    )
    return { processed: false, bookingId, reason: MIGRATION_NOT_APPLIED }
  }
  if (!booking) {
    log.error('Booking not found — cannot fulfill (nothing claimed)')
    return { processed: false, bookingId, reason: 'booking-not-found' }
  }
  if (degradedRead) {
    log.warn(
      { reason: MIGRATION_MISSING_MESSAGE },
      'fulfillment read degraded (unapplied migration) — fan-out continues without the newest columns',
    )
  }
  // The status to restore if the fan-out cannot run (below). Captured from the
  // row we just read, so a DRAFT booking is never "rolled back" into a state it
  // was never in.
  const statusBeforeClaim = booking.status

  // ── Atomic claim — the race-condition fix ───────────────────────────────
  // updateMany with a status guard compiles to ONE conditional SQL UPDATE.
  // Whoever flips PENDING_PAYMENT/DRAFT → PENDING_APPROVAL first gets count:1
  // and starts the fan-out; a concurrent caller (the other trigger, or a Stripe
  // retry) gets count:0 and takes the RESUME path below, which re-drives only
  // what the durable ledger says is still outstanding. No double cards, no
  // double emails — without a lock. THIS CODE IS VERIFIED CORRECT: do not
  // replace it with a read-then-write.
  const claim = await prisma.booking.updateMany({
    where: { id: bookingId, status: { in: ['PENDING_PAYMENT', 'DRAFT'] } },
    data: {
      status: 'PENDING_APPROVAL',
      depositPaid: false, // AUTHORIZE-ONLY: the $49 is held, not captured yet
      ...(paymentIntentId ? { stripePaymentIntentId: paymentIntentId } : {}),
    },
  })

  // Give the claim back. Used in exactly ONE place now (below): when the
  // durable handoff ledger cannot be written, so the fan-out is refused before
  // a single message is attempted. Guarded on PENDING_APPROVAL so it can never
  // walk back a booking someone else has since moved on. Returns whether the
  // row was actually restored.
  //
  // ITEM R4 — it is NOT used when the fan-out delivered nothing any more.
  // Releasing there made the forced retry re-run handoffs that had already
  // succeeded; the ledger + a resume path replaced it.
  const releaseClaim = async (): Promise<boolean> =>
    prisma.booking
      .updateMany({ where: { id: bookingId, status: 'PENDING_APPROVAL' }, data: { status: statusBeforeClaim } })
      .then((r) => r.count === 1)
      .catch((rbErr) => {
        log.error(
          { err: rbErr instanceof Error ? rbErr.message : String(rbErr) },
          'CRITICAL: fulfillment could not start AND the claim could not be released — this booking may never fan out',
        )
        return false
      })

  // ── Everything the fan-out will say, built once ─────────────────────────
  // (No I/O. Computed before the plan so both the first run and a RESUME build
  // byte-identical handoffs.)
  // ── ITEM C1 (round 8) — THE HOLD FIGURE THE CUSTOMER IS TOLD ──────────────
  //  This was `((amountTotalCents ?? 4900) / 100).toFixed(2)`, and it is the
  //  number the PRE-APPROVAL email prints as "$X hold" — on BOTH senders (the
  //  outbox PAYMENT_COMPLETED event, which EMAIL-REGISTRY.md calls the live
  //  path, and the legacy queue payload below).
  //
  //  `amountTotalCents` is `session.amount_total`, which Stripe types as
  //  `number | null`. When it is null this printed the house $49 as an
  //  authorization nobody had measured — while the SAME run recorded
  //  `{ authorized: true, amount: null }` in the audit row (see the
  //  PAYMENT_RECEIVED write below) and told the owner "Stripe reported no
  //  amount" in the fallback notice. The system already knew it did not know;
  //  only the customer was given a number. `provenDepositMoney` /
  //  `provenAuthorizedHoldCents` would later read that audit row and answer
  //  "no figure", so the email also contradicted every other surface.
  //
  //  NULL now travels as null the whole way: the payload omits the amount and
  //  src/emails/pre-approval.tsx names the booking fee without naming a figure.
  const provenHoldCents =
    typeof amountTotalCents === 'number' && Number.isFinite(amountTotalCents) && amountTotalCents > 0
      ? amountTotalCents
      : null
  const amountPaid = provenHoldCents != null ? (provenHoldCents / 100).toFixed(2) : null
  const appUrl = process.env.APP_URL ?? 'https://wmiwci-api.vercel.app'
  const portalUrl = `${appUrl}/my-booking/${booking.customerToken}`
  const locale = booking.customer.locale
  // ── ITEM R3-1: the confirmation SMS ─────────────────────────────────────
  // `timeStyle:'short'` on a booking whose hour nobody chose formatted the
  // 00:00 ET DAY ANCHOR and texted the customer "Jul 15, 2027, 12:00 AM".
  // moveWhenParts is the ONE booking-aware formatter — same medium date, and
  // the time only when a real one exists. A timed move reads exactly as before.
  const dateStr =
    smsMoveWhen(booking, locale === 'es' ? 'es-US' : 'en-US') ??
    (locale === 'es' ? 'tu fecha solicitada' : 'your requested date')

  // ════════════════════════════════════════════════════════════════════════
  //  THE PLAN — what this booking's fan-out consists of.
  //  ITEM R4: describing each handoff instead of firing it immediately is what
  //  lets a resume run EXACTLY the outstanding subset. Every queue add carries
  //  its DETERMINISTIC job id, so even a handoff that is re-driven because it
  //  was recorded `ok:false` collapses onto the job the abandoned (hanging)
  //  add later landed, instead of becoming a second send.
  //
  //  MESSAGING POLICY — the PAYMENT step (booking → PENDING_APPROVAL, $49 held
  //  but NOT captured) sends the PRE-CONFIRMATION email + a payment-step SMS.
  //  The FINAL CONFIRMATION ("you're approved") is sent later by the Discord
  //  approval handler once the owner approves and the $49 is captured. Sending
  //  the pre-confirmation here (not the confirmation) keeps every message honest
  //  about the true booking state.
  // ════════════════════════════════════════════════════════════════════════
  const plan: PlannedHandoff[] = []

  // 1) Payment-step EMAIL = the premium PRE-CONFIRMATION ("we've received your
  //    booking request"). OUTBOX_ENABLED → emit PAYMENT_COMPLETED to the outbox
  //    (which renders + sends that template) and SKIP the legacy queue here so
  //    the customer never gets both.
  if (deps.outboxEnabled()) {
    plan.push({
      label: OUTBOX_EMAIL_LABEL,
      run: async () => {
        log.info({ to: booking.customer.email }, '[outbox] emitting PAYMENT_COMPLETED (legacy payment email skipped)')
        // ITEM B4 — emitPaymentCompleted RETURNS whether the outbox row was
        // written (src/outbox/integration.ts swallows the failure and returns
        // false). That answer used to be thrown away, so a swallowed outbox
        // failure was indistinguishable from a durable write.
        const written = await deps.emitPaymentCompleted({
          bookingId,
          // ITEM C1 (round 8) — absent when Stripe reported no amount. The
          // stored event payload then carries no figure at all, so a resend
          // years later cannot resurrect one.
          ...(amountPaid != null ? { amountPaid } : {}),
          customerName: booking.customer.name,
          customerEmail: booking.customer.email,
          requestedDate: booking.requestedDate?.toISOString() ?? null,
          items: booking.itemsDescription ?? undefined,
        })
        if (written !== true) {
          log.error('[outbox] PAYMENT_COMPLETED emit did not write a job — the customer email was NOT queued')
          throw new Error('outbox emit returned false (not written)')
        }
        return written
      },
    })
  } else {
    plan.push({
      label: EMAIL_LABEL,
      run: () => {
        log.info({ to: booking.customer.email }, '[messaging] queueing PRE-CONFIRMATION email')
        // NB: `emailQueue.add('pre-approval'` stays on ONE line —
        // src/lib/__tests__/day-anchor-display.test.ts finds this call by that
        // exact marker to prove the payload still carries the time facts.
        return deps.emailQueue.add('pre-approval',
          {
            template: 'pre-approval',
            to: booking.customer.email,
            bookingId,
            payload: {
              customerName: booking.customer.name,
              displayId: booking.displayId,
              requestedDate: booking.requestedDate?.toISOString(),
              // Item R3-1 — the legacy queue payload is the OTHER pre-approval
              // sender, and it passed no time information at all, so the template
              // derived "12:00 AM" from the day anchor. An arrival window the
              // owner typed still wins; otherwise the flag suppresses the hour.
              timeLabel: booking.arrivalWindow ?? undefined,
              startTimeKnown: booking.startTimeKnown,
              originAddress: booking.originAddress,
              destAddress: booking.destAddress,
              estimate: booking.totalEstimate != null ? `$${Math.round(booking.totalEstimate).toLocaleString('en-US')}` : undefined,
              // ITEM C1 (round 8) — the legacy sender's twin of the outbox line
              // above. Omitted entirely when Stripe reported no amount; the
              // rounding of a KNOWN figure is unchanged.
              ...(amountPaid != null ? { amountHold: String(Math.round(Number(amountPaid))) } : {}),
              portalUrl,
              serviceAreaZone: booking.serviceAreaZone ?? undefined,
              travelFee: booking.travelFee ? booking.travelFee / 100 : undefined,
              manualReviewRequired: booking.manualReviewRequired ?? undefined,
              locale,
            },
          },
          { jobId: fulfillmentJobId(bookingId, EMAIL_LABEL) },
        )
      },
    })
  }

  // 2) FINAL CONFIRMATION SMS (1 of 2 allowed texts) — bilingual
  if (booking.customer.phone) {
    plan.push({
      label: SMS_LABEL,
      run: () => {
        log.info('[messaging] queueing FINAL CONFIRMATION sms')
        return deps.smsQueue.add(
          'final-confirmation-sms',
          {
            to: booking.customer.phone!,
            message: t(locale, 'finalConfirmation', {
              name: booking.customer.name,
              displayId: booking.displayId,
              date: dateStr,
            }),
            bookingId,
          },
          { jobId: fulfillmentJobId(bookingId, SMS_LABEL) },
        )
      },
    })
  }

  // 3) Discord booking approval card (the Approve / Offer / Deny card)
  plan.push({
    label: CARD_LABEL,
    run: () =>
      deps.discordQueue.add(
        'booking-created',
        {
          type: 'booking-created',
          bookingId,
          payload: {
            bookingId,
            displayId: booking.displayId,
            customerName: booking.customer.name,
            customerEmail: booking.customer.email,
            customerPhone: booking.customer.phone,
            originAddress: booking.originAddress,
            destAddress: booking.destAddress,
            requestedDate: booking.requestedDate?.toISOString(),
            discountType: booking.discountType,
            discountCode: booking.discountCode,
            estimatedHours: booking.estimatedHours,
            items: booking.itemsDescription,
            // ITEM C1 (round 8) — null rather than an invented $49. The card
            // builder derives its own deposit lines from the Payment rows
            // (booking-display.approvalCardDataFromBooking), so this is carried
            // for the queued-payload record only — and a record may not carry a
            // figure Stripe never reported either.
            amountPaid,
            // ── Payment / balance breakdown (shown on the card) ──
            moveTotal: booking.totalEstimate,
            balanceAfterJob: booking.totalEstimate != null ? booking.totalEstimate - 49 : null,
            truckAddonDueOnMoveDay: booking.truckAddonDueOnMoveDay,
            truckAddonAmount: booking.truckAddonAmount,
            // ── Moving Service Agreement status (shown on the card) ──
            agreementAccepted: booking.agreementAccepted,
            agreementVersion: booking.agreementVersion,
            agreementName: booking.agreementName,
            agreementAcceptedAt: booking.agreementAcceptedAt?.toISOString(),
          },
        },
        { jobId: fulfillmentJobId(bookingId, CARD_LABEL) },
      ),
  })

  // 4) Marketing automation enrollment (external tool — env-gated stub)
  plan.push({
    label: MARKETING_LABEL,
    run: () =>
      deps.marketingQueue.add(
        'booking-paid',
        {
          type: 'enroll-customer',
          bookingId,
          payload: {
            email: booking.customer.email,
            name: booking.customer.name,
            phone: booking.customer.phone,
            displayId: booking.displayId,
            requestedDate: booking.requestedDate?.toISOString(),
          },
        },
        { jobId: fulfillmentJobId(bookingId, MARKETING_LABEL) },
      ),
  })

  // 5) Create the Discord job-coordination card (worker dispatch view).
  //    The payload carries everything the MOVE DAY JOB card renders so the
  //    worker never needs raw DB access; price detail stays owner-side except
  //    the labor estimate + travel-fee status the crew is allowed to see.
  plan.push({
    label: JOB_CHANNELS_LABEL,
    run: () =>
      deps.discordQueue.add(
        'create-job-channels',
        {
          type: 'create-job-channels',
          bookingId,
          payload: {
            bookingId,
            displayId: booking.displayId,
            customerName: booking.customer.name,
            customerPhone: booking.customer.phone,
            originAddress: booking.originAddress,
            destAddress: booking.destAddress,
            requestedDate: booking.requestedDate?.toISOString(),
            items: booking.itemsDescription ?? undefined,
            // Item R3-1 — the crew dispatch card renders this date; without the
            // flag it printed the day anchor's midnight as the job's start time.
            startTimeKnown: booking.startTimeKnown,
            truckAddonDueOnMoveDay: booking.truckAddonDueOnMoveDay,
            laborEstimate: booking.baseRate,
            travelFeeDollars: booking.travelFee ? booking.travelFee / 100 : 0,
            manualReviewRequired: booking.manualReviewRequired,
          },
        },
        { jobId: fulfillmentJobId(bookingId, JOB_CHANNELS_LABEL) },
      ),
  })

  // 6) Door-hanger discount approval card — REMOVED 2026-07-21 (owner
  //    decision). The campaign approved 30%, over the 10% public cap, so no
  //    new approval card is ever created. Historical DiscountType enum values
  //    are retained in the schema so existing bookings still read correctly.

  const plannedLabels = plan.map((h) => h.label)

  // ════════════════════════════════════════════════════════════════════════
  //  ITEM R4 — OWN THE FAN-OUT, DURABLY.
  //  The booking claim above is consumed the first time. It therefore cannot
  //  protect a RESUME, so the ledger row carries its own lease and every
  //  transition through it is one conditional UPDATE.
  // ════════════════════════════════════════════════════════════════════════
  const ledgerKey = fulfillmentLedgerKey(bookingId)
  const leaseAt = new Date()

  /** The plan this run intends to deliver. Initialised to a FIRST RUN — nothing
   *  delivered — which is what both the ordinary first run and the item-M3
   *  adoption below need; the RESUME path replaces it with what the durable row
   *  says is already done. */
  let ledger: HandoffLedger = { version: 1, planned: plannedLabels, done: [], attempts: 1 }
  let resumed = false
  /** ITEM M3 — this run took over a fan-out that was claimed and then abandoned
   *  before its ledger was written (see the branch below). It is NOT a resume:
   *  nothing was ever sent. */
  let adopted = false

  /** ONE durable write of the ledger, guarded on THIS run still holding the
   *  lease (status AND token). `status` is explicit: a progress write keeps the
   *  row 'in-progress' so the run does not hand away its own lease mid-fan-out;
   *  only the final write settles it. The payload is a SNAPSHOT — the live
   *  object is mutated by handoffs that are still running. */
  const writeLedger = async (status: 'in-progress' | 'outstanding' | 'complete'): Promise<boolean> => {
    const snapshot: HandoffLedger = {
      version: 1,
      planned: [...ledger.planned],
      done: [...ledger.done],
      attempts: ledger.attempts,
    }
    try {
      const res = await prisma.webhookLog.updateMany({
        where: { eventId: ledgerKey, status: 'in-progress', processedAt: leaseAt },
        data: { status, payload: snapshot as unknown as Prisma.InputJsonValue },
      })
      if (res.count === 0) {
        log.warn({ ledgerKey }, 'the fulfilment handoff ledger is no longer owned by this run — not overwriting it')
        return false
      }
      return true
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err), ledgerKey, status },
        'could not update the fulfilment handoff ledger — a later retry may re-drive a handoff that already succeeded ' +
          '(the deterministic job ids and the deterministic audit primary key are what stop that becoming a second send)',
      )
      return false
    }
  }

  /** ITEM T2 — the durable writes are SERIALISED. The handoffs run
   *  concurrently, and two overlapping writes of the same JSON array would lose
   *  one of them; chained, each write carries a superset of the one before it
   *  (`done` only ever grows), so the last write is the most complete. */
  let ledgerWrites: Promise<boolean> = Promise.resolve(true)
  const queueLedgerWrite = (status: 'in-progress' | 'outstanding' | 'complete'): Promise<boolean> => {
    const run = ledgerWrites.catch(() => false).then(() => writeLedger(status))
    ledgerWrites = run
    return run
  }

  /** ITEM T2 — a step is PROVEN done: record it durably, right now. Never
   *  throws; a failed write is logged and falls through to the deterministic
   *  job id / audit primary key. */
  const markDone = async (label: string): Promise<void> => {
    if (!ledger.done.includes(label)) ledger.done.push(label)
    await queueLedgerWrite('in-progress')
  }

  /** The FINAL write: settles the row (and so releases the lease). */
  const persistLedger = (): Promise<boolean> => queueLedgerWrite(ledgerStatus(ledger))

  /** ITEM T3 — give the resume lease back. Used on every early return that
   *  happens AFTER the lease was taken: the row goes straight to 'outstanding'
   *  so the next delivery can pick it up immediately instead of waiting out a
   *  lease nothing is holding. */
  const releaseLedgerLease = async (): Promise<boolean> =>
    prisma.webhookLog
      .updateMany({
        where: { eventId: ledgerKey, status: 'in-progress', processedAt: leaseAt },
        data: { status: 'outstanding' },
      })
      .then((r) => r.count === 1)
      .catch((err) => {
        log.error(
          { err: err instanceof Error ? err.message : String(err), ledgerKey },
          'could not release the fulfilment ledger lease — the next delivery must wait for it to expire',
        )
        return false
      })

  if (claim.count === 1) {
    // FIRST RUN. Record the intent BEFORE a single handoff is attempted: a run
    // that dies mid-fan-out must leave behind what it meant to do, or a retry
    // has to choose between doing nothing and doing everything twice.
    ledger = { version: 1, planned: plannedLabels, done: [], attempts: 1 }
    const row = {
      source: LEDGER_SOURCE,
      eventType: LEDGER_EVENT_TYPE,
      status: 'in-progress',
      processedAt: leaseAt,
      // A COPY, never the live object: `ledger` is mutated by the fan-out, and a
      // row that silently tracked those mutations would be a durable record of
      // nothing (ITEM T2 — the whole defect was progress that existed only in
      // memory).
      payload: { version: 1, planned: [...plannedLabels], done: [], attempts: 1 } as unknown as Prisma.InputJsonValue,
    }
    let recorded = false
    try {
      // `update` overwrites any ledger from an earlier lifecycle of this booking
      // (a re-checkout): this is a NEW fan-out, so nothing is carried over.
      await prisma.webhookLog.upsert({
        where: { eventId: ledgerKey },
        update: row,
        create: { ...row, eventId: ledgerKey },
      })
      recorded = true
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'could not create the fulfilment handoff ledger')
    }
    if (!recorded) {
      // Nothing has been sent yet, so this is the one safe place to give the
      // claim back: the booking returns to its honest pre-claim status and the
      // next trigger does the whole thing.
      const released = await releaseClaim()
      log.error(
        { released },
        'CRITICAL: the fulfilment handoff ledger could not be written, so no retry could know what had been sent — ' +
          'the fan-out was NOT started and the claim was released; nothing reached the customer or the owner',
      )
      throw new Error(
        `${LEDGER_UNAVAILABLE}: booking ${bookingId} — the handoff ledger could not be written, so the fan-out was not started (nothing was sent). Retry this trigger.`,
      )
    }
  } else {
    // ── RESUME ────────────────────────────────────────────────────────────
    // The booking is already claimed. That used to end here, unconditionally —
    // which is why releasing the claim on a partial fan-out was the only way to
    // get the outstanding handoffs re-driven, and why doing so re-sent the ones
    // that had succeeded. Take the ledger's own lease instead: one conditional
    // UPDATE, so two triggers arriving together cannot both resume.
    //
    // ITEM T3 — A READ FAILURE IS NOT A STATE. Both database calls below used
    // to swallow their error (`claimedLedger = 0`, `.catch(() => null)`) and
    // fall into the "no ledger row ⇒ nothing to do" branch, which returns a
    // reason the caller does NOT throw on. A single failed query therefore
    // marked the webhook 'processed', retired the Stripe event, left the
    // outstanding customer email and Discord card unsent — and, when the lease
    // had already been taken, left it held with nothing to release it. Failures
    // are now carried, not swallowed: the lease is released and the caller is
    // told to come back.
    const staleBefore = new Date(leaseAt.getTime() - FULFILMENT_LEASE_MS)
    let claimedLedger = 0
    let ledgerError: string | null = null
    try {
      const res = await prisma.webhookLog.updateMany({
        where: {
          eventId: ledgerKey,
          OR: [
            { status: 'outstanding' },
            { status: 'in-progress', processedAt: null },
            { status: 'in-progress', processedAt: { lt: staleBefore } },
          ],
        },
        data: { status: 'in-progress', processedAt: leaseAt },
      })
      claimedLedger = res.count
    } catch (err) {
      ledgerError = err instanceof Error ? err.message : String(err)
    }

    let row: { status: string; payload: Prisma.JsonValue } | null = null
    if (!ledgerError) {
      try {
        row = await prisma.webhookLog.findUnique({
          where: { eventId: ledgerKey },
          select: { status: true, payload: true },
        })
        // The claim matched a row one statement ago, so a null here is not
        // "there is nothing to do" — it is a row that vanished underneath us.
        if (!row && claimedLedger === 1) ledgerError = 'the ledger row disappeared between the claim and the read'
      } catch (err) {
        ledgerError = err instanceof Error ? err.message : String(err)
      }
    }

    if (ledgerError) {
      // We may be holding the lease (the claim can succeed and the read fail).
      const released = claimedLedger === 1 ? await releaseLedgerLease() : false
      log.error(
        { err: ledgerError, ledgerKey, leaseHeld: claimedLedger === 1, leaseReleased: released },
        'could not read the fulfilment handoff ledger — this run does not know what has already been sent, so it ' +
          'sent nothing and is NOT reporting the checkout as fulfilled; retry this trigger',
      )
      return { processed: false, bookingId, reason: LEDGER_UNREADABLE }
    }

    if (claimedLedger === 0) {
      // Everything is already delivered: genuinely FINISHED, and — now that a
      // failed read cannot land here — a statement the database supports.
      if (row?.status === 'complete') {
        log.info('Checkout already fulfilled — skipping')
        return { processed: false, bookingId, reason: 'already-fulfilled-or-not-pending' }
      }

      if (!row) {
        // ══════════════════════════════════════════════════════════════════
        //  ITEM M3 — NO LEDGER ROW IS NOT AUTOMATICALLY "NOTHING TO DO".
        //
        //  This branch used to return `already-fulfilled-or-not-pending` for
        //  every rowless case, and that reason is CLASSIFIED FINISHED: the
        //  caller answers Stripe 200 and stamps the webhook 'processed', so the
        //  event is retired forever. One of the states hiding in here is a
        //  PERMANENT LOSS, not a finished checkout —
        //
        //    the booking-status claim above is taken FIRST and the ledger row is
        //    written a few statements later. A runner killed in that window (a
        //    serverless timeout, a deploy, the process reaped) leaves the
        //    booking sitting in PENDING_APPROVAL with NO ledger row and NOT ONE
        //    handoff attempted — the customer has paid $49 and nobody has been
        //    emailed, texted or carded. The claim is consumed, so the retry
        //    matched 0 rows, found no ledger, and reported the whole thing
        //    finished.
        //
        //  The booking's OWN STATUS separates the two shapes, and the audit
        //  ledger separates the third:
        //    • not in the claimed status  → this booking was never claimed by a
        //      fan-out (or has moved on): nothing to do, genuinely finished;
        //    • claimed status + a recorded authorization → a fan-out DID run to
        //      its end, before this ledger existed: finished;
        //    • claimed status + nothing recorded → an ORPHANED fan-out. It is
        //      ADOPTED and run in full below. Nothing can be double-sent by
        //      that: the ledger row is written BEFORE the first handoff, so a
        //      run that left no ledger row sent nothing — and the deterministic
        //      BullMQ job ids and PAYMENT_RECEIVED primary key stand behind it.
        //
        //  DO NOT "simplify" this back to a bare `!row ⇒ finished`. Keeping the
        //  old test and dropping this fix would restore a silent, unrecoverable
        //  loss of a paid customer's entire fan-out.
        // ══════════════════════════════════════════════════════════════════
        if (statusBeforeClaim !== CLAIMED_STATUS) {
          log.info(
            { status: statusBeforeClaim },
            'No fulfilment ledger and the booking is not in the claimed state — nothing to fulfil here',
          )
          return { processed: false, bookingId, reason: 'already-fulfilled-or-not-pending' }
        }

        const recordedAuthorization = await authorizationAlreadyRecorded(bookingId, paymentIntentId, log)
        if (recordedAuthorization === null) {
          // The question could not be asked. Unknown is not done (ITEM T3).
          log.error(
            'could not check whether this booking already had a fan-out — refusing to report the checkout as fulfilled',
          )
          return { processed: false, bookingId, reason: LEDGER_UNREADABLE }
        }
        if (recordedAuthorization) {
          log.info('Checkout already fulfilled before this ledger existed (its authorization is recorded) — skipping')
          return { processed: false, bookingId, reason: 'already-fulfilled-or-not-pending' }
        }

        // ORPHANED. Take the fan-out over: create the ledger row, which is also
        // the atomic claim — `eventId` is unique, so of N triggers arriving
        // together exactly one adopts and the rest are told to come back.
        const adoptedRow = {
          source: LEDGER_SOURCE,
          eventType: LEDGER_EVENT_TYPE,
          status: 'in-progress',
          processedAt: leaseAt,
          payload: { version: 1, planned: [...plannedLabels], done: [], attempts: 1 } as unknown as Prisma.InputJsonValue,
        }
        try {
          await prisma.webhookLog.create({ data: { ...adoptedRow, eventId: ledgerKey } })
        } catch (err) {
          if (isUniqueViolation(err)) {
            log.warn('another runner adopted this orphaned fan-out first — this delivery did nothing')
            return { processed: false, bookingId, reason: RESUME_IN_PROGRESS }
          }
          log.error(
            { err: err instanceof Error ? err.message : String(err) },
            'CRITICAL: an orphaned fan-out could not be adopted because its ledger could not be written — ' +
              'nothing was sent; retry this trigger',
          )
          throw new Error(
            `${LEDGER_UNAVAILABLE}: booking ${bookingId} — an abandoned fan-out could not be adopted (its handoff ledger could not be written), so nothing was sent. Retry this trigger.`,
          )
        }
        log.error(
          'ADOPTING an abandoned checkout fan-out: the booking was claimed and no fan-out was ever recorded, so nothing ' +
            'reached the customer or the owner. Running it now.',
        )
        ledger = { version: 1, planned: plannedLabels, done: [], attempts: 1 }
        // Deliberately NOT a resume: nothing was delivered, so every handoff —
        // and the tracker ingest a resume skips — is outstanding.
        resumed = false
        adopted = true
      }

      if (!adopted) {
        // Someone else is re-driving it RIGHT NOW. This delivery did nothing, so
        // it must not be reported as finished.
        log.warn(
          { ledgerStatus: row?.status },
          'another runner is re-driving the outstanding handoffs for this booking — this delivery did nothing',
        )
        return { processed: false, bookingId, reason: RESUME_IN_PROGRESS }
      }
    }

    if (!adopted) {

    const existing = parseLedger(row?.payload)
    if (!existing) {
      // The row is there and this run holds its lease, but the payload is not a
      // ledger, so what has already been sent is UNKNOWN. Refusing to guess is
      // still right — reporting it as finished was not. Give the lease back and
      // make the caller come back: unknown is not done.
      const released = await releaseLedgerLease()
      log.error(
        { ledgerKey, leaseReleased: released },
        'the fulfilment handoff ledger is unreadable — refusing to guess what was already sent, and refusing to ' +
          'report this checkout as fulfilled',
      )
      return { processed: false, bookingId, reason: LEDGER_UNREADABLE }
    }
    // The plan is whatever this booking needs NOW; `done` is what is proven.
    // Replacing (not merging) `planned` is what stops a label that is no longer
    // part of the plan from holding the ledger 'outstanding' forever.
    ledger = { version: 1, planned: plannedLabels, done: existing.done, attempts: existing.attempts + 1 }
    // The customer's pre-approval email is ONE handoff with two transports
    // (legacy queue vs outbox). If OUTBOX_ENABLED changed between runs, the
    // label in the plan differs from the one in `done` — and re-sending would
    // be a second email to a customer who already has one.
    if (ledger.done.includes(EMAIL_LABEL) || ledger.done.includes(OUTBOX_EMAIL_LABEL)) {
      for (const label of [EMAIL_LABEL, OUTBOX_EMAIL_LABEL]) {
        if (!ledger.done.includes(label)) ledger.done.push(label)
      }
    }
    resumed = true
    }
  }

  const alreadyDelivered = [...ledger.done]
  const outstanding = plan.filter((h) => !ledger.done.includes(h.label))
  if (resumed) {
    log.warn(
      { attempt: ledger.attempts, alreadyDelivered, outstanding: outstanding.map((h) => h.label) },
      'RESUMING an incomplete checkout fan-out — only the outstanding handoffs are re-driven',
    )
  }

  // ── ITEM P0-E / B4 / R4 — the claim must never outlive the work it was
  //    taken for. Everything from here to the end runs inside this try.
  //
  //  B4 CORRECTION: this block used to claim that reaching the catch meant
  //  "essentially nothing was queued". The opposite was true — every task is
  //  individually guarded and CANNOT reject, so the catch could not fire in the
  //  one case it named, and a fan-out where all five handoffs failed returned
  //  processed:true. The catch is now only what it really is (an UNEXPECTED
  //  throw); "nothing reached anyone" is decided explicitly, from the recorded
  //  handoff outcomes, after the fan-out below.
  //
  //  R4 CORRECTION: the catch no longer RELEASES the claim. The ledger above
  //  already records what this run intended and what it achieved, so the next
  //  trigger resumes the remainder; releasing would send it back through the
  //  whole fan-out and duplicate everything that had already gone out.
  const handoffs: HandoffOutcome[] = []
  try {

  // ── Fan out the OUTSTANDING side-effects concurrently (each guarded) ────
  // Concurrent (not sequential) bounds the worst case to ~5s even if Redis is
  // down, which keeps the browser success redirect snappy.
  const tasks: Promise<unknown>[] = outstanding.map((h) => enqueue(handoffs, h.label, h.run, markDone))

  // Marketing-tracker revenue merge (Phase 2). Attribute this paid booking to
  // its source / found-us in the scans→leads→jobs funnel. Idempotent on
  // external_ref and self-guarded (5s timeout) — a tracker outage is a no-op.
  // Revenue recorded is the move ESTIMATE (expected job value), not the $49.
  // It is not a notification and never throws, so it is not a tracked handoff;
  // it belongs to the run that owns the money event, not to a resume.
  if (!resumed) {
    tasks.push(
      deps.ingestBookingToTracker({
        bookingId,
        source: booking.source,
        foundUs: booking.foundUs,
        name: booking.customer.name,
        phone: booking.customer.phone,
        email: booking.customer.email,
        revenueCents:
          booking.totalEstimate != null ? Math.round(booking.totalEstimate * 100) : amountTotalCents ?? 4900,
        status: 'scheduled',
        scheduledDate: booking.requestedDate ? booking.requestedDate.toISOString().slice(0, 10) : null,
        notes: `Booking ${booking.displayId} — deposit paid`,
      }),
    )
  }

  await Promise.all(tasks)

  // Everything this run got through is PROVEN delivered — and each of these was
  // already written durably by `markDone` as it happened (ITEM T2). This loop is
  // the belt to that braces: it costs nothing and keeps the in-memory ledger
  // correct even if one incremental write was refused.
  for (const h of handoffs) {
    if (h.ok && !ledger.done.includes(h.label)) ledger.done.push(h.label)
  }

  // ══════════════════════════════════════════════════════════════════════
  //  ITEM B4 — DID ANYTHING ACTUALLY REACH ANYONE?
  //  --------------------------------------------------------------------
  //  Every handoff above is individually guarded, so up to this point a total
  //  Redis outage looks exactly like a healthy fan-out. The next three blocks
  //  are the difference: the owner gets a fallback that does not need Redis,
  //  the log tells the truth, and "nothing reached anyone" refuses to report
  //  the event as processed.
  // ══════════════════════════════════════════════════════════════════════
  const delivered = (label: string): boolean => ledger.done.includes(label)

  // GUARANTEED OWNER NOTICE — the same shape as the $0-lead fallback in
  // src/lib/quote-capture.ts (queue down ⇒ post it directly). The rich
  // Approve/Deny card needs Redis; the OWNER needs to know a paid booking is
  // waiting. ops-alert is a bare HTTPS POST — no BullMQ, no discord.js — so it
  // survives precisely the outage that killed the card. It never throws.
  // It is recorded in the ledger too: an earlier run that already reached the
  // owner this way must not ping him again on every resume.
  let ownerNotified = delivered(CARD_LABEL) || delivered(DIRECT_NOTICE_LABEL)
  if (!ownerNotified) {
    const adminUrl = `${appUrl.replace(/\/+$/, '')}/admin/bookings`
    // Every line is something the row or the Stripe event proves. The amount is
    // printed only when Stripe actually reported one — the $49 default used for
    // the card elsewhere is an assumption, and this notice is the owner's only
    // record of the money in this failure mode.
    const moneyLine =
      amountTotalCents != null
        ? `$${(amountTotalCents / 100).toFixed(2)} authorized (a HOLD — not captured)`
        : 'Deposit authorized (a HOLD — not captured); Stripe reported no amount'
    const notice = await deps
      .postOwnerNotice(`🆕 BOOKING AWAITING APPROVAL — ${booking.displayId} (Discord card could not be queued)`, [
        { message: `${booking.customer.name}${booking.customer.phone ? ` · ${booking.customer.phone}` : ''}` },
        { message: `Move: ${smsMoveWhen(booking, 'en-US') ?? 'date not set'}` },
        { message: moneyLine },
        { message: 'Approve it in the admin', action: adminUrl },
      ])
      .catch((err) => ({ delivered: false, reason: err instanceof Error ? err.message : String(err) }) as AlertResult)
    handoffs.push({
      label: DIRECT_NOTICE_LABEL,
      ok: notice.delivered,
      error: notice.delivered ? undefined : notice.reason,
    })
    ownerNotified = notice.delivered
    // ITEM T2 — durable the moment it is proven, like every other handoff: a
    // run killed after this point must not ping the owner a second time.
    if (notice.delivered) await markDone(DIRECT_NOTICE_LABEL)
    log.error(
      { delivered: notice.delivered, reason: notice.reason },
      notice.delivered
        ? 'approval card could not be queued — plain-text approval notice posted to Discord instead'
        : 'approval card could not be queued AND the direct notice failed — the owner has NOT been told about this booking',
    )
  }

  const customerNotified = delivered(EMAIL_LABEL) || delivered(OUTBOX_EMAIL_LABEL)

  // NOTHING DURABLE ⇒ DO NOT REPORT THIS EVENT AS PROCESSED. Neither the
  // customer nor the owner was reached, so this run fulfilled nothing.
  //
  // ITEM R4 — the claim is KEPT. Releasing it (the previous behaviour) sent the
  // next trigger through the WHOLE fan-out again, so a partial failure — SMS
  // and marketing accepted, email and card refused, which is the ordinary shape
  // of an Upstash blip — double-sent everything that had worked. The ledger
  // above is what makes keeping it safe: the retry resumes the outstanding
  // handoffs only. Keeping the claim is also the honest booking state — the $49
  // IS authorized, and PENDING_APPROVAL is what puts the booking on the admin
  // dashboard's "waiting for approval" counter; PENDING_PAYMENT hides it there.
  if (!ownerNotified && !customerNotified) {
    const persisted = await persistLedger()
    log.error(
      { handoffs, ledgerPersisted: persisted, outstanding: plannedLabels.filter((l) => !ledger.done.includes(l)) },
      'CRITICAL: paid checkout reached NOBODY (no customer email, no owner card, no direct notice) — ' +
        'the claim is KEPT and the outstanding handoffs are recorded; the next trigger re-drives ONLY those. ' +
        'Nothing is recorded as sent',
    )
    return { processed: false, bookingId, reason: NO_DURABLE_HANDOFF, handoffs, ownerNotified, customerNotified, resumed, alreadyDelivered }
  }

  // The money DID arrive and this run is keeping its claim, so record it ONCE —
  // across runs, not just within one. src/lib/booking-approval.ts counts
  // PAYMENT_RECEIVED rows as a one-per-booking marker for "this money is already
  // recorded", so a per-attempt audit would corrupt that guard.
  //
  // ITEM T2 — the row carries a DETERMINISTIC PRIMARY KEY (`fulfillmentAuditId`)
  // so "one authorization ⇒ one audit row" is enforced by Postgres and not by
  // this function's memory. The ledger label is the fast path; the primary key
  // is what holds when the ledger write itself was the thing that was lost.
  if (!ledger.done.includes(AUDIT_LABEL)) {
    const wrote = await prisma.auditLog
      .create({
        data: {
          id: fulfillmentAuditId(bookingId, paymentIntentId),
          action: 'PAYMENT_RECEIVED',
          bookingId,
          details: { authorized: true, amount: amountTotalCents, paymentIntentId, source },
        },
      })
      .then(() => true)
      .catch((err) => {
        // A unique violation means the row is ALREADY there — this exact
        // authorization is recorded, which is the whole point of the label. It
        // is the good news, not a failure to retry.
        if (isUniqueViolation(err)) {
          log.info('PAYMENT_RECEIVED was already recorded for this authorization — nothing to add')
          return true
        }
        log.warn({ err: err instanceof Error ? err.message : String(err) }, 'audit log write failed (non-fatal)')
        return false
      })
    if (wrote) await markDone(AUDIT_LABEL)
  }

  // ── STOP RULE: the customer converted ───────────────────────────────────
  // Cancel every pending abandoned-recovery stage. This is an optimisation, not
  // the guarantee — each stage also re-reads the booking status at send time
  // (scheduled.worker) and again in the email worker (stillWantedForBooking),
  // so a queue we fail to clean still cannot produce a wrong email.
  //
  // ITEM T2 — this is the ONE step whose exactly-once rests on IDEMPOTENCE
  // rather than on a durable record or a key: something has to run last, and
  // whatever runs last can always be re-run by a kill in the statement before
  // its ledger write. Cancelling already-cancelled recovery stages is a no-op,
  // so a second pass costs nothing and sends nothing. (Its window is now one
  // statement wide; before this repair it was the entire fan-out.)
  if (!ledger.done.includes(JOURNEY_LABEL)) {
    const cleaned = await deps
      .onBookingPaid(bookingId)
      .then(() => true)
      .catch((err) => {
        log.warn({ err: err instanceof Error ? err.message : String(err) }, 'onBookingPaid cleanup failed (non-fatal)')
        return false
      })
    if (cleaned) await markDone(JOURNEY_LABEL)
  }

  await persistLedger()

  // TRUTHFUL LEDGER — "all jobs queued" is printed only when all jobs queued.
  const summary = summarizeHandoffs(handoffs)
  if (resumed) {
    log.info(
      { retried: outstanding.map((h) => h.label), alreadyDelivered, queued: summary.queued, failedHandoffs: summary.failed },
      'Checkout fan-out RESUMED — only the outstanding handoffs were re-driven',
    )
  } else if (summary.allQueued) {
    log.info({ handoffs: handoffs.length }, summary.message)
  } else {
    log.error(
      { queued: summary.queued, failedHandoffs: summary.failed, ownerNotified, customerNotified },
      summary.message,
    )
  }
  return { processed: true, bookingId, handoffs, ownerNotified, customerNotified, resumed, alreadyDelivered }

  } catch (err) {
    // An UNEXPECTED throw (not a handoff failure — those are recorded, never
    // thrown). Record what DID get through, keep the claim, and rethrow so the
    // trigger retries and resumes the remainder.
    for (const h of handoffs) {
      if (h.ok && !ledger.done.includes(h.label)) ledger.done.push(h.label)
    }
    await persistLedger()
    log.error(
      { err: err instanceof Error ? err.message : String(err), delivered: ledger.done },
      'fulfillment threw after the claim — the claim is KEPT and the ledger records what is still outstanding, ' +
        'so the next trigger re-drives only that',
    )
    throw err
  }
}
