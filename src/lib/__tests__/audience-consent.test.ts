import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// ════════════════════════════════════════════════════════════════════════
//  PROMOTIONAL CONSENT ON EVERY SEGMENT (near-miss 2026-07-25).
//
//  Consent was enforced only inside leadWhere(), so it covered LEAD segments
//  and nothing else. bookingWhere() filters on isInternalTest alone — so every
//  BOOKING-based segment resolved customers who had never opted in. Caught
//  while rehearsing a "1 recipient" campaign that actually resolved SIX people,
//  five with emailMarketingConsent = null, two of them real customers.
//
//  Enforcement lives at the shared, email-keyed choke point that BOTH
//  previewAudience and resolveAudienceDetailed run, so the rule holds for every
//  segment — including segments added later. These tests pin that property.
// ════════════════════════════════════════════════════════════════════════

const SRC = resolve(__dirname, '../email-audience.ts')
const src = () => readFileSync(SRC, 'utf8')
/** Source minus `//` comments — a rule about CODE must not be satisfied by prose. */
const code = () => src().split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')

test('a single consent resolver exists and requires an EXPLICIT opt-in', () => {
  const s = code()
  assert.ok(/async function consentingEmails\(/.test(s), 'consentingEmails() must exist')
  // Must query for emailMarketingConsent: true — never "not false", which would
  // let null (no decision recorded) through as if it were permission.
  assert.ok(s.includes('emailMarketingConsent: true'), 'must require an explicit true')
  assert.ok(!/emailMarketingConsent:\s*\{\s*not:\s*false/.test(s), 'null must NOT count as consent')
})

test('consent is checked on BOTH the preview and the dispatch path', () => {
  const s = code()
  const uses = (s.match(/consentingEmails\(emails\)/g) || []).length
  assert.equal(uses, 2, 'both previewAudience and resolveAudienceDetailed must resolve consent')
  assert.ok(s.includes("reason: 'no_consent'"), 'dispatch path must exclude with no_consent')
  assert.ok(s.includes('base.excluded.noConsent++'), 'preview path must count noConsent')
})

test('the gate FAILS CLOSED — absence of consent excludes', () => {
  const s = code()
  // The guard must be `!consenting.has(...)` — i.e. you are out unless proven in.
  assert.ok(/if \(!consenting\.has\(c\.email\)\)/.test(s), 'must exclude when consent is absent')
  assert.ok(!/if \(consenting\.has\(c\.email\)\)\s*\{\s*continue/.test(s), 'must not invert the gate')
})

test('consent is honoured from EITHER a Customer or a Lead record', () => {
  const s = code()
  assert.ok(/prisma\.customer\.findMany/.test(s) && /prisma\.lead\.findMany/.test(s),
    'a person may be a Customer, a Lead, or both — check both')
})

test('booking segments no longer rely on bookingWhere alone for consent', () => {
  // bookingWhere() legitimately has no consent clause (consent is not a booking
  // column). The protection must therefore exist at the shared choke point —
  // this pins that we did not "fix" it by editing bookingWhere.
  const s = code()
  const bw = s.slice(s.indexOf('function bookingWhere'), s.indexOf('function bookingWhere') + 900)
  assert.ok(!bw.includes('emailMarketingConsent'), 'bookingWhere is not where consent belongs')
  assert.ok(s.includes('async function consentingEmails('), 'the shared gate must exist instead')
})
