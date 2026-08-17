// ════════════════════════════════════════════════════════════════════════════
//  deposit-links.ts — PURE logic for admin-issued deposit links.
//  ------------------------------------------------------------------------
//  No Prisma, no Stripe, no network, no `process` reads except through an
//  explicitly-passed env object. Everything here is unit-testable offline, and
//  every money figure the customer or the owner ever sees originates in one of
//  these functions.
//
//  THE ONE RULE THIS FILE EXISTS TO ENFORCE: the amount is decided on the
//  server, in integer cents, and is never re-derived from anything the browser
//  sends. `parseAmountToCents` is the ONLY door dollars come through, and it is
//  deliberately strict — a silent Number() coercion is how "1,0" becomes $1.
//
//  It also does NOT touch pricing. Nothing here recalculates a quote, a labor
//  rate, mileage, a truck charge or an accepted total. A deposit is money taken
//  AGAINST an existing balance; the balance formula stays in job-money.ts.
// ════════════════════════════════════════════════════════════════════════════

import { randomBytes } from 'node:crypto'

// ── Amount bounds ───────────────────────────────────────────────────────────
// $1 floor: a $0 (or negative) "payment" is not a deposit, and Stripe rejects
// sub-50¢ USD charges anyway. $10,000 ceiling: a deposit is a deposit — a
// fat-fingered extra zero on a phone keyboard should be refused, not charged.
export const MIN_DEPOSIT_CENTS = 100
export const MAX_DEPOSIT_CENTS = 1_000_000
/** The quick preset on the admin form. Any other valid amount is still allowed. */
export const PRESET_DEPOSIT_CENTS = 4900

export type AmountParse = { ok: true; cents: number } | { ok: false; error: string }

/**
 * Dollars (as typed on a phone) → integer cents.
 *
 * Accepts: 49, "49", "49.5", "49.50", "$49.50", "1,495.00", " 49 ".
 * Rejects: "", "abc", "-49", "49.999", "1e3", "49.5.5", NaN, Infinity.
 *
 * Rounding is deliberately ABSENT for >2 decimals: "49.999" is refused rather
 * than quietly becoming $50.00. If the owner meant fifty dollars he can type
 * fifty dollars.
 */
export function parseAmountToCents(input: unknown): AmountParse {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return { ok: false, error: 'Enter a dollar amount' }
    // A JS number of dollars can carry float dust (49.1 * 100 = 4909.999…).
    // Round to the nearest cent, then verify it round-trips: 49.999 does not.
    const cents = Math.round(input * 100)
    if (Math.abs(input * 100 - cents) > 1e-6) return { ok: false, error: 'Amount can have at most 2 decimal places' }
    return boundsCheck(cents)
  }
  if (typeof input !== 'string') return { ok: false, error: 'Enter a dollar amount' }

  let raw = input.trim().replace(/^\$/, '')
  if (raw === '') return { ok: false, error: 'Enter a dollar amount' }

  // Commas are stripped ONLY from valid thousands grouping. Blanket-stripping
  // them looks friendlier and is a money bug: "4,9" would become "49" and quietly
  // charge $49 instead of the $4.90 the typo suggests, and "49," would be
  // accepted as a well-formed amount. A malformed comma is a typo — refuse it
  // and let the owner retype rather than guess which number they meant.
  if (raw.includes(',')) {
    if (!/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(raw)) {
      return { ok: false, error: 'Enter a dollar amount like 49 or 1,495.00' }
    }
    raw = raw.replace(/,/g, '')
  }
  // Digits, one optional dot, at most 2 decimals. No exponent, no sign, no
  // second dot — the regex IS the validation, not a pre-filter for parseFloat.
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(raw)
  if (!m) return { ok: false, error: 'Enter a dollar amount like 49 or 49.50' }

  const dollars = Number(m[1])
  const centsPart = m[2] ? Number(m[2].padEnd(2, '0')) : 0
  if (!Number.isSafeInteger(dollars)) return { ok: false, error: 'That amount is too large' }
  return boundsCheck(dollars * 100 + centsPart)
}

function boundsCheck(cents: number): AmountParse {
  if (!Number.isInteger(cents)) return { ok: false, error: 'Amount can have at most 2 decimal places' }
  if (cents < MIN_DEPOSIT_CENTS) return { ok: false, error: `Minimum deposit is ${formatCents(MIN_DEPOSIT_CENTS)}` }
  if (cents > MAX_DEPOSIT_CENTS) return { ok: false, error: `Maximum deposit is ${formatCents(MAX_DEPOSIT_CENTS)}` }
  return { ok: true, cents }
}

