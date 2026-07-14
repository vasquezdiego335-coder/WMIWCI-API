// Offline unit tests for the public booking reference (WMIC-####).
// Run: npm test  (tsx --test)  — no DB, no network.
//
// The DB-level guarantees (unique generation, no collision under concurrent
// creation, immutability, backfill idempotency) are provided by the atomic
// Postgres sequence + guarded updateMany. Since those can't run offline, the
// final test asserts the migration actually DECLARES those mechanisms — so a
// future edit that swaps the sequence for an unsafe count+1 or a random number
// fails CI.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  formatBookingReference,
  isBookingReference,
  normalizeBookingReference,
  publicRef,
  BOOKING_REF_PREFIX,
} from '../booking-reference'

// ── formatting ──────────────────────────────────────────────────────────────
test('ref: format pads to at least 4 digits and prefixes WMIC-', () => {
  assert.equal(formatBookingReference(1000), 'WMIC-1000')
  assert.equal(formatBookingReference(1042), 'WMIC-1042')
  assert.equal(formatBookingReference(7), 'WMIC-0007')
  assert.equal(formatBookingReference(123456), 'WMIC-123456')
  assert.equal(formatBookingReference(BigInt(1000)), 'WMIC-1000') // bigint from nextval
  assert.equal(BOOKING_REF_PREFIX, 'WMIC-')
})

// ── validation ──────────────────────────────────────────────────────────────
test('ref: isBookingReference accepts canonical + lenient forms, rejects junk', () => {
  assert.equal(isBookingReference('WMIC-1042'), true)
  assert.equal(isBookingReference('wmic-1042'), true)
  assert.equal(isBookingReference('WMIC1042'), true) // missing dash tolerated
  assert.equal(isBookingReference(' WMIC-1042 '), true)
  assert.equal(isBookingReference('1042'), false) // bare number is not a full reference
  assert.equal(isBookingReference('WMIC-12'), false) // too few digits
  assert.equal(isBookingReference('ABCD-1042'), false)
  assert.equal(isBookingReference(''), false)
})

// ── search normalisation (feeds the admin search where-clause) ──────────────
test('ref: normalize maps user input to the canonical stored form', () => {
  assert.equal(normalizeBookingReference('WMIC-1042'), 'WMIC-1042')
  assert.equal(normalizeBookingReference('wmic-1042'), 'WMIC-1042')
  assert.equal(normalizeBookingReference('wmic1042'), 'WMIC-1042')
  assert.equal(normalizeBookingReference('WMIC 1042'), 'WMIC-1042')
  assert.equal(normalizeBookingReference('  1042 '), 'WMIC-1042') // bare number → reference
  assert.equal(normalizeBookingReference('1000'), 'WMIC-1000')
  // Non-references fall through (search then treats the term as name/email/etc.)
  assert.equal(normalizeBookingReference('john@example.com'), null)
  assert.equal(normalizeBookingReference('Diego'), null)
  assert.equal(normalizeBookingReference('12'), null) // too short to be a ref
  assert.equal(normalizeBookingReference(''), null)
})

// ── public display: reference wins, safe fallback for legacy rows ───────────
test('ref: publicRef prefers bookingReference, falls back to displayId then id', () => {
  assert.equal(publicRef({ bookingReference: 'WMIC-1042', displayId: 'cuid_x', id: 'cuid_id' }), 'WMIC-1042')
  assert.equal(publicRef({ bookingReference: null, displayId: 'cuid_x', id: 'cuid_id' }), 'cuid_x')
  assert.equal(publicRef({ bookingReference: null, displayId: null, id: 'cuid_id' }), 'cuid_id')
  assert.equal(publicRef({}), '—')
})

// ── the internal cuid is never a public reference (identifiers stay separate) ─
test('ref: a cuid is not mistaken for a public reference', () => {
  assert.equal(isBookingReference('cmrjblxtl0004s1a665vzliw9'), false)
  assert.equal(normalizeBookingReference('cmrjblxtl0004s1a665vzliw9'), null)
})

// ── migration guard: the concurrency-safe mechanism must stay in place ───────
test('ref: migration declares an atomic sequence + unique index (no count+1/random)', () => {
  const sql = readFileSync(
    join(__dirname, '..', '..', '..', 'prisma', 'migrations', '20260713120000_booking_reference', 'migration.sql'),
    'utf8',
  )
  assert.match(sql, /CREATE SEQUENCE IF NOT EXISTS booking_reference_seq/i, 'must use a DB sequence')
  assert.match(sql, /nextval\('booking_reference_seq'\)/i, 'default must draw from the sequence')
  assert.match(sql, /CREATE UNIQUE INDEX[\s\S]*booking_reference/i, 'must enforce uniqueness at the DB')
  // Guard against a regression to an unsafe scheme.
  assert.doesNotMatch(sql, /count\s*\+\s*1/i, 'must not use count+1')
  assert.doesNotMatch(sql, /random\(\)/i, 'must not use random()')
})
