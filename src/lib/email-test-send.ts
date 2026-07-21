// ════════════════════════════════════════════════════════════════════════
//  TEST SENDS — rehearse a template without touching a customer.
//  (owner spec 2026-07-21)
//  ---------------------------------------------------------------------
//  A test-send feature is where email systems usually grow their first hole:
//  it "just needs to render and send", so it gets its own code path, and that
//  path quietly skips suppression, validation or the compliance footer. Then
//  someone tests against a real customer address and the guard everyone trusted
//  was never in the loop.
//
//  So a test send here goes through `guardedSend` — the SAME door as real
//  customer mail. Suppression, URL safety, required fields, postal address and
//  idempotency all apply. What makes it a test is what surrounds it:
//
//   • the recipient must be the CONFIGURED test address (EMAIL_TEST_RECIPIENT),
//     unless an owner explicitly overrides with an acknowledged warning;
//   • the subject is prefixed `[TEST]` so nobody mistakes it in an inbox;
//   • the ledger row is flagged `isTest`, which excludes it from every
//     conversion, revenue, profit and frequency-cap number;
//   • the idempotency key is time-scoped, so repeated tests are ALLOWED
//     (rehearsing twice is the point) while a real business event still cannot
//     double-send;
//   • no journey, booking, review, referral or payment state is touched. This
//     module reads templates and calls the guard. It writes nothing else.
// ════════════════════════════════════════════════════════════════════════

import { guardedSend, type SendOutcome } from './email-guard'
import { templateByKey } from './email-registry'
import { REQUIRED_FIELDS } from '../emails/validation'
import { buildMarketingContext, applyMarketingContext } from './marketing-context'
import { normalizeEmail } from './email-tokens'

export const TEST_SUBJECT_PREFIX = '[TEST]'

/** The one address a test may go to without an explicit override. */
export function configuredTestRecipient(): string | null {
  const raw = process.env.EMAIL_TEST_RECIPIENT?.trim()
  return raw ? normalizeEmail(raw) : null
}

export type RecipientCheck =
  | { ok: true; email: string; isOverride: boolean }
  | { ok: false; error: string }

/**
 * Decide whether this address may receive a test.
 *
 * The override exists because there are legitimate reasons to preview on a
 * personal device — but it is never implicit. An owner must ASK for it, and the
 * result records that they did.
 */
export function checkTestRecipient(requested: string | null | undefined, allowOverride: boolean): RecipientCheck {
  const configured = configuredTestRecipient()
  const wanted = requested ? normalizeEmail(requested) : configured

  if (!wanted) {
    return {
      ok: false,
      error: 'No test recipient. Set EMAIL_TEST_RECIPIENT in the environment, or supply an address with the override acknowledged.',
    }
  }
  if (configured && wanted === configured) return { ok: true, email: wanted, isOverride: false }
  if (!allowOverride) {
    return {
      ok: false,
      error: configured
        ? `Test sends go to the configured recipient (${configured}). Sending to another address requires the explicit owner override.`
        : 'EMAIL_TEST_RECIPIENT is not set, so an explicit owner override is required to choose an address.',
    }
  }
  return { ok: true, email: wanted, isOverride: true }
}

// ── Synthetic variables ─────────────────────────────────────────────────

/**
 * Obviously-fake values for a template preview.
 *
 * Every string says TEST or SAMPLE on purpose. If one of these ever escapes
 * into a real email, it should be unmistakable in the inbox rather than looking
 * like a plausible booking.
 */
export function syntheticPayload(template: string, appUrl: string): Record<string, unknown> {
  const base: Record<string, unknown> = {
    customerName: 'Test Customer',
    name: 'Test Customer',
    bookingReference: 'TEST-0000',
    displayId: 'TEST-0000',
    locale: 'en',
    moveDate: 'Saturday, August 1, 2026',
    date: 'Saturday, August 1, 2026',
    time: '9:00 AM',
    originAddress: '123 Sample Street, Newark NJ',
    destAddress: '456 Example Avenue, Jersey City NJ',
    serviceType: 'SAMPLE — 2 Bedrooms',
    amount: '$49.00',
    amountCents: 4900,
    depositAmount: '$49.00',
    totalAmount: '$0.00',
    balanceDue: '$0.00',
    crewSize: 2,
    estimatedHours: 3,
    bookingUrl: `${appUrl}/my-booking/TEST-TOKEN`,
    portalUrl: `${appUrl}/my-booking/TEST-TOKEN`,
    reviewUrl: process.env.GOOGLE_REVIEW_URL?.trim() || `${appUrl}/review`,
    referralUrl: `${appUrl}/referral/TEST-CODE`,
    checkoutUrl: `${appUrl}/book`,
    invoiceUrl: `${appUrl}/my-booking/TEST-TOKEN`,
    supportEmail: process.env.EMAIL_REPLY_TO ?? 'support@moveitclearit.com',
    reason: 'SAMPLE reason text for a test render.',
    message: 'SAMPLE message body for a test render.',
    stage: 1,
  }

  // Guarantee every declared required field has SOMETHING, so a test failure is
  // a real template problem rather than a gap in this fixture.
  const required = (REQUIRED_FIELDS as Record<string, readonly string[]>)[template] ?? []
  for (const field of required) {
    if (base[field] === undefined) base[field] = `SAMPLE ${field}`
  }
  return base
}

/** Fields the template declares as required, and whether the payload has them. */
export function checkRequiredVariables(template: string, payload: Record<string, unknown>): { missing: string[]; required: string[] } {
  const required = (REQUIRED_FIELDS as Record<string, readonly string[]>)[template] ?? []
  const missing = required.filter((f) => payload[f] === undefined || payload[f] === null || payload[f] === '')
  return { missing, required: Array.from(required) }
}

// ── Sending ─────────────────────────────────────────────────────────────

export type TestSendInput = {
  template: string
  to: string
  subject: string
  html: string
  text?: string
  payload: Record<string, unknown>
  /** True when the owner deliberately chose a non-configured address. */
  isOverride: boolean
}

export type TestSendResult = {
  outcome: SendOutcome
  subject: string
  recipient: string
  isOverride: boolean
}

/**
 * Send the test through the CANONICAL guard.
 *
 * The idempotency key is scoped to the current minute. That is deliberate: a
 * test that could only ever be sent once would be useless the second time
 * someone tweaked a template, while a per-minute key still prevents a
 * double-clicked button from sending twice.
 */
export async function sendTestEmail(input: TestSendInput): Promise<TestSendResult> {
  const entry = templateByKey(input.template)
  const subject = input.subject.startsWith(TEST_SUBJECT_PREFIX)
    ? input.subject
    : `${TEST_SUBJECT_PREFIX} ${input.subject}`

  const minuteBucket = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')

  const outcome = await guardedSend({
    to: input.to,
    subject,
    html: input.html,
    text: input.text,
    template: input.template,
    // Classified by the registry, not overridden — a test of a promotional
    // template must exercise the promotional compliance gate too, otherwise the
    // rehearsal proves nothing about the real send.
    emailClass: entry?.emailClass,
    journey: 'admin-test',
    eventId: `test:${minuteBucket}`,
    payload: input.payload,
    isTest: true,
    // NO `recheck`: a test is not about a booking, so there is no live state to
    // reload. Everything else in the guard still runs.
  })

  return { outcome, subject, recipient: input.to, isOverride: input.isOverride }
}

/** Marketing context (unsubscribe + postal address) for a promotional preview. */
export function testMarketingContext(email: string, template: string) {
  return buildMarketingContext(email, template, 'en')
}

export { applyMarketingContext }
