// Offline tests for the pure lead-pipeline state machine (Moving OS Phase 1,
// Stage 2C). Every allowed action, the LOST-requires-reason rule, the
// BOOKED-is-unreachable hard rule, reopen clearing the loss fields, and the
// first-wins contactedAt idempotency.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LeadStatus, LeadLostReason } from '@prisma/client'
import {
  ALLOWED_LEAD_ACTIONS,
  LEAD_ACTIONS,
  OPEN_LEAD_STATUSES,
  allowedActionsFor,
  applyLeadAction,
  buildManualLeadCreate,
  type LeadAction,
  type LeadForTransition,
} from '../lead-transitions'

const NOW = new Date('2026-08-11T15:00:00.000Z')
const EARLIER = new Date('2026-08-01T10:00:00.000Z')

const lead = (status: LeadStatus, contactedAt: Date | null = null): LeadForTransition => ({ status, contactedAt })

function dataOf(res: ReturnType<typeof applyLeadAction>): Record<string, unknown> {
  assert.equal(res.error, undefined, `expected success, got error: ${res.error}`)
  return res.data as Record<string, unknown>
}

// ── Every allowed action ─────────────────────────────────────────────────────

test('mark_contacted: NEW → CONTACTED and stamps contactedAt', () => {
  const d = dataOf(applyLeadAction(lead(LeadStatus.NEW), 'mark_contacted', {}, NOW))
  assert.equal(d.status, LeadStatus.CONTACTED)
  assert.equal(d.contactedAt, NOW)
  assert.equal(d.lastActivityAt, NOW)
})

test('mark_contacted is refused from any non-NEW status', () => {
  for (const s of [LeadStatus.CONTACTED, LeadStatus.QUOTE_SENT, LeadStatus.FOLLOW_UP, LeadStatus.BOOKED, LeadStatus.LOST]) {
    const res = applyLeadAction(lead(s), 'mark_contacted', {}, NOW)
    assert.ok(res.error, `expected refusal from ${s}`)
  }
})

test('contactedAt is FIRST-WINS: an already-stamped lead keeps its original time', () => {
  const d = dataOf(applyLeadAction(lead(LeadStatus.NEW, EARLIER), 'mark_contacted', {}, NOW))
  assert.equal(d.status, LeadStatus.CONTACTED)
  // The patch must NOT touch contactedAt at all — the first stamp survives.
  assert.equal('contactedAt' in d, false)
})

test('set_follow_up: CONTACTED and QUOTE_SENT → FOLLOW_UP, nothing else', () => {
  for (const s of [LeadStatus.CONTACTED, LeadStatus.QUOTE_SENT]) {
    const d = dataOf(applyLeadAction(lead(s), 'set_follow_up', {}, NOW))
    assert.equal(d.status, LeadStatus.FOLLOW_UP)
    assert.equal(d.lastActivityAt, NOW)
  }
  for (const s of [LeadStatus.NEW, LeadStatus.FOLLOW_UP, LeadStatus.BOOKED, LeadStatus.LOST]) {
    assert.ok(applyLeadAction(lead(s), 'set_follow_up', {}, NOW).error, `expected refusal from ${s}`)
  }
})

test('mark_lost: any OPEN status → LOST with reason + lostAt', () => {
  for (const s of OPEN_LEAD_STATUSES) {
    const d = dataOf(applyLeadAction(lead(s), 'mark_lost', { lostReason: LeadLostReason.NO_RESPONSE }, NOW))
    assert.equal(d.status, LeadStatus.LOST)
    assert.equal(d.lostReason, LeadLostReason.NO_RESPONSE)
    assert.equal(d.lostAt, NOW)
  }
})

test('mark_lost REQUIRES a valid reason', () => {
  assert.ok(applyLeadAction(lead(LeadStatus.NEW), 'mark_lost', {}, NOW).error)
  assert.ok(applyLeadAction(lead(LeadStatus.NEW), 'mark_lost', { lostReason: null }, NOW).error)
  assert.ok(applyLeadAction(lead(LeadStatus.NEW), 'mark_lost', { lostReason: 'GHOSTED' as LeadLostReason }, NOW).error)
})

test('mark_lost is refused on closed leads (BOOKED / LOST)', () => {
  for (const s of [LeadStatus.BOOKED, LeadStatus.LOST]) {
    assert.ok(applyLeadAction(lead(s), 'mark_lost', { lostReason: LeadLostReason.OTHER }, NOW).error)
  }
})

test('reopen: LOST → NEW and CLEARS both loss fields', () => {
  const d = dataOf(applyLeadAction(lead(LeadStatus.LOST), 'reopen', {}, NOW))
  assert.equal(d.status, LeadStatus.NEW)
  assert.equal(d.lostReason, null)
  assert.equal(d.lostAt, null)
  assert.equal(d.lastActivityAt, NOW)
})

test('reopen is refused from any non-LOST status', () => {
  for (const s of OPEN_LEAD_STATUSES.concat(LeadStatus.BOOKED)) {
    assert.ok(applyLeadAction(lead(s), 'reopen', {}, NOW).error, `expected refusal from ${s}`)
  }
})

