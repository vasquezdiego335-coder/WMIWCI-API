import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import {
  attributionSchemaFields,
  attributionColumns,
  attributionSummary,
  hasAdClickId,
} from '../attribution'

const schema = z.object({ ...attributionSchemaFields })

test('parses and maps a full paid-click payload to columns', () => {
  const parsed = schema.parse({
    gclid: 'Cj0KCQ_test',
    utm_source: 'google',
    utm_medium: 'cpc',
    utm_campaign: 'essex-moving',
    utm_term: 'movers near me',
    utm_content: 'ad-a',
    landing_page: 'https://www.moveitclearit.com/west-orange-movers',
    initial_referrer: 'https://www.google.com/',
    first_touch_at: '2026-07-15T12:00:00.000Z',
  })
  const cols = attributionColumns(parsed)
  assert.equal(cols.gclid, 'Cj0KCQ_test')
  assert.equal(cols.utmSource, 'google')
  assert.equal(cols.utmMedium, 'cpc')
  assert.equal(cols.utmCampaign, 'essex-moving')
  assert.equal(cols.utmTerm, 'movers near me')
  assert.equal(cols.landingPage, 'https://www.moveitclearit.com/west-orange-movers')
  assert.ok(cols.firstTouchAt instanceof Date)
  assert.equal(cols.firstTouchAt?.toISOString(), '2026-07-15T12:00:00.000Z')
  assert.equal(hasAdClickId(cols), true)
})

test('empty payload yields all-null columns and no ad click id', () => {
  const cols = attributionColumns(schema.parse({}))
  assert.equal(cols.gclid, null)
  assert.equal(cols.utmSource, null)
  assert.equal(cols.firstTouchAt, null)
  assert.equal(hasAdClickId(cols), false)
  assert.equal(attributionSummary(cols), '—')
})

test('invalid first_touch_at does not throw and maps to null', () => {
  const cols = attributionColumns({ first_touch_at: 'not-a-date' })
  assert.equal(cols.firstTouchAt, null)
})

test('length caps reject over-long values', () => {
  const res = schema.safeParse({ gclid: 'x'.repeat(300) })
  assert.equal(res.success, false)
})

test('control characters are stripped from values', () => {
  const parsed = schema.parse({ utm_campaign: 'sum' + String.fromCharCode(1) + 'mersale' })
  assert.equal(parsed.utm_campaign, 'summersale')
})

test('summary renders click id + utm compactly', () => {
  const cols = attributionColumns({ gclid: 'abc', utm_source: 'google', utm_medium: 'cpc' })
  assert.equal(attributionSummary(cols), 'gclid=abc · google / cpc')
})
