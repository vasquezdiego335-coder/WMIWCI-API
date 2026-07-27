import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { senderDomain } from '../email-dns'

// ════════════════════════════════════════════════════════════════════════
//  LIVE DNS CHECKS (audit pass D, 2026-07-27)
//
//  The Deliverability page reported SPF/DKIM/DMARC as "UNVERIFIED, always".
//  Honest, but permanently uninformative — and it hid a real defect: DMARC was
//  published as p=none with NO rua=, so the policy whose entire purpose is
//  reporting was reporting to nobody. Nothing in the product could have shown
//  that; it took a manual dig.
//
//  These tests use no network. The parsing and classification are pure, and
//  that is where every judgement call lives.
// ════════════════════════════════════════════════════════════════════════

const src = readFileSync(resolve(__dirname, '..', 'email-dns.ts'), 'utf8')
const code = src.split('\n').filter((l) => {
  const s = l.trim()
  return !s.startsWith('//') && !s.startsWith('*') && !s.startsWith('/*')
}).join('\n')

test('senderDomain parses the From header, including a display name', () => {
  // DMARC alignment is judged against the From-header domain, so getting this
  // wrong would check the wrong domain entirely and report confident nonsense.
  assert.equal(senderDomain('Move It Clear It <hello@moveitclearit.com>'), 'moveitclearit.com')
  assert.equal(senderDomain('hello@moveitclearit.com'), 'moveitclearit.com')
  assert.equal(senderDomain('HELLO@MoveItClearIt.COM'), 'moveitclearit.com')
  assert.equal(senderDomain(''), null)
  assert.equal(senderDomain('not-an-address'), null)
  assert.equal(senderDomain('broken@localhost'), null, 'a domain with no dot is not usable')
})

test('a DMARC p=none with NO rua is reported as INVALID — the actual finding', () => {
  // The exact record that was live on 2026-07-27 before it was fixed:
  //   "v=DMARC1; p=none;"
  // p=none exists ONLY to gather reports. With no rua= nobody receives them,
  // so the policy neither protects the domain nor reports anything.
  assert.match(code, /policy === 'none' && !rua \? 'INVALID' : 'VERIFIED'/,
    'p=none without rua must not be shown as a healthy configuration')
  assert.match(code, /NO rua= REPORTING ADDRESS/, 'and must say plainly what is missing')
  assert.match(code, /this policy is currently doing nothing at all/, 'and what the consequence is')
})

test('p=none WITH rua is VERIFIED but still advises hardening', () => {
  assert.match(code, /p=none does not protect the domain/, 'monitoring-only must not read as protected')
  assert.match(code, /Move to p=quarantine/, 'and must name the next step')
})

test('SPF: multiple records and +all are INVALID, not warnings', () => {
  // Two SPF records is a permanent error per RFC 7208 — receivers fail it
  // outright, so it is worse than a soft misconfiguration.
  assert.match(code, /MORE THAN ONE SPF record/, 'duplicate SPF must be caught')
  assert.match(code, /RFC 7208/, 'with the reason it is fatal')
  assert.match(code, /authorises the entire internet/, '+all must be caught')
})

test('SPF: a root record without the ESP include is NOT reported as a failure', () => {
  // The trap this avoids: SPF authenticates the ENVELOPE sender, and providers
  // put their include on a bounce subdomain. Demanding it at the root would
  // report a false failure on a correctly-configured domain — which is exactly
  // what moveitclearit.com looks like.
  assert.match(code, /the ESP include commonly sits on the bounce subdomain/, 'must explain rather than flag')
  assert.match(code, /still aligns under DMARC relaxed mode/, 'and state why it is fine')
})

test('DKIM: an EMPTY public key is INVALID, not present', () => {
  // `p=` with nothing after it is how a REVOKED key is published. Treating the
  // record as "exists, therefore fine" would report a green light on a domain
  // whose signatures all fail.
  assert.match(code, /p=\\s\*\(;\|\$\)/, 'must detect an empty p= value')
  assert.match(code, /how a revoked key is published/, 'and name what it means')
})

test('a lookup FAILURE is never reported as a passing check', () => {
  // The worst outcome for a checker: a network error rendering as green.
  assert.match(code, /DNS lookup failed: \$\{error\}\. Status is unknown, not necessarily wrong\./)
  assert.match(code, /status: 'UNVERIFIED'/, 'unknown is its own state, distinct from MISSING')
})

test('"no such record" is an ANSWER, not a lookup failure', () => {
  // ENODATA/ENOTFOUND mean the DNS system successfully told us nothing is
  // published. Treating that as an error would report UNVERIFIED where the
  // honest answer is MISSING.
  assert.match(code, /code === 'ENODATA' \|\| code === 'ENOTFOUND'/)
  assert.match(code, /return \{ records: \[\], error: null \}/)
})

test('DNS can never hang a page render', () => {
  assert.match(code, /LOOKUP_TIMEOUT_MS/, 'lookups must be time-bounded')
  assert.match(code, /Promise\.race/, 'via a race, so a hung resolver cannot block')
})

test('checks never claim more than DNS proves', () => {
  assert.match(code, /it does not prove a given message passes SPF/)
  assert.match(code, /can align for DMARC/, 'DKIM presence enables alignment; it does not guarantee signing')
})

test('the Deliverability page uses the LIVE checks, not the env attestations', () => {
  const page = readFileSync(
    resolve(__dirname, '..', '..', '..', 'app/(admin)/admin/(dashboard)/email-marketing/deliverability/page.tsx'),
    'utf8'
  )
  assert.match(page, /liveDnsChecks\(\)/, 'the page must resolve DNS')
  assert.match(page, /live\.checks\.map/, 'and render the live results')
  // The old permanent-unknown copy must be gone.
  assert.ok(!/reported as <strong>unverified<\/strong> on purpose/.test(page), 'the always-unverified explanation is obsolete')
})
