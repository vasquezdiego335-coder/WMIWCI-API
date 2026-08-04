// ════════════════════════════════════════════════════════════════════════
//  business-contact.ts — ONE source for the business phone number.
//
//  WHY. `BUSINESS_PHONE` was read in exactly one place (the confirmation email
//  payload) while the same number sat hardcoded in the email template default,
//  the Discord card, the quote page and the booking page. Changing the number
//  in the environment therefore changed it in ONE of six surfaces — the worst
//  possible outcome, because the inconsistency is invisible until a customer
//  calls a dead line.
//
//  DISPLAY vs DIAL are separated deliberately. A human reads "(862) 640-0625";
//  a `tel:` / `sms:` href needs "+18626400625". Formatting one from the other
//  at each call site is how they drift.
//
//  PURE + OFFLINE apart from reading process.env at call time (never at module
//  scope, so a test can set the variable and see it take effect).
// ════════════════════════════════════════════════════════════════════════

/** The number to fall back to when nothing is configured. Kept here and ONLY
 *  here — no other file may hardcode it. */
const DEFAULT_PHONE = '862-640-0625'

/** Digits only, E.164-ready. Returns null when there is nothing dialable. */
export function normalizePhoneDigits(raw?: string | null): string | null {
  const digits = (raw ?? '').replace(/\D/g, '')
  if (digits.length === 10) return '1' + digits
  if (digits.length === 11 && digits.startsWith('1')) return digits
  // Anything else (extension, short code, international) is passed through
  // only if it is plausibly a phone number at all.
  return digits.length >= 10 ? digits : null
}

/** "(862) 640-0625" for a 10-digit US number; the raw string otherwise. */
export function formatPhoneDisplay(raw?: string | null): string {
  const d = (raw ?? '').replace(/\D/g, '')
  const ten = d.length === 11 && d.startsWith('1') ? d.slice(1) : d
  if (ten.length !== 10) return (raw ?? '').trim()
  return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`
}

export type BusinessContact = {
  /** Human-readable, e.g. "(862) 640-0625". */
  display: string
  /** `tel:` href value, e.g. "+18626400625". */
  tel: string
  /** `sms:` href value — same E.164 form. */
  sms: string
  /** The raw configured value, for surfaces that already format their own. */
  raw: string
}

/**
 * THE business phone. Read `process.env.BUSINESS_PHONE` at call time so the
 * value is never frozen into a module-scope constant at import.
 */
export function businessPhone(): BusinessContact {
  const raw = (process.env.BUSINESS_PHONE || '').trim() || DEFAULT_PHONE
  const digits = normalizePhoneDigits(raw)
  const e164 = digits ? `+${digits}` : ''
  return { display: formatPhoneDisplay(raw), tel: e164, sms: e164, raw }
}
