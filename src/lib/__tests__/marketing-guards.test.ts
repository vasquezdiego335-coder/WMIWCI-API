// P1-1 — the marketing write-path rules. These are the exact predicates the
// /api/admin/marketing routes call (src/lib/marketing-guards.ts), so a passing
// test here is a statement about the routes' behavior, not a parallel
// re-implementation of it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CampaignStatus } from '@prisma/client'
import {
  normalizeSourceKey,
  sourceKeysMatch,
  checkSourceKeyJoin,
  evaluateSpend,
  budgetStatus,
} from '../marketing-guards'

// ── Source key canonicalization ─────────────────────────────────────────────

test('a source key becomes UPPER_SNAKE', () => {
  assert.equal(normalizeSourceKey('Door Hanger'), 'DOOR_HANGER')
  assert.equal(normalizeSourceKey('  google-ads  '), 'GOOGLE_ADS')
  assert.equal(normalizeSourceKey('Door Hanger #3'), 'DOOR_HANGER_3')
})

test('punctuation runs collapse and never leave leading or trailing underscores', () => {
  assert.equal(normalizeSourceKey('--yard//sign--'), 'YARD_SIGN')
  assert.equal(normalizeSourceKey('!!!'), '')
})

test('an already-canonical key is unchanged (normalizing twice is safe)', () => {
  assert.equal(normalizeSourceKey('DOOR_HANGER'), 'DOOR_HANGER')
  assert.equal(normalizeSourceKey(normalizeSourceKey('Door Hanger')), 'DOOR_HANGER')
})

test('keys that differ only in case or spacing are the same campaign', () => {
  assert.equal(sourceKeysMatch('door_hanger', 'DOOR HANGER'), true)
  assert.equal(sourceKeysMatch('GOOGLE_ADS', 'META_ADS'), false)
})

// ── The join hazard ─────────────────────────────────────────────────────────
// resolveAttribution() only trims booking sources, and spend is matched to
// revenue by exact string compare. A near-miss is worse than no match: the cost
// and the revenue it bought land in two unrelated report rows.

test('an exact match is counted and raises no warning', () => {
  const j = checkSourceKeyJoin('DOOR_HANGER', ['DOOR_HANGER', 'DOOR_HANGER', 'GOOGLE_ADS'])
  assert.equal(j.exact, 2)
  assert.equal(j.canonicalOnly.length, 0)
  assert.equal(j.warning, null)
})

test('a case-only mismatch is caught and named — this is the ROAS-corrupting case', () => {
  const j = checkSourceKeyJoin('DOOR_HANGER', ['door_hanger'])
  assert.equal(j.exact, 0)
  assert.deepEqual(j.canonicalOnly, ['door_hanger'])
  assert.ok(j.warning?.includes('door_hanger'))
  assert.ok(j.warning?.includes('NOT aggregate'))
})

test('a brand-new campaign with no bookings is NOT warned about', () => {
  // Zero matches is normal before the campaign runs. Warning here would train
  // the owner to ignore the warning that actually matters.
  const j = checkSourceKeyJoin('NEW_FLYER', ['GOOGLE_ADS', 'REFERRAL'])
  assert.equal(j.exact, 0)
  assert.equal(j.warning, null)
})

test('multiple spellings of the same key are all reported', () => {
  const j = checkSourceKeyJoin('YARD_SIGN', ['yard sign', 'Yard_Sign', 'YARD_SIGN'])
  assert.equal(j.exact, 1)
  assert.equal(j.canonicalOnly.length, 2)
})

// ── Spend rules ─────────────────────────────────────────────────────────────

const SPEND_OK = {
  campaignStatus: CampaignStatus.ACTIVE,
  amountCents: 15000,
  incurredOn: new Date('2026-06-15T12:00:00Z'),
  campaignStart: new Date('2026-06-01T12:00:00Z'),
  campaignEnd: new Date('2026-06-30T12:00:00Z'),
  now: new Date('2026-07-01T12:00:00Z'),
}

