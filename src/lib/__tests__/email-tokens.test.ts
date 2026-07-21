// Offline tests for the signed unsubscribe/preference tokens.
// No database, no network. Sets a deterministic secret so signatures are stable.
process.env.EMAIL_TOKEN_SECRET = 'test-secret-for-email-tokens'

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  signToken,
  verifyToken,
  normalizeEmail,
  unsubscribeUrl,
  preferencesUrl,
  DEFAULT_MAX_AGE_MS,
} from '../email-tokens'

const EMAIL = 'Customer@Example.COM'

test('normalizeEmail lowercases and trims — one canonical spelling', () => {
  assert.equal(normalizeEmail('  Foo@Bar.com '), 'foo@bar.com')
  assert.equal(normalizeEmail(''), '')
  assert.equal(normalizeEmail(undefined as unknown as string), '')
})

test('a signed token round-trips to the normalized address', () => {
  const token = signToken(EMAIL)
  const verified = verifyToken(token)
  assert.ok(verified, 'token should verify')
  assert.equal(verified.email, 'customer@example.com')
  assert.equal(verified.purpose, 'unsubscribe')
})

test('a tampered payload fails closed', () => {
  const token = signToken(EMAIL)
  const [, mac] = token.split('.')
  // Re-encode a DIFFERENT address against the original signature.
  const forgedPayload = Buffer.from('v1:unsubscribe:victim@example.com:1')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  assert.equal(verifyToken(`${forgedPayload}.${mac}`), null)
})

test('a tampered signature fails closed', () => {
  const token = signToken(EMAIL)
  const [payload] = token.split('.')
  assert.equal(verifyToken(`${payload}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`), null)
})

test('malformed input never throws — it returns null', () => {
  for (const bad of ['', '.', 'nodot', 'a.', '.b', null, undefined, 12345 as unknown as string]) {
    assert.equal(verifyToken(bad as string), null, JSON.stringify(bad))
  }
})

test('a token signed for one purpose does not verify for another', () => {
  const token = signToken(EMAIL, 'preferences')
  assert.equal(verifyToken(token, 'unsubscribe'), null)
  assert.ok(verifyToken(token, 'preferences'))
})

test('an expired token is refused', () => {
  const longAgo = Date.now() - (DEFAULT_MAX_AGE_MS + 60_000)
  const token = signToken(EMAIL, 'unsubscribe', longAgo)
  assert.equal(verifyToken(token, 'unsubscribe'), null)
  // …but still valid when the caller opts out of expiry (maxAge = 0).
  assert.ok(verifyToken(token, 'unsubscribe', 0))
})

test('an unsubscribe link a year old still works — that is a legal expectation', () => {
  const aYearAgo = Date.now() - 365 * 24 * 60 * 60 * 1000
  assert.ok(verifyToken(signToken(EMAIL, 'unsubscribe', aYearAgo)))
})

test('a far-future issue time is refused (clock skew / forged timestamp)', () => {
  const future = Date.now() + 48 * 60 * 60 * 1000
  assert.equal(verifyToken(signToken(EMAIL, 'unsubscribe', future)), null)
})

test('tokens for different addresses differ', () => {
  assert.notEqual(signToken('a@example.com'), signToken('b@example.com'))
})

test('signing a blank address throws rather than producing a useless link', () => {
  assert.throws(() => signToken('   '))
})

test('the address never appears in the URL (no leak via referrer or logs)', () => {
  process.env.APP_URL = 'https://app.moveitclearit.com'
  const url = unsubscribeUrl(EMAIL)
  assert.ok(url)
  assert.ok(!url.toLowerCase().includes('customer@example.com'))
  assert.ok(url.startsWith('https://app.moveitclearit.com/api/email/unsubscribe?token='))
})

test('link builders return null when APP_URL is unset — never a "#" placeholder', () => {
  const saved = process.env.APP_URL
  delete process.env.APP_URL
  assert.equal(unsubscribeUrl(EMAIL), null)
  assert.equal(preferencesUrl(EMAIL), null)
  process.env.APP_URL = saved
})

test('a URL-built token survives round-tripping through encodeURIComponent', () => {
  process.env.APP_URL = 'https://app.moveitclearit.com'
  const url = unsubscribeUrl(EMAIL) as string
  const token = decodeURIComponent(new URL(url).searchParams.get('token') as string)
  assert.equal(verifyToken(token)?.email, 'customer@example.com')
})
