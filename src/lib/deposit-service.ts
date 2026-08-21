// ════════════════════════════════════════════════════════════════════════════
//  deposit-service.ts — the database half of admin deposit links.
//  ------------------------------------------------------------------------
//  Everything that decides an AMOUNT or a STATUS lives in deposit-links.ts
//  (pure, tested offline). This file only persists those decisions, and it is
//  where the two money invariants are enforced with the DATABASE rather than
//  with hope:
//
//    1. ONE PAYABLE SESSION PER LINK — a rapid double-tap reuses the live
//       Stripe session instead of minting a second one (conditional UPDATE +
//       a Stripe idempotency key derived from the attempt number).
//    2. A DEPOSIT IS APPLIED EXACTLY ONCE — `markDepositPaid` claims the row
//       with a conditional UPDATE on `paid_at IS NULL`. Whoever wins writes the
//       Payment row; a duplicate Stripe delivery gets count:0 and returns
//       without touching the ledger.
//
//  The Discord notification is NEVER on the payment's critical path. It is a
//  column on this row (a minimal durable outbox), set to PENDING inside the
//  same transaction that records the money. If Redis, the worker or Discord
//  itself is down, the payment is still complete and the admin list shows the
//  notification as Pending with a retry button.
// ════════════════════════════════════════════════════════════════════════════
import { prisma } from './db'
import { apiLogger } from './logger'
import { customerBalance, JOB_MONEY_PAYMENT_SELECT } from './job-money'
import { anchorFromInstant, easternTimeMinutes } from './move-date'
import {
  checkDepositAgainstBalance,
  effectiveStatus,
  newPublicToken,
  isPayable,
  type DepositStatus,
} from './deposit-links'

const log = apiLogger.child({ mod: 'deposit-service' })

/** A SENDING claim older than this is treated as a crashed worker, not an
 *  in-flight send, so a notification can never be wedged forever. */
export const DISCORD_CLAIM_STALE_MS = 5 * 60 * 1000

// ── Balance context for a booking ───────────────────────────────────────────

export type BookingDepositContext = {
  bookingId: string
  displayId: string
  bookingReference: string | null
  customerName: string
  customerEmail: string
  customerPhone: string | null
  requestedDate: Date | null
  itemsDescription: string | null
  /** finalBilled — the accepted quote plus approved add-ons, less discount. */
  quoteTotalCents: number
  /** What is still owed right now. */
  unpaidBalanceCents: number
  /** True when no accepted total is stored, so the balance above is a FLOOR. */
  quoteMissing: boolean
  /** The $49 booking hold, if one is authorized but not captured. */
  authorizedNotCapturedCents: number
  isInternalTest: boolean
}

/**
 * Read a booking's live money picture through `customerBalance()` — the ONE
 * balance formula. Nothing here re-sums fee columns, so a deposit link can
 * never disagree with the job page about what a customer owes.
 */
export async function bookingDepositContext(bookingId: string): Promise<BookingDepositContext | null> {
  // `include` (not a hand-written select) so every money column customerBalance
  // reads is present by construction — a new fee column added to Booking later
  // cannot silently drop out of the deposit cap.
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: {
      customer: { select: { name: true, email: true, phone: true } },
      payments: { select: JOB_MONEY_PAYMENT_SELECT },
    },
  })
  if (!booking) return null

  const balance = customerBalance(booking as never)

  return {
    bookingId,
    displayId: booking.displayId,
    bookingReference: booking.bookingReference,
    customerName: booking.customer?.name ?? '',
    customerEmail: booking.customer?.email ?? '',
    customerPhone: booking.customer?.phone ?? null,
    requestedDate: booking.requestedDate,
    itemsDescription: booking.itemsDescription,
    quoteTotalCents: balance.finalBilledCents,
    unpaidBalanceCents: balance.outstandingCents,
    quoteMissing: balance.quoteMissing,
    authorizedNotCapturedCents: balance.authorizedNotCapturedCents,
    isInternalTest: booking.isInternalTest,
  }
}

// ── Create ──────────────────────────────────────────────────────────────────