test('assign works from every status, trims, and null/blank unassigns', () => {
  for (const s of Object.values(LeadStatus)) {
    const d = dataOf(applyLeadAction(lead(s), 'assign', { assignedTo: '  Diego ' }, NOW))
    assert.equal(d.assignedTo, 'Diego')
    assert.equal('status' in d, false, 'assign never changes status')
  }
  const un = dataOf(applyLeadAction(lead(LeadStatus.NEW), 'assign', { assignedTo: null }, NOW))
  assert.equal(un.assignedTo, null)
  const blank = dataOf(applyLeadAction(lead(LeadStatus.NEW), 'assign', { assignedTo: '   ' }, NOW))
  assert.equal(blank.assignedTo, null)
})

test('assign requires the assignedTo key (string or null)', () => {
  assert.ok(applyLeadAction(lead(LeadStatus.NEW), 'assign', {}, NOW).error)
})

// ── The hard rule: BOOKED is unreachable by hand ─────────────────────────────

test('BOOKED is NEVER settable by any action/payload combination', () => {
  const payloads = [
    {},
    { lostReason: LeadLostReason.OTHER },
    { assignedTo: 'Diego' },
    { assignedTo: null },
    { lostReason: LeadLostReason.PRICE_TOO_HIGH, assignedTo: 'BOOKED' },
  ]
  for (const action of LEAD_ACTIONS) {
    for (const s of Object.values(LeadStatus)) {
      for (const p of payloads) {
        const res = applyLeadAction(lead(s), action, p, NOW)
        if (res.error === undefined) {
          assert.notEqual(res.data.status, LeadStatus.BOOKED, `${action} from ${s} produced BOOKED`)
        }
      }
    }
  }
  // And the transition table itself never names BOOKED as a destination —
  // it is only ever a FROM status (for assign).
  assert.ok(!('mark_booked' in ALLOWED_LEAD_ACTIONS))
})

test('unknown action is refused', () => {
  const res = applyLeadAction(lead(LeadStatus.NEW), 'mark_booked' as LeadAction, {}, NOW)
  assert.ok(res.error)
})

// ── allowedActionsFor drives the UI ──────────────────────────────────────────

test('allowedActionsFor mirrors the transition table per status', () => {
  assert.deepEqual(allowedActionsFor(LeadStatus.NEW), ['mark_contacted', 'mark_lost', 'assign'])
  assert.deepEqual(allowedActionsFor(LeadStatus.CONTACTED), ['set_follow_up', 'mark_lost', 'assign'])
  assert.deepEqual(allowedActionsFor(LeadStatus.QUOTE_SENT), ['set_follow_up', 'mark_lost', 'assign'])
  assert.deepEqual(allowedActionsFor(LeadStatus.FOLLOW_UP), ['mark_lost', 'assign'])
  assert.deepEqual(allowedActionsFor(LeadStatus.LOST), ['reopen', 'assign'])
  assert.deepEqual(allowedActionsFor(LeadStatus.BOOKED), ['assign'])
})

// ── Manual entry builder (POST /api/admin/leads) ─────────────────────────────

test('buildManualLeadCreate maps fields, normalizes email, NEW + MANUAL_ENTRY', () => {
  const d = buildManualLeadCreate(
    {
      name: ' Sam Jones ', phone: ' 555-0123 ', email: ' SAM@X.com ', moveDate: NOW,
      moveSize: '2br', originZip: '07030', destinationZip: '07302', notes: 'called about a couch',
      serviceInterest: 'labor-only',
    },
    NOW
  )
  assert.equal(d.name, 'Sam Jones')
  assert.equal(d.email, 'sam@x.com')
  assert.equal(d.phone, '555-0123')
  assert.equal(d.source, 'MANUAL_ENTRY')
  assert.equal(d.status, LeadStatus.NEW)
  assert.equal(d.moveDate, NOW)
  assert.equal(d.moveSize, '2br')
  assert.equal(d.originZip, '07030')
  assert.equal(d.destinationZip, '07302')
  assert.equal(d.notes, 'called about a couch')
  assert.equal(d.jobType, 'labor-only')
  assert.equal(d.lastActivityAt, NOW)
})

test('manual entry NEVER grants marketing consent (columns left unset = never asked)', () => {
  const d = buildManualLeadCreate({ name: 'Sam', phone: '5550123', email: 'sam@x.com' }, NOW) as Record<string, unknown>
  for (const k of ['emailMarketingConsent', 'marketingConsentAt', 'marketingConsentSource', 'marketingConsentVersion']) {
    assert.equal(k in d, false, `${k} must not be written by manual entry`)
  }
})

test('buildManualLeadCreate defaults the name and nulls junk email', () => {
  const d = buildManualLeadCreate({ phone: '5550123', email: 'not-an-email' }, NOW)
  assert.equal(d.name, 'Manual lead')
  assert.equal(d.email, null)
  assert.equal(d.phone, '5550123')
})
