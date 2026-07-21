import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { signReferralCode, verifyReferralCode, isWellFormedReferralCode } from '../referral-code'

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
