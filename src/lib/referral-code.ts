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
