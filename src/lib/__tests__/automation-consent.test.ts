// ════════════════════════════════════════════════════════════════════════
//  AUTOMATION PROMOTIONAL CONSENT — the gate the BOOKING side never had.
//  (owner spec 2026-08-07)
//  ---------------------------------------------------------------------
//  THE DEFECT. Every stage `executeAutomationStage` sends is classified
//  PROMOTIONAL, and `guardedSend` does NOT check consent — it checks
//  suppression, caps, quiet hours and the rollout allowlist, and delegates
//  "may we market to this person at all" to the caller's `recheck`.
//
//  The LEAD side was covered: `fireLeadTrigger` refuses to enrol anybody
//  without an explicit opt-in. The BOOKING side was not. `fireBookingTrigger`
//  checked only `isInternalTest`, and `evaluateStopRules` had no consent rule
//  to apply because `LiveSubjectState` carried no consent field. So an ACTIVE
//  automation on any booking trigger would have mailed customers who never
//  opted in — the same defect PR #32 fixed for `bookingBlockReason`, one layer
//  over, on the path that was left open.
//
//  It never fired in production only because no automation had been built yet
//  (verified: zero rows in EmailAutomation). It was a trap armed for the
//  owner's first one.
// ════════════════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { evaluateStopRules, type LiveSubjectState } from '../email-automation-runtime'
import type { StopEvaluation } from '../email-automation-runtime'
import type { AutomationDefinition } from '../email-automation'

const NOW = new Date('2026-08-07T15:00:00.000Z')

/** StopEvaluation is a discriminated union; this narrows it for assertions. */
const reasonOf = (v: StopEvaluation): string | null => (v.stop ? v.reason : null)

/** The shape the admin builder emits with the segment dropdown left blank —
 *  deliberately the LOOSEST definition, so the gate is tested at its weakest. */
function def(over: Partial<AutomationDefinition> = {}): AutomationDefinition {
  return {
    trigger: 'booking_started',
    audience: null,
    stages: [],
    stopRules: {},
    ...over,
  } as AutomationDefinition
}

const booking = (over: Partial<NonNullable<LiveSubjectState['booking']>> = {}) => ({
  status: 'PENDING_PAYMENT',
  depositPaid: false,
  moveDate: new Date(NOW.getTime() + 7 * 86_400_000),
  hasReview: false,
  cancelled: false,
  ...over,
})

test('a booking customer who never opted in is STOPPED before any other rule', () => {
  const v = evaluateStopRules(
    def(),
    { booking: booking(), marketing: { consent: null, optOut: false } },
    NOW
  )
  assert.deepEqual(v, { stop: true, reason: 'no_marketing_consent' })
})

test('an explicit decline blocks just as hard as never being asked', () => {
  const v = evaluateStopRules(
    def(),
    { booking: booking(), marketing: { consent: false, optOut: false } },
    NOW
  )
  assert.equal(reasonOf(v), 'no_marketing_consent')
})

test('an SMS STOP beats a stored opt-in', () => {
  const v = evaluateStopRules(
    def(),
    { booking: booking(), marketing: { consent: true, optOut: true } },
    NOW
  )
  assert.deepEqual(v, { stop: true, reason: 'marketing_opted_out' })
})

test('an opted-in customer is unaffected', () => {
  const v = evaluateStopRules(
    def(),
    { booking: booking(), marketing: { consent: true, optOut: false } },
    NOW
  )
  assert.equal(v.stop, false)
})

test('the consent rule is NOT switchable by the automation builder', () => {
  // Every other rule here reads def.stopRules and can be turned off in the UI.
  // This one must not be: consent is not a preference.
  const allOff = def({
    stopRules: {
      stopAfterBooking: false,
      stopAfterCancellation: false,
      stopAfterPayment: false,
      stopAfterReview: false,
      stopAfterReferral: false,
    } as AutomationDefinition['stopRules'],
  })
  const v = evaluateStopRules(allOff, { booking: booking(), marketing: { consent: null, optOut: false } }, NOW)
  assert.deepEqual(v, { stop: true, reason: 'no_marketing_consent' })
})

test('consent is checked BEFORE the subject rules — it is the more fundamental fact', () => {
  // A cancelled booking AND no consent reports the consent reason: for a
  // promotional template no amount of correct booking state permits the send.
  const v = evaluateStopRules(
    def(),
    { booking: booking({ cancelled: true, status: 'CANCELLED' }), marketing: { consent: null, optOut: false } },
    NOW
  )
  assert.equal(reasonOf(v), 'no_marketing_consent')
  // ...but SUPPRESSION still wins over everything, as it always has.
  const s = evaluateStopRules(
    def(),
    { booking: booking(), suppressed: { reason: 'HARD_BOUNCE' }, marketing: { consent: true, optOut: false } },
    NOW
  )
  assert.equal(reasonOf(s), 'suppressed:hard_bounce')
})

test('a caller that did not load consent leaves the rule silent (no false stops)', () => {
  // `undefined` means "not loaded", which must not be read as "never asked" —
  // otherwise adding this rule would have stopped every existing enrollment.
  const v = evaluateStopRules(def(), { booking: booking() }, NOW)
  assert.equal(v.stop, false)
})

test('a lead-scoped enrollment gets the same send-time consent check', () => {
  const v = evaluateStopRules(
    def({ trigger: 'lead_created' }),
    {
      lead: { status: 'NEW', bookedAt: null, convertedBookingId: null, lostAt: null, moveDate: null },
      marketing: { consent: null, optOut: false },
    },
    NOW
  )
  assert.deepEqual(v, { stop: true, reason: 'no_marketing_consent' })
})

// ── The two loaders, asserted structurally ──────────────────────────────
// The rule above is pure and cannot see whether the runtime actually LOADS the
// columns. A gate that cannot see the field cannot enforce it — which is
// exactly how the booking side stayed open.

function code(rel: string): string {
  return readFileSync(resolve(__dirname, '../..', rel), 'utf8')
    .split('\n')
    .filter((l) => {
      const t = l.trim()
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    })
    .join('\n')
}

test('loadLiveState LOADS the consent columns for both subject types', () => {
  const src = code('lib/email-automation-runtime.ts')
  const loader = src.slice(src.indexOf('async function loadLiveState'), src.indexOf('return state'))
  assert.match(loader, /customer: \{ select: \{ emailMarketingConsent: true, marketingOptOut: true \} \}/)
  assert.match(loader, /emailMarketingConsent: true,/)
  assert.match(loader, /state\.marketing = \{/)
})

test('fireBookingTrigger refuses an un-consented enrolment, like fireLeadTrigger always has', () => {
  const src = code('lib/email-automation-runtime.ts')
  const fn = src.slice(src.indexOf('export async function fireBookingTrigger'), src.indexOf('export function mayEnrollLeadSubject'))
  assert.match(fn, /hasPromotionalConsent\(/, 'the same tested predicate, not a second rule')
  assert.match(fn, /marketingOptOut/)
  const guard = fn.indexOf('hasPromotionalConsent(')
  const enrol = fn.indexOf('fireAutomationTrigger(')
  assert.ok(guard > -1 && enrol > guard, 'the refusal must precede the enrolment')
})