export type CreateDepositInput = {
  amountCents: number
  bookingId?: string | null
  leadId?: string | null
  customerName?: string | null
  customerEmail?: string | null
  customerPhone?: string | null
  quoteTotalCents?: number | null
  serviceSummary?: string | null
  /** CUSTOMER-FACING bullets. */
  moveDetails?: string[] | null
  /** CUSTOMER-FACING to-do. */
  customerNote?: string | null
  /** PRIVATE crew note. Never reaches the public projection or Stripe. */
  internalNote?: string | null
  moveDate?: Date | null
  moveTimeMinutes?: number | null
  expiresAt?: Date | null
  createdById?: string | null
  createdByName?: string | null
}

export type CreateDepositResult =
  | { ok: true; id: string; publicToken: string; warning?: string }
  | { ok: false; status: number; error: string }

export async function createDepositRequest(input: CreateDepositInput): Promise<CreateDepositResult> {
  let quoteTotalCents = input.quoteTotalCents ?? null
  let balanceBeforeCents: number | null = null
  let warning: string | undefined
  let moveDate = input.moveDate ?? null
  let moveTimeMinutes = input.moveTimeMinutes ?? null
  let customerName = input.customerName ?? null
  let customerEmail = input.customerEmail ?? null
  let customerPhone = input.customerPhone ?? null
  let serviceSummary = input.serviceSummary ?? null

  if (input.bookingId) {
    const ctx = await bookingDepositContext(input.bookingId)
    if (!ctx) return { ok: false, status: 404, error: 'Booking not found' }

    // The booking is the source of truth for the money. Admin-typed values are
    // used only to FILL what the booking does not know — never to overwrite it,
    // because a hand-typed quote total that disagrees with the accepted quote is
    // exactly how a customer gets shown a number nobody owes.
    quoteTotalCents = ctx.quoteMissing ? quoteTotalCents ?? null : ctx.quoteTotalCents
    balanceBeforeCents = ctx.quoteMissing ? null : ctx.unpaidBalanceCents
    customerName = customerName ?? ctx.customerName ?? null
    customerEmail = customerEmail ?? ctx.customerEmail ?? null
    customerPhone = customerPhone ?? ctx.customerPhone ?? null
    // INHERITING A DATE FROM A BOOKING IS A CONVERSION, NOT A COPY.
    // `requestedDate` is a real INSTANT carrying an Eastern wall-clock time.
    // A move date is a CALENDAR DATE. Storing the instant verbatim left the
    // deposit holding a value whose meaning depended on how it was read, which
    // is the whole class of bug this feature was reported for. Take the Eastern
    // calendar day and the Eastern time, then store each in its own column.
    if (!moveDate && ctx.requestedDate) {
      moveDate = anchorFromInstant(ctx.requestedDate)
      moveTimeMinutes = moveTimeMinutes ?? easternTimeMinutes(ctx.requestedDate)
    }
    // serviceSummary is deliberately NOT inherited. A booking's
    // `itemsDescription` is written for the crew and the owner; publishing it
    // on a payment page unread is exactly how an internal note reached a
    // customer. The owner types the customer-facing line himself.

    const check = checkDepositAgainstBalance(input.amountCents, {
      unpaidBalanceCents: ctx.unpaidBalanceCents,
      quoteMissing: ctx.quoteMissing,
      authorizedNotCapturedCents: ctx.authorizedNotCapturedCents,
    })
    if (!check.ok) return { ok: false, status: 422, error: check.error ?? 'Invalid deposit amount' }
    warning = check.warning
  } else if (quoteTotalCents != null) {
    // Standalone: the typed quote total is the only balance information there
    // is, so it is also the starting balance.
    balanceBeforeCents = quoteTotalCents
    if (input.amountCents > quoteTotalCents) {
      return { ok: false, status: 422, error: 'Deposit cannot exceed the quote total.' }
    }
  }

  // THE FIVE NEW COLUMNS ARE SPLIT OUT so the create can drop them and retry if
  // the production database has not had migration 20260820120000 applied yet.
  // This repo does not run migrations at build time (nixpacks.toml), so there is
  // always a window where new code runs against the old schema. On the PUBLIC
  // page that window is a P2022 fallback; here it is this one. Without it, the
  // admin "create deposit link" flow would 500 the instant the code deploys
  // ahead of the migration — an outage on the owner's most-used button. With it,
  // deploy order genuinely does not matter: a link still mints (without the move
  // time / details / notes), and once the migration lands every field works.
  const newSchemaFields = {
    moveDetails: input.moveDetails ?? [],
    customerNote: input.customerNote ?? null,
    internalNote: input.internalNote ?? null,
    moveTimeMinutes,
  }

  // A token collision at 60 bits is not a real event, but a retry costs nothing
  // and turns an impossible-but-fatal 500 into a no-op.
  let schemaHasNewColumns = true
  for (let attempt = 0; attempt < 3; attempt++) {
    const publicToken = newPublicToken()
    try {
      const row = await prisma.depositRequest.create({
        data: {
          publicToken,
          bookingId: input.bookingId ?? null,
          leadId: input.leadId ?? null,
          customerName,
          customerEmail,
          customerPhone,
          quoteTotalCents,
          balanceBeforeCents,
          amountCents: input.amountCents,
          serviceSummary,
          ...(schemaHasNewColumns ? newSchemaFields : {}),
          moveDate,
          expiresAt: input.expiresAt ?? null,
          createdById: input.createdById ?? null,
          createdByName: input.createdByName ?? null,
          status: 'ACTIVE',
          discordStatus: 'NOT_APPLICABLE',
        },
        select: { id: true, publicToken: true },
      })

      await prisma.auditLog
        .create({
          data: {
            action: 'DEPOSIT_LINK_CREATED',
            userId: input.createdById ?? null,
            bookingId: input.bookingId ?? null,
            details: {
              depositRequestId: row.id,
              amountCents: input.amountCents,
              quoteTotalCents,
              balanceBeforeCents,
              standalone: !input.bookingId,
              by: input.createdByName ?? null,
            },
          },
        })
        .catch((err) => log.warn({ err: msg(err) }, 'deposit audit write failed (non-fatal)'))

      const okWarning =
        schemaHasNewColumns
          ? warning
          : [
              warning,
              'Saved without move time / details / notes: the deposit-fields migration is not applied to this database yet. Run `prisma migrate deploy`.',
            ]
              .filter(Boolean)
              .join(' ')

      return { ok: true, id: row.id, publicToken: row.publicToken, warning: okWarning || undefined }
    } catch (err) {
      if (isUniqueViolation(err) && attempt < 2) continue
      // The database predates migration 20260820120000. Drop the new columns
      // and retry ONCE so the owner still gets a working link instead of a 500.
      if (isMissingColumnError(err) && schemaHasNewColumns) {
        schemaHasNewColumns = false
        log.warn(
          { err: msg(err) },
          'deposit_requests is missing the move-time/details/notes columns — creating the link without them (run prisma migrate deploy)'
        )
        continue
      }
      log.error({ err: msg(err) }, 'deposit link create failed')
      return { ok: false, status: 500, error: 'Could not create the deposit link' }
    }
  }
  return { ok: false, status: 500, error: 'Could not create the deposit link' }
}

