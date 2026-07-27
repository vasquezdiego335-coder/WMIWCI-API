import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sendConfigHash, needsReapproval, type SendConfigFields } from '../email-campaign-approval'

// ════════════════════════════════════════════════════════════════════════
//  Bug #6 ROOT CAUSE (owner spec 2026-07-26).
//  Approval invalidation compared `updatedAt > approvedAt`. Persisting a
//  validation RESULT bumps updatedAt, so Validate destroyed Approve — and the
//  dispatch error instructed the operator to Validate. The only workaround was
//  "do not click Validate after Approve", which is not a workflow.
//  Approval now records a hash of the SEND-AFFECTING fields.
// ════════════════════════════════════════════════════════════════════════

const BASE: SendConfigFields = {
  template: 'abandoned-checkout',
  subject: '[TEST] Summer',
  audienceId: 'aud_1',
  scheduledAt: new Date('2026-07-26T12:00:00.000Z'),
  utmSource: 'email',
  utmMedium: 'email',
  utmCampaign: 'summer-reengagement',
  utmContent: null,
  discountCode: null,
}
const approved = (over: Partial<SendConfigFields> = {}) => {
  const cfg = { ...BASE, ...over }
  return { ...cfg, approvedAt: new Date('2026-07-26T12:00:00.000Z'), updatedAt: new Date('2026-07-26T12:00:00.000Z'), approvedConfigHash: sendConfigHash(cfg) }
}

test('1. Validate -> Approve -> Validate with NO config change stays approved', () => {
  const c = approved()
  // Validation writes its result, so updatedAt moves far past approvedAt. Under
  // the old timestamp rule this alone demanded re-approval. It must not now.
  c.updatedAt = new Date('2026-07-26T18:00:00.000Z')
  assert.equal(needsReapproval(c), false, 'a validation write must not invalidate approval')
})

test('2. Changing the SUBJECT requires re-approval', () => {
  const c = approved()
  assert.equal(needsReapproval({ ...c, subject: 'Different subject' }), true)
})

test('3. Changing the AUDIENCE requires re-approval', () => {
  const c = approved()
  assert.equal(needsReapproval({ ...c, audienceId: 'aud_2' }), true)
  assert.equal(needsReapproval({ ...c, audienceId: null }), true)
})

test('3b. Template, tracking and discount changes require re-approval', () => {
  const c = approved()
  assert.equal(needsReapproval({ ...c, template: 'review-request' }), true)
  assert.equal(needsReapproval({ ...c, utmCampaign: 'other' }), true)
  assert.equal(needsReapproval({ ...c, discountCode: 'SAVE10' }), true)
})

test('3c. SETTING THE SEND TIME does not invalidate approval (bug #10)', () => {
  // This assertion REPLACES an earlier one that required the opposite. The
  // earlier requirement was wrong, and following it produced a workflow that
  // could not be completed correctly:
  //
  //   the lifecycle is VALIDATING -> READY -> (approve) -> SCHEDULED, so
  //   scheduling happens AFTER approval by design. With scheduledAt hashed,
  //   that next legitimate step always produced "edited after approval" — an
  //   owner following the intended sequence exactly was told they had tampered
  //   with the campaign, on every single campaign.
  //
  // This is not the assertion being weakened to get a green run: WHEN a
  // campaign sends is still gated, just not by this mechanism. The transition
  // to SCHEDULED refuses without approvedAt, needs email.manage_campaign, is
  // confirmed in the UI with the time shown, and is audited — and `update`
  // refuses any campaign past DRAFT/VALIDATING/FAILED, so no other path can
  // change it. The hash answers "same campaign, same recipients?", which is
  // what a stale approval must not be allowed to cover.
  const c = approved()
  assert.equal(
    needsReapproval({ ...c, scheduledAt: new Date('2026-08-01T00:00:00.000Z') }),
    false,
    'scheduling an approved campaign must not invalidate its approval'
  )
  // Approve-then-schedule, the real sequence, must end dispatchable.
  const scheduled = { ...approved({ scheduledAt: null }), scheduledAt: new Date('2026-07-27T21:19:09.000Z') }
  assert.equal(needsReapproval(scheduled), false, 'the canonical approve -> schedule flow must not self-invalidate')
})

test('4. Metadata-only writes do NOT require re-approval', () => {
  const c = approved()
  // validation / statusNote / dispatchedAt / counters are not inputs to the hash
  // at all, so there is no way for them to affect the decision.
  const hashBefore = c.approvedConfigHash
  assert.equal(sendConfigHash({ ...BASE }), hashBefore)
  assert.equal(needsReapproval({ ...c, updatedAt: new Date('2027-01-01T00:00:00.000Z') }), false)
})

test('5. UI and dispatch guard cannot disagree (one function)', () => {
  // Both call needsReapproval; this pins that the exported name exists and is
  // deterministic for identical input.
  const c = approved()
  assert.equal(needsReapproval(c), needsReapproval({ ...c }))
})

test('6. A stale approval hash cannot cover newer content', () => {
  const c = approved()
  const edited = { ...c, subject: 'Edited after approval' }
  assert.equal(needsReapproval(edited), true, 'the old hash must not validate new content')
})

test('never approved -> always needs approval', () => {
  const c = approved()
  assert.equal(needsReapproval({ ...c, approvedAt: null }), true)
})

test('legacy rows with no hash fall back to the timestamp rule (conservative)', () => {
  const c = approved()
  const legacy = { ...c, approvedConfigHash: null, updatedAt: new Date('2026-07-26T18:00:00.000Z') }
  assert.equal(needsReapproval(legacy), true, 'no recorded hash -> ask for re-approval rather than assume')
})

test('hash distinguishes null from empty string, and resists field-shift collisions', () => {
  assert.notEqual(sendConfigHash({ ...BASE, subject: null }), sendConfigHash({ ...BASE, subject: '' }))
  // ("a","b") must not hash the same as ("ab", null-ish) — the unit separator.
  assert.notEqual(
    sendConfigHash({ ...BASE, utmSource: 'a', utmMedium: 'b' }),
    sendConfigHash({ ...BASE, utmSource: 'ab', utmMedium: '' })
  )
})
