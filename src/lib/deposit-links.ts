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
import { formatMoveDateLong, formatMoveWhen, parseEtDateTimeLocal } from './move-date'

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

// formatCents now lives in deposit-copy.ts so the CLIENT payment page can use
// it without pulling node:crypto (below) into the browser bundle. Re-exported
// here so every existing server caller and test keeps one import path.
import { formatCents } from './deposit-copy'
export { formatCents }


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

/**
 * What the customer has ALREADY paid toward this job before today's deposit.
 *
 * WHY THIS EXISTS: `quoteTotalCents` is the booking's final billed total, while
 * `balanceBeforeCents` is what was still OUTSTANDING when the link was made —
 * and `outstanding = finalBilled - collected`. On any approved booking the $49
 * hold has already been captured, so the two differ, and the page was printing
 * three numbers that did not subtract:
 *
 *     Quote total              $495.00
 *     Deposit due today         $49.00
 *     Remaining after deposit  $397.00      <- $495 - $49 = $446, not $397
 *
 * The missing $49 was real money the customer had already paid, with nothing on
 * the page to account for it. Naming it turns an apparent arithmetic error into
 * a statement of fact.
 *
 * Returns null when there is nothing to state: no quote, no recorded balance, or
 * the two agree (nothing collected yet). Never negative — a balance LARGER than
 * the total is a data problem, not a payment, and inventing a negative "already
 * paid" row would be worse than staying quiet.
 */
export function alreadyPaidCents(b: BalanceInput): number | null {
  const { quoteTotalCents: total, balanceBeforeCents: before } = b
  if (total == null || before == null) return null
  const diff = total - before
  return diff > 0 ? diff : null
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

/**
 * Parse an admin-supplied DEPOSIT LINK expiry. Must be in the future and within
 * a year.
 *
 * THIS IS THE LINK'S EXPIRY, NOT THE MOVE DATE. The two are independent facts
 * and are deliberately parsed by different functions with different rules: a
 * move date is a CALENDAR DATE (`parseCalendarDate`), while an expiry is a real
 * INSTANT — a moment at which the link stops taking money.
 *
 * The wall clock is EASTERN, because that is the clock the owner is reading
 * when he picks it. `new Date(input)` used to be used here, which parses an
 * offset-less "2026-08-22T23:00" in the SERVER's timezone — UTC in production —
 * and killed links four to five hours early. See move-date.ts.
 */
export function parseExpiry(input: unknown, now: Date = new Date()): { ok: true; at: Date | null } | { ok: false; error: string } {
  if (input == null || input === '') return { ok: true, at: null }
  if (typeof input !== 'string') return { ok: false, error: 'Invalid expiration' }
  const at = parseEtDateTimeLocal(input)
  if (!at || Number.isNaN(at.getTime())) return { ok: false, error: 'Invalid expiration' }
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
  moveDetails?: string[] | null
  customerNote?: string | null
  moveDate?: Date | null
  moveTimeMinutes?: number | null
  status: string
  expiresAt?: Date | null
  paidAt?: Date | null
}

export type PublicDepositView = {
  token: string
  status: DepositStatus
  firstName: string | null
  /** One short customer-facing line, e.g. "Labor-Only Move · 2 Movers". */
  serviceSummary: string | null
  /** Short customer-facing bullets. ALWAYS an array — never a paragraph. */
  moveDetails: string[]
  /** The one thing the customer has to do before move day, or null. */
  customerNote: string | null
  moveDate: Date | null
  /** Minutes after midnight Eastern, or null when no time was recorded. */
  moveTimeMinutes: number | null
  /** null ⇒ the section is HIDDEN, never rendered as $0.00. */
  quoteTotalCents: number | null
  /** Money already collected on this job before today's deposit, or null. */
  alreadyPaidCents: number | null
  depositCents: number
  remainingCents: number | null
  amountPaidCents: number | null
  paidAt: Date | null
  showsBalance: boolean
}

// ── Customer-facing text hygiene ────────────────────────────────────────────
//
// The owner types these into an admin form on a phone, mid-conversation. What
// arrives can carry newlines, tabs, doubled spaces and stray control bytes from
// a paste out of Messenger — none of which belong in a layout that has to hold
// together at 320px.

/** Collapse whitespace, strip control bytes, trim. Empty ⇒ null. */
export function cleanCustomerText(value: unknown, maxLen: number): string | null {
  if (typeof value !== 'string') return null
  const flat = value.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!flat) return null
  return flat.length > maxLen ? flat.slice(0, maxLen).trimEnd() : flat
}

