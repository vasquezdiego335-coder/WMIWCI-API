// ════════════════════════════════════════════════════════════════════════
//  GRANT SAFEGUARDS — may this submission be GIVEN a marketing basis?
//  (email consent release 2026-09-16, DESIGN-v2 §6)
//  ---------------------------------------------------------------------
//  FAIL CLOSED FOR MARKETING, FAIL SOFT FOR THE CUSTOMER. Every check here only
//  decides whether a notice is recorded as a grant or as `basis_withheld`. The
//  lead is still saved and transactional mail still goes out either way;
//  nothing in this file may block a capture.
//
//  WHY THIS EXISTS. Every capture route is anonymous. Anyone can type anyone's
//  address, and the existing rate limits are fail-open without Upstash — in
//  production they limited nothing. So the grant itself is throttled, backed by
//  Postgres (counting email_consent_events), NOT Upstash and NOT ioredis inside
//  a Next route (REDIS_URL is not available at build time):
//    • per client IP (HMAC; IPv6 grouped by /64): at most 5 distinct addresses
//      granted per 24h — a household or office sharing one connection fits,
//      a script typing strangers' addresses does not
//    • global breaker: 100 distinct granted addresses in 24h withholds every
//      NEW address and posts ONE ops alert (a repeat submission from someone
//      already granted is never counted twice)
//    • popup breaker: 30 distinct popup addresses in 24h, so popup spam can
//      never use up the budget quote and booking customers need
//  Each limit is read from the environment at call time (blank or invalid =
//  the default, never 0): CONSENT_IP_DISTINCT_EMAILS_24H,
//  CONSENT_GLOBAL_GRANTS_24H, CONSENT_POPUP_GRANTS_24H.
//  Duplicate sequences are NOT a grant question: the enrollment claim decides
//  (journeys.claimEnrollment + the sequence_enrollments unique key).
//  plus Turnstile when configured, the honeypot, test/staff/role identities,
//  and — on the booking form — proof the address was typed on this page load.
//
//  The counts are check-then-insert and therefore soft under a burst; that is
//  acceptable because the per-person enrollment is a hard unique constraint
//  and the limits exist to bound abuse, not to be exact.
// ════════════════════════════════════════════════════════════════════════

import { createHash, createHmac } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import { prisma } from '../db'
import { normalizeEmail } from '../email-tokens'
import { postOpsAlert, type AlertLine } from '../ops-alert'
import { GRANT_EVENT_KINDS, isPlausibleEmail, type RegionSignal } from './consent-events'
import type { NoticeSurface, SequenceKind } from './notice-registry'
import { testIdentityReason, type TestIdentityReason } from './test-identity'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

/** The DEFAULT limits; grantLimits(env) is what evaluateGrantSafeguards uses. */
export const GRANT_LIMITS = {
  /** Distinct addresses one client IP (IPv6: its /64) may be granted, per 24h. */
  perIpDistinctEmails24h: 5,
  /** Distinct addresses granted across everyone per 24h before the breaker withholds new ones. */
  globalGrants24h: 100,
  /** Distinct addresses granted through the popup per 24h before popup grants are withheld. */
  popupGrants24h: 30,
} as const

export type GrantLimits = { perIpDistinctEmails24h: number; globalGrants24h: number; popupGrants24h: number }

/** A positive integer from an environment value, or the default (blank, invalid, 0 or negative). */
function limitFromEnv(value: string | undefined, fallback: number): number {
  const raw = value?.trim()
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isInteger(n) && n >= 1 ? n : fallback
}

/** The limits in force, read at call time so a Railway variable change needs no code change. */
export function grantLimits(env: Env = process.env): GrantLimits {
  return {
    perIpDistinctEmails24h: limitFromEnv(env.CONSENT_IP_DISTINCT_EMAILS_24H, GRANT_LIMITS.perIpDistinctEmails24h),
    globalGrants24h: limitFromEnv(env.CONSENT_GLOBAL_GRANTS_24H, GRANT_LIMITS.globalGrants24h),
    popupGrants24h: limitFromEnv(env.CONSENT_POPUP_GRANTS_24H, GRANT_LIMITS.popupGrants24h),
  }
}

/** Siteverify is bounded: a slow Cloudflare must not hold a customer's submit. */
export const TURNSTILE_TIMEOUT_MS = 3000
export const TURNSTILE_SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