/**
 * Postgres 42703 / Prisma P2022: "the column does not exist in the current
 * database". THE signal that new code is running against a schema that has not
 * had a migration applied yet. Shared by every deposit read/write path so that
 * — since this repo does not run migrations at build time — deploy order never
 * causes an outage.
 */
export function isMissingColumnError(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null
  if (e?.code === 'P2022') return true
  const text = err instanceof Error ? err.message : String(err)
  return /column .* does not exist|42703/i.test(text)
}

// ── Checkout session (double-click safety) ──────────────────────────────────

export type SessionClaim =
  | { kind: 'reuse'; url: string }
  | { kind: 'create'; attempt: number }
  | { kind: 'busy' }

/**
 * Decide whether this request may mint a Stripe session.
 *
 * `reuse` — a live session already exists; hand back the SAME URL. This is what
 *   makes a double-tap safe in the common case: no second session, no second
 *   payable page.
 * `create` — nobody holds a live session and THIS caller won the conditional
 *   UPDATE on `checkout_attempts`. The returned attempt number becomes part of
 *   the Stripe idempotency key, so even a retry of this exact call collapses
 *   into one session at Stripe's end.
 * `busy` — another request won the race a millisecond ago. The caller re-reads
 *   and returns whatever URL now exists rather than racing again.
 */