/** How many bullets the customer-facing detail list may hold, and how long each may be. */
export const MAX_MOVE_DETAILS = 6
export const MAX_MOVE_DETAIL_LEN = 90
export const MAX_SERVICE_SUMMARY_LEN = 80
export const MAX_CUSTOMER_NOTE_LEN = 160

/**
 * Free text (one bullet per line, as typed in the admin textarea) → the stored
 * array. Bounded on BOTH axes so no admin entry can produce the wall of text
 * this feature was reported for: at most `MAX_MOVE_DETAILS` bullets, each at
 * most `MAX_MOVE_DETAIL_LEN` characters. Leading "-" / "*" / "•" bullets people
 * type by hand are stripped so the page does not render a double bullet.
 */
export function parseMoveDetails(value: unknown): string[] {
  const lines =
    Array.isArray(value) ? value
    : typeof value === 'string' ? value.split(/\r?\n/)
    : []
  const out: string[] = []
  for (const line of lines) {
    if (typeof line !== 'string') continue
    const stripped = line.replace(/^\s*[-*•·]\s*/, '')
    const clean = cleanCustomerText(stripped, MAX_MOVE_DETAIL_LEN)
    if (clean) out.push(clean)
    if (out.length >= MAX_MOVE_DETAILS) break
  }
  return out
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
    // Re-cleaned on the way OUT as well as on the way in. Rows written before
    // the bullets existed hold whatever the single free-text field held, and a
    // projection that trusts its input is how the paragraph got onto the page
    // the first time.
    moveDetails: parseMoveDetails(row.moveDetails ?? []),
    customerNote: cleanCustomerText(row.customerNote, MAX_CUSTOMER_NOTE_LEN),
    moveDate: row.moveDate ?? null,
    moveTimeMinutes:
      row.moveTimeMinutes != null && Number.isInteger(row.moveTimeMinutes) && row.moveTimeMinutes >= 0 && row.moveTimeMinutes <= 1439
        ? row.moveTimeMinutes
        : null,
    quoteTotalCents: row.quoteTotalCents ?? null,
    alreadyPaidCents: alreadyPaidCents({
      quoteTotalCents: row.quoteTotalCents,
      balanceBeforeCents: row.balanceBeforeCents,
      amountCents: applied,
    }),
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

/**
 * "Saturday, August 22, 2026".
 *
 * DELEGATES to move-date.ts, which is THE authority on what calendar day a
 * stored move date is. This function used to do
 * `d.toLocaleDateString('en-US', { timeZone: 'America/New_York', … })`, which
 * is what printed "August 21" for a move booked on Saturday the 22nd: a
 * date-only value stored at 00:00 UTC is the previous evening in Eastern.
 *
 * Every surface that shows a move date — this page, the Discord card, the admin
 * list — goes through here, so they cannot disagree about the day.
 */
export function formatMoveDate(d: Date | null | undefined, _timeZone = TIMEZONE): string | null {
  return formatMoveDateLong(d, 'en')
}

/** "Saturday, August 22 · 7:00 AM" when a time is known, the long date when not. */
export function formatMoveWhenEn(d: Date | null | undefined, timeMinutes?: number | null): string | null {
  return formatMoveWhen(d, timeMinutes ?? null, 'en')
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
