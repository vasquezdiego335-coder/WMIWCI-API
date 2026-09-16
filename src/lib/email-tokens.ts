// ════════════════════════════════════════════════════════════════════════
//  SIGNED EMAIL TOKENS (HMAC-SHA256) — owner spec 2026-07-20.
//  ---------------------------------------------------------------------
//  The unsubscribe link must work with no login and must NOT be guessable.
//  Putting a customer id (or worse, an email) in the URL lets anyone
//  unsubscribe anyone by iterating ids — so the address is bound to an HMAC
//  and only a link WE generated is accepted.
//
//  Token format:  base64url(payload) "." base64url(HMAC_SHA256(secret, payload))
//  payload      :  "<version>:<purpose>:<email>:<issuedAtMs>"
//
//  Verification is CONSTANT-TIME and fails CLOSED (null) on any tamper.
//  Pure + dependency-free (node:crypto) + unit-tested offline.
//
//  This is the TypeScript twin of Leadtracking's backend/lib/unsub-token.js.
//  The two systems deliberately do NOT share tokens (different secrets and
//  different subjects — lead id there, email here); cross-system suppression
//  happens through the shared suppression API, not through shared tokens.
// ════════════════════════════════════════════════════════════════════════

import crypto from 'node:crypto'

/** Bump when the payload shape changes — old tokens then fail closed. */
const TOKEN_VERSION = 'v1'

export type TokenPurpose = 'unsubscribe' | 'preferences' | 'resubscribe'

/**
 * Default token lifetime. Long, because an unsubscribe link in an email a
 * customer opens a year later MUST still work (that is a legal expectation,
 * not a convenience) — but not infinite, so a leaked link eventually dies.
 */
export const DEFAULT_MAX_AGE_MS = 400 * 24 * 60 * 60 * 1000 // ~13 months

// ════════════════════════════════════════════════════════════════════════
//  PURPOSE TOKENS THAT GRANT PERMISSION (email consent release 2026-09-16,
//  DESIGN-v2 §4 and §8)
//  ---------------------------------------------------------------------
//  An unsubscribe token only ever WITHDRAWS, so it may live ~13 months in an
//  inbox and be forwarded around harmlessly. A token that GRANTS permission
//  must not: the old "keep me subscribed" button accepted that same 13-month
//  unsubscribe token, so anybody holding a forwarded promotional email could
//  resubscribe its owner. Granting now needs its own purpose, and each purpose
//  has a short, fixed lifetime:
//
//    'resubscribe' — minted ONLY on the page shown right after an unsubscribe
//                    POST, valid ~1 hour, accepted ONLY by POST.
//  (A popup 'confirm' purpose existed briefly and was removed with the popup's
//  confirmation step, owner direction 2026-09-16.)
//
//  SINGLE USE. A token cannot remember that it was spent, so single use is
//  enforced by the database: `purposeTokenUseId(token)` is a stable id for one
//  minted token, and a flow uses it as the consent event's request id. UNIQUE
//  (request_id, kind) on email_consent_events then records the grant once, and
//  a replay comes back `created: false` — which the flow must treat as "already
//  used" and refuse to act on again.
// ════════════════════════════════════════════════════════════════════════

/** How long a resubscribe token from the unsubscribe confirmation page lives. */
export const RESUBSCRIBE_TOKEN_MAX_AGE_MS = 60 * 60 * 1000

/** The fixed lifetime of each purpose. A caller cannot widen it. */
export const PURPOSE_MAX_AGE_MS: Record<TokenPurpose, number> = {
  unsubscribe: DEFAULT_MAX_AGE_MS,
  preferences: DEFAULT_MAX_AGE_MS,
  resubscribe: RESUBSCRIBE_TOKEN_MAX_AGE_MS,
}

/** Purposes that GRANT permission. They never accept an unlimited max age. */
export const GRANTING_PURPOSES: readonly TokenPurpose[] = ['resubscribe']

export class EmailTokenError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EmailTokenError'
  }
}

/**
 * The signing secret. Prefers an explicit EMAIL_TOKEN_SECRET; falls back to a
 * value DERIVED from the Resend key so a half-configured environment still
 * produces stable tokens. Never a hardcoded literal secret in production.
 */
function secret(): string {
  const explicit = process.env.EMAIL_TOKEN_SECRET?.trim()
  if (explicit) return explicit

  const resendKey = process.env.RESEND_API_KEY?.trim()
  if (resendKey && resendKey !== 're_placeholder') {
    return crypto.createHash('sha256').update(`email-token:${resendKey}`).digest('hex')
  }

  if (process.env.NODE_ENV === 'production') {
    // Fail loudly rather than sign production links with a known dev secret.
    throw new EmailTokenError(
      'EMAIL_TOKEN_SECRET is not set (and RESEND_API_KEY is a placeholder) — refusing to sign email tokens in production'
    )
  }
  return 'insecure-dev-email-token-secret'
}

/** True when a real (non-fallback) secret is configured. Used by health checks. */
export function isTokenSecretConfigured(): boolean {
  const explicit = process.env.EMAIL_TOKEN_SECRET?.trim()
  if (explicit) return true
  const resendKey = process.env.RESEND_API_KEY?.trim()
  return Boolean(resendKey && resendKey !== 're_placeholder')
}

const b64url = (buf: Buffer | string): string =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const fromB64url = (s: string): string =>
  Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')

function hmac(payload: string): string {
  return b64url(crypto.createHmac('sha256', secret()).update(payload).digest())
}

/** Canonical address form. Every suppression lookup uses this — one spelling. */
export function normalizeEmail(email: string): string {
  return String(email ?? '').trim().toLowerCase()
}