export async function claimCheckoutSession(id: string, now: Date = new Date()): Promise<SessionClaim> {
  const row = await prisma.depositRequest.findUnique({
    where: { id },
    select: { stripeCheckoutUrl: true, checkoutSessionExpiresAt: true, checkoutAttempts: true },
  })
  if (!row) return { kind: 'busy' }

  // 60s of headroom: a session that expires while the customer is typing their
  // card number is a failed payment attempt, not a saved API call.
  const live =
    row.stripeCheckoutUrl &&
    row.checkoutSessionExpiresAt &&
    row.checkoutSessionExpiresAt.getTime() > now.getTime() + 60_000
  if (live) return { kind: 'reuse', url: row.stripeCheckoutUrl as string }

  const next = row.checkoutAttempts + 1
  const claim = await prisma.depositRequest.updateMany({
    where: { id, checkoutAttempts: row.checkoutAttempts, status: 'ACTIVE', paidAt: null },
    data: { checkoutAttempts: next },
  })
  if (claim.count === 0) return { kind: 'busy' }
  return { kind: 'create', attempt: next }
}

export async function recordCheckoutSession(
  id: string,
  session: { id: string; url: string | null; expiresAt: Date | null }
): Promise<void> {
  await prisma.depositRequest.update({
    where: { id },
    data: {
      stripeCheckoutSessionId: session.id,
      stripeCheckoutUrl: session.url,
      checkoutSessionExpiresAt: session.expiresAt,
    },
  })
}

// ── Payment application (the money-critical path) ───────────────────────────

export type MarkPaidInput = {
  depositRequestId: string
  checkoutSessionId: string | null
  paymentIntentId: string | null
  stripeEventId: string
  amountPaidCents: number
  livemode: boolean
  currency?: string | null
}

export type MarkPaidResult = {
  applied: boolean
  reason?: string
  depositRequestId: string
  bookingId?: string | null
  paymentId?: string | null
}

/**
 * Record a CONFIRMED deposit payment and apply it to the ledger, exactly once.
 *
 * Called ONLY from the Stripe webhook path, and only for an event Stripe
 * reported as paid. The success redirect never reaches this function.
 *
 * A link that had expired or been canceled is still recorded if Stripe says the
 * money moved: refusing to record a real capture would lose money that is
 * already in the account. The prior status is written to the audit log so the
 * anomaly is visible rather than silently normalised.
 */
