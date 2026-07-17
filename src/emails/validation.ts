// ════════════════════════════════════════════════════════════════════════
//  Email pre-send validation (owner spec 2026-07-17).
//   • Link safety  — a production email must never ship a placeholder/unsafe URL.
//   • Required data — fail safely rather than send a misleading placeholder
//     (e.g. a "confirmation" with no real date).
//  Pure + typed; unit-tested. Wire assertEmailPayload() into the send path (email
//  worker) to make it a hard gate, and the rendered-href test (see __tests__)
//  fails the build when any rendered link is unsafe.
// ════════════════════════════════════════════════════════════════════════

import { statusMismatchReason } from './status'

export class EmailValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EmailValidationError'
  }
}

/** Returns a reason string if the URL is unsafe for a production email, else null. */
export function unsafeUrlReason(url: string | undefined | null): string | null {
  if (url == null) return 'missing'
  const u = String(url).trim()
  if (u === '' || u === '#') return 'placeholder (empty/#)'
  if (/^javascript:/i.test(u)) return 'javascript: scheme'
  if (/^(mailto:|tel:)/i.test(u)) return null // allowed
  if (/\b(localhost|127\.0\.0\.1|0\.0\.0\.0)\b/i.test(u)) return 'localhost'
  if (/^https?:\/\/[^/]*\.(vercel|ngrok(-free)?|railway)\.app/i.test(u)) return 'preview/staging domain'
  if (!/^https:\/\//i.test(u)) return 'not an absolute https URL'
  return null
}

export const isSafeUrl = (url: string | undefined | null): boolean => unsafeUrlReason(url) === null

/** Throws if any provided URL is unsafe. Keys are used in the error for triage. */
export function assertSafeUrls(urls: Record<string, string | undefined | null>): void {
  const bad = Object.entries(urls)
    .map(([k, v]) => [k, unsafeUrlReason(v)] as const)
    .filter(([, reason]) => reason)
    .map(([k, reason]) => `${k}: ${reason}`)
  if (bad.length) throw new EmailValidationError(`Unsafe email link(s): ${bad.join('; ')}`)
}

const isBlank = (v: unknown): boolean => v == null || (typeof v === 'string' && v.trim() === '')

/** Throws if any required field is missing/blank. */
export function requireFields(template: string, data: Record<string, unknown>, required: readonly string[]): void {
  const missing = required.filter((f) => isBlank(data[f]))
  if (missing.length) throw new EmailValidationError(`${template}: missing required field(s): ${missing.join(', ')}`)
}

// Per-template required fields (Phase 5). Reminders/confirmations must have a REAL
// date + window — never "To be confirmed" / "Coming up soon".
// Keys match the ACTUAL payloads the senders enqueue (verified against
// booking-approval.ts / fulfillment.ts), so the gate blocks the real
// "missing real date/window/link" case without blocking valid sends.
export const REQUIRED_FIELDS = {
  'final-confirmation': ['displayId', 'date', 'timeLabel', 'amountPaid', 'portalUrl'],
  'job-reminder': ['scheduledStart', 'timeLabel', 'originAddress', 'portalUrl'],
  'payment-receipt': ['displayId', 'date', 'amountPaid', 'portalUrl'],
  'review-request': ['googleReviewUrl'],
  'payment-failed': ['updatePaymentUrl'],
  // A pending-details ask / final invoice must carry a real link back to act on.
  'information-required': ['portalUrl'],
  'final-invoice': ['portalUrl'],
  // The referral reward is meaningless without a link to redeem it.
  'referral-reward': ['redeemUrl'],
} as const satisfies Record<string, readonly string[]>

export type ValidatedTemplate = keyof typeof REQUIRED_FIELDS

/**
 * Central pre-send gate: enforce required fields for known templates + link
 * safety on any URL-ish field in the payload. Call before enqueue/render.
 */
export function assertEmailPayload(template: string, payload: Record<string, unknown>): void {
  const required = (REQUIRED_FIELDS as Record<string, readonly string[]>)[template]
  if (required) requireFields(template, payload, required)

  // booking-updated must carry at least one real change.
  if (template === 'booking-updated') {
    const changes = payload.changes
    const hasChange = Array.isArray(changes) ? changes.length > 0 : !isBlank(payload.changedLabel)
    if (!hasChange) throw new EmailValidationError('booking-updated: no changed fields supplied')
  }

  // Phase 4 — typed status gate (opt-in). When the sender includes the booking's
  // real status, a state-dependent template (e.g. final-confirmation) must be
  // truthful for it: a confirmation can never go out for a pending booking.
  const bookingStatus = (payload.bookingStatus ?? payload.status) as string | undefined
  const mismatch = statusMismatchReason(template, bookingStatus)
  if (mismatch) throw new EmailValidationError(mismatch)

  // Any *_url / *Url field must be a safe production URL (skip unset optionals).
  const urlFields: Record<string, string | undefined | null> = {}
  for (const [k, v] of Object.entries(payload)) {
    if (/url$/i.test(k) && v != null && String(v).trim() !== '') urlFields[k] = v as string
  }
  if (Object.keys(urlFields).length) assertSafeUrls(urlFields)
}
