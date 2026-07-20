// Offline tests for provider-webhook verification + bounce classification.
// No database, no network — signatures are computed locally.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { verifySvixSignature, isHardBounce } from '../email-events'

const SECRET_RAW = crypto.randomBytes(24).toString('base64')
const SECRET = `whsec_${SECRET_RAW}`
const BODY = JSON.stringify({ type: 'email.bounced', data: { to: ['a@b.com'] } })
const ID = 'msg_2abcDEF'
const NOW_S = 1_784_000_000

function sign(body: string, id: string, ts: number, secret = SECRET_RAW): string {
  const key = Buffer.from(secret, 'base64')
  return crypto.createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64')
}

const headers = (over: Partial<{ id: string; timestamp: string; signature: string }> = {}) => ({
  id: ID,
  timestamp: String(NOW_S),
  signature: `v1,${sign(BODY, ID, NOW_S)}`,
  ...over,
})

test('a correctly signed payload verifies', () => {
  assert.equal(verifySvixSignature(BODY, headers(), SECRET, NOW_S), true)
})

test('the secret works with or without the whsec_ prefix', () => {
  assert.equal(verifySvixSignature(BODY, headers(), SECRET_RAW, NOW_S), true)
})

test('a tampered BODY fails — this is the whole point', () => {
  const forged = JSON.stringify({ type: 'email.complained', data: { to: ['victim@example.com'] } })
  assert.equal(verifySvixSignature(forged, headers(), SECRET, NOW_S), false)
})

test('a wrong secret fails', () => {
  const other = crypto.randomBytes(24).toString('base64')
  assert.equal(verifySvixSignature(BODY, headers(), other, NOW_S), false)
})

test('a replayed OLD timestamp is refused', () => {
  const old = NOW_S - 10 * 60
  const h = { id: ID, timestamp: String(old), signature: `v1,${sign(BODY, ID, old)}` }
  assert.equal(verifySvixSignature(BODY, h, SECRET, NOW_S), false)
})

test('a FUTURE timestamp is refused', () => {
  const future = NOW_S + 10 * 60
  const h = { id: ID, timestamp: String(future), signature: `v1,${sign(BODY, ID, future)}` }
  assert.equal(verifySvixSignature(BODY, h, SECRET, NOW_S), false)
})

test('a timestamp inside the tolerance is accepted', () => {
  const recent = NOW_S - 60
  const h = { id: ID, timestamp: String(recent), signature: `v1,${sign(BODY, ID, recent)}` }
  assert.equal(verifySvixSignature(BODY, h, SECRET, NOW_S), true)
})

test('multiple signatures (secret rotation) verify if ANY matches', () => {
  const h = headers({ signature: `v1,AAAAinvalidAAAA v1,${sign(BODY, ID, NOW_S)}` })
  assert.equal(verifySvixSignature(BODY, h, SECRET, NOW_S), true)
})

test('a non-v1 signature version is ignored', () => {
  assert.equal(
    verifySvixSignature(BODY, headers({ signature: `v2,${sign(BODY, ID, NOW_S)}` }), SECRET, NOW_S),
    false
  )
})

test('missing headers or secret fail CLOSED, never throw', () => {
  assert.equal(verifySvixSignature(BODY, { id: null, timestamp: null, signature: null }, SECRET, NOW_S), false)
  assert.equal(verifySvixSignature(BODY, headers(), '', NOW_S), false)
  assert.equal(verifySvixSignature(BODY, headers({ timestamp: 'not-a-number' }), SECRET, NOW_S), false)
  assert.equal(verifySvixSignature(BODY, headers({ signature: 'garbage-no-comma' }), SECRET, NOW_S), false)
})

// ── bounce classification: only PERMANENT failures suppress ─────────────

test('a permanent bounce is hard — the address is dead', () => {
  assert.equal(isHardBounce({ type: 'Permanent', subType: 'General' }), true)
  assert.equal(isHardBounce({ type: 'Permanent', subType: 'NoSuchUser' }), true)
})

test('a transient bounce is NOT hard — do not suppress a real customer', () => {
  assert.equal(isHardBounce({ type: 'Transient', subType: 'General' }), false)
  assert.equal(isHardBounce({ type: 'Transient', subType: 'MailboxFull' }), false)
})

test('a full mailbox never suppresses, even if reported as permanent', () => {
  assert.equal(isHardBounce({ type: 'Permanent', subType: 'MailboxFull' }), false)
})

test('an UNKNOWN bounce shape does not suppress — ambiguity favours the customer', () => {
  assert.equal(isHardBounce(undefined), false)
  assert.equal(isHardBounce({}), false)
  assert.equal(isHardBounce({ type: 'Weird' }), false)
})
