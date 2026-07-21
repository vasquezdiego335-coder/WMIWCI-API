// ============================================================================
// labor-rates.test.ts — Stage 4 D6: the owner's labor-rate configuration.
//
// The tests that matter here are the REFUSALS and the NON-EVENTS: who cannot
// change a rate, what a blank rate is NOT, and the fact that a rate change
// leaves every historical assignment exactly where it was.
// ============================================================================

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveOwnerEconomicRateCents, hasUsableRate, evaluateRateChange, buildRateAudit,
  describeLaborSetup, renderLaborSetupText, LABOR_SETUP_TITLE, OWNER_RATE_EXPLANATION,
  NOT_CONFIGURED, MAX_RATE_CENTS, type RateProfile,
} from '../labor-rates'
import { buildRateSnapshot } from '../labor-calc'

const diego: RateProfile = { id: 'u1', name: 'Diego', role: 'OWNER', active: true, workerType: 'OWNER' }
const sebastian: RateProfile = { id: 'u2', name: 'Sebastian', role: 'OWNER', active: true, workerType: 'OWNER' }
const crew: RateProfile = { id: 'u3', name: 'Worker', role: 'CREW', active: true, payRateCents: 2200 }

// ── Who may change a rate ───────────────────────────────────────────────────

test('an OWNER can configure Diego’s owner labor rate', () => {
  const d = evaluateRateChange({ role: 'OWNER', patch: { ownerEconomicRateCents: 4500 } })
  assert.equal(d.allow, true)
  assert.equal(d.allow && d.patch.ownerEconomicRateCents, 4500)
})

test('an OWNER can configure Sebastian’s owner labor rate', () => {
  const d = evaluateRateChange({ role: 'OWNER', patch: { ownerEconomicRateCents: 5000, rateNotes: 'agreed 2026-07-21' } })
  assert.equal(d.allow, true)
})

test('a MANAGER is refused — rates are owner-financial authority', () => {
  const d = evaluateRateChange({ role: 'MANAGER', patch: { ownerEconomicRateCents: 4500 } })
  assert.equal(d.allow, false)
  assert.equal(d.allow === false && d.status, 403)
})

test('CREW is refused', () => {
  const d = evaluateRateChange({ role: 'CREW', patch: { payRateCents: 9999 } })
  assert.equal(d.allow, false)
  assert.equal(d.allow === false && d.status, 403)
})

test('no session at all is refused', () => {
  assert.equal(evaluateRateChange({ role: null, patch: { payRateCents: 2000 } }).allow, false)
})

// ── A missing rate is UNKNOWN, never $0 ─────────────────────────────────────

test('an explicit $0 owner labor rate is refused, and the message offers blank instead', () => {
  const d = evaluateRateChange({ role: 'OWNER', patch: { ownerEconomicRateCents: 0 } })
  assert.equal(d.allow, false)
  assert.equal(d.allow === false && d.status, 422)
  assert.match(d.allow === false ? d.error : '', /not decided yet/i)
})

test('CLEARING a rate to null is allowed — an empty rate is a valid state', () => {
  const d = evaluateRateChange({ role: 'OWNER', patch: { ownerEconomicRateCents: null } })
  assert.equal(d.allow, true)
})

test('resolution never invents a rate', () => {
  assert.equal(resolveOwnerEconomicRateCents({}), null)
  assert.equal(resolveOwnerEconomicRateCents({ profileRateCents: null, businessDefaultCents: null }), null)
  assert.equal(resolveOwnerEconomicRateCents({ profileRateCents: 0, businessDefaultCents: 0 }), null)
})

test('the owner’s OWN rate wins over the business-wide default', () => {
  assert.equal(resolveOwnerEconomicRateCents({ profileRateCents: 4500, businessDefaultCents: 3000 }), 4500)
  assert.equal(resolveOwnerEconomicRateCents({ businessDefaultCents: 3000 }), 3000)
})

test('a typo-sized rate is refused', () => {
  const d = evaluateRateChange({ role: 'OWNER', patch: { ownerEconomicRateCents: MAX_RATE_CENTS + 1 } })
  assert.equal(d.allow, false)
})

test('a missing rate remains a blocker: the profile reports no usable rate', () => {
  assert.equal(hasUsableRate(diego), false)
  assert.equal(hasUsableRate({ ...diego, ownerEconomicRateCents: 4500 }), true)
  assert.equal(hasUsableRate(crew), true)
  assert.equal(hasUsableRate({ ...crew, payRateCents: null }), false)
  // A FLAT worker is priced by their flat rate, not by an hourly one.
  assert.equal(hasUsableRate({ ...crew, payRateCents: null, defaultPayModel: 'FLAT', defaultFlatRateCents: 20000 }), true)
})

// ── History does not move ───────────────────────────────────────────────────

