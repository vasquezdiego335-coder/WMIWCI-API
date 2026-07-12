// Offline unit tests for the door-hanger discount decision + the owner gate
// that protects the approve_discount / deny_discount buttons.
// Run: npm test  (tsx --test)  — no DB, no network, no Discord.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  decideDiscount,
  DOOR_HANGER_APPROVED_PERCENT,
  DOOR_HANGER_DENIED_FALLBACK_PERCENT,
} from '../discount-decision'
import { isAuthorizedOwner } from '../discord-auth'

// ── Authorized approval ────────────────────────────────────────────────────
test('discount: approve a PENDING request → DOOR_HANGER_APPROVED at 30%', () => {
  const d = decideDiscount('DOOR_HANGER_PENDING', 'approve')
  assert.equal(d.ok, true)
  assert.equal(d.reason, 'ok')
  assert.equal(d.nextType, 'DOOR_HANGER_APPROVED')
  assert.equal(d.nextPercent, DOOR_HANGER_APPROVED_PERCENT)
  assert.equal(d.nextPercent, 30)
})

// ── Authorized denial ──────────────────────────────────────────────────────
test('discount: deny a PENDING request → DOOR_HANGER_DENIED, 10% fallback kept', () => {
  const d = decideDiscount('DOOR_HANGER_PENDING', 'deny')
  assert.equal(d.ok, true)
  assert.equal(d.nextType, 'DOOR_HANGER_DENIED')
  assert.equal(d.nextPercent, DOOR_HANGER_DENIED_FALLBACK_PERCENT)
  assert.equal(d.nextPercent, 10)
})

// ── Duplicate clicks ───────────────────────────────────────────────────────
test('discount: duplicate approve on an already-approved request is refused (idempotent)', () => {
  const d = decideDiscount('DOOR_HANGER_APPROVED', 'approve')
  assert.equal(d.ok, false)
  assert.equal(d.reason, 'already_approved')
  assert.equal(d.nextType, undefined)
})

test('discount: duplicate deny on an already-denied request is refused (idempotent)', () => {
  const d = decideDiscount('DOOR_HANGER_DENIED', 'deny')
  assert.equal(d.ok, false)
  assert.equal(d.reason, 'already_denied')
})

test('discount: crossed duplicate (approve after deny) is refused, not flipped', () => {
  assert.equal(decideDiscount('DOOR_HANGER_DENIED', 'approve').ok, false)
  assert.equal(decideDiscount('DOOR_HANGER_APPROVED', 'deny').ok, false)
})

// ── Concurrent clicks ──────────────────────────────────────────────────────
// Two owners both see a PENDING request. The winner's atomic UPDATE flips it to
// APPROVED; the loser re-reads and decideDiscount must now report "already
// handled" (mirrors the count===0 re-read branch in the route handler).
test('discount: concurrent second owner sees an already-handled state after the winner commits', () => {
  const winner = decideDiscount('DOOR_HANGER_PENDING', 'approve')
  assert.equal(winner.ok, true) // winner commits DOOR_HANGER_APPROVED
  const loser = decideDiscount(winner.nextType, 'approve') // loser re-reads the new state
  assert.equal(loser.ok, false)
  assert.equal(loser.reason, 'already_approved')
})

// ── Not-pending guards (no door-hanger claim) ──────────────────────────────
test('discount: a non-pending / absent discount is never mutated by the buttons', () => {
  assert.equal(decideDiscount('FIRST_TIME_AUTO', 'approve').reason, 'not_pending')
  assert.equal(decideDiscount(null, 'deny').reason, 'not_pending')
  assert.equal(decideDiscount(undefined, 'approve').reason, 'not_pending')
})

// ── Unauthorized access ────────────────────────────────────────────────────
// approve_discount / deny_discount are in OWNER_ACTIONS and pass through
// authorizeOwnerAction → isAuthorizedOwner before any handler runs. A non-owner
// is rejected (fail closed); a listed owner in the right guild is allowed.
test('discount buttons are owner-gated: non-owner rejected, listed owner allowed', () => {
  const GUILD = '987654321098765432'
  const OWNER = '111111111111111111'
  const NON_OWNER = '222222222222222222'
  process.env.DISCORD_GUILD_ID = GUILD
  process.env.DISCORD_OWNER_USER_IDS = OWNER
  process.env.DISCORD_OWNER_ROLE_ID = ''

  const mk = (userId: string) => ({ guild_id: GUILD, member: { user: { id: userId }, roles: [] } })

  assert.equal(isAuthorizedOwner(mk(NON_OWNER)).ok, false, 'non-owner must be blocked')
  assert.equal(isAuthorizedOwner(mk(OWNER)).ok, true, 'listed owner must be allowed')
  // Fail closed on the wrong guild even for a listed owner.
  assert.equal(isAuthorizedOwner({ guild_id: 'somewhere-else', member: { user: { id: OWNER }, roles: [] } }).ok, false)
})
