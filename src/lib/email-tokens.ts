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

export type TokenPurpose = 'unsubscribe' | 'preferences'

/**
 * Default token lifetime. Long, because an unsubscribe link in an email a
 * customer opens a year later MUST still work (that is a legal expectation,
 * not a convenience) — but not infinite, so a leaked link eventually dies.
 */
export const DEFAULT_MAX_AGE_MS = 400 * 24 * 60 * 60 * 1000 // ~13 months

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