/** Integer cents → "$1,234.56". The ONE money formatter for this feature. */
export function formatCents(cents: number): string {
  const neg = cents < 0
  const abs = Math.abs(Math.round(cents))
  const s = (abs / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return `${neg ? '-' : ''}$${s}`
}

// ── Public token ────────────────────────────────────────────────────────────
// Crockford-style base32 minus I, L, O and U: unambiguous when read aloud over
// the phone, and 32 characters means one random byte maps to one character with
// NO modulo bias (256 / 32 = 8 exactly).
const TOKEN_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const TOKEN_LENGTH = 12

/**
 * A cryptographically strong, non-sequential public token (~60 bits).
 *
 * It is the ONLY identifier in a customer-visible URL. It is not derived from
 * the row id, the booking number, the email or the time, so possessing one
 * reveals nothing about any other link and guessing one is not feasible.
 */
export function newPublicToken(length: number = TOKEN_LENGTH): string {
  const bytes = randomBytes(length)
  let out = ''
  for (let i = 0; i < length; i++) out += TOKEN_ALPHABET[bytes[i] & 31]
  return out
}

/** Shape-check a token from a URL before it ever reaches the database. */
export function isValidPublicToken(token: unknown): token is string {
  return typeof token === 'string' && token.length === TOKEN_LENGTH && /^[0-9A-HJKMNP-TV-Z]+$/.test(token)
}

// ── URLs ────────────────────────────────────────────────────────────────────
const strip = (u: string): string => u.trim().replace(/\/+$/, '')

/**
 * The base the customer-facing deposit link is built on.
 *
 * DEPOSIT_LINK_BASE_URL exists so the owner can hand out
 * `https://moveitclearit.com/deposit/…` the moment that path is proxied to this
 * app, WITHOUT touching APP_URL (which every email link and the Discord admin
 * URL also depend on). Until it is set, links are built on APP_URL — the host
 * that definitely serves this page — because a pretty URL that 404s is worse
 * than an ugly one that works.
 */
export function depositBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configured = strip(env.DEPOSIT_LINK_BASE_URL ?? '')
  if (configured) return configured
  const app = strip(env.APP_URL ?? '')
  if (app) return app
  return 'https://www.moveitclearit.com'
}

export function depositUrl(token: string, env: NodeJS.ProcessEnv = process.env): string {
  return `${depositBaseUrl(env)}/deposit/${token}`
}

/** Absolute URL of the deposit-link social card. Must be public and cacheable. */
export function depositOgImageUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = strip(env.DEPOSIT_OG_IMAGE_URL ?? '')
  if (override) return override
  // Served from THIS app's /public, so it ships and versions with the page it
  // describes — no cross-repo deploy dependency for the preview to work.
  const app = strip(env.APP_URL ?? '') || 'https://www.moveitclearit.com'
  return `${app}/assets/social/move-it-clear-it-deposit-v1.jpg`
}

// ── Status ──────────────────────────────────────────────────────────────────
export type DepositStatus = 'ACTIVE' | 'PAID' | 'EXPIRED' | 'CANCELED'

export type StatusInput = {
  status: DepositStatus | string
  expiresAt?: Date | null
  paidAt?: Date | null
}

/**
 * What the link IS right now, as opposed to what the column last said.
 *
 * PAID always wins: a link that was paid and then reached its expiry is still
 * paid, and a customer returning to it must see "Deposit received", not
 * "expired". Expiry is evaluated live so a link goes dead on time without a
 * sweeper job needing to have run.
 */
export function effectiveStatus(row: StatusInput, now: Date = new Date()): DepositStatus {
  if (row.paidAt || row.status === 'PAID') return 'PAID'
  if (row.status === 'CANCELED') return 'CANCELED'
  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) return 'EXPIRED'
  if (row.status === 'EXPIRED') return 'EXPIRED'
  return 'ACTIVE'
}

/** Can this link still take money? The single gate before any Stripe call. */
export function isPayable(row: StatusInput, now: Date = new Date()): boolean {
  return effectiveStatus(row, now) === 'ACTIVE'
}

// ── Balance arithmetic ──────────────────────────────────────────────────────
//
// THE WORKED EXAMPLE FROM THE SPEC:
//   accepted quote $495.00  →  quoteTotalCents      49500
//   nothing collected yet   →  balanceBeforeCents   49500
//   deposit                 →  amountCents           4900
//   remaining               →                       44600  ($446.00)
//
// There is NO processing fee anywhere in this file. The customer is charged the
// deposit and nothing else, and the remainder is the plain subtraction above.

export type BalanceInput = {
  quoteTotalCents?: number | null
  balanceBeforeCents?: number | null
  amountCents: number
}