test('ordinary spend inside the campaign window is allowed with no warnings', () => {
  const d = evaluateSpend(SPEND_OK)
  assert.equal(d.allow, true)
  assert.deepEqual(d.allow && d.warnings, [])
})

test('an archived campaign refuses spend', () => {
  const d = evaluateSpend({ ...SPEND_OK, campaignStatus: CampaignStatus.ARCHIVED })
  assert.equal(d.allow, false)
  assert.equal(!d.allow && d.status, 409)
})

test('zero and negative amounts are refused', () => {
  assert.equal(evaluateSpend({ ...SPEND_OK, amountCents: 0 }).allow, false)
  assert.equal(evaluateSpend({ ...SPEND_OK, amountCents: -500 }).allow, false)
})

test('a non-integer amount is refused (cents are whole numbers)', () => {
  assert.equal(evaluateSpend({ ...SPEND_OK, amountCents: 150.5 }).allow, false)
})

test('future-dated spend is refused', () => {
  const d = evaluateSpend({ ...SPEND_OK, incurredOn: new Date('2026-08-01T12:00:00Z') })
  assert.equal(d.allow, false)
  assert.equal(!d.allow && d.status, 422)
})

test('a late invoice is ALLOWED but warned — refusing it would push the owner to fake the date', () => {
  const d = evaluateSpend({ ...SPEND_OK, incurredOn: new Date('2026-06-05T12:00:00Z'), campaignStart: new Date('2026-06-10T12:00:00Z') })
  assert.equal(d.allow, true)
  assert.ok(d.allow && d.warnings.some((w) => w.includes('before the campaign start')))
})

test('spend after the campaign end is allowed and warned', () => {
  const d = evaluateSpend({ ...SPEND_OK, incurredOn: new Date('2026-06-29T12:00:00Z'), campaignEnd: new Date('2026-06-20T12:00:00Z') })
  assert.equal(d.allow, true)
  assert.ok(d.allow && d.warnings.some((w) => w.includes('after the campaign end')))
})

test('DRAFT spend is allowed but flagged as invisible to the report', () => {
  // loadMarketingReport only reads ACTIVE/PAUSED/COMPLETED campaigns, so DRAFT
  // spend really is excluded — the owner must be told, not left guessing.
  const d = evaluateSpend({ ...SPEND_OK, campaignStatus: CampaignStatus.DRAFT })
  assert.equal(d.allow, true)
  assert.ok(d.allow && d.warnings.some((w) => w.includes('DRAFT')))
})

test('spend exactly one day ahead is tolerated (timezone slack), two days is not', () => {
  const now = new Date('2026-07-01T12:00:00Z')
  assert.equal(evaluateSpend({ ...SPEND_OK, now, campaignEnd: null, incurredOn: new Date('2026-07-02T06:00:00Z') }).allow, true)
  assert.equal(evaluateSpend({ ...SPEND_OK, now, campaignEnd: null, incurredOn: new Date('2026-07-03T12:00:00Z') }).allow, false)
})

// ── Budget (advisory only) ──────────────────────────────────────────────────

test('no budget set means nothing to be over', () => {
  assert.deepEqual(budgetStatus(50000, null), { overBudget: false, remainingCents: null, usedBp: null })
  assert.deepEqual(budgetStatus(50000, 0), { overBudget: false, remainingCents: null, usedBp: null })
})

test('over budget is reported, not blocked — the money was really spent', () => {
  const b = budgetStatus(60000, 50000)
  assert.equal(b.overBudget, true)
  assert.equal(b.remainingCents, -10000)
  assert.equal(b.usedBp, 12000) // 120%
})

test('spend exactly at budget is not over', () => {
  const b = budgetStatus(50000, 50000)
  assert.equal(b.overBudget, false)
  assert.equal(b.remainingCents, 0)
  assert.equal(b.usedBp, 10000)
})
