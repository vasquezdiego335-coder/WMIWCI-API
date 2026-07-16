import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import {
  attributionSchemaFields,
  attributionColumns,
  attributionLeadInput,
  attributionSummary,
  hasAdClickId,
} from '../attribution'

const schema = z.object({ ...attributionSchemaFields })

test('parses a full paid-click payload to camelCase columns', () => {
  const cols = attributionColumns(
    schema.parse({
      gclid: 'Cj0KCQ_test',
      utm_source: 'google',
      utm_medium: 'cpc',
      utm_campaign: 'essex-moving',
      utm_term: 'movers near me',
      landing_page: 'https://www.moveitclearit.com/movers-west-orange-nj.html',
      first_touch_at: '2026-07-15T12:00:00.000Z',
    }),
  )
  assert.equal(cols.gclid, 'Cj0KCQ_test')
  assert.equal(cols.utmSource, 'google')
  assert.equal(cols.utmCampaign, 'essex-moving')
  assert.equal(cols.landingPage, 'https://www.moveitclearit.com/movers-west-orange-nj.html')
  assert.ok(cols.firstTouchAt instanceof Date)
  assert.equal(cols.firstTouchAt?.toISOString(), '2026-07-15T12:00:00.000Z')
  assert.equal(hasAdClickId(cols), true)
})

test('empty payload → all null, no click id, "—" summary', () => {
  const cols = attributionColumns(schema.parse({}))
  assert.equal(cols.gclid, null)
  assert.equal(cols.firstTouchAt, null)
  assert.equal(hasAdClickId(cols), false)
  assert.equal(attributionSummary(cols), '—')
})

test('attributionLeadInput maps initial_referrer → referrer', () => {
  const li = attributionLeadInput(schema.parse({ initial_referrer: 'https://www.google.com/' }))
  assert.equal(li.referrer, 'https://www.google.com/')
})

test('invalid first_touch_at does not throw and maps to null', () => {
  assert.equal(attributionColumns({ first_touch_at: 'not-a-date' }).firstTouchAt, null)
})

test('over-long values are rejected', () => {
  assert.equal(schema.safeParse({ gclid: 'x'.repeat(300) }).success, false)
})

test('control characters are stripped', () => {
  const p = schema.parse({ utm_campaign: 'sum' + String.fromCharCode(1) + 'mersale' })
  assert.equal(p.utm_campaign, 'summersale')
})

test('summary renders click id + utm compactly', () => {
  const cols = attributionColumns({ gclid: 'abc', utm_source: 'google', utm_medium: 'cpc' })
  assert.equal(attributionSummary(cols), 'gclid=abc · google / cpc')
})