export async function markDepositPaid(input: MarkPaidInput): Promise<MarkPaidResult> {
  const now = new Date()

  const result = await prisma.$transaction(async (tx) => {
    const before = await tx.depositRequest.findUnique({
      where: { id: input.depositRequestId },
      select: { id: true, status: true, bookingId: true, amountCents: true, customerName: true, paidAt: true },
    })
    if (!before) return { applied: false, reason: 'deposit-not-found', depositRequestId: input.depositRequestId }

    // THE claim. `paidAt: null` is the whole guard — a replayed webhook, a
    // second event type for the same session, and two workers racing all lose
    // here, and only the winner writes a Payment row.
    const claim = await tx.depositRequest.updateMany({
      where: { id: input.depositRequestId, paidAt: null },
      data: {
        status: 'PAID',
        paidAt: now,
        amountPaidCents: input.amountPaidCents,
        stripeCheckoutSessionId: input.checkoutSessionId ?? undefined,
        stripePaymentIntentId: input.paymentIntentId ?? undefined,
        stripeEventId: input.stripeEventId,
        livemode: input.livemode,
        // Durable outbox: the notification becomes owed in the SAME transaction
        // that records the money, so it cannot be lost by a crash between them.
        discordStatus: 'PENDING',
      },
    })
    if (claim.count === 0) {
      return { applied: false, reason: 'already-paid', depositRequestId: input.depositRequestId, bookingId: before.bookingId }
    }

    let paymentId: string | null = null
    if (before.bookingId) {
      // An ordinary COMPLETED Stripe payment — the same row shape a captured
      // booking deposit produces. `customerBalance()` therefore nets it off the
      // outstanding balance with no new arithmetic anywhere in the admin.
      const payment = await tx.payment.create({
        data: {
          bookingId: before.bookingId,
          amount: input.amountPaidCents,
          currency: input.currency ?? 'usd',
          status: 'COMPLETED',
          method: 'STRIPE',
          stripePaymentIntentId: input.paymentIntentId ?? undefined,
          description: 'Move deposit (payment link)',
          metadata: {
            depositRequestId: input.depositRequestId,
            stripeCheckoutSessionId: input.checkoutSessionId,
            stripeEventId: input.stripeEventId,
            source: 'deposit-link',
          },
        },
        select: { id: true },
      })
      paymentId = payment.id
      await tx.depositRequest.update({ where: { id: input.depositRequestId }, data: { paymentId } })
    }

    await tx.auditLog.create({
      data: {
        action: 'DEPOSIT_LINK_PAID',
        bookingId: before.bookingId,
        details: {
          depositRequestId: input.depositRequestId,
          amountPaidCents: input.amountPaidCents,
          amountRequestedCents: before.amountCents,
          statusBefore: before.status,
          stripeEventId: input.stripeEventId,
          stripeCheckoutSessionId: input.checkoutSessionId,
          stripePaymentIntentId: input.paymentIntentId,
          paymentId,
          livemode: input.livemode,
        },
      },
    })

    return { applied: true, depositRequestId: input.depositRequestId, bookingId: before.bookingId, paymentId }
  })

  if (result.applied) {
    log.info(
      { depositRequestId: input.depositRequestId, bookingId: result.bookingId, amountPaidCents: input.amountPaidCents },
      'deposit payment applied'
    )
  }
  return result as MarkPaidResult
}

// ── Discord delivery state ──────────────────────────────────────────────────

/**
 * Take exclusive ownership of this row's notification, or refuse.
 *
 * Returning false is the "exactly one Discord message" guarantee: a duplicate
 * Stripe event, a retried BullMQ job and an admin pressing Retry all funnel
 * through here, and only one of them is ever allowed to post.
 */
export async function claimDiscordNotification(id: string, now: Date = new Date()): Promise<boolean> {
  const staleBefore = new Date(now.getTime() - DISCORD_CLAIM_STALE_MS)
  const claim = await prisma.depositRequest.updateMany({
    where: {
      id,
      paidAt: { not: null },
      OR: [
        { discordStatus: { in: ['PENDING', 'FAILED'] } },
        // A crashed worker left this SENDING. After the stale window it is
        // fair game again — otherwise the owner is never told.
        { discordStatus: 'SENDING', discordClaimedAt: { lt: staleBefore } },
      ],
    },
    data: { discordStatus: 'SENDING', discordClaimedAt: now },
  })
  return claim.count > 0
}

export async function recordDiscordSuccess(id: string, messageId: string | null): Promise<void> {
  await prisma.depositRequest.update({
    where: { id },
    data: { discordStatus: 'SENT', discordNotifiedAt: new Date(), discordMessageId: messageId, discordError: null },
  })
}

export async function recordDiscordFailure(id: string, error: string): Promise<void> {
  await prisma.depositRequest.update({
    where: { id },
    data: {
      discordStatus: 'FAILED',
      // Truncated and already scrubbed by the sender — a URL never reaches here.
      discordError: error.slice(0, 300),
      discordRetryCount: { increment: 1 },
    },
  })
}

// ── Admin list / lookup ─────────────────────────────────────────────────────