test('an existing JobCrew rate snapshot is unchanged when the profile rate changes', () => {
  // The snapshot is taken ONCE, from the values in force at assignment.
  const atAssignment = buildRateSnapshot({
    payModel: 'HOURLY', hourlyRateCents: null, userProfilePayRateCents: 2200,
    ownerEconomicRateCents: 3000, workerType: 'EMPLOYEE', overtimeMultiplierPct: 150,
  })
  assert.equal(atAssignment.hourlyRateCentsSnapshot, 2200)

  // The owner later raises the profile rate. Recomputing the snapshot for a NEW
  // assignment gives the new number; the old object is untouched, which is what
  // keeps a past move's cost from being rewritten.
  const afterRaise = buildRateSnapshot({
    payModel: 'HOURLY', hourlyRateCents: null, userProfilePayRateCents: 3000,
    ownerEconomicRateCents: 3000, workerType: 'EMPLOYEE', overtimeMultiplierPct: 150,
  })
  assert.equal(atAssignment.hourlyRateCentsSnapshot, 2200)
  assert.equal(afterRaise.hourlyRateCentsSnapshot, 3000)
})

test('an OWNER assignment with no configured rate snapshots NULL, not $30/h', () => {
  const s = buildRateSnapshot({ payModel: 'UNPAID_OWNER', workerType: 'OWNER', ownerEconomicRateCents: null })
  assert.equal(s.economicRateCentsSnapshot, null)
})

test('an OWNER assignment WITH a configured rate snapshots that rate', () => {
  const s = buildRateSnapshot({ payModel: 'UNPAID_OWNER', workerType: 'OWNER', ownerEconomicRateCents: 4500 })
  assert.equal(s.economicRateCentsSnapshot, 4500)
})

// ── Auditing ────────────────────────────────────────────────────────────────

test('a rate update is auditable: both values, only for fields that moved', () => {
  const entry = buildRateAudit({
    targetUserId: 'u1', targetUserName: 'Diego',
    before: { ...diego, ownerEconomicRateCents: 3000 },
    patch: { ownerEconomicRateCents: 4500, canDrive: true },
    byName: 'Diego',
  })
  const changes = entry.changes as Record<string, { from: unknown; to: unknown }>
  assert.deepEqual(changes.ownerEconomicRateCents, { from: 3000, to: 4500 })
  assert.deepEqual(changes.canDrive, { from: false, to: true })
  // Nothing else moved, so nothing else is recorded as having moved.
  assert.equal(changes.payRateCents, undefined)
  assert.equal(entry.historicalRatesUnchanged, true)
})

test('an unchanged value is not recorded as a change', () => {
  const entry = buildRateAudit({
    targetUserId: 'u1', targetUserName: 'Diego',
    before: { ...diego, ownerEconomicRateCents: 4500 },
    patch: { ownerEconomicRateCents: 4500 },
    byName: 'Diego',
  })
  assert.deepEqual(entry.changes, {})
})

// ── The owner-facing panel ──────────────────────────────────────────────────

test('the panel reads exactly as the owner agreed', () => {
  const view = describeLaborSetup([diego, sebastian])
  const text = renderLaborSetupText(view)
  assert.match(text, /^Financial labor setup/)
  assert.match(text, /Diego owner labor rate: Not configured/)
  assert.match(text, /Sebastian owner labor rate: Not configured/)
  assert.match(text, /Active crew members: 0/)
  assert.equal(view.title, LABOR_SETUP_TITLE)
})

test('the explanation separates labor cost from the 30% profit allocations', () => {
  const view = describeLaborSetup([diego, sebastian])
  assert.equal(view.explanation, OWNER_RATE_EXPLANATION)
  assert.match(view.explanation, /economic cost of owner work/)
  assert.match(view.explanation, /separate from the 30% owner profit allocations/)
})

test('a configured rate is shown as money; an unconfigured one never is', () => {
  const view = describeLaborSetup([{ ...diego, ownerEconomicRateCents: 4500 }, sebastian])
  assert.equal(view.ownerLines[0].value, '$45.00/hour')
  assert.equal(view.ownerLines[1].value, NOT_CONFIGURED)
  assert.equal(view.ownerRatesReady, false)
})

test('the panel is ready only when EVERY owner has a rate', () => {
  const both = describeLaborSetup([
    { ...diego, ownerEconomicRateCents: 4500 },
    { ...sebastian, ownerEconomicRateCents: 4500 },
  ])
  assert.equal(both.ownerRatesReady, true)
})

test('active crew are counted; inactive ones are not', () => {
  const view = describeLaborSetup([diego, crew, { ...crew, id: 'u4', name: 'Old', active: false }])
  assert.equal(view.activeCrewLine.value, '1')
})

test('the panel never prints a number that could be mistaken for a rate', () => {
  const view = describeLaborSetup([diego, sebastian])
  const blob = JSON.stringify(view)
  assert.ok(!/\$\d/.test(blob.replace(/\$0\b/g, '')))
  assert.ok(blob.includes(NOT_CONFIGURED))
})
