// ════════════════════════════════════════════════════════════════════════
//  MARKETING CONTEXT — the compliance block every promotional email needs.
//  (finding EMAIL-P1-06)
//  ---------------------------------------------------------------------
//  THE DEFECT: the shared footer already RENDERS an unsubscribe link, a
//  physical postal address and a "why you're getting this" line — but only when
//  they are passed to it, and NO SENDER PASSED THEM.
//
//    • the queue worker supplied `unsubscribeUrl` and nothing else;
//    • direct followups (src/lib/followups.ts) supplied neither;
//    • `repeat-reminder` did not use the shared footer at all.
//
//  So every promotional email shipped without a physical postal address, which
//  CAN-SPAM requires on commercial email. `List-Unsubscribe` headers do not
//  satisfy that — the address and a visible unsubscribe must be IN the message.
//
//  THIS MODULE IS THE ONE SOURCE. `guardedSend` refuses any promotional send
//  whose context is incomplete, so the failure mode is a BLOCKED SEND with a
//  clear reason rather than a quietly non-compliant email.
//
//  FAIL-CLOSED BY DESIGN: there is no default postal address and none is
//  invented here. `BUSINESS_POSTAL_ADDRESS` must be set to the real registered
//  address before any promotional journey can send. That is a deliberate
//  blocker, not an oversight — a made-up address is worse than none.
// ════════════════════════════════════════════════════════════════════════

import { unsubscribeUrl, preferencesUrl } from './email-tokens'
import { isSafeUrl } from '../emails/validation'

export type MarketingContext = {
  /** Visible, working unsubscribe link. Signed + per-recipient. */
  unsubscribeUrl: string
  /** Real physical postal address. Required by CAN-SPAM on commercial email. */
  postalAddress: string
  /** Why this person is receiving this message. */
  reasonForContact: string
  /** Preference centre, when one exists. */
  preferenceUrl?: string
}

export type MarketingContextResult =
  | { ok: true; context: MarketingContext }
  | { ok: false; missing: string[] }

/**
 * Why the recipient is getting this message, per template. Shown in the footer
 * so the claim is specific and true rather than a generic "you subscribed".
 */
const REASONS: Record<string, { en: string; es: string }> = {
  'abandoned-checkout': {
    en: "You're receiving this because you started a booking with us and didn't finish it.",
    es: 'Recibes esto porque comenzaste una reserva con nosotros y no la completaste.',
  },
  'review-request': {
    en: "You're receiving this because we recently completed a move for you.",
    es: 'Recibes esto porque completamos tu mudanza recientemente.',
  },
  referral: {
    en: "You're receiving this because we recently completed a move for you.",
    es: 'Recibes esto porque completamos tu mudanza recientemente.',
  },
  'referral-reward': {
    en: "You're receiving this because someone you referred completed a move with us.",
    es: 'Recibes esto porque alguien que recomendaste completó una mudanza con nosotros.',
  },
  'repeat-reminder': {
    en: "You're receiving this because we moved you in the past.",
    es: 'Recibes esto porque te ayudamos con una mudanza anteriormente.',
  },
  'quote-followup': {
    en: "You're receiving this because you asked us for a moving quote.",
    es: 'Recibes esto porque nos pediste un presupuesto para una mudanza.',
  },
}

const DEFAULT_REASON = {
  en: "You're receiving this because you contacted Move It Clear It about a move.",
  es: 'Recibes esto porque contactaste a Move It Clear It sobre una mudanza.',
}

/** Template → reason key. Stage variants share their family's reason. */
function reasonFor(template: string, es: boolean): string {
  const family = template.replace(/-(?:\d+|final)$/, '')
  const entry = REASONS[template] ?? REASONS[family] ?? DEFAULT_REASON
  return es ? entry.es : entry.en
}

