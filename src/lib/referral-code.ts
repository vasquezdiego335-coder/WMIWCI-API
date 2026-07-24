// ════════════════════════════════════════════════════════════════════════
//  SIGNED REFERRAL CODES (Phase 9 — the simple/affordable slice).
//  A deterministic, tamper-evident per-customer referral code — no database,
//  no new route, no infra. `signReferralCode(customerId)` derives the same code
//  every time for a given customer; `verifyReferralCode(code, customerId)`
//  confirms a code was issued to that customer without storing anything.
//
//  This is the CHEAP, foundational part. Full redemption ENFORCEMENT (mapping an
//  entered code back to the referrer and crediting the reward) still needs a DB
//  field + a redemption route — that backend work is intentionally NOT here.
//  Until then, senders can already ship a real, forgery-detectable per-customer
//  code (via the referral / referral-reward `referralCode` prop) instead of a
//  shared static code.
// ════════════════════════════════════════════════════════════════════════
import { createHmac, timingSafeEqual } from 'node:crypto'

const PREFIX = 'MIC'
// Crockford-ish base32 (no I/O/0/1) — short and unambiguous to read/type aloud.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
const CODE_LEN = 6

function secret(): string {
  const s = process.env.REFERRAL_SECRET
  if (!s) throw new Error('REFERRAL_SECRET is not set')
  return s
}

/** hex → CODE_LEN chars of the unambiguous alphabet (deterministic). */
function encode(hex: string): string {
  let out = ''
  for (let i = 0; i < CODE_LEN; i++) {
    const byte = parseInt(hex.slice(i * 2, i * 2 + 2) || '0', 16)
    out += ALPHABET[byte % ALPHABET.length]
  }
  return out
}

/** The deterministic, tamper-evident referral code for a customer. */
export function signReferralCode(customerId: string, opts?: { prefix?: string }): string {
  if (!customerId) throw new Error('customerId required')
  const mac = createHmac('sha256', secret()).update(`referral:v1:${customerId}`).digest('hex')
  return `${opts?.prefix ?? PREFIX}-${encode(mac)}`
}

/** Shape check only (no secret): PREFIX-XXXXXX in the code alphabet. */
export function isWellFormedReferralCode(code: string | undefined | null, prefix = PREFIX): boolean {
  if (!code) return false
  const re = new RegExp(`^${prefix}-[${ALPHABET}]{${CODE_LEN}}$`)
  return re.test(code.trim().toUpperCase())
}

/**
 * True iff `code` is the code issued to `customerId`. Constant-time compare;
 * never throws (a missing secret / bad input → false).
 */
export function verifyReferralCode(code: string | undefined | null, customerId: string): boolean {
  if (!code || !customerId) return false
  let expected: string
  try {
    expected = signReferralCode(customerId)
  } catch {
    return false
  }
  const a = Buffer.from(code.trim().toUpperCase())
  const b = Buffer.from(expected.toUpperCase())
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

// ════════════════════════════════════════════════════════════════════════
//  REDEMPTION URL (owner request 2026-07-24)
//  ---------------------------------------------------------------------
//  `referral-reward` declares `redeemUrl` as a REQUIRED link, but nothing ever
//  produced one — so the template defaulted to '#', assertEmailPayload refused
//  it ("unparseable URL"), and the email could never be sent. This builds the
//  real link.
//
//  It points at the BOOKING FORM on the marketing site (not APP_URL, which is
//  the API backend): redeeming a reward means booking the next move. The base
//  comes from MARKETING_SITE_URL — the same env var followups.ts already uses
//  for its book link — so nothing is hard-coded to one host.
//
//  The reward code travels as `?code=`, which the booking form reads to prefill
//  its coupon field. `src=referral_reward` preserves attribution through the
//  existing ?src= pipeline. Codes are uppercased to match the form's input.
//
//  NOTE ON ENFORCEMENT (unchanged, and deliberately so): as the header above
//  states, a code is tamper-EVIDENT, not self-enforcing. The team still
//  verifies it at booking review before any card is charged — which is exactly
//  what the coupon note on the form promises the customer.
// ════════════════════════════════════════════════════════════════════════

/** Marketing-site base, trailing slash stripped. Mirrors followups.ts BOOK_URL. */
function marketingBase(): string {
  return (process.env.MARKETING_SITE_URL?.trim() || 'https://www.moveitclearit.com').replace(/\/+$/, '')
}

/**
 * The CTA link for a referral reward email: the booking form, carrying the
 * reward code and referral attribution. Always an absolute https URL, so it
 * satisfies the email link validator.
 */
export function referralRedeemUrl(rewardCode?: string | null): string {
  const base = marketingBase()
  const params = new URLSearchParams({ src: 'referral_reward' })
  const code = (rewardCode ?? '').trim().toUpperCase()
  if (code) params.set('code', code)
  return `${base}/booking-form.html?${params.toString()}`
}