export const WITHHELD_REASONS = [
  'notice_basis_disabled',
  'offer_signup_disabled',
  'unknown_notice_version',
  'honeypot',
  'invalid_email',
  'role_address',
  'reserved_address',
  'test_identity',
  'email_not_user_typed',
  'turnstile_failed',
  'ip_unavailable',
  'already_enrolled',
  'ip_throttle',
  'global_breaker',
  'popup_breaker',
  'throttle_read_failed',
] as const
export type WithheldReason = (typeof WITHHELD_REASONS)[number]

type Env = Record<string, string | undefined>

// ── FLAGS (all default OFF) ─────────────────────────────────────────────────

/** EMAIL_NOTICE_BASIS_ENABLED === 'true'. Off = no notice basis is granted OR honoured. */
export function noticeBasisEnabled(env: Env = process.env): boolean {
  return env.EMAIL_NOTICE_BASIS_ENABLED === 'true'
}

/** OFFER_SIGNUP_ENABLED === 'true'. Off = the popup route answers 404 and grants nothing. */
export function offerSignupEnabled(env: Env = process.env): boolean {
  return env.OFFER_SIGNUP_ENABLED === 'true'
}

/**
 * Turnstile is required only when it is SWITCHED ON: TURNSTILE_ENABLED ===
 * 'true' (the switch .env.example and DEPLOY.md already document), or
 * EMAIL_REQUIRE_TURNSTILE === 'true'. A key on its own is not a switch —
 * .env.example ships the keys with TURNSTILE_ENABLED=false as the inactive
 * state, and requiring a token no page sends would withhold every grant.
 * Switched on with a missing or wrong secret still fails closed at verification.
 */
export function turnstileRequired(env: Env = process.env): boolean {
  return env.TURNSTILE_ENABLED === 'true' || env.EMAIL_REQUIRE_TURNSTILE === 'true'
}

// ── TURNSTILE ───────────────────────────────────────────────────────────────

export type TurnstileResult = {
  ok: boolean
  reason: 'verified' | 'missing_token' | 'missing_secret' | 'rejected' | 'timeout' | 'network_error' | 'bad_response'
  errorCodes?: string[]
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
}>

/**
 * Verify a Turnstile token with Cloudflare siteverify. Never throws; any
 * failure — no token, no secret, timeout, network error, odd response — is
 * { ok: false } and therefore no basis.
 */
export async function verifyTurnstile(
  token: string | null | undefined,
  ip: string | null | undefined,
  opts: { fetch?: FetchLike; secret?: string; timeoutMs?: number; env?: Env } = {},
): Promise<TurnstileResult> {
  const env = opts.env ?? process.env
  const secret = (opts.secret ?? env.TURNSTILE_SECRET_KEY ?? '').trim()
  const response = typeof token === 'string' ? token.trim() : ''
  if (!response) return { ok: false, reason: 'missing_token' }
  if (!secret) return { ok: false, reason: 'missing_secret' }
  //  Cloudflare documents a 2048-character maximum token.
  if (response.length > 2048) return { ok: false, reason: 'rejected', errorCodes: ['invalid-input-response'] }

  const body = new URLSearchParams({ secret, response })
  if (ip && ip !== 'unknown') body.set('remoteip', ip)

  const doFetch: FetchLike = opts.fetch ?? (globalThis.fetch as unknown as FetchLike)
  const controller = new AbortController()
  const timeoutMs = opts.timeoutMs ?? TURNSTILE_TIMEOUT_MS
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  try {
    const res = await Promise.race([
      doFetch(TURNSTILE_SITEVERIFY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: controller.signal,
      }),
      //  A fetch implementation that ignores the abort signal still cannot hold
      //  the request past the timeout.
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(new Error('turnstile timeout')))
      }),
    ])
    if (!res.ok) return { ok: false, reason: 'bad_response' }
    const json = (await res.json()) as { success?: unknown; 'error-codes'?: unknown }
    if (!json || typeof json !== 'object' || typeof json.success !== 'boolean') return { ok: false, reason: 'bad_response' }
    const errorCodes = Array.isArray(json['error-codes']) ? json['error-codes'].map(String).slice(0, 5) : undefined
    return json.success ? { ok: true, reason: 'verified' } : { ok: false, reason: 'rejected', errorCodes }
  } catch {
    return { ok: false, reason: timedOut ? 'timeout' : 'network_error' }
  } finally {
    clearTimeout(timer)
  }
}

// ── CLIENT IDENTIFIERS ──────────────────────────────────────────────────────

/**
 * The client IP for consent throttling. Prefers X-Real-IP, then the LAST
 * X-Forwarded-For hop — the one our own edge appended — never the first, which
 * the client can write. (rate-limit.ts clientIp() uses the first entry, which
 * is why it is not reused here.) CONFIRM the header Railway's edge sets in
 * staging before relying on the per-IP limit; a proxy that hides the client
 * collapses every visitor into one IP, which fails CLOSED (grants withheld).
 */
