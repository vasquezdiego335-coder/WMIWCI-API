import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { signReferralCode, verifyReferralCode, isWellFormedReferralCode, referralRedeemUrl } from '../referral-code'
import { unsafeUrlReason } from '../../emails/validation'

before(() => {
  process.env.REFERRAL_SECRET = 'test_secret_do_not_use_in_prod'
})

test('sign is deterministic per customer and differs across customers', () => {
  const a1 = signReferralCode('cust_A')
  const a2 = signReferralCode('cust_A')
  const b = signReferralCode('cust_B')
  assert.equal(a1, a2, 'same customer → same code')
  assert.notEqual(a1, b, 'different customers → different codes')
})

test('codes are well-formed (PREFIX-XXXXXX, unambiguous alphabet)', () => {
  const c = signReferralCode('cust_A')
  assert.match(c, /^MIC-[2-9A-HJKMNP-Z]{6}$/)
  assert.ok(isWellFormedReferralCode(c))
  assert.ok(!isWellFormedReferralCode('MIC-ABC'))
  assert.ok(!isWellFormedReferralCode('REFER15'))
  assert.ok(!isWellFormedReferralCode(undefined))
})

test('verify accepts the real code and rejects forgeries / wrong owner', () => {
  const code = signReferralCode('cust_A')
  assert.ok(verifyReferralCode(code, 'cust_A'))
  assert.ok(verifyReferralCode(code.toLowerCase(), 'cust_A'), 'case-insensitive input')
  assert.ok(!verifyReferralCode(code, 'cust_B'), 'not the code owner')
  assert.ok(!verifyReferralCode('MIC-ZZZZZZ', 'cust_A'), 'forged code')
  assert.ok(!verifyReferralCode('', 'cust_A'))
})

test('a different secret yields a different code (signature is keyed)', () => {
  const withA = signReferralCode('cust_A')
  process.env.REFERRAL_SECRET = 'a_totally_different_secret'
  const withB = signReferralCode('cust_A')
  process.env.REFERRAL_SECRET = 'test_secret_do_not_use_in_prod'
  assert.notEqual(withA, withB)
})

test('verify never throws when the secret is missing', () => {
  const saved = process.env.REFERRAL_SECRET
  delete process.env.REFERRAL_SECRET
  assert.doesNotThrow(() => verifyReferralCode('MIC-AAAAAA', 'cust_A'))
  assert.equal(verifyReferralCode('MIC-AAAAAA', 'cust_A'), false)
  process.env.REFERRAL_SECRET = saved
})

// ── REDEMPTION URL (owner request 2026-07-24) ────────────────────────────────
// `referral-reward` requires `redeemUrl`; nothing produced one, so the template
// fell back to '#' and every send was refused ("unparseable URL"). These pin the
// generator AND the property that actually matters: the URL it builds must pass
// the same link validator the email guard runs.
test('referralRedeemUrl builds an absolute https booking link carrying the code', () => {
  const url = referralRedeemUrl('MIC-7F3A2X')
  assert.ok(url.startsWith('https://'), 'must be absolute https')
  assert.ok(url.includes('/booking-form.html'), 'must land on the booking form')
  const q = new URL(url).searchParams
  assert.equal(q.get('code'), 'MIC-7F3A2X')
  assert.equal(q.get('src'), 'referral_reward', 'attribution must survive')
})

test('referralRedeemUrl uppercases/trims the code and omits it when absent', () => {
  assert.equal(new URL(referralRedeemUrl('  mic-abc123 ')).searchParams.get('code'), 'MIC-ABC123')
  const none = new URL(referralRedeemUrl())
  assert.equal(none.searchParams.get('code'), null)
  assert.equal(none.searchParams.get('src'), 'referral_reward')
})

test('referralRedeemUrl passes the EMAIL LINK VALIDATOR (the original failure)', () => {
  // This is the assertion that would have caught the production defect.
  assert.equal(unsafeUrlReason(referralRedeemUrl('MIC-7F3A2X')), null)
  assert.equal(unsafeUrlReason(referralRedeemUrl()), null)
  // ...and the old broken value is still correctly refused.
  assert.ok(unsafeUrlReason('#') !== null)
})