/** The configured postal address, or null. NEVER defaulted. */
export function businessPostalAddress(): string | null {
  const value = process.env.BUSINESS_POSTAL_ADDRESS?.trim()
  if (!value) return null
  // A placeholder is not an address. Same reasoning as the review-URL gate.
  if (/REPLACE_ME|REPLACE_WITH|YOUR[-_ ]?ADDRESS|CHANGE[-_ ]?ME|PLACEHOLDER|TODO/i.test(value)) return null
  // A real postal address has, at minimum, a number and some words.
  if (value.length < 10) return null
  return value
}

/** True when promotional sending is configured well enough to be lawful. */
export function isMarketingContextConfigured(): boolean {
  return businessPostalAddress() !== null
}

/**
 * Build the compliance context for one recipient + template.
 * Returns the MISSING pieces rather than a partial context, so the caller can
 * block the send and name exactly what is unconfigured.
 */
export function buildMarketingContext(
  email: string,
  template: string,
  locale = 'en'
): MarketingContextResult {
  const es = (locale ?? 'en').toLowerCase().startsWith('es')
  const missing: string[] = []

  const unsub = unsubscribeUrl(email)
  if (!unsub || !isSafeUrl(unsub)) missing.push('unsubscribeUrl (check APP_URL and EMAIL_TOKEN_SECRET)')

  const postal = businessPostalAddress()
  if (!postal) missing.push('BUSINESS_POSTAL_ADDRESS')

  if (missing.length) return { ok: false, missing }

  const prefs = preferencesUrl(email)

  return {
    ok: true,
    context: {
      unsubscribeUrl: unsub as string,
      postalAddress: postal as string,
      reasonForContact: reasonFor(template, es),
      preferenceUrl: prefs && isSafeUrl(prefs) ? prefs : undefined,
    },
  }
}

/**
 * Merge the context into a template payload. The shared `MarketingFooter`
 * already renders `unsubscribeUrl` / `postalAddress` / `disclaimer` when they
 * are present — the gap was never the footer, it was that nothing supplied them.
 */
export function applyMarketingContext(
  payload: Record<string, unknown>,
  context: MarketingContext
): Record<string, unknown> {
  // ONLY props the templates actually accept. `manageUrl` and
  // `reasonForContact` were passed here at first and were DEAD — no promotional
  // template declares either, so React would have dropped them silently while
  // the code implied a preference link was shipping.
  //
  // The REASON FOR CONTACT is not missing: every promotional template already
  // renders a specific, true `disclaimer` in its own copy table ("you started a
  // booking with us", "we recently completed your move"). That is the compliance
  // requirement, and `promotionalComplianceCheck()` verifies it rather than
  // assuming it. `context.reasonForContact` remains the canonical wording for
  // any surface that needs it (plain-text builders, future preference centre).
  return {
    ...payload,
    unsubscribeUrl: context.unsubscribeUrl,
    postalAddress: context.postalAddress,
  }
}

/**
 * Does this rendered promotional email actually carry the required block?
 * Used by tests and by the conformance check — proving compliance from the
 * OUTPUT rather than trusting that a prop was passed.
 */
export function promotionalComplianceCheck(html: string): { ok: boolean; missing: string[] } {
  const missing: string[] = []
  // A visible unsubscribe link (not merely the List-Unsubscribe header).
  if (!/\/api\/email\/unsubscribe\?token=/.test(html)) missing.push('visible unsubscribe link')
  // A dead link does not count.
  if (/href="#"/.test(html)) missing.push('placeholder href in footer')
  // A reason-for-contact sentence. Both real phrasings are covered: the English
  // templates say "You're receiving this because…" and the SPANISH ones say
  // "Te escribimos porque…". An earlier version of this check only matched
  // "Recibes esto" and wrongly reported every Spanish email as non-compliant —
  // the templates were right and the check was wrong.
  if (!/receiving this|Recibes esto|Te escribimos porque/i.test(html)) missing.push('reason for contact')
  return { ok: missing.length === 0, missing }
}
