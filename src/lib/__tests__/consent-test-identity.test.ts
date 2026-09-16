// ════════════════════════════════════════════════════════════════════════
//  consent-test-identity.test.ts — test, staff and role addresses never get a
//  marketing basis, an enrollment or a promotional send (DESIGN-v2 §5 rule 4).
//
//  The owner tests through the public forms, so these identities arrive looking
//  exactly like customers. Pure table tests plus the async loader with an
//  injected staff lookup — no database.
// ════════════════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertNoProductionCredentials } from './_disposable-test-env'
import {
  BUSINESS_EMAIL_DOMAINS,
  canonicalIdentity,
  classifyTestIdentity,
  isRoleAddress,
  isTestIdentity,
  testIdentityReason,
} from '../consent/test-identity'

assertNoProductionCredentials()

const ENV = { OWNER_EMAIL: 'owner.person@example.org', EMAIL_TEST_RECIPIENT: 'inbox.tester@example.net' }
const NO_ENV = {}

test('canonicalIdentity folds +tags, case and Gmail dots', () => {
  assert.equal(canonicalIdentity(' Some.One+promo@Example.com '), 'some.one@example.com')
  assert.equal(canonicalIdentity('v.a.s.q+x@googlemail.com'), 'vasq@gmail.com')
  assert.equal(canonicalIdentity('not-an-address'), null)
  assert.equal(canonicalIdentity('@example.com'), null)
  assert.equal(canonicalIdentity('+tag@example.com'), null)
  assert.equal(canonicalIdentity(null), null)
})

test('classification table', () => {
  const table: Array<[string, ReturnType<typeof classifyTestIdentity>, object?]> = [
    // Reserved domains (RFC 2606 / 6761)
    ['customer@example.com', 'reserved_domain'],
    ['customer@EXAMPLE.org', 'reserved_domain'],
    ['customer@mail.example.net', 'reserved_domain'],
    ['customer@shop.test', 'reserved_domain'],
    ['customer@nowhere.invalid', 'reserved_domain'],
    ['customer@localhost', 'reserved_domain'],
    ['customer@box.localhost', 'reserved_domain'],
    ['customer@site.example', 'reserved_domain'],
    // The business's own domains, current and retired, and subdomains
    ['owner-test+1726500000@moveitclearit.com', 'business_domain'],
    ['crew@mail.moveitclearit.com', 'business_domain'],
    ['old@wemoveitweclearit.com', 'business_domain'],
    ['x@moveitclearit.internal', 'business_domain'],
    ['x@moveitclearit.test', 'reserved_domain'], // .test is reserved first; either way excluded
    // Look-alikes are NOT the business
    ['someone@notmoveitclearit.com', null],
    ['someone@moveitclearit.com.evil.io', null],
    // Known test identity from scripts/flag-test-identities.ts, with +tag and dots
    ['vasquezdiego335@gmail.com', 'known_test'],
    ['VasquezDiego335+quote@gmail.com', 'known_test'],
    ['vasquez.diego335@googlemail.com', 'known_test'],
    // Role accounts
    ['info@acme-movers.io', 'role_account'],
    ['noreply@acme-movers.io', 'role_account'],
    ['no-reply@acme-movers.io', 'role_account'],
    ['postmaster@acme-movers.io', 'role_account'],
    ['abuse@acme-movers.io', 'role_account'],
    ['Info+leads@acme-movers.io', 'role_account'],
    // Ordinary customers
    ['jane.doe@gmail.com', null],
    ['information.desk.person@acme-movers.io', null],
    ['', null],
    ['garbage', null],
  ]
  for (const [email, expected] of table) {
    assert.equal(classifyTestIdentity(email, { env: NO_ENV }), expected, email)
  }
})

test('OWNER_EMAIL and EMAIL_TEST_RECIPIENT match with +tags; env lists are split', () => {
  //  Owner/test recipients on a non-reserved domain, so the env rule is what matches.
  const env = { OWNER_EMAIL: 'the.owner@gmail.com', EMAIL_TEST_RECIPIENT: 'qa-inbox@fastmail.fm, second@fastmail.fm' }
  assert.equal(classifyTestIdentity('theowner+x@gmail.com', { env }), 'owner')
  assert.equal(classifyTestIdentity('QA-inbox+run7@fastmail.fm', { env }), 'test_recipient')
  assert.equal(classifyTestIdentity('second@fastmail.fm', { env }), 'test_recipient')
  assert.equal(classifyTestIdentity('the.owner@gmail.com', { env: NO_ENV }), null, 'without the env var it is an ordinary address')
  //  An unset env never matches everyone.
  assert.equal(classifyTestIdentity('jane@gmail.com', { env: { OWNER_EMAIL: '', EMAIL_TEST_RECIPIENT: '  ' } }), null)
  assert.ok(ENV.OWNER_EMAIL)
})

test('admin users and crew invitations are staff', () => {
  const ctx = { env: NO_ENV, staffEmails: ['Dispatcher@Gmail.com'], invitationEmails: ['new.mover@outlook.com'] }
  assert.equal(classifyTestIdentity('dispatcher+book@gmail.com', ctx), 'staff')
  assert.equal(classifyTestIdentity('new.mover@outlook.com', ctx), 'crew_invitation')
  assert.equal(classifyTestIdentity('newmover@outlook.com', ctx), null, 'dots only fold for Gmail')
})

test('isRoleAddress', () => {
  assert.equal(isRoleAddress('postmaster@anything.io'), true)
  assert.equal(isRoleAddress('mailer-daemon@anything.io'), true)
  assert.equal(isRoleAddress('infographics@anything.io'), false)
  assert.equal(isRoleAddress('not an address'), false)
})

test('the async check loads staff, skips the query for static matches, and FAILS CLOSED', async () => {
  let loads = 0
  const loadStaffEmails = async () => {
    loads++
    return { staff: ['boss.lady@gmail.com'], invitations: [] }
  }
  assert.equal(await testIdentityReason('bosslady+x@gmail.com', { env: NO_ENV, loadStaffEmails }), 'staff')
  assert.equal(await isTestIdentity('regular.customer@gmail.com', { env: NO_ENV, loadStaffEmails }), false)
  assert.equal(loads, 2)

  assert.equal(await testIdentityReason('x@example.com', { env: NO_ENV, loadStaffEmails }), 'reserved_domain')
  assert.equal(loads, 2, 'a reserved address never costs a query')

  const failing = async () => {
    throw new Error('db down')
  }
  assert.equal(await testIdentityReason('regular.customer@gmail.com', { env: NO_ENV, loadStaffEmails: failing }), 'staff_lookup_failed')
  assert.equal(await isTestIdentity('regular.customer@gmail.com', { env: NO_ENV, loadStaffEmails: failing }), true)
})

test('the business domain list includes the retired brand domain', () => {
  assert.ok(BUSINESS_EMAIL_DOMAINS.includes('moveitclearit.com'))
  assert.ok(BUSINESS_EMAIL_DOMAINS.includes('wemoveitweclearit.com'))
})
