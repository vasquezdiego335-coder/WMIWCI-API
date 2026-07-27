import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  canApprove,
  canDispatch,
  allowedTransitions,
  APPROVABLE_STATES,
  type CampaignState,
  type CampaignValidation,
} from '../email-campaign'
import { needsReapproval, sendConfigHash } from '../email-campaign-approval'

// ════════════════════════════════════════════════════════════════════════
//  BUG #8 — THE DEAD END (found by clicking, 2026-07-26).
//
//  A SCHEDULED campaign whose configuration changed after approval was
//  permanently undispatchable:
//
//    dispatch  → "edited after approval — approve it again"
//    approve   → "Only a validated campaign can be approved. This one is
//                 SCHEDULED."
//    SCHEDULED → READY is not a legal transition, so there was no way back
//                 to a state approval accepted.
//
//  The invariant this file pins is general, not a patch for one state:
//
//    IF a state can require re-approval, THAT STATE MUST ACCEPT APPROVAL —
//    or offer a legal transition to a state that does.
//
//  Any future state added to the machine is checked by the sweep below, so
//  this class of dead end cannot be reintroduced silently.
// ════════════════════════════════════════════════════════════════════════

const ALL_STATES: CampaignState[] = [
  'DRAFT', 'VALIDATING', 'READY', 'SCHEDULED', 'ACTIVE',
  'PAUSED', 'COMPLETED', 'CANCELLED', 'FAILED', 'ARCHIVED',
]

const passing = (): CampaignValidation => ({ ok: true, errors: [], warnings: [], checkedAt: new Date().toISOString() })

/** States from which mail can actually go out — the ones a dead end matters in. */
const SENDABLE: CampaignState[] = ['SCHEDULED', 'ACTIVE']

test('a SCHEDULED campaign with passing validation can be approved', () => {
  const verdict = canApprove('SCHEDULED', passing())
  assert.ok(verdict.ok, `SCHEDULED must be approvable; got: ${verdict.ok ? '' : verdict.error}`)
})

test('THE INVARIANT: every sendable state either accepts approval or can legally reach one that does', () => {
  for (const state of SENDABLE) {
    const direct = canApprove(state, passing()).ok
    const viaTransition = allowedTransitions(state).some((t) => canApprove(t, passing()).ok)
    assert.ok(
      direct || viaTransition,
      `${state} can require re-approval (canDispatch refuses an unapproved campaign there) but cannot reach approval: ` +
        `canApprove refuses it and no allowed transition ${JSON.stringify(allowedTransitions(state))} accepts it. This is bug #8.`
    )
  }
})

test('the guard that demands re-approval is reachable for the exact production row', () => {
  // The real campaign: SCHEDULED, approved, then edited (validation persisted).
  const cfg = {
    template: 'abandoned-checkout', subject: '[TEST] Summer', audienceId: 'aud_1',
    scheduledAt: new Date('2026-07-27T12:00:00.000Z'),
    utmSource: 'email', utmMedium: 'email', utmCampaign: 'summer-reengagement',
    utmContent: null, discountCode: null,
  }
  const stale = {
    ...cfg,
    approvedAt: new Date('2026-07-26T12:00:00.000Z'),
    updatedAt: new Date('2026-07-26T18:00:00.000Z'),
    approvedConfigHash: sendConfigHash({ ...cfg, subject: 'OLD SUBJECT' }),
  }
  assert.equal(needsReapproval(stale), true, 'this row must demand re-approval')
  assert.ok(canApprove('SCHEDULED', passing()).ok, 'and re-approval must be accepted, not refused')
})

test('terminal and paused states are still NOT approvable', () => {
  for (const s of ['CANCELLED', 'FAILED', 'ARCHIVED', 'COMPLETED', 'PAUSED', 'DRAFT'] as CampaignState[]) {
    assert.equal(canApprove(s, passing()).ok, false, `${s} must not be approvable`)
    assert.ok(!APPROVABLE_STATES.includes(s))
  }
})