export type DepositListRow = {
  id: string
  publicToken: string
  url: string
  status: DepositStatus
  amountCents: number
  quoteTotalCents: number | null
  balanceBeforeCents: number | null
  amountPaidCents: number | null
  remainingCents: number | null
  customerName: string | null
  bookingId: string | null
  bookingDisplayId: string | null
  bookingReference: string | null
  serviceSummary: string | null
  moveDate: string | null
  expiresAt: string | null
  paidAt: string | null
  createdAt: string
  createdByName: string | null
  discordStatus: string
  discordNotifiedAt: string | null
  discordRetryCount: number
  discordError: string | null
}

/** Cancel a link. Refused once paid — cancelling a payment is a refund, and a
 *  refund is a deliberate act somewhere else, not a side-effect of this button. */
export async function cancelDepositRequest(
  id: string,
  actor: { userId?: string | null; name?: string | null }
): Promise<{ ok: boolean; status: number; error?: string }> {
  const row = await prisma.depositRequest.findUnique({
    where: { id },
    select: {
      id: true, status: true, paidAt: true, bookingId: true, expiresAt: true,
      stripeCheckoutSessionId: true, checkoutSessionExpiresAt: true,
    },
  })
  if (!row) return { ok: false, status: 404, error: 'Deposit link not found' }
  if (effectiveStatus(row as never) === 'PAID') {
    return { ok: false, status: 409, error: 'This deposit was already paid — cancel it as a refund in Stripe instead.' }
  }
  const claim = await prisma.depositRequest.updateMany({
    where: { id, paidAt: null, status: { not: 'CANCELED' } },
    data: { status: 'CANCELED' },
  })
  if (claim.count === 0) return { ok: false, status: 409, error: 'This deposit link can no longer be canceled' }

  // KILL THE OPEN STRIPE SESSION. Our link is now CANCELED, but a customer who
  // opened Checkout minutes ago could still have a payable Stripe page. Expiring
  // the session closes that door. It runs AFTER the DB cancel (the source of
  // truth) and is fully guarded: a session that is already paid is left for the
  // webhook to record — we never expire our way into losing money. Best-effort
  // and non-fatal: the cancel succeeds regardless of what Stripe says.
  if (row.stripeCheckoutSessionId) {
    const stillOpen =
      !row.checkoutSessionExpiresAt || row.checkoutSessionExpiresAt.getTime() > Date.now()
    if (stillOpen) {
      try {
        const { expireDepositCheckoutSession } = await import('./stripe')
        const res = await expireDepositCheckoutSession(row.stripeCheckoutSessionId)
        log.info({ depositRequestId: id, sessionId: row.stripeCheckoutSessionId, ...res }, 'expired Stripe session on cancel')
      } catch (err) {
        log.warn({ err: msg(err) }, 'could not expire the Stripe session on cancel (link is still canceled)')
      }
    }
  }

  await prisma.auditLog
    .create({
      data: {
        action: 'DEPOSIT_LINK_CANCELED',
        userId: actor.userId ?? null,
        bookingId: row.bookingId,
        details: { depositRequestId: id, by: actor.name ?? null },
      },
    })
    .catch((err) => log.warn({ err: msg(err) }, 'deposit cancel audit write failed (non-fatal)'))

  return { ok: true, status: 200 }
}

/**
 * Guard used by the public checkout route before any Stripe call.
 *
 * Returns a CODE as well as an English sentence. The code is what the page
 * translates: a Spanish customer was previously shown these strings in English
 * at the exact moment their payment was refused. The sentence stays as the
 * fallback for any client that does not know the code.
 */
export type PayRefusal = { code: 'already_paid' | 'expired' | 'inactive'; message: string }

export function payableOrReason(row: { status: string; expiresAt: Date | null; paidAt: Date | null }): PayRefusal | null {
  if (isPayable(row as never)) return null
  const s = effectiveStatus(row as never)
  if (s === 'PAID') return { code: 'already_paid', message: 'This deposit has already been paid.' }
  if (s === 'EXPIRED') return { code: 'expired', message: 'This payment link has expired. Ask us for a new one.' }
  return { code: 'inactive', message: 'This payment link is no longer active. Ask us for a new one.' }
}

// ── small helpers ───────────────────────────────────────────────────────────
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002'
}
