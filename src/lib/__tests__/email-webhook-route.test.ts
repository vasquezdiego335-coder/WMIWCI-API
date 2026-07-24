import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// ════════════════════════════════════════════════════════════════════════
//  WEBHOOK ROUTE CONTRACT (production incident 2026-07-24).
//
//  Resend was registered against the app ROOT (no path). Next.js serves a PAGE
//  at `/`, which accepts GET only, so every webhook POST got `405 Method Not
//  Allowed` with an HTML error body — and no provider event was ever recorded,
//  which meant bounces and complaints could never reach the suppression list.
//
//  The endpoint itself was always correct. These tests pin the properties that
//  make it correct, so a future refactor cannot silently reintroduce the
//  failure mode (a route that answers GET, or one that parses JSON before
//  verifying the signature and thereby breaks verification).
// ════════════════════════════════════════════════════════════════════════

const ROUTE = resolve(__dirname, '../../../app/api/email/webhook/route.ts')
const src = () => readFileSync(ROUTE, 'utf8')

test('the webhook route exists at app/api/email/webhook and exports POST', () => {
  const s = src()
  assert.ok(/export\s+async\s+function\s+POST\s*\(/.test(s), 'route must export a POST handler')
})

test('signature verification reads the RAW body (never req.json() first)', () => {
  const s = src()
  // Re-serializing the payload changes bytes and invalidates the HMAC, so the
  // handler must take the raw text before anything else touches the body.
  assert.ok(/await\s+req\.text\(\)/.test(s), 'must read the raw body with req.text()')
  // Compare against the ACTUAL call (`await req.json()`), not the reference to
  // req.json() inside the explanatory comment above the raw-body read.
  const rawIdx = s.indexOf('await req.text()')
  const jsonIdx = s.indexOf('await req.json()')
  assert.ok(jsonIdx === -1 || rawIdx < jsonIdx, 'req.json() must never precede the raw-body read')
})

test('the svix signature headers are all read', () => {
  const s = src()
  for (const h of ['svix-id', 'svix-timestamp', 'svix-signature']) {
    assert.ok(s.includes(h), `must read the ${h} header`)
  }
})

test('the signing secret is read from RESEND_WEBHOOK_SECRET and never logged', () => {
  const s = src()
  assert.ok(s.includes('RESEND_WEBHOOK_SECRET'), 'must reference RESEND_WEBHOOK_SECRET')
  assert.ok(
    !/console\.log\([^)]*RESEND_WEBHOOK_SECRET/.test(s),
    'the signing secret must never be logged'
  )
})
