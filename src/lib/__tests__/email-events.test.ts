// Offline tests for provider-webhook verification + bounce classification.
// No database, no network — signatures are computed locally.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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

// ── provider-side events verified against Resend's published list 2026-07-20 ──

test('email.suppressed causes a SUPPRESSION, not just a recorded event', () => {
  // Resend keeps its OWN suppression list and refuses to send to addresses on
  // it. Before this was mapped, the event fell through to 'ignored' — our table
  // believed the address was fine while every message was silently dropped
  // inside Resend. No bounce ever arrives, because the mail never leaves the
  // provider, so nothing else would have caught it.
  const src = readFileSync(join(__dirname, '..', 'email-events.ts'), 'utf8')
  const block = src.slice(src.indexOf('const SUPPRESSING'), src.indexOf('const EVENT_TYPES'))
  // It must be in the SUPPRESSING map (which drives the side effect), not
  // merely in EVENT_TYPES (which only records).
  assert.match(block, /'email\.suppressed':\s*'PROVIDER_REJECTED'/)
  assert.match(block, /'email\.bounced':\s*'HARD_BOUNCE'/)
  assert.match(block, /'email\.complained':\s*'SPAM_COMPLAINT'/)
})

test('PROVIDER_REJECTED suppresses at scope "all", not promotional-only', () => {
  // A provider refusing to deliver is not a marketing preference — nothing
  // should be sent to that address, receipts included.
  const { scopeForReason } = require('../email-suppression')
  assert.equal(scopeForReason('PROVIDER_REJECTED'), 'all')
  assert.equal(scopeForReason('HARD_BOUNCE'), 'all')
  assert.equal(scopeForReason('SPAM_COMPLAINT'), 'all')
  assert.equal(scopeForReason('UNSUBSCRIBED'), 'promotional')
})

test('the handled event set matches what Resend actually publishes', () => {
  // Guards against the assumption that Resend exposes "only four" events.
  // Checked against resend.com/docs/dashboard/webhooks/event-types.
  const src = readFileSync(join(__dirname, '..', 'email-events.ts'), 'utf8')
  for (const t of [
    'email.sent',
    'email.delivered',
    'email.delivery_delayed',
    'email.bounced',
    'email.complained',
    'email.opened',
    'email.clicked',
    'email.failed',
    'email.suppressed',
  ]) {
    assert.ok(src.includes(`'${t}'`), `event type not handled: ${t}`)
  }
})

test('bounce softness applies ONLY to email.bounced', () => {
  // A complaint and a provider suppression have no "soft" variant — treating
  // them like a bounce would let a spam complaint go unsuppressed.
  const src = readFileSync(join(__dirname, '..', 'email-events.ts'), 'utf8')
  assert.match(src, /resendType === 'email\.bounced' && !isHardBounce/)
})