export function consentClientIp(headers: { get(name: string): string | null }): string | null {
  const real = headers.get('x-real-ip')?.trim()
  if (real) return real.slice(0, 64)
  const hops = (headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean)
  return hops.length ? hops[hops.length - 1].slice(0, 64) : null
}

/**
 * HMAC-SHA256 of the IP under CONSENT_IP_HMAC_SECRET (falling back to
 * EMAIL_TOKEN_SECRET). A plain SHA-256 of an IPv4 address is reversible by
 * enumeration, so a keyed hash is used. Null when there is no IP or no secret —
 * and a null answer withholds the grant ('ip_unavailable').
 */
export function consentIpHmac(ip: string | null | undefined, env: Env = process.env): string | null {
  const value = consentIpKey(ip)
  if (!value) return null
  const secret = env.CONSENT_IP_HMAC_SECRET?.trim() || env.EMAIL_TOKEN_SECRET?.trim()
  if (!secret) return null
  return createHmac('sha256', secret).update(`consent-ip:${value}`).digest('hex').slice(0, 64)
}

/**
 * The part of an address that identifies one connection: IPv4 as is; an
 * IPv4-mapped IPv6 address as its IPv4; any other IPv6 address as its /64
 * network. A home or phone rotates the last 64 bits on its own, so keying the
 * full IPv6 address would both split one household and let a script rotate
 * past the per-IP limit. Null when there is no usable address.
 */
export function consentIpKey(ip: string | null | undefined): string | null {
  let value = typeof ip === 'string' ? ip.trim().toLowerCase() : ''
  if (!value || value === 'unknown') return null
  if (value.startsWith('[')) value = value.slice(1, value.indexOf(']') > 0 ? value.indexOf(']') : undefined)
  const zone = value.indexOf('%')
  if (zone >= 0) value = value.slice(0, zone)
  if (!value.includes(':')) return value
  const mapped = value.match(/^(?:0{0,4}:){0,5}(?:0{0,4}:)?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/) ?? value.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/)
  if (mapped) return mapped[1]
  const expanded = expandIpv6(value)
  if (!expanded) return value
  return `${expanded.slice(0, 4).join(':')}::/64`
}

/** Eight full hextets, or null when the text is not an IPv6 address. */
function expandIpv6(value: string): string[] | null {
  if (value.split('::').length > 2) return null
  const [head, tail] = value.includes('::') ? value.split('::') : [value, null]
  const parts = (s: string | null) => (s ? s.split(':') : [])
  const h = parts(head)
  const t = parts(tail)
  if ([...h, ...t].some((p) => !/^[0-9a-f]{1,4}$/.test(p))) return null
  const missing = 8 - h.length - t.length
  if (tail === null ? missing !== 0 : missing < 1) return null
  const full = [...h, ...Array(tail === null ? 0 : missing).fill('0'), ...t]
  return full.map((p) => p.padStart(4, '0'))
}

/** SHA-256 of the user agent, truncated. A UA is not secret; it is just bulky. */
export function hashUserAgent(ua: string | null | undefined): string | null {
  const value = typeof ua === 'string' ? ua.trim() : ''
  if (!value) return null
  return createHash('sha256').update(value.slice(0, 1000)).digest('hex').slice(0, 32)
}

// ── REGION SIGNAL ───────────────────────────────────────────────────────────

const CANADIAN_POSTAL = /^[abceghj-nprstvxy]\d[abceghj-nprstv-z] ?\d[abceghj-nprstv-z]\d$/i
const US_ZIP = /^\d{5}(-?\d{4})?$/

function phoneSignal(phone: string | null | undefined): RegionSignal {
  const raw = typeof phone === 'string' ? phone.trim() : ''
  if (!raw) return 'unknown'
  const digits = raw.replace(/\D/g, '')
  if (!digits) return 'unknown'
  if (raw.startsWith('+')) return digits.startsWith('1') ? 'nanp' : 'non_nanp'
  //  International dialling prefixes: 00 (most of the world), 011 (NANP).
  if (digits.startsWith('011') && digits.length > 11) return digits.charAt(3) === '1' ? 'nanp' : 'non_nanp'
  if (digits.startsWith('00') && digits.length > 10) return digits.charAt(2) === '1' ? 'nanp' : 'non_nanp'
  if (digits.length === 10) return 'nanp'
  if (digits.length === 11 && digits.startsWith('1')) return 'nanp'
  return 'unknown'
}