test('widening approval did NOT weaken any other approval requirement', () => {
  // Same three refusals, now checked from SCHEDULED as well as READY.
  for (const s of APPROVABLE_STATES) {
    assert.equal(canApprove(s, null).ok, false, `${s}: unvalidated must be refused`)
    assert.equal(
      canApprove(s, { ok: false, errors: ['nope'], warnings: [], checkedAt: new Date().toISOString() }).ok,
      false,
      `${s}: failing validation must be refused`
    )
    const stale = { ok: true, errors: [], warnings: [], checkedAt: new Date(Date.now() - 25 * 3600_000).toISOString() }
    assert.equal(canApprove(s, stale).ok, false, `${s}: a >24h validation must be refused`)
  }
})

test('re-approval keeps the campaign SCHEDULED (it must not be silently unscheduled)', () => {
  const src = readFileSync(
    resolve(__dirname, '../../../app/api/admin/email-marketing/campaigns/route.ts'),
    'utf8'
  )
  const approve = src.slice(src.indexOf("action === 'approve'"), src.indexOf('// ── transition ──'))
  const code = approve.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')
  assert.ok(/keepState/.test(code), 'the approve handler must distinguish re-approval from first approval')
  // The unconditional `status: 'READY'` write is what would unschedule it. It
  // must now be gated on keepState.
  assert.ok(
    /keepState \? \[\] : \[prisma\.marketingCampaign\.update/.test(code),
    'the status->READY write must be skipped when re-approving in place'
  )
  // scheduledAt is NOT hashed (bug #10): hashing it made the canonical
  // approve -> schedule flow self-invalidating, because scheduling happens
  // AFTER approval by design. So a repaired send time cannot affect approval
  // identity, and the hash call must stay plain.
  assert.match(code, /approvedConfigHash: sendConfigHash\(config\)/, 'the approved hash is taken over the config as-is')
  // Checks the CALL, not a window after it: the handler still WRITES a repaired
  // scheduledAt on the next line, which is correct and must not trip this.
  assert.ok(
    !/sendConfigHash\(\s*\{/.test(code),
    'the approval hash must be taken over config as-is, never a spread that injects the send time'
  )
  // The repair itself must still happen — it is what escapes the no-send-time
  // dead end; it just no longer participates in approval identity.
  assert.match(code, /scheduledAt: repairScheduledAt/, 'a repaired send time must still be written')
})

test('a SCHEDULED campaign with no send time is not approved into a second dead end', () => {
  // canDispatch tolerates a null scheduledAt, but the SWEEP selects on
  // `scheduledAt <= now`, so null never matches and the campaign silently never
  // sends. The approve handler refuses rather than blessing that state.
  const src = readFileSync(
    resolve(__dirname, '../../../app/api/admin/email-marketing/campaigns/route.ts'),
    'utf8'
  )
  const approve = src.slice(src.indexOf("action === 'approve'"), src.indexOf('// ── transition ──'))
  assert.ok(/needsScheduledAt: true/.test(approve), 'must tell the operator a send time is required')
  assert.ok(/repairScheduledAt/.test(approve), 'and must accept one in the same call')
  // Sanity: an approved+scheduled campaign whose time has arrived dispatches.
  assert.ok(canDispatch({ state: 'SCHEDULED', approvedAt: new Date(), scheduledAt: new Date(Date.now() - 1000) }).ok)
})

test('the UI offers approval exactly where the server accepts it', () => {
  const ui = readFileSync(
    resolve(__dirname, '../../../app/(admin)/admin/(dashboard)/email-marketing/campaigns/CampaignComposer.tsx'),
    'utf8'
  )
  // Button visibility is driven by the server-computed needsReapproval flag,
  // never by a locally re-derived rule that could drift from the guard.
  assert.ok(/\{c\.needsReapproval && \(/.test(ui), 'the Approve button must be gated on the server flag')
  // And it must pass the state through, so the send-time prompt and the
  // re-approval wording are correct.
  assert.ok(/act\(c\.id, 'approve', undefined, undefined, c\.scheduledAt, c\.status\)/.test(ui), 'approve must carry scheduledAt + state')
  assert.ok(/campaignState === 'SCHEDULED' && !existingScheduledAt/.test(ui), 'must prompt for a missing send time on re-approval')
})
