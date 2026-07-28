// ════════════════════════════════════════════════════════════════════════
//  MARKETING CONSENT — the single source of truth (owner spec 2026-07-28)
//  ---------------------------------------------------------------------
//  Consent is the one thing in this system that cannot be reconstructed if it
//  is lost or mis-recorded. A wrong price can be refunded and a missed email
//  can be resent; a person who never agreed to marketing and receives it is a
//  complaint, and complaints are what get a sending domain blocked.
//
//  So the rules live HERE, in one file, as pure functions — not spread across
//  routes where each one can drift.
//
//  THE CENTRAL RULE: consent is EVIDENCE, not a preference.
//  Storing `true` is not enough. To defend a send you need to know WHERE the
//  person agreed (source), WHAT they were shown (version), and WHEN. Those
//  three travel together or the record proves nothing.
//
//  TRI-STATE, AND IT MATTERS:
//    true      — explicitly opted in
//    false     — explicitly declined a choice they were shown
//    null      — NEVER ASKED
//  `false` and `null` are both "do not send", but they are not the same fact.
//  `false` means we asked and they said no. `null` means the question was
//  never put to them, and they can still be asked. Collapsing them destroys
//  that distinction permanently — which is why the six customers who booked
//  before the checkbox existed must stay `null`, not be written to `false`.
// ════════════════════════════════════════════════════════════════════════

/**
 * The disclosure version currently shown to users.
 *
 * BUMP THIS whenever the consent WORDING changes — what a person agreed to is
 * the text they read, so a new text is a new agreement. Old records keep the
 * old version, which is the entire point: it says what THAT person was shown.
 */
export const CONSENT_VERSION = '2026-07-v1'

/**
 * Where a consent decision was captured.
 *
 * A capture SURFACE, deliberately distinct from `LeadSource`, which records the
 * marketing CHANNEL that brought someone in (Google, a door hanger, a
 * referral). One person can arrive from a door hanger and consent on the
 * booking form; those are two different facts and each needs its own column.
 */
export const CONSENT_SOURCES = [
  'BOOKING_FORM',
  'QUICK_QUOTE_FORM',
  'HOMEPAGE_ESTIMATE',
  'MOVING_CHECKLIST',
  'CONTACT_FORM',
  'SERVICES_PAGE',
  'EXISTING_CUSTOMER_OPT_IN',
  'ADMIN_MANUAL',
  'IMPORTED',
] as const

export type ConsentSource = (typeof CONSENT_SOURCES)[number]

export const isConsentSource = (v: unknown): v is ConsentSource =>
  typeof v === 'string' && (CONSENT_SOURCES as readonly string[]).includes(v)

/**
 * Legacy source strings, mapped forward.
 *
 * `booking_step_1` was written by the partial-lead capture before the
 * controlled vocabulary existed. Historical rows keep whatever they have —
 * this only normalises values arriving NOW, so a rename never rewrites the
 * past.
 */
const LEGACY_SOURCE_MAP: Record<string, ConsentSource> = {
  booking_step_1: 'BOOKING_FORM',
  booking_form: 'BOOKING_FORM',
  quote_form: 'QUICK_QUOTE_FORM',
  homepage: 'HOMEPAGE_ESTIMATE',
}

export function normaliseConsentSource(raw?: string | null): ConsentSource | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (isConsentSource(trimmed)) return trimmed
  const upper = trimmed.toUpperCase()
  if (isConsentSource(upper)) return upper
  return LEGACY_SOURCE_MAP[trimmed.toLowerCase()] ?? null
}

// ── The decision ────────────────────────────────────────────────────────

/** What is already on the record. */
export type ExistingConsent = {
  consent: boolean | null | undefined
  consentAt?: Date | null
  consentSource?: string | null
  consentVersion?: string | null
}

/** What this request is claiming. */
export type IncomingConsent = {
  /** undefined = the form did not present a choice. Never treat as false. */
  consent?: boolean | null
  source?: string | null
  version?: string | null
  /** True only for a page whose PURPOSE is withdrawing consent. */
  isWithdrawal?: boolean
  /** A suppression (unsubscribe / complaint / hard bounce) overrides everything. */
  isSuppressed?: boolean
}

export type ConsentDecision = {
  /** Fields to write. EMPTY means write nothing — leave the record alone. */
  changes: {
    emailMarketingConsent?: boolean
    marketingConsentAt?: Date
    marketingConsentSource?: string
    marketingConsentVersion?: string
  }
  /** Why, in one sentence, for the audit trail. */
  reason: string
  /** True when this request grants marketing permission that did not exist. */
  granted: boolean
}

/**
 * Decide what a submission may change about someone's consent.
 *
 * PURE. No database, no clock beyond what is passed in — so every rule below
 * is testable, and the rules are the product, not an implementation detail.
 *
 * The ordering encodes the priority: suppression beats everything, an explicit
 * withdrawal beats an existing grant, silence changes nothing, and an explicit
 * grant is the only thing that can create permission.
 */