function postalSignal(postal: string | null | undefined): RegionSignal {
  const raw = typeof postal === 'string' ? postal.trim() : ''
  if (!raw) return 'unknown'
  if (US_ZIP.test(raw) || CANADIAN_POSTAL.test(raw)) return 'nanp'
  //  Letters in a postcode that is not Canadian (UK "SW1A 1AA", NL "1012 AB",
  //  IE "D02 X285") are clearly not US or Canadian.
  if (/[a-z]/i.test(raw)) return 'non_nanp'
  //  Digits in a non-ZIP punctuated shape: PT "1000-001", JP "100-0001", PL "00-950".
  if (/^\d+[- ]\d+$/.test(raw)) return 'non_nanp'
  //  Bare 4 or 6+ digits stay unknown: "7102" is usually a New Jersey ZIP that
  //  lost its leading zero in a spreadsheet, not an Australian postcode.
  return 'unknown'
}

/**
 * 'non_nanp' when ANY signal is positively outside the US/Canada numbering and
 * postal systems (a non-+1 phone, a clearly foreign postcode, a non-US/CA
 * country): no notice basis, express only. Otherwise 'nanp' when a phone or
 * postal code positively matches, else 'unknown' — and unknown is treated like
 * nanp under the uniform 6-month inquiry rule.
 */
export function deriveRegionSignal(input: {
  phone?: string | null
  postalCodes?: Array<string | null | undefined>
  country?: string | null
}): RegionSignal {
  const signals: RegionSignal[] = [phoneSignal(input.phone), ...(input.postalCodes ?? []).map(postalSignal)]
  const country = typeof input.country === 'string' ? input.country.trim().toUpperCase() : ''
  if (country) signals.push(country === 'US' || country === 'USA' || country === 'CA' || country === 'CAN' ? 'nanp' : 'non_nanp')
  if (signals.includes('non_nanp')) return 'non_nanp'
  if (signals.includes('nanp')) return 'nanp'
  return 'unknown'
}

// ── THE DECISION ────────────────────────────────────────────────────────────

/**
 * Every form records a NOTICE — the popup included (owner direction
 * 2026-09-16: no separate opt-in or confirmation step).
 */
export type GrantKind = 'notice'

export type GrantSafeguardInput = {
  grant: GrantKind
  /** The route-derived surface. The popup additionally needs OFFER_SIGNUP_ENABLED. */
  surface?: NoticeSurface
  email: string
  /** The sequence this grant would start (recorded; duplicates are the enrollment claim's job). */
  sequenceKind: SequenceKind | null
  /** From consentClientIp(), or the tracker's forwarded client IP (token-authenticated). */
  ip: string | null
  turnstileToken?: string | null
  /** The hidden 'company' field. Any value = a bot. */
  honeypot?: string | null
  emailUserTyped?: boolean | null
  /** True on the booking form (P2): the address must have been typed on this page load. */
  requireEmailUserTyped?: boolean
  now?: Date
}

export type GrantDecision =
  | { grant: true; turnstileOk: boolean | null; ipHmac: string }
  | { grant: false; reason: WithheldReason; turnstileOk: boolean | null; ipHmac: string | null; alerted?: boolean }

export type SafeguardDb = Pick<PrismaClient, 'emailConsentEvent' | 'sequenceEnrollment'>

export type GrantSafeguardDeps = {
  db?: SafeguardDb
  env?: Env
  fetch?: FetchLike
  /** Defaults to the existing ops alert (Discord). Must not throw. */
  alert?: (title: string, lines: AlertLine[]) => Promise<unknown>
  testIdentity?: (email: string) => Promise<TestIdentityReason | null>
}

/**
 * Decide whether a grant may be recorded. The caller records the result:
 * grant → notice_accepted with turnstileOk + ipHmac;
 * no grant → basis_withheld with `reason`. Never throws.
 */