/**
 * What the customer still owes AFTER this deposit clears, or null when it is
 * genuinely unknown.
 *
 * Null is a first-class answer. A phone quote with no total entered has no
 * remaining balance to state, and inventing one (or printing "$0.00") would be
 * a lie the customer could reasonably rely on. The page HIDES the row instead.
 *
 * `balanceBeforeCents` wins over `quoteTotalCents` when both exist: on a booking
 * that already took a payment, the quote total is the headline figure but the
 * unpaid balance is the true starting point.
 */
export function remainingAfterCents(b: BalanceInput): number | null {
  const base = b.balanceBeforeCents ?? b.quoteTotalCents
  if (base == null) return null
  return Math.max(0, base - b.amountCents)
}

/** Can the customer be shown a quote total / remaining balance at all? */
export function showsBalance(b: BalanceInput): boolean {
  return remainingAfterCents(b) != null
}

// ── Amount validation against a booking ─────────────────────────────────────

export type DepositAmountCheck = {
  ok: boolean
  error?: string
  /** Advisory the admin sees but which does not block the create. */
  warning?: string
}

export type BalanceContext = {
  /** Unpaid balance in cents, or null when the booking has no real quote. */
  unpaidBalanceCents: number | null
  /** True when the booking stores no accepted total, so the balance is a FLOOR. */
  quoteMissing?: boolean
  /** Cents authorized-but-not-captured on the booking (the $49 booking hold). */
  authorizedNotCapturedCents?: number
}

/**
 * May this deposit be taken?
 *
 * OVERPAYMENT IS REFUSED. There is no overpayment policy in this business, so a
 * deposit larger than what is actually owed is a bug or a typo, not a feature —
 * and taking it would create a refund obligation nobody asked for.
 *
 * THE EXCEPTION, stated out loud: when the booking has no accepted total, the
 * "unpaid balance" is reconstructed from parts and is a FLOOR, not the amount.
 * Capping against a floor would refuse legitimate deposits on exactly the jobs
 * that most need one, so the cap is skipped and the caller is warned instead.
 */
export function checkDepositAgainstBalance(amountCents: number, ctx: BalanceContext): DepositAmountCheck {
  const warnings: string[] = []

  if (ctx.authorizedNotCapturedCents && ctx.authorizedNotCapturedCents > 0) {
    warnings.push(
      `This booking already has ${formatCents(ctx.authorizedNotCapturedCents)} authorized (held, not captured). ` +
        'Taking a deposit as well will collect money twice unless that hold is released.'
    )
  }

  if (ctx.unpaidBalanceCents == null) {
    return { ok: true, warning: warnings.join(' ') || undefined }
  }

  if (ctx.quoteMissing) {
    warnings.push(
      `This booking has no accepted quote total, so ${formatCents(ctx.unpaidBalanceCents)} is a minimum, not the full balance. The unpaid-balance cap is not enforced.`
    )
    return { ok: true, warning: warnings.join(' ') }
  }

  if (amountCents > ctx.unpaidBalanceCents) {
    return {
      ok: false,
      error:
        ctx.unpaidBalanceCents <= 0
          ? 'This booking has no unpaid balance — there is nothing left to collect.'
          : `Deposit cannot exceed the unpaid balance of ${formatCents(ctx.unpaidBalanceCents)}.`,
    }
  }

  return { ok: true, warning: warnings.join(' ') || undefined }
}

// ── Customer message ────────────────────────────────────────────────────────

/** First name only — the greeting on the page and in the copied message. */
export function firstNameOf(fullName?: string | null): string | null {
  const first = (fullName ?? '').trim().split(/\s+/)[0]
  return first ? first : null
}

/**
 * The message the owner pastes into Messenger or a text. Exact wording is the
 * owner's; only the three values are substituted.
 */
export function customerDepositMessage(opts: {
  customerName?: string | null
  amountCents: number
  url: string
}): string {
  const name = firstNameOf(opts.customerName) ?? 'there'
  return (
    `Hi ${name}, you can securely pay the ${formatCents(opts.amountCents)} deposit for your move here: ${opts.url}. ` +
    'This deposit will be applied toward your remaining balance.'
  )
}

// ── Expiry ──────────────────────────────────────────────────────────────────