/**
 * Sign a token binding an email address to a purpose.
 * @param issuedAt override for tests; defaults to now.
 */
export function signToken(email: string, purpose: TokenPurpose = 'unsubscribe', issuedAt = Date.now()): string {
  const normalized = normalizeEmail(email)
  if (!normalized) throw new EmailTokenError('cannot sign a token for a blank email')
  // ':' is the field separator, so an address containing one would be ambiguous.
  // Addresses cannot legally contain ':' unquoted; reject rather than mis-parse.
  if (normalized.includes(':')) throw new EmailTokenError('unsupported character in email address')

  const payload = `${TOKEN_VERSION}:${purpose}:${normalized}:${issuedAt}`
  return `${b64url(payload)}.${hmac(payload)}`
}

export type VerifiedToken = { email: string; purpose: TokenPurpose; issuedAt: number }

/**
 * Verify a token. Returns the bound address, or null when the token is
 * missing, malformed, tampered with, for the wrong purpose, or expired.
 * NEVER throws on bad input — callers treat null as "invalid link".
 */
export function verifyToken(
  token: string | null | undefined,
  purpose: TokenPurpose = 'unsubscribe',
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  now = Date.now()
): VerifiedToken | null {
  if (!token || typeof token !== 'string') return null
  const dot = token.indexOf('.')
  if (dot <= 0 || dot === token.length - 1) return null

  const payloadPart = token.slice(0, dot)
  const macPart = token.slice(dot + 1)

  let payload: string
  try {
    payload = fromB64url(payloadPart)
  } catch {
    return null
  }

  // Constant-time compare. Length mismatch short-circuits (timingSafeEqual throws
  // on unequal lengths), which leaks only the MAC length — a fixed constant.
  const expected = hmac(payload)
  const a = Buffer.from(macPart)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null

  const parts = payload.split(':')
  if (parts.length !== 4) return null
  const [version, tokenPurpose, email, issuedAtRaw] = parts
  if (version !== TOKEN_VERSION) return null
  if (tokenPurpose !== purpose) return null
  if (!email) return null

  const issuedAt = Number(issuedAtRaw)
  if (!Number.isFinite(issuedAt) || issuedAt <= 0) return null
  // Reject far-future issue times (clock skew tolerance: 1 day).
  if (issuedAt > now + 24 * 60 * 60 * 1000) return null
  if (maxAgeMs > 0 && now - issuedAt > maxAgeMs) return null

  return { email, purpose: tokenPurpose as TokenPurpose, issuedAt }
}

/**
 * Verify a token at its purpose's FIXED lifetime. The only verifier a
 * permission-granting flow (resubscribe) may use: `verifyToken` lets a
 * caller pass maxAge 0 (no expiry), which must never apply to a grant.
 */
export function verifyPurposeToken(
  token: string | null | undefined,
  purpose: TokenPurpose,
  now = Date.now()
): VerifiedToken | null {
  const maxAge = PURPOSE_MAX_AGE_MS[purpose]
  if (!(maxAge > 0)) return null
  return verifyToken(token, purpose, maxAge, now)
}

/**
 * A stable id for ONE minted token: `<purpose>:<sha256 of its verified content, hex>`.
 * Use it as the consent event request id so UNIQUE (request_id, kind) makes the
 * token single-use. Null for a token that does not verify for `purpose`, so an
 * invalid token can never occupy a real one's id.
 *
 * Hashed from the VERIFIED payload, never the raw string: base64 decoding is
 * lenient — `payload=`, `payload==` or a stray non-alphabet character decode to
 * the same payload and verify — so hashing the string let one minted token
 * produce several different ids and be spent more than once.
 */
export function purposeTokenUseId(token: string | null | undefined, purpose: TokenPurpose, now = Date.now()): string | null {
  const verified = verifyPurposeToken(token, purpose, now)
  if (!verified) return null
  const canonical = `${TOKEN_VERSION}:${verified.purpose}:${verified.email}:${verified.issuedAt}`
  return `${purpose}:${crypto.createHash('sha256').update(canonical).digest('hex')}`
}

/** Absolute base URL for public email links. Trailing slashes stripped. */
function appBase(): string | null {
  const base = process.env.APP_URL?.trim()
  if (!base) return null
  return base.replace(/\/+$/, '')
}

/**
 * Build the one-click unsubscribe URL for an address.
 * Returns null when APP_URL is unset — callers then omit the link rather than
 * ship a `#` placeholder (which the send-time URL gate would block anyway).
 */
export function unsubscribeUrl(email: string): string | null {
  const base = appBase()
  if (!base) return null
  try {
    return `${base}/api/email/unsubscribe?token=${encodeURIComponent(signToken(email, 'unsubscribe'))}`
  } catch {
    return null
  }
}

/**
 * The "keep me subscribed" form action for an address that has JUST
 * unsubscribed. A relative path on purpose: it is only ever rendered on this
 * app's own confirmation page, never put in an email. POST only; ~1 hour.
 */
export function resubscribeActionPath(email: string, issuedAt = Date.now()): string | null {
  try {
    return `/api/email/unsubscribe?action=resubscribe&token=${encodeURIComponent(signToken(email, 'resubscribe', issuedAt))}`
  } catch {
    return null
  }
}

/** Build the preference-centre URL for an address (same route, manage view). */
export function preferencesUrl(email: string): string | null {
  const base = appBase()
  if (!base) return null
  try {
    return `${base}/api/email/preferences?token=${encodeURIComponent(signToken(email, 'preferences'))}`
  } catch {
    return null
  }
}