export async function evaluateGrantSafeguards(input: GrantSafeguardInput, deps: GrantSafeguardDeps = {}): Promise<GrantDecision> {
  const env = deps.env ?? process.env
  const db = deps.db ?? prisma
  const now = input.now ?? new Date()
  let turnstileOk: boolean | null = null
  let ipHmac: string | null = null
  const withhold = (reason: WithheldReason, extra: { alerted?: boolean } = {}): GrantDecision => ({
    grant: false,
    reason,
    turnstileOk,
    ipHmac,
    ...extra,
  })

  // 1. The feature flag for this kind of grant. Default OFF.
  if (!noticeBasisEnabled(env)) return withhold('notice_basis_disabled')
  if (input.surface === 'popup' && !offerSignupEnabled(env)) return withhold('offer_signup_disabled')

  // 2. Cheap, local checks.
  if (typeof input.honeypot === 'string' && input.honeypot.trim() !== '') return withhold('honeypot')
  const email = normalizeEmail(input.email)
  if (!isPlausibleEmail(email)) return withhold('invalid_email')
  let identity: TestIdentityReason | null
  try {
    identity = await (deps.testIdentity ?? ((e: string) => testIdentityReason(e, { env })))(email)
  } catch {
    identity = 'staff_lookup_failed'
  }
  if (identity === 'role_account') return withhold('role_address')
  if (identity === 'reserved_domain') return withhold('reserved_address')
  if (identity) return withhold('test_identity')
  if (input.requireEmailUserTyped && input.emailUserTyped !== true) return withhold('email_not_user_typed')

  // 3. Turnstile, when required. A missing token or secret is a failure.
  if (turnstileRequired(env)) {
    const verdict = await verifyTurnstile(input.turnstileToken, input.ip, { fetch: deps.fetch, env })
    turnstileOk = verdict.ok
    if (!verdict.ok) return withhold('turnstile_failed')
  }

  // 4. The throttles need a keyed IP.
  ipHmac = consentIpHmac(input.ip, env)
  if (!ipHmac) return withhold('ip_unavailable')

  // 5. Postgres-backed throttles.
  try {
    //  NO per-address sequence throttle here (2026-09-16). Every genuine
    //  submission is recorded as the notice it is; whether it starts a SECOND
    //  sequence is decided atomically by the enrollment claim (one active copy
    //  per person, one per 30 days on a notice — journeys.claimEnrollment and
    //  the sequence_enrollments unique key). Withholding the notice here used to
    //  drop the person's latest submission from the record as well.

    const limits = grantLimits(env)
    const since24h = new Date(now.getTime() - DAY_MS)
    //  DISTINCT OTHER addresses: the person submitting again (a second form, a
    //  corrected typo resubmitted) never counts against their own limit.
    const distinctOthers = async (where: Record<string, unknown>, limit: number): Promise<number> => {
      const rows = await db.emailConsentEvent.findMany({
        where: { ...where, kind: { in: [...GRANT_EVENT_KINDS] }, occurredAt: { gte: since24h } },
        distinct: ['emailNormalized'],
        select: { emailNormalized: true },
        take: limit + 1,
      })
      return rows.filter((r) => r.emailNormalized !== email).length
    }

    if ((await distinctOthers({ ipHmac }, limits.perIpDistinctEmails24h)) >= limits.perIpDistinctEmails24h) {
      return withhold('ip_throttle')
    }

    //  A breaker trips per address; it alerts once per trip — only when no
    //  submission was withheld by the same breaker in the last 24 hours. A
    //  channel that pings for every withheld submission during an attack gets
    //  muted.
    const trip = async (reason: 'global_breaker' | 'popup_breaker', count: number, limit: number, scope: string): Promise<GrantDecision> => {
      const alreadyTripped = await db.emailConsentEvent.count({
        where: { kind: 'basis_withheld', withheldReason: reason, occurredAt: { gte: since24h } },
      })
      let alerted = false
      if (alreadyTripped === 0) {
        try {
          await (deps.alert ?? postOpsAlert)(`Email consent: ${scope} breaker tripped`, [
            {
              message: `${count} distinct addresses were granted ${scope === 'popup' ? 'through the popup ' : ''}in the last 24 hours (limit ${limit}). New ${scope === 'popup' ? 'popup' : 'notice and popup'} grants are being withheld.`,
              action: 'Check email_consent_events for a burst from one ip_hmac or surface. Leads are still saved and transactional mail still sends. The limit is adjustable on the API service without a deploy (CONSENT_GLOBAL_GRANTS_24H / CONSENT_POPUP_GRANTS_24H).',
            },
          ])
          alerted = true
        } catch {
          alerted = false
        }
      }
      return withhold(reason, { alerted })
    }

    if (input.surface === 'popup') {
      const popup = await distinctOthers({ surface: 'popup' }, limits.popupGrants24h)
      if (popup >= limits.popupGrants24h) return await trip('popup_breaker', popup, limits.popupGrants24h, 'popup')
    }
    const global = await distinctOthers({}, limits.globalGrants24h)
    if (global >= limits.globalGrants24h) return await trip('global_breaker', global, limits.globalGrants24h, 'grant')
  } catch {
    return withhold('throttle_read_failed')
  }

  return { grant: true, turnstileOk, ipHmac }
}
