// Offline tests for the lead-lifecycle trigger logic added to close the
// documented "Known gap" (move reminders + quote recovery were built and tested
// but never fired). These cover the PURE decision the DB helpers delegate to;
// the DB writes themselves are thin and exercised in staging.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LeadStatus } from '@prisma/client'
import { buildQuoteUpdate } from '../leads'

const now = new Date('2026-07-21T15:00:00Z')

test('buildQuoteUpdate: a first quote stamps quotedAt and reports newlyQuoted', () => {
  const { data, newlyQuoted } = buildQuoteUpdate({ status: LeadStatus.NEW, quotedAt: null, estimatedValue: null }, now)
  assert.equal(newlyQuoted, true)
  assert.equal(data.quotedAt, now)
  assert.equal(data.status, LeadStatus.QUOTE_SENT)
  assert.equal(data.lastActivityAt, now)
})

test('buildQuoteUpdate: a re-quote does NOT restart the clock (newlyQuoted false, quotedAt untouched)', () => {
  const earlier = new Date('2026-07-01T00:00:00Z')
  const { data, newlyQuoted } = buildQuoteUpdate(
    { status: LeadStatus.QUOTE_SENT, quotedAt: earlier, estimatedValue: 50000 },
    now
  )
  assert.equal(newlyQuoted, false)
  assert.ok(!('quotedAt' in data), 'must not rewrite quotedAt on a re-quote')
})

test('buildQuoteUpdate: status advances to QUOTE_SENT only from an OPEN status', () => {
  // FOLLOW_UP is open → advances.
  const open = buildQuoteUpdate({ status: LeadStatus.FOLLOW_UP, quotedAt: null, estimatedValue: null }, now)
  assert.equal(open.data.status, LeadStatus.QUOTE_SENT)
  // Already QUOTE_SENT → no redundant status write.
  const already = buildQuoteUpdate({ status: LeadStatus.QUOTE_SENT, quotedAt: null, estimatedValue: null }, now)
  assert.ok(!('status' in already.data), 'must not re-set an already QUOTE_SENT status')
})

test('buildQuoteUpdate: a real estimate fills only when none exists (never clobbers a curated value)', () => {
  const filled = buildQuoteUpdate({ status: LeadStatus.NEW, quotedAt: null, estimatedValue: null }, now, 42000)
  assert.equal(filled.data.estimatedValue, 42000)

  const kept = buildQuoteUpdate({ status: LeadStatus.NEW, quotedAt: null, estimatedValue: 99000 }, now, 42000)
  assert.ok(!('estimatedValue' in kept.data), 'must not overwrite an existing estimate')

  const zeroIgnored = buildQuoteUpdate({ status: LeadStatus.NEW, quotedAt: null, estimatedValue: null }, now, 0)
  assert.ok(!('estimatedValue' in zeroIgnored.data), 'a non-positive estimate is not a real quote value')
})