export function decideConsent(existing: ExistingConsent, incoming: IncomingConsent, now: Date): ConsentDecision {
  // 1. SUPPRESSION WINS, ALWAYS. Someone who unsubscribed, complained or hard
  //    bounced is not marketable, and no later form re-subscribes them. This
  //    is checked first so no branch below can accidentally undo it.
  if (incoming.isSuppressed) {
    return {
      changes: {},
      reason: 'This address is suppressed (unsubscribed, complained or hard-bounced). Suppression overrides any consent supplied here.',
      granted: false,
    }
  }

  // 2. AN EXPLICIT WITHDRAWAL. Only a page whose purpose is withdrawal may set
  //    consent to false — an ordinary form with an unchecked box must not.
  if (incoming.isWithdrawal) {
    return {
      changes: {
        emailMarketingConsent: false,
        marketingConsentAt: now,
        marketingConsentSource: normaliseConsentSource(incoming.source) ?? 'ADMIN_MANUAL',
        marketingConsentVersion: incoming.version ?? CONSENT_VERSION,
      },
      reason: 'Consent explicitly withdrawn.',
      granted: false,
    }
  }

  // 3. SILENCE CHANGES NOTHING. The form did not present a choice, so this
  //    request carries no opinion about marketing. THE MOST IMPORTANT RULE
  //    HERE: a returning customer booking again on a form without a checkbox
  //    must neither gain nor lose consent.
  if (incoming.consent === undefined || incoming.consent === null) {
    return {
      changes: {},
      reason: 'No consent choice was submitted, so the existing record is left exactly as it was.',
      granted: false,
    }
  }

  // 4. AN EXPLICIT DECLINE. The person saw the checkbox and left it unchecked.
  //    Recorded as `false` — which is genuinely different from `null`, because
  //    it means we asked. It never erases an EARLIER explicit opt-in: opting
  //    out is what the unsubscribe link is for, and a half-filled form is not
  //    an unsubscribe.
  if (incoming.consent === false) {
    if (existing.consent === true) {
      return {
        changes: {},
        reason: 'An earlier explicit opt-in stands. An unchecked box on a later form is not an unsubscribe, so it does not revoke consent.',
        granted: false,
      }
    }
    return {
      changes: {
        emailMarketingConsent: false,
        marketingConsentAt: now,
        marketingConsentSource: normaliseConsentSource(incoming.source) ?? 'ADMIN_MANUAL',
        marketingConsentVersion: incoming.version ?? CONSENT_VERSION,
      },
      reason: 'The choice was presented and declined; recorded as an explicit decline rather than "never asked".',
      granted: false,
    }
  }

  // 5. AN EXPLICIT GRANT — the only path that creates marketing permission.
  //    The ORIGINAL grant is preserved: re-consenting does not reset the
  //    timestamp, because "consented since June" is the fact that matters when
  //    somebody asks how long we have been allowed to mail them.
  if (existing.consent === true) {
    return {
      changes: {},
      reason: 'Already opted in. The original consent timestamp, source and version are preserved.',
      granted: false,
    }
  }

  return {
    changes: {
      emailMarketingConsent: true,
      marketingConsentAt: now,
      marketingConsentSource: normaliseConsentSource(incoming.source) ?? 'ADMIN_MANUAL',
      marketingConsentVersion: incoming.version ?? CONSENT_VERSION,
    },
    reason:
      existing.consent === false
        ? 'Previously declined, now explicitly opted in on this submission.'
        : 'Explicit opt-in recorded with its source and disclosure version.',
    granted: true,
  }
}

/**
 * Is this contact marketable RIGHT NOW?
 *
 * Pure, and deliberately strict: every condition must be affirmatively true.
 * Absence of information is never treated as permission.
 */
export function isMarketable(input: {
  email?: string | null
  consent?: boolean | null
  suppressed?: boolean
  unsubscribed?: boolean
  hardBounced?: boolean
  complained?: boolean
}): { marketable: boolean; reason: string } {
  if (!input.email || !input.email.includes('@')) return { marketable: false, reason: 'No usable email address.' }
  if (input.suppressed) return { marketable: false, reason: 'On the suppression list.' }
  if (input.unsubscribed) return { marketable: false, reason: 'Unsubscribed.' }
  if (input.hardBounced) return { marketable: false, reason: 'Hard bounced — the address does not exist.' }
  if (input.complained) return { marketable: false, reason: 'Marked a previous message as spam.' }
  if (input.consent !== true) {
    return {
      marketable: false,
      reason: input.consent === false ? 'Explicitly declined marketing email.' : 'Never opted in — absence of a decision is not consent.',
    }
  }
  return { marketable: true, reason: 'Explicit opt-in, not suppressed.' }
}
