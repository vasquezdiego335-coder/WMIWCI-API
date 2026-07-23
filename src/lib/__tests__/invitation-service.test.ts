// invitation-service.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateInvite, newInvitationToken, invitationExpiry, isExpired, INVITATION_TTL_DAYS } from '../invitation-service'

test('a fresh invite for a new email is allowed', () => {
  assert.equal(evaluateInvite({ existingUser: false, activePendingInvite: false, role: 'CREW' }).allow, true)
})

test('an existing account is refused 409', () => {
  const d = evaluateInvite({ existingUser: true, activePendingInvite: false, role: 'CREW' })
  assert.equal(d.allow, false)
  assert.equal(d.allow === false && d.status, 409)
})

test('a duplicate pending invite is refused 409', () => {
  const d = evaluateInvite({ existingUser: false, activePendingInvite: true, role: 'CREW' })
  assert.equal(d.allow, false)
  assert.equal(d.allow === false && d.status, 409)
})

test('inviting as OWNER is refused 422', () => {
  const d = evaluateInvite({ existingUser: false, activePendingInvite: false, role: 'OWNER' })
  assert.equal(d.allow, false)
  assert.equal(d.allow === false && d.status, 422)
})

test('tokens are long and unique', () => {
  const a = newInvitationToken()
  const b = newInvitationToken()
  assert.notEqual(a, b)
  assert.ok(a.length >= 30)
})

test('expiry is TTL days out and isExpired reads it correctly', () => {
  const from = new Date('2026-07-22T00:00:00Z')
  const exp = invitationExpiry(from)
  assert.equal(exp.getTime(), from.getTime() + INVITATION_TTL_DAYS * 86400000)
  assert.equal(isExpired(exp, from), false)
  assert.equal(isExpired(exp, new Date(exp.getTime() + 1)), true)
})