/** Parse an admin-supplied expiry. Must be in the future and within a year. */
export function parseExpiry(input: unknown, now: Date = new Date()): { ok: true; at: Date | null } | { ok: false; error: string } {
  if (input == null || input === '') return { ok: true, at: null }
  if (typeof input !== 'string') return { ok: false, error: 'Invalid expiration' }
  const at = new Date(input)
  if (Number.isNaN(at.getTime())) return { ok: false, error: 'Invalid expiration' }
  if (at.getTime() <= now.getTime()) return { ok: false, error: 'Expiration must be in the future' }
  if (at.getTime() > now.getTime() + 365 * 24 * 60 * 60 * 1000) return { ok: false, error: 'Expiration cannot be more than a year out' }
  return { ok: true, at }
}

// ── Public page view model ──────────────────────────────────────────────────

export type DepositRowLike = {
  publicToken: string
  customerName?: string | null
  quoteTotalCents?: number | null
  balanceBeforeCents?: number | null
  amountCents: number
  amountPaidCents?: number | null
  serviceSummary?: string | null
  moveDate?: Date | null
  status: string
  expiresAt?: Date | null
  paidAt?: Date | null
}

export type PublicDepositView = {
  token: string
  status: DepositStatus
  firstName: string | null
  serviceSummary: string | null
  moveDate: Date | null
  /** null ⇒ the section is HIDDEN, never rendered as $0.00. */
  quoteTotalCents: number | null
  depositCents: number
  remainingCents: number | null
  amountPaidCents: number | null
  paidAt: Date | null
  showsBalance: boolean
}

/**
 * THE projection for the public page. Built by PICKING fields, the same posture
 * as booking-projections.ts — an address, an email, a phone number or a booking
 * number can never reach the page by being added to the model later.
 */
export function publicDepositView(row: DepositRowLike, now: Date = new Date()): PublicDepositView {
  const status = effectiveStatus(row, now)
  // Once paid, the remaining balance is stated against what was ACTUALLY
  // captured, not what was asked for. They are the same in every normal case;
  // where they differ, the captured amount is the truth.
  const applied = status === 'PAID' ? row.amountPaidCents ?? row.amountCents : row.amountCents
  const remaining = remainingAfterCents({
    quoteTotalCents: row.quoteTotalCents,
    balanceBeforeCents: row.balanceBeforeCents,
    amountCents: applied,
  })
  return {
    token: row.publicToken,
    status,
    firstName: firstNameOf(row.customerName),
    serviceSummary: row.serviceSummary?.trim() || null,
    moveDate: row.moveDate ?? null,
    quoteTotalCents: row.quoteTotalCents ?? null,
    depositCents: row.amountCents,
    remainingCents: remaining,
    amountPaidCents: row.amountPaidCents ?? null,
    paidAt: row.paidAt ?? null,
    showsBalance: remaining != null,
  }
}

// ── The confirmed-payment gate ──────────────────────────────────────────────

export type SessionLike = {
  payment_status?: string | null
  amount_total?: number | null
}

export type ConfirmedSession =
  | { confirmed: true; amountCents: number }
  | { confirmed: false; reason: string }

/**
 * Is this Checkout Session a CONFIRMED payment?
 *
 * `checkout.session.completed` does NOT mean paid. For a delayed payment method
 * (ACH and friends) Stripe fires it with payment_status `unpaid` and confirms
 * later with `checkout.session.async_payment_succeeded`. Treating "completed"
 * as "paid" would credit a booking — and notify the owner — for money that had
 * not moved and might never move.
 *
 * `no_payment_required` is refused too: a zero-amount session is not a deposit.
 *
 * Pure, so this rule is testable without Stripe, a database or a network.
 */
export function isConfirmedDepositSession(session: SessionLike): ConfirmedSession {
  if (session.payment_status !== 'paid') {
    return { confirmed: false, reason: `payment_status=${session.payment_status ?? 'missing'}` }
  }
  const amount = session.amount_total
  if (amount == null || !Number.isInteger(amount) || amount <= 0) {
    // Never guess an amount. Recording the requested figure when Stripe did not
    // report one would put an unverified number in the ledger.
    return { confirmed: false, reason: 'missing amount_total' }
  }
  return { confirmed: true, amountCents: amount }
}

// ── Display helpers (shared by the page, the admin list and the embed) ──────

const TIMEZONE = 'America/New_York'

/** "August 16, 2026" in the company's local timezone. */
export function formatMoveDate(d: Date | null | undefined, timeZone = TIMEZONE): string | null {
  if (!d) return null
  return d.toLocaleDateString('en-US', { timeZone, month: 'long', day: 'numeric', year: 'numeric' })
}

/** "Aug 15, 2026 at 3:04 PM ET" — used for the confirmed-payment time. */
export function formatPaymentTime(d: Date | null | undefined, timeZone = TIMEZONE): string | null {
  if (!d) return null
  return `${d.toLocaleString('en-US', {
    timeZone,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })} ET`
}
