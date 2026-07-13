// Offline tests for the centralized entity-link builder (increment 2.1).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { entityLink, hasEntityPage } from '../entity-links'

test('booking and job link to the job detail page', () => {
  assert.equal(entityLink('booking', 'b1'), '/admin/jobs/b1')
  assert.equal(entityLink('job', 'j1'), '/admin/jobs/j1')
})

test('expense / owner_transaction / customer / crew link to their list pages', () => {
  assert.equal(entityLink('expense', 'e1'), '/admin/expenses')
  assert.equal(entityLink('owner_transaction', 'o1'), '/admin/owner-money')
  assert.equal(entityLink('customer', 'c1'), '/admin/customers')
  assert.equal(entityLink('crew', 'u1'), '/admin/staff')
})

test('lead has no page yet → null link (never a broken 404)', () => {
  assert.equal(entityLink('lead', 'l1'), null)
  assert.equal(hasEntityPage('lead'), false)
  assert.equal(hasEntityPage('booking'), true)
})

test('unknown entity type → null', () => {
  assert.equal(entityLink('spaceship', 'x'), null)
  assert.equal(hasEntityPage('spaceship'), false)
})
