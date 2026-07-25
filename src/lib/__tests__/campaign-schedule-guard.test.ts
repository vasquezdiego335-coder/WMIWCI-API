import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// ════════════════════════════════════════════════════════════════════════
//  SCHEDULED REQUIRES A SEND TIME (staging rehearsal 2026-07-25).
//
//  The transition set status=SCHEDULED without checking `scheduledAt`. The
//  dispatch sweep selects on `status: 'SCHEDULED' AND scheduledAt <= now`, so a
//  null send time could never match: the campaign reported "Scheduled", sat
//  forever, and sent nothing. Found because a rehearsal campaign produced
//  campaign_runs = 0 with no error anywhere.
//
//  Silent non-delivery is the worst failure mode for a campaign tool — an
//  operator believes mail went out. These pin the guard.
// ════════════════════════════════════════════════════════════════════════

const ROUTE = resolve(__dirname, '../../../app/api/admin/email-marketing/campaigns/route.ts')
const code = () =>
  readFileSync(ROUTE, 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')

test('scheduling is REFUSED when no send time exists', () => {
  const s = code()
  assert.ok(/if \(target === 'SCHEDULED'\)/.test(s), 'must special-case the SCHEDULED transition')
  assert.ok(/scheduledAtToSet \?\? config\.scheduledAt/.test(s), 'must consider both a supplied and a stored send time')
  assert.ok(/A send time is required/.test(s), 'must refuse with an actionable message')
})

test('the send time is written in the SAME transaction as the status change', () => {
  const s = code()
  const txIdx = s.indexOf('prisma.$transaction([')
  const statusIdx = s.indexOf('status: target', txIdx)
  const schedIdx = s.indexOf('scheduledAt: scheduledAtToSet', txIdx)
  assert.ok(txIdx > -1 && statusIdx > -1 && schedIdx > -1, 'both writes must be inside the transaction')
  // Status and schedule must not be able to disagree after a partial failure.
  assert.ok(schedIdx > txIdx, 'the scheduledAt write must be part of the transaction array')
})

test('an invalid date is rejected rather than silently stored', () => {
  assert.ok(/Number\.isNaN\(d\.getTime\(\)\)/.test(code()), 'must validate the supplied date')
})

test('approval is still required (the existing gate is not weakened)', () => {
  assert.ok(/!config\.approvedAt/.test(code()), 'approval gate must remain')
})
