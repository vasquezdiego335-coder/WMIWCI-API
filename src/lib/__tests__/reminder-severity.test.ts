// Offline boundary tests for deterministic severity (increment 2.1). Uses a
// fixed clock — never the real time.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  severityByLeadTime, daysUntil, computeFingerprint, unpaidBalanceSeverity, negativeProfitSeverity,
  ADDRESS_TIERS, ADDRESS_FALLBACK, MISSING_ADDRESS_TIERS, MISSING_ADDRESS_FALLBACK, DAY_MS,
} from '../reminder-severity'

const NOW = new Date('2026-07-13T12:00:00-04:00')
const inDays = (d: number) => new Date(NOW.getTime() + d * DAY_MS)
const inHours = (h: number) => new Date(NOW.getTime() + h * 3_600_000)

test('daysUntil: positive, negative, null', () => {
  assert.equal(daysUntil(inDays(2), NOW), 2)
  assert.equal(daysUntil(inDays(-1), NOW), -1)
  assert.equal(daysUntil(null, NOW), null)
})

test('address tiers: <24h CRITICAL, 1-3d HIGH, >3d MEDIUM, past/none MEDIUM', () => {
  assert.equal(severityByLeadTime(inHours(6), NOW, ADDRESS_TIERS, ADDRESS_FALLBACK), 'CRITICAL')
  assert.equal(severityByLeadTime(inDays(2), NOW, ADDRESS_TIERS, ADDRESS_FALLBACK), 'HIGH')
  assert.equal(severityByLeadTime(inDays(7), NOW, ADDRESS_TIERS, ADDRESS_FALLBACK), 'MEDIUM')
  assert.equal(severityByLeadTime(inDays(-1), NOW, ADDRESS_TIERS, ADDRESS_FALLBACK), 'MEDIUM')
  assert.equal(severityByLeadTime(null, NOW, ADDRESS_TIERS, ADDRESS_FALLBACK), 'MEDIUM')
})

test('exact boundaries are inclusive of the tighter tier', () => {
  // Exactly 1.0 day → still CRITICAL (<= 1). Exactly 3.0 days → HIGH (<= 3).
  assert.equal(severityByLeadTime(inDays(1), NOW, ADDRESS_TIERS, ADDRESS_FALLBACK), 'CRITICAL')
  assert.equal(severityByLeadTime(inDays(3), NOW, ADDRESS_TIERS, ADDRESS_FALLBACK), 'HIGH')
  // One minute past the 1-day boundary → HIGH; one minute before → CRITICAL.
  assert.equal(severityByLeadTime(new Date(inDays(1).getTime() + 60_000), NOW, ADDRESS_TIERS, ADDRESS_FALLBACK), 'HIGH')
  assert.equal(severityByLeadTime(new Date(inDays(1).getTime() - 60_000), NOW, ADDRESS_TIERS, ADDRESS_FALLBACK), 'CRITICAL')
  // One minute past the 3-day boundary → MEDIUM.
  assert.equal(severityByLeadTime(new Date(inDays(3).getTime() + 60_000), NOW, ADDRESS_TIERS, ADDRESS_FALLBACK), 'MEDIUM')
})

test('missing-address floor is HIGH, not MEDIUM', () => {
  assert.equal(severityByLeadTime(inDays(2), NOW, MISSING_ADDRESS_TIERS, MISSING_ADDRESS_FALLBACK), 'CRITICAL')
  assert.equal(severityByLeadTime(inDays(10), NOW, MISSING_ADDRESS_TIERS, MISSING_ADDRESS_FALLBACK), 'HIGH')
})

test('unpaid-balance severity by amount and age', () => {
  assert.equal(unpaidBalanceSeverity(41000, 0), 'HIGH') // $410 ≥ $250
  assert.equal(unpaidBalanceSeverity(5000, 0), 'MEDIUM') // small + fresh
  assert.equal(unpaidBalanceSeverity(5000, 8), 'HIGH') // small but overdue 8d
  assert.equal(unpaidBalanceSeverity(0, 0), 'LOW')
})

test('negative-profit severity by loss magnitude', () => {
  assert.equal(negativeProfitSeverity(-20000), 'HIGH') // -$200
  assert.equal(negativeProfitSeverity(-5000), 'MEDIUM') // -$50
})

test('fingerprint is deterministic and changes with material state', () => {
  const a = computeFingerprint({ reminderType: 'x', severity: 'HIGH', dueAt: inDays(1), description: 'owes $410' })
  const b = computeFingerprint({ reminderType: 'x', severity: 'HIGH', dueAt: inDays(1), description: 'owes $410' })
  assert.equal(a, b) // stable
  const c = computeFingerprint({ reminderType: 'x', severity: 'HIGH', dueAt: inDays(1), description: 'owes $500' })
  assert.notEqual(a, c) // amount changed → fingerprint changed
  const d = computeFingerprint({ reminderType: 'x', severity: 'CRITICAL', dueAt: inDays(1), description: 'owes $410' })
  assert.notEqual(a, d) // severity changed → fingerprint changed
})
