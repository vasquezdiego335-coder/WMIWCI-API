// ════════════════════════════════════════════════════════════════════════
//  consent-marketing-eligibility.test.ts — DESIGN-v2 §5 as a truth table.
//
//  Prohibitions belong to the person and always win; permissions belong to the
//  submission. Part 1 drives the PURE decision over explicit facts through
//  every prohibition, permission, context and reason — including the scenario
//  table (every surface's notice permits lead_nurture; quote_followup only from
//  quote; abandoned_checkout only from booking) and rule 8, a campaign's use of
//  the person's LATEST form notice (a support message counts like every other
//  topic). Part 2 drives the loader against an in-memory fake Prisma to prove it
//  gathers the right facts: the subject's STORED basis, the latest notice via
//  email_marketing_status.last_notice_event_id in campaign context only,
//  per-person suppression and opt-out, today's legacy consent scoping,
//  fail-closed reads, and that pre-policy rows shaped like production are never
//  eligible.
//
//  Offline. Every address is @example.com; nothing is sent.
// ════════════════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { assertNoProductionCredentials, assertTestRecipient } from './_disposable-test-env'
import { createFakeConsentDb } from './_consent-fake-db'
import {
  BASIS_EVENT_SELECT,
  EBR_BASIS_DAYS,
  ELIGIBILITY_CONTEXTS,
  INELIGIBLE_REASONS,
  NOTICE_BASIS_DAYS,
  RETRYABLE_INELIGIBLE_REASONS,
  decidePromotionalEligibility,
  promotionalEligibility,
  type BasisEventFact,
  type EligibilityDb,
  type EligibilityDecision,
  type EligibilityFacts,
} from '../consent/marketing-eligibility'
import {
  NOTICE_POLICY_START,
  NOTICE_SURFACES,
  NOTICE_VERSIONS,
  SEQUENCE_KINDS,
  type NoticeSurface,
  type SequenceKind,
} from '../consent/notice-registry'

assertNoProductionCredentials()

const DAY = 24 * 60 * 60 * 1000
const EMAIL = 'person@example.com'
assertTestRecipient(EMAIL)
const NOW = new Date('2026-10-01T15:00:00Z')
const T = (iso: string) => new Date(iso)
const QUOTE_HASH_EN = NOTICE_VERSIONS['quote-2026-09-16-r2'].copySha256.en

/** The registered r2 version for a surface. */
const versionFor = (surface: NoticeSurface): string =>
  Object.keys(NOTICE_VERSIONS).find((v) => NOTICE_VERSIONS[v].surfaces.includes(surface)) as string

function noticeEvent(over: Partial<BasisEventFact> = {}): BasisEventFact {
  return {
    id: 'evt_notice',
    emailNormalized: EMAIL,
    kind: 'notice_accepted',
    surface: 'quote',
    occurredAt: T('2026-09-20T12:00:00Z'),
    regionSignal: 'nanp',
    noticeVersion: 'quote-2026-09-16-r2',
    noticeCopySha256: QUOTE_HASH_EN,
    locale: 'en',
    ...over,
  }
}

/** A registered notice event recorded on `surface` (its own r2 version and hash). */
function surfaceNotice(surface: NoticeSurface, over: Partial<BasisEventFact> = {}, locale: 'en' | 'es' = 'en'): BasisEventFact {
  const version = versionFor(surface)
  return noticeEvent({ surface, noticeVersion: version, noticeCopySha256: NOTICE_VERSIONS[version].copySha256[locale], locale, ...over })
}

function facts(over: Partial<EligibilityFacts> = {}): EligibilityFacts {
  return {
    context: 'scenario_flow',
    now: NOW,
    emailNormalized: EMAIL,
    suppression: null,
    customerMarketingOptOut: false,
    status: null,
    legacyConsent: [],
    testIdentity: null,
    subject: { type: 'lead', id: 'lead_1', sequenceKind: null, basisEventId: null },
    basisEvent: null,
    ebrAt: null,
    flags: { noticeBasisEnabled: true, ebrBasisEnabled: false },
    ...over,
  }
}

/** A valid scenario-flow notice subject for a quote follow-up. */
function withNotice(over: Partial<EligibilityFacts> = {}, kind: SequenceKind = 'quote_followup'): EligibilityFacts {
  return facts({
    subject: { type: 'lead', id: 'lead_1', sequenceKind: kind, basisEventId: 'evt_notice' },
    basisEvent: noticeEvent(),
    ...over,
  })
}

const express = (at: string, id = 'evt_express') => ({ expressOptInAt: T(at), expressEventId: id, optedOutAt: null, declinedAt: null })

const reason = (d: EligibilityDecision) => (d.eligible ? `eligible:${d.basis}` : d.reason)

// ═══ PART 1 — THE PURE DECISION ════════════════════════════════════════════

test('no facts at all: no_marketing_basis in every context, and it is terminal', () => {
  for (const context of ELIGIBILITY_CONTEXTS) {
    const d = decidePromotionalEligibility(facts({ context }))
    assert.deepEqual(d, { eligible: false, reason: 'no_marketing_basis', terminal: true })
  }
})

test('PROHIBITION 1: every suppression reason, both scopes, beats express and notice', () => {
  const reasons = ['UNSUBSCRIBED', 'HARD_BOUNCE', 'SPAM_COMPLAINT', 'INVALID_ADDRESS', 'ADMIN_BLOCK', 'PROVIDER_REJECTED']
  for (const r of reasons) {
    for (const scope of ['promotional', 'all']) {
      const withExpress = decidePromotionalEligibility(
        facts({ context: 'campaign', suppression: { reason: r, scope }, status: express('2026-09-30T00:00:00Z') }),
      )
      assert.equal(reason(withExpress), 'suppressed', `${r}/${scope} with express`)
      assert.ok(!withExpress.eligible && withExpress.detail === `suppression:${r.toLowerCase()}`)
      const withNoticeBasis = decidePromotionalEligibility(withNotice({ suppression: { reason: r, scope } }))
      assert.equal(reason(withNoticeBasis), 'suppressed', `${r}/${scope} with notice`)
    }
  }
})

test('PROHIBITION 1: Customer.marketingOptOut beats express and notice', () => {
  assert.equal(reason(decidePromotionalEligibility(facts({ customerMarketingOptOut: true, status: express('2026-09-30T00:00:00Z') }))), 'opted_out')
  assert.equal(reason(decidePromotionalEligibility(withNotice({ customerMarketingOptOut: true }))), 'opted_out')
})

test('PROHIBITION 2: opt-out after express wins; express after opt-out wins; a tie goes to the opt-out', () => {
  const after = decidePromotionalEligibility(
    facts({ status: { ...express('2026-09-20T00:00:00Z'), optedOutAt: T('2026-09-25T00:00:00Z') } }),
  )
  assert.equal(reason(after), 'opted_out')
  const reExpressed = decidePromotionalEligibility(
    facts({ status: { ...express('2026-09-28T00:00:00Z', 'evt_re'), optedOutAt: T('2026-09-25T00:00:00Z') } }),
  )
  assert.deepEqual(reExpressed, { eligible: true, basis: 'express', basisEventId: 'evt_re' })
  const tie = decidePromotionalEligibility(
    facts({ status: { ...express('2026-09-25T00:00:00Z'), optedOutAt: T('2026-09-25T00:00:00Z') } }),
  )
  assert.equal(reason(tie), 'opted_out')
})

test('PROHIBITION 2: a legacy consent column set AFTER an opt-out does not lift it (a form submission never resubscribes)', () => {
  const optedOut = { expressOptInAt: null, expressEventId: null, optedOutAt: T('2026-09-20T00:00:00Z'), declinedAt: null }
  const laterTick = [{ record: 'lead' as const, id: 'lead_1', value: true, at: T('2026-09-25T00:00:00Z'), isSubject: true }]
  for (const context of ELIGIBILITY_CONTEXTS) {
    assert.equal(reason(decidePromotionalEligibility(facts({ context, status: optedOut, legacyConsent: laterTick }))), 'opted_out', context)
  }
  //  Only a later CONFIRMED express opt-in (status) lifts it.
  assert.equal(
    reason(decidePromotionalEligibility(facts({ status: { ...optedOut, expressOptInAt: T('2026-09-26T00:00:00Z'), expressEventId: 'evt_confirmed' } }))),
    'eligible:express',
  )
})

test('PROHIBITION 2: a notice never overrides an opt-out', () => {
  const d = decidePromotionalEligibility(
    withNotice({ status: { expressOptInAt: null, expressEventId: null, optedOutAt: T('2026-09-18T00:00:00Z'), declinedAt: null } }),
  )
  assert.equal(reason(d), 'opted_out')
})

test('PROHIBITION 3: decline after express wins; express after decline wins; notice after decline does NOT', () => {
  assert.equal(
    reason(decidePromotionalEligibility(facts({ status: { ...express('2026-09-20T00:00:00Z'), declinedAt: T('2026-09-22T00:00:00Z') } }))),
    'declined',
  )
  assert.equal(
    reason(decidePromotionalEligibility(facts({ status: { ...express('2026-09-24T00:00:00Z'), declinedAt: T('2026-09-22T00:00:00Z') } }))),
    'eligible:express',
  )
  //  The notice (2026-09-20) came after the decline (2026-09-17): still declined.
  const noticeAfterDecline = decidePromotionalEligibility(
    withNotice({ status: { expressOptInAt: null, expressEventId: null, optedOutAt: null, declinedAt: T('2026-09-17T00:00:00Z') } }),
  )
  assert.equal(reason(noticeAfterDecline), 'declined')
})

test('PROHIBITION 4: a test identity beats express and notice', () => {
  assert.equal(reason(decidePromotionalEligibility(facts({ context: 'campaign', testIdentity: 'owner', status: express('2026-09-20T00:00:00Z') }))), 'test_identity')
  assert.equal(reason(decidePromotionalEligibility(withNotice({ testIdentity: 'role_account' }))), 'test_identity')
})

test('a FAILED staff lookup is a retryable read error, never a terminal test identity', () => {
  //  A pool timeout on the users/crew query is not a finding about the person.
  //  As a terminal 'test_identity' it blocked guard ledger rows for good,
  //  stopped enrollments and skipped whole campaigns.
  const ownTrue = [{ record: 'lead' as const, id: 'lead_1', value: true, at: T('2026-08-01T00:00:00Z'), isSubject: true }]
  const d = decidePromotionalEligibility(facts({ legacyConsent: ownTrue, testIdentity: 'staff_lookup_failed' }))
  assert.deepEqual(d, { eligible: false, reason: 'eligibility_read_failed', terminal: false, detail: 'staff_lookup_failed' })
  //  A real finding is still terminal.
  const staff = decidePromotionalEligibility(facts({ legacyConsent: ownTrue, testIdentity: 'staff' }))
  assert.equal(staff.eligible, false)
  assert.equal((staff as { reason: string }).reason, 'test_identity')
  assert.equal((staff as { terminal: boolean }).terminal, true)
  //  Prohibitions still come first: a suppressed address is refused as suppressed.
  const sup = decidePromotionalEligibility(facts({ legacyConsent: ownTrue, testIdentity: 'staff_lookup_failed', suppression: { reason: 'UNSUBSCRIBED', scope: 'promotional' } }))
  assert.equal((sup as { reason: string }).reason, 'suppressed')
})

test('campaign audiences THROW on a failed staff lookup instead of skipping everyone', () => {
  const src = readFileSync(resolve(__dirname, '../email-audience.ts'), 'utf8')
  const fn = src.slice(src.indexOf('export async function campaignEligibilityDecisions('), src.indexOf('export async function priorAmbiguousEmails('))
  assert.ok(fn.length > 100, 'campaignEligibilityDecisions was found')
  assert.doesNotMatch(fn, /staff_lookup_failed/, 'no swallowed failure turned into a per-person verdict')
  assert.doesNotMatch(fn, /ok: false as const/, 'the staff lookup has no catch branch')
})

test('prohibitions are ordered: suppressed, then opted_out, then declined, then test_identity', () => {
  const all = facts({
    suppression: { reason: 'UNSUBSCRIBED', scope: 'promotional' },
    customerMarketingOptOut: true,
    status: { expressOptInAt: null, expressEventId: null, optedOutAt: T('2026-09-20T00:00:00Z'), declinedAt: T('2026-09-20T00:00:00Z') },
    testIdentity: 'staff',
  })
  assert.equal(reason(decidePromotionalEligibility(all)), 'suppressed')
  assert.equal(reason(decidePromotionalEligibility({ ...all, suppression: null })), 'opted_out')
  assert.equal(reason(decidePromotionalEligibility({ ...all, suppression: null, customerMarketingOptOut: false, status: { ...all.status!, optedOutAt: null } })), 'declined')
  assert.equal(reason(decidePromotionalEligibility({ ...all, suppression: null, customerMarketingOptOut: false, status: null })), 'test_identity')
})

test('PERMISSION 5: express (status) is valid in every context', () => {
  for (const context of ELIGIBILITY_CONTEXTS) {
    const d = decidePromotionalEligibility(facts({ context, status: express('2026-09-20T00:00:00Z', 'evt_x') }))
    assert.deepEqual(d, { eligible: true, basis: 'express', basisEventId: 'evt_x' }, context)
  }
})

test('PERMISSION 5 (legacy columns): TODAY\'S scoping — campaigns any row, everything else the subject\'s own row', () => {
  const otherLeadTrue = [{ record: 'lead' as const, id: 'lead_other', value: true, at: T('2026-08-01T00:00:00Z'), isSubject: false }]
  assert.equal(reason(decidePromotionalEligibility(facts({ context: 'campaign', legacyConsent: otherLeadTrue }))), 'eligible:express')
  for (const context of ['scenario_flow', 'automation', 'post_move'] as const) {
    assert.equal(
      reason(decidePromotionalEligibility(facts({ context, legacyConsent: otherLeadTrue }))),
      'no_marketing_basis',
      `${context}: another row's legacy consent must not be borrowed (it is not today)`,
    )
  }
  const ownTrue = [{ record: 'lead' as const, id: 'lead_1', value: true, at: T('2026-08-01T00:00:00Z'), isSubject: true }]
  const d = decidePromotionalEligibility(facts({ legacyConsent: ownTrue }))
  assert.deepEqual(d, { eligible: true, basis: 'express', basisEventId: null })
})

test('a legacy UNTICKED box never revokes an opt-in (today\'s consent.ts rule), but still blocks a person who never opted in', () => {
  //  The repeat customer: opted in on an earlier booking (Customer row true),
  //  books again and leaves the live form's box unticked (a new Lead row false).
  //  Today that customer keeps getting the mail they asked for.
  const rows = [
    { record: 'customer' as const, id: 'cust_1', value: true, at: T('2026-08-01T00:00:00Z'), isSubject: true },
    { record: 'lead' as const, id: 'lead_2', value: false, at: T('2026-08-05T00:00:00Z'), isSubject: false },
  ]
  for (const context of ['campaign', 'post_move', 'automation', 'scenario_flow'] as const) {
    assert.equal(reason(decidePromotionalEligibility(facts({ context, legacyConsent: rows }))), 'eligible:express',
      `${context}: a later unticked box must not revoke the earlier opt-in`)
  }
  //  Neither row recorded a time: the opt-in still stands.
  const untimed = [{ ...rows[0], at: null }, { ...rows[1], at: null }]
  assert.equal(reason(decidePromotionalEligibility(facts({ context: 'campaign', legacyConsent: untimed }))), 'eligible:express')
  //  A confirmed express opt-in is not revoked by a later unticked box either.
  assert.equal(
    reason(decidePromotionalEligibility(facts({ context: 'campaign', legacyConsent: [rows[1]], status: express('2026-08-01T00:00:00Z') }))),
    'eligible:express',
  )
  //  NO express permission anywhere: the unticked box is a decline, and it still
  //  refuses a notice basis for that person.
  const onlyDeclined = [{ ...rows[1], isSubject: true }]
  assert.equal(reason(decidePromotionalEligibility(facts({ context: 'campaign', legacyConsent: onlyDeclined }))), 'declined')
  assert.equal(reason(decidePromotionalEligibility(withNotice({ legacyConsent: onlyDeclined }))), 'declined')
  //  A decline EVENT is stronger: it beats an EARLIER express permission of any kind.
  assert.equal(
    reason(decidePromotionalEligibility(facts({ context: 'campaign', legacyConsent: [rows[0]], status: { expressOptInAt: null, expressEventId: null, optedOutAt: null, declinedAt: T('2026-08-10T00:00:00Z') } }))),
    'declined',
  )
  //  And every withdrawal still wins: an opt-out beats the legacy true outright.
  assert.equal(
    reason(decidePromotionalEligibility(facts({ context: 'campaign', legacyConsent: rows, status: { expressOptInAt: null, expressEventId: null, optedOutAt: T('2026-08-03T00:00:00Z'), declinedAt: null } }))),
    'opted_out',
  )
})

test('PERMISSION 6: a valid notice is a basis for its scenario sequence only', () => {
  assert.deepEqual(decidePromotionalEligibility(withNotice()), { eligible: true, basis: 'notice', basisEventId: 'evt_notice' })
  //  The booking notice covers the abandoned-checkout sequence for its booking.
  const booking = withNotice({ subject: { type: 'booking', id: 'bk_1', sequenceKind: 'abandoned_checkout', basisEventId: 'evt_notice' }, basisEvent: surfaceNotice('booking', {}, 'es') }, 'abandoned_checkout')
  assert.deepEqual(decidePromotionalEligibility(booking), { eligible: true, basis: 'notice', basisEventId: 'evt_notice' })
  //  The SUBJECT's stored basis is a scenario-flow basis only (a campaign reads the latest notice instead).
  for (const context of ['campaign', 'automation', 'post_move'] as const) {
    assert.equal(reason(decidePromotionalEligibility(withNotice({ context }))), 'no_marketing_basis', context)
  }
})

test('PERMISSION 6: a notice for another scenario, or with no sequence kind, is not a basis', () => {
  const quoteForAbandoned = decidePromotionalEligibility(withNotice({}, 'abandoned_checkout'))
  assert.deepEqual(quoteForAbandoned, { eligible: false, reason: 'no_marketing_basis', terminal: true, detail: 'sequence_not_in_scenario' })
  assert.equal(reason(decidePromotionalEligibility(withNotice({ basisEvent: surfaceNotice('booking') }, 'quote_followup'))), 'no_marketing_basis')
  //  The removed scenario kinds are no sequence at all.
  for (const removed of ['offer', 'lead_nurture_contact', 'lead_nurture_quote_request', 'lead_nurture_booking_form']) {
    assert.equal(reason(decidePromotionalEligibility(withNotice({}, removed as SequenceKind))), 'no_marketing_basis', removed)
  }
  const noKind = withNotice()
  noKind.subject = { ...noKind.subject, sequenceKind: null }
  assert.equal(reason(decidePromotionalEligibility(noKind)), 'no_marketing_basis')
  //  Contact, support, tracker and popup notices start the general lead nurture
  //  ONLY: never the quote follow-up or the abandoned-checkout reminders.
  for (const surface of ['contact', 'contact_support', 'tracker', 'popup'] as const) {
    for (const kind of ['quote_followup', 'abandoned_checkout'] as const) {
      const d = decidePromotionalEligibility(withNotice({ basisEvent: surfaceNotice(surface) }, kind))
      assert.ok(!d.eligible && d.reason === 'no_marketing_basis' && d.detail === 'sequence_not_in_scenario', `${surface} → ${kind}`)
    }
  }
})

// ── The scenario table: which EXISTING sequence a stored notice may start ────

/** The spec's table, pinned literally here (not read back from the registry). */
const EXPECTED_SCENARIOS: Record<NoticeSurface, readonly SequenceKind[]> = {
  quote: ['quote_followup', 'lead_nurture'],
  booking: ['abandoned_checkout', 'lead_nurture'],
  contact: ['lead_nurture'],
  contact_support: ['lead_nurture'],
  tracker: ['lead_nurture'],
  popup: ['lead_nurture'],
}

/** A scenario-flow subject for `kind` whose STORED basis is a notice recorded on `surface`. */
function scenarioOn(surface: NoticeSurface, kind: SequenceKind, over: Partial<EligibilityFacts> = {}, locale: 'en' | 'es' = 'en'): EligibilityFacts {
  const subject =
    kind === 'abandoned_checkout'
      ? { type: 'booking' as const, id: 'bk_1', sequenceKind: kind, basisEventId: 'evt_notice' }
      : { type: 'lead' as const, id: 'lead_1', sequenceKind: kind, basisEventId: 'evt_notice' }
  return facts({ subject, basisEvent: surfaceNotice(surface, {}, locale), ...over })
}

const NOTICE_OK = { eligible: true, basis: 'notice', basisEventId: 'evt_notice' } as const
const NOT_IN_SCENARIO = { eligible: false, reason: 'no_marketing_basis', terminal: true, detail: 'sequence_not_in_scenario' } as const

test('SCENARIOS: the sequence kinds are exactly the three existing sequences, and every surface has a row', () => {
  assert.deepEqual([...SEQUENCE_KINDS], ['quote_followup', 'abandoned_checkout', 'lead_nurture'])
  assert.deepEqual([...NOTICE_SURFACES].sort(), Object.keys(EXPECTED_SCENARIOS).sort())
})

test('SCENARIOS: a stored notice from EVERY surface permits lead_nurture, in both locales', () => {
  for (const surface of NOTICE_SURFACES) {
    for (const locale of ['en', 'es'] as const) {
      assert.deepEqual(decidePromotionalEligibility(scenarioOn(surface, 'lead_nurture', {}, locale)), NOTICE_OK, `${surface}/${locale}`)
    }
  }
  //  The subject's stored basis is still a scenario-flow basis only.
  for (const context of ['campaign', 'automation', 'post_move'] as const) {
    assert.equal(reason(decidePromotionalEligibility(scenarioOn('popup', 'lead_nurture', { context }))), 'no_marketing_basis', context)
  }
})

test('SCENARIOS: quote_followup only from quote, abandoned_checkout only from booking — every other pair is sequence_not_in_scenario', () => {
  let permitted = 0
  for (const surface of NOTICE_SURFACES) {
    for (const kind of SEQUENCE_KINDS) {
      for (const locale of ['en', 'es'] as const) {
        const d = decidePromotionalEligibility(scenarioOn(surface, kind, {}, locale))
        if (EXPECTED_SCENARIOS[surface].includes(kind)) {
          assert.deepEqual(d, NOTICE_OK, `${surface} → ${kind} (${locale})`)
          if (locale === 'en') permitted++
        } else {
          assert.deepEqual(d, NOT_IN_SCENARIO, `${surface} → ${kind} (${locale})`)
        }
      }
    }
  }
  assert.equal(permitted, 8, 'quote ×2, booking ×2, contact, contact_support, tracker, popup')
  //  Spelled out, so the table above cannot drift quietly.
  for (const surface of NOTICE_SURFACES.filter((s) => s !== 'quote')) {
    assert.deepEqual(decidePromotionalEligibility(scenarioOn(surface, 'quote_followup')), NOT_IN_SCENARIO, `${surface} → quote_followup`)
  }
  for (const surface of NOTICE_SURFACES.filter((s) => s !== 'booking')) {
    assert.deepEqual(decidePromotionalEligibility(scenarioOn(surface, 'abandoned_checkout')), NOT_IN_SCENARIO, `${surface} → abandoned_checkout`)
  }
})

test('SCENARIOS: lead_nurture on a notice from any surface still yields to every prohibition and every notice check', () => {
  const noStatus = { expressOptInAt: null, expressEventId: null, optedOutAt: null, declinedAt: null }
  const at = T('2026-09-20T12:00:00Z')
  const cases: Array<[string, Partial<EligibilityFacts>, string]> = [
    ...['UNSUBSCRIBED', 'HARD_BOUNCE', 'SPAM_COMPLAINT', 'INVALID_ADDRESS', 'ADMIN_BLOCK', 'PROVIDER_REJECTED'].flatMap((r) =>
      ['promotional', 'all'].map((scope): [string, Partial<EligibilityFacts>, string] => [`suppression ${r}/${scope}`, { suppression: { reason: r, scope } }, 'suppressed']),
    ),
    ['customer marketingOptOut', { customerMarketingOptOut: true }, 'opted_out'],
    ['opt-out box / unsubscribe before the notice', { status: { ...noStatus, optedOutAt: T('2026-09-18T00:00:00Z') } }, 'opted_out'],
    ['opt-out after the notice', { status: { ...noStatus, optedOutAt: T('2026-09-25T00:00:00Z') } }, 'opted_out'],
    ['decline before the notice', { status: { ...noStatus, declinedAt: T('2026-09-17T00:00:00Z') } }, 'declined'],
    ['legacy unticked box, no express anywhere', { legacyConsent: [{ record: 'lead', id: 'lead_1', value: false, at: T('2026-09-17T00:00:00Z'), isSubject: true }] }, 'declined'],
    ['test identity (owner)', { testIdentity: 'owner' }, 'test_identity'],
    ['test identity (staff)', { testIdentity: 'staff' }, 'test_identity'],
    ['failed staff lookup', { testIdentity: 'staff_lookup_failed' }, 'eligibility_read_failed'],
    ['invalid address', { emailNormalized: 'nope' }, 'invalid_email'],
    ['notice flag off', { flags: { noticeBasisEnabled: false, ebrBasisEnabled: false } }, 'notice_basis_disabled'],
    ['183 days and a millisecond', { now: new Date(at.getTime() + NOTICE_BASIS_DAYS * DAY + 1) }, 'notice_expired'],
  ]
  for (const surface of NOTICE_SURFACES) {
    for (const [label, over, expected] of cases) {
      assert.equal(reason(decidePromotionalEligibility(scenarioOn(surface, 'lead_nurture', over))), expected, `${surface}: ${label}`)
    }
    //  The event-level checks run on the stored event itself.
    const ev = (o: Partial<BasisEventFact>) => ({ basisEvent: surfaceNotice(surface, o) })
    assert.equal(reason(decidePromotionalEligibility(scenarioOn(surface, 'lead_nurture', ev({ emailNormalized: 'first-typed@example.com' })))), 'basis_email_mismatch', surface)
    const nonNanp = decidePromotionalEligibility(scenarioOn(surface, 'lead_nurture', ev({ regionSignal: 'non_nanp' })))
    assert.ok(!nonNanp.eligible && nonNanp.reason === 'no_marketing_basis' && nonNanp.detail === 'non_nanp', `${surface} non_nanp`)
    const prePolicy = decidePromotionalEligibility(scenarioOn(surface, 'lead_nurture', ev({ occurredAt: new Date(NOTICE_POLICY_START.getTime() - 1) })))
    assert.ok(!prePolicy.eligible && prePolicy.detail === 'pre_policy_notice', `${surface} pre-policy`)
    const forged = decidePromotionalEligibility(scenarioOn(surface, 'lead_nurture', ev({ noticeCopySha256: 'f'.repeat(64) })))
    assert.ok(!forged.eligible && forged.detail === 'unregistered_notice', `${surface} forged hash`)
    const withheld = decidePromotionalEligibility(scenarioOn(surface, 'lead_nurture', ev({ kind: 'basis_withheld' })))
    assert.ok(!withheld.eligible && withheld.detail === 'basis_event_not_a_notice', `${surface} withheld event`)
    //  Exactly 183 days is still inside.
    assert.equal(reason(decidePromotionalEligibility(scenarioOn(surface, 'lead_nurture', { now: new Date(at.getTime() + NOTICE_BASIS_DAYS * DAY) }))), 'eligible:notice', surface)
  }
})

test('PERMISSION 6: basis_email_mismatch when the address changed after the notice', () => {
  const d = decidePromotionalEligibility(withNotice({ basisEvent: noticeEvent({ emailNormalized: 'first-typed@example.com' }) }))
  assert.deepEqual(d, { eligible: false, reason: 'basis_email_mismatch', terminal: true })
})

test('PERMISSION 6: expiry at 183 days — exactly 183 days is inside, one millisecond more is expired', () => {
  const at = T('2026-09-20T12:00:00Z')
  const edge = withNotice({ now: new Date(at.getTime() + NOTICE_BASIS_DAYS * DAY) })
  assert.equal(reason(decidePromotionalEligibility(edge)), 'eligible:notice')
  const past = withNotice({ now: new Date(at.getTime() + NOTICE_BASIS_DAYS * DAY + 1) })
  assert.deepEqual(decidePromotionalEligibility(past), { eligible: false, reason: 'notice_expired', terminal: true })
  //  Across the November DST change the window is still measured in elapsed time.
  const dstNotice = withNotice({
    basisEvent: noticeEvent({ occurredAt: T('2026-10-31T23:30:00-04:00') }),
    now: new Date(T('2026-10-31T23:30:00-04:00').getTime() + NOTICE_BASIS_DAYS * DAY),
  })
  assert.equal(reason(decidePromotionalEligibility(dstNotice)), 'eligible:notice')
})

test('PERMISSION 6: non_nanp gets no notice basis; unknown is treated like nanp', () => {
  const foreign = decidePromotionalEligibility(withNotice({ basisEvent: noticeEvent({ regionSignal: 'non_nanp' }) }))
  assert.ok(!foreign.eligible && foreign.reason === 'no_marketing_basis' && foreign.detail === 'non_nanp')
  assert.equal(reason(decidePromotionalEligibility(withNotice({ basisEvent: noticeEvent({ regionSignal: 'unknown' }) }))), 'eligible:notice')
  assert.equal(reason(decidePromotionalEligibility(withNotice({ basisEvent: noticeEvent({ regionSignal: null }) }))), 'eligible:notice')
  //  Express consent is still honoured for a non-NANP person.
  assert.equal(
    reason(decidePromotionalEligibility(withNotice({ basisEvent: noticeEvent({ regionSignal: 'non_nanp' }), status: express('2026-09-21T00:00:00Z') }))),
    'eligible:express',
  )
})

test('PERMISSION 6: pre-policy, unregistered, non-notice and missing events are never a basis', () => {
  const cases: Array<[string, Partial<EligibilityFacts>]> = [
    ['pre-policy notice', { basisEvent: noticeEvent({ occurredAt: T('2026-09-15T12:00:00Z') }) }],
    ['forged version', { basisEvent: noticeEvent({ noticeVersion: '2026-07-v1' }) }],
    ['hash for another locale', { basisEvent: noticeEvent({ locale: 'es' }) }],
    ['removed first-release version', { basisEvent: noticeEvent({ noticeVersion: 'quote-2026-09-16' }) }],
    ['a kind that no longer exists as a basis', { basisEvent: noticeEvent({ kind: 'express_opt_in_pending' }) }],
    ['an express opt-in event as a notice basis', { basisEvent: noticeEvent({ kind: 'express_opt_in' }) }],
    ['withheld event as a basis', { basisEvent: noticeEvent({ kind: 'basis_withheld' }) }],
    ['popup notice claimed for a quote follow-up', { basisEvent: surfaceNotice('popup') }],
    ['unknown surface', { basisEvent: noticeEvent({ surface: 'homepage' }) }],
    ['event not found', { basisEvent: null }],
    ['event id does not match the subject', { basisEvent: noticeEvent({ id: 'evt_other' }) }],
  ]
  for (const [label, over] of cases) {
    const d = decidePromotionalEligibility(withNotice(over, 'quote_followup'))
    assert.equal(reason(d), 'no_marketing_basis', label)
  }
})

test('flags off: the notice basis is disabled; express keeps working exactly as today', () => {
  const off = { noticeBasisEnabled: false, ebrBasisEnabled: false }
  assert.deepEqual(decidePromotionalEligibility(withNotice({ flags: off })), {
    eligible: false,
    reason: 'notice_basis_disabled',
    terminal: true,
  })
  assert.equal(reason(decidePromotionalEligibility(withNotice({ flags: off, status: express('2026-09-21T00:00:00Z') }))), 'eligible:express')
  assert.equal(reason(decidePromotionalEligibility(facts({ flags: off }))), 'no_marketing_basis')
})

// ── PERMISSION 8: campaigns may use the person's LATEST form notice ──────────

/** A campaign audience member (no subject) whose latest submission is `latestNotice`. */
function campaign(over: Partial<EligibilityFacts> = {}): EligibilityFacts {
  return facts({
    context: 'campaign',
    subject: { type: 'none', id: null, sequenceKind: null, basisEventId: null },
    latestNotice: noticeEvent({ id: 'evt_latest' }),
    ...over,
  })
}

test('PERMISSION 8: a valid latest notice from EVERY surface (contact_support included) is a campaign basis, under THAT event id', () => {
  assert.deepEqual(decidePromotionalEligibility(campaign()), { eligible: true, basis: 'notice', basisEventId: 'evt_latest' })
  for (const surface of NOTICE_SURFACES) {
    for (const locale of ['en', 'es'] as const) {
      const d = decidePromotionalEligibility(campaign({ latestNotice: surfaceNotice(surface, { id: `evt_${surface}_${locale}` }, locale) }))
      assert.deepEqual(d, { eligible: true, basis: 'notice', basisEventId: `evt_${surface}_${locale}` }, `${surface}/${locale}`)
    }
  }
  //  No latest notice: nothing to stand on.
  assert.deepEqual(decidePromotionalEligibility(campaign({ latestNotice: null })), { eligible: false, reason: 'no_marketing_basis', terminal: true })
  assert.equal(reason(decidePromotionalEligibility(campaign({ latestNotice: undefined }))), 'no_marketing_basis')
  //  Region unknown is treated like nanp, as for a scenario basis.
  assert.equal(reason(decidePromotionalEligibility(campaign({ latestNotice: noticeEvent({ regionSignal: 'unknown' }) }))), 'eligible:notice')
  assert.equal(reason(decidePromotionalEligibility(campaign({ latestNotice: noticeEvent({ regionSignal: null }) }))), 'eligible:notice')
})

test('PERMISSION 8: notice flag off → notice_basis_disabled', () => {
  const d = decidePromotionalEligibility(campaign({ flags: { noticeBasisEnabled: false, ebrBasisEnabled: true } }))
  assert.deepEqual(d, { eligible: false, reason: 'notice_basis_disabled', terminal: true })
})

test('PERMISSION 8: 183 days from the latest submission — exactly 183 is inside, a millisecond more is notice_expired', () => {
  const at = T('2026-09-20T12:00:00Z')
  assert.equal(reason(decidePromotionalEligibility(campaign({ now: new Date(at.getTime() + NOTICE_BASIS_DAYS * DAY) }))), 'eligible:notice')
  assert.deepEqual(decidePromotionalEligibility(campaign({ now: new Date(at.getTime() + NOTICE_BASIS_DAYS * DAY + 1) })), {
    eligible: false,
    reason: 'notice_expired',
    terminal: true,
  })
})

test('PERMISSION 8: a latest notice that is pre-policy, unregistered, non-NANP, not a notice, or for another address is refused', () => {
  const refused: Array<[string, BasisEventFact, string, string | undefined]> = [
    ['before NOTICE_POLICY_START', noticeEvent({ occurredAt: new Date(NOTICE_POLICY_START.getTime() - 1) }), 'no_marketing_basis', 'pre_policy_notice'],
    ['forged hash', noticeEvent({ noticeCopySha256: 'f'.repeat(64) }), 'no_marketing_basis', 'unregistered_notice'],
    ['hash for another locale', noticeEvent({ locale: 'es' }), 'no_marketing_basis', 'unregistered_notice'],
    ['unregistered version', noticeEvent({ noticeVersion: '2026-07-v1' }), 'no_marketing_basis', 'unregistered_notice'],
    ['removed first-release version', noticeEvent({ noticeVersion: 'quote-2026-09-16' }), 'no_marketing_basis', 'unregistered_notice'],
    ['version not registered for the surface', noticeEvent({ surface: 'contact' }), 'no_marketing_basis', 'unregistered_notice'],
    ['unknown surface', noticeEvent({ surface: 'homepage' }), 'no_marketing_basis', 'unknown_surface'],
    ['non_nanp', noticeEvent({ regionSignal: 'non_nanp' }), 'no_marketing_basis', 'non_nanp'],
    ['a withheld event', noticeEvent({ kind: 'basis_withheld' }), 'no_marketing_basis', 'basis_event_not_a_notice'],
    ['an express event', noticeEvent({ kind: 'express_opt_in' }), 'no_marketing_basis', 'basis_event_not_a_notice'],
    ['another address', noticeEvent({ emailNormalized: 'someone-else@example.com' }), 'basis_email_mismatch', undefined],
  ]
  for (const [label, ev, expected, detail] of refused) {
    const d = decidePromotionalEligibility(campaign({ latestNotice: ev }))
    assert.equal(d.eligible, false, label)
    if (!d.eligible) {
      assert.equal(d.reason, expected, label)
      assert.equal(d.detail, detail, label)
      assert.equal(d.terminal, true, label)
    }
  }
  //  The pre-policy boundary itself is inside.
  assert.equal(reason(decidePromotionalEligibility(campaign({ latestNotice: noticeEvent({ occurredAt: NOTICE_POLICY_START }), now: T('2026-09-20T00:00:00Z') }))), 'eligible:notice')
})

test('PERMISSION 8: a latest submission on contact_support is a normal campaign basis — answered first, then marketing, like contact, popup and tracker', () => {
  //  Owner direction 2026-09-16: a support or existing-booking message counts
  //  like every other topic. The 'support_request' hold no longer exists.
  for (const surface of ['contact_support', 'contact', 'popup', 'tracker'] as const) {
    for (const locale of ['en', 'es'] as const) {
      const d = decidePromotionalEligibility(campaign({ latestNotice: surfaceNotice(surface, { id: 'evt_support' }, locale) }))
      assert.deepEqual(d, { eligible: true, basis: 'notice', basisEventId: 'evt_support' }, `${surface}/${locale}`)
    }
  }
  assert.ok(!(INELIGIBLE_REASONS as readonly string[]).includes('support_request'), 'the support_request reason is gone')

  const support = (over: Partial<EligibilityFacts> = {}) => campaign({ latestNotice: surfaceNotice('contact_support', { id: 'evt_support' }), ...over })

  //  The notice flag still gates it.
  assert.deepEqual(decidePromotionalEligibility(support({ flags: { noticeBasisEnabled: false, ebrBasisEnabled: true } })), {
    eligible: false,
    reason: 'notice_basis_disabled',
    terminal: true,
  })
  //  183 days from the support message: exactly 183 is inside, a millisecond more is expired.
  const at = T('2026-09-20T12:00:00Z')
  assert.equal(reason(decidePromotionalEligibility(support({ now: new Date(at.getTime() + NOTICE_BASIS_DAYS * DAY) }))), 'eligible:notice')
  assert.deepEqual(decidePromotionalEligibility(support({ now: new Date(at.getTime() + NOTICE_BASIS_DAYS * DAY + 1) })), {
    eligible: false,
    reason: 'notice_expired',
    terminal: true,
  })
  //  The registry checks still apply to the support event itself.
  const forged = decidePromotionalEligibility(campaign({ latestNotice: surfaceNotice('contact_support', { noticeCopySha256: 'f'.repeat(64) }) }))
  assert.ok(!forged.eligible && forged.reason === 'no_marketing_basis' && forged.detail === 'unregistered_notice')
  const foreign = decidePromotionalEligibility(campaign({ latestNotice: surfaceNotice('contact_support', { regionSignal: 'non_nanp' }) }))
  assert.ok(!foreign.eligible && foreign.reason === 'no_marketing_basis' && foreign.detail === 'non_nanp')
  assert.equal(reason(decidePromotionalEligibility(campaign({ latestNotice: surfaceNotice('contact_support', { emailNormalized: 'someone-else@example.com' }) }))), 'basis_email_mismatch')

  //  EVERY prohibition still beats it: a support message never resubscribes anyone.
  const noStatus = { expressOptInAt: null, expressEventId: null, optedOutAt: null, declinedAt: null }
  for (const r of ['UNSUBSCRIBED', 'HARD_BOUNCE', 'SPAM_COMPLAINT', 'INVALID_ADDRESS', 'ADMIN_BLOCK', 'PROVIDER_REJECTED']) {
    for (const scope of ['promotional', 'all']) {
      const d = decidePromotionalEligibility(support({ suppression: { reason: r, scope } }))
      assert.ok(!d.eligible && d.reason === 'suppressed' && d.terminal && d.detail === `suppression:${r.toLowerCase()}`, `${r}/${scope}`)
    }
  }
  const prohibited: Array<[string, Partial<EligibilityFacts>, string]> = [
    ['customer marketingOptOut', { customerMarketingOptOut: true }, 'opted_out'],
    ['opt-out before the support message', { status: { ...noStatus, optedOutAt: T('2026-09-18T00:00:00Z') } }, 'opted_out'],
    ['opt-out after the support message', { status: { ...noStatus, optedOutAt: T('2026-09-25T00:00:00Z') } }, 'opted_out'],
    ['decline before the support message', { status: { ...noStatus, declinedAt: T('2026-09-17T00:00:00Z') } }, 'declined'],
    ['test identity (owner)', { testIdentity: 'owner' }, 'test_identity'],
    ['test identity (staff)', { testIdentity: 'staff' }, 'test_identity'],
    ['test identity (role account)', { testIdentity: 'role_account' }, 'test_identity'],
  ]
  for (const [label, over, expected] of prohibited) {
    const d = decidePromotionalEligibility(support(over))
    assert.equal(reason(d), expected, label)
    assert.ok(!d.eligible && d.terminal, `${label} is terminal`)
  }
})

test('PERMISSION 8: express permission is checked FIRST and wins over any latest notice', () => {
  const support = surfaceNotice('contact_support')
  for (const latestNotice of [noticeEvent(), support, noticeEvent({ regionSignal: 'non_nanp' }), noticeEvent({ noticeCopySha256: 'f'.repeat(64) })]) {
    assert.deepEqual(decidePromotionalEligibility(campaign({ latestNotice, status: express('2026-09-01T00:00:00Z', 'evt_x') })), {
      eligible: true,
      basis: 'express',
      basisEventId: 'evt_x',
    })
    //  A legacy true on any row counts in a campaign, as today — even with the notice flag off.
    const legacyTrue = [{ record: 'lead' as const, id: 'lead_other', value: true, at: T('2026-08-01T00:00:00Z'), isSubject: false }]
    assert.equal(reason(decidePromotionalEligibility(campaign({ latestNotice, legacyConsent: legacyTrue, flags: { noticeBasisEnabled: false, ebrBasisEnabled: false } }))), 'eligible:express')
  }
})

test('PERMISSION 8: every prohibition beats a valid latest notice — a form submission never resubscribes anyone', () => {
  const noStatus = { expressOptInAt: null, expressEventId: null, optedOutAt: null, declinedAt: null }
  const cases: Array<[string, Partial<EligibilityFacts>, string]> = [
    ['suppression', { suppression: { reason: 'UNSUBSCRIBED', scope: 'promotional' } }, 'suppressed'],
    ['bounce suppression', { suppression: { reason: 'HARD_BOUNCE', scope: 'all' } }, 'suppressed'],
    ['customer marketingOptOut', { customerMarketingOptOut: true }, 'opted_out'],
    //  The notice (2026-09-20) came AFTER these withdrawals: they still win.
    ['opt-out before the notice', { status: { ...noStatus, optedOutAt: T('2026-09-18T00:00:00Z') } }, 'opted_out'],
    ['opt-out after the notice', { status: { ...noStatus, optedOutAt: T('2026-09-25T00:00:00Z') } }, 'opted_out'],
    ['decline before the notice', { status: { ...noStatus, declinedAt: T('2026-09-17T00:00:00Z') } }, 'declined'],
    ['legacy unticked box, no express anywhere', { legacyConsent: [{ record: 'lead', id: 'lead_1', value: false, at: T('2026-09-17T00:00:00Z'), isSubject: false }] }, 'declined'],
    ['test identity', { testIdentity: 'staff' }, 'test_identity'],
    ['failed staff lookup', { testIdentity: 'staff_lookup_failed' }, 'eligibility_read_failed'],
    ['invalid address', { emailNormalized: 'nope' }, 'invalid_email'],
  ]
  for (const [label, over, expected] of cases) {
    assert.equal(reason(decidePromotionalEligibility(campaign(over))), expected, label)
  }
})

test('PERMISSION 8 is campaign-only: scenario_flow, automation and post_move IGNORE latestNotice', () => {
  for (const context of ['scenario_flow', 'automation', 'post_move'] as const) {
    const onlyLatest = decidePromotionalEligibility(campaign({ context }))
    assert.deepEqual(onlyLatest, { eligible: false, reason: 'no_marketing_basis', terminal: true }, context)
    //  Whatever surface it came from, the latest notice is simply not read.
    for (const surface of NOTICE_SURFACES) {
      assert.equal(reason(decidePromotionalEligibility(campaign({ context, latestNotice: surfaceNotice(surface) }))), 'no_marketing_basis', `${context} ${surface}`)
    }
    //  Nor does the flag matter to it.
    assert.equal(reason(decidePromotionalEligibility(campaign({ context, flags: { noticeBasisEnabled: false, ebrBasisEnabled: false } }))), 'no_marketing_basis', context)
  }
  //  A scenario flow decides on the SUBJECT's own basis whatever the latest notice says…
  const own = decidePromotionalEligibility(withNotice({ latestNotice: surfaceNotice('contact_support', { id: 'evt_support' }) }))
  assert.deepEqual(own, { eligible: true, basis: 'notice', basisEventId: 'evt_notice' })
  //  …and a valid latest notice cannot rescue a subject without one.
  const rescue = decidePromotionalEligibility(withNotice({ basisEvent: noticeEvent({ id: 'evt_other' }), latestNotice: noticeEvent({ id: 'evt_notice' }) }))
  assert.equal(reason(rescue), 'no_marketing_basis')
})

test('PERMISSION 7: ebr only for post_move, only with its flag, only within two years', () => {
  const recent = T('2026-06-01T00:00:00Z')
  assert.equal(reason(decidePromotionalEligibility(facts({ context: 'post_move', ebrAt: recent }))), 'no_marketing_basis', 'flag off = today')
  const on = { noticeBasisEnabled: true, ebrBasisEnabled: true }
  assert.deepEqual(decidePromotionalEligibility(facts({ context: 'post_move', ebrAt: recent, flags: on })), {
    eligible: true,
    basis: 'ebr',
    basisEventId: null,
  })
  for (const context of ['scenario_flow', 'campaign', 'automation'] as const) {
    assert.equal(reason(decidePromotionalEligibility(facts({ context, ebrAt: recent, flags: on }))), 'no_marketing_basis', context)
  }
  const old = new Date(NOW.getTime() - EBR_BASIS_DAYS * DAY - 1)
  assert.equal(reason(decidePromotionalEligibility(facts({ context: 'post_move', ebrAt: old, flags: on }))), 'no_marketing_basis')
  assert.equal(
    reason(decidePromotionalEligibility(facts({ context: 'post_move', ebrAt: recent, flags: on, suppression: { reason: 'UNSUBSCRIBED', scope: 'promotional' } }))),
    'suppressed',
  )
})

test('an address that is not an address is refused', () => {
  assert.equal(reason(decidePromotionalEligibility(facts({ emailNormalized: 'nope' }))), 'invalid_email')
})

test('every reason is terminal except a read failure', () => {
  assert.ok(INELIGIBLE_REASONS.includes('eligibility_read_failed'))
  assert.deepEqual([...RETRYABLE_INELIGIBLE_REASONS], ['eligibility_read_failed'])
  for (const r of ['suppressed', 'opted_out', 'declined', 'test_identity', 'no_marketing_basis', 'notice_expired', 'notice_basis_disabled', 'basis_email_mismatch', 'invalid_email']) {
    assert.ok(INELIGIBLE_REASONS.includes(r as never), r)
  }
  //  The campaign support-request hold was removed: a support message is a normal notice basis.
  assert.ok(!(INELIGIBLE_REASONS as readonly string[]).includes('support_request'))
  assert.equal(INELIGIBLE_REASONS.length, 10)
})

// ═══ PART 2 — THE LOADER ═══════════════════════════════════════════════════

const NOTICE_ENV = { EMAIL_NOTICE_BASIS_ENABLED: 'true' }
const notTest = async () => null

function seedNoticeEvent(db: ReturnType<typeof createFakeConsentDb>, over: Record<string, unknown> = {}) {
  const row = {
    id: 'evt_q1',
    emailNormalized: EMAIL,
    kind: 'notice_accepted',
    surface: 'quote',
    occurredAt: T('2026-09-20T12:00:00Z'),
    regionSignal: 'nanp',
    noticeVersion: 'quote-2026-09-16-r2',
    noticeCopySha256: QUOTE_HASH_EN,
    locale: 'en',
    requestId: 'req_q1',
    ...over,
  }
  db.tables.events.push(row)
  return row
}

const asDb = (db: ReturnType<typeof createFakeConsentDb>) => db as unknown as EligibilityDb

test('loader: a lead whose STORED basis is a valid notice is eligible for its scenario', async () => {
  const db = createFakeConsentDb()
  seedNoticeEvent(db)
  db.tables.leads.push({ id: 'lead_1', email: EMAIL, emailMarketingConsent: null, marketingConsentAt: null, basisEventId: 'evt_q1' })
  const d = await promotionalEligibility(
    { context: 'scenario_flow', email: 'Person@Example.com ', subject: { type: 'lead', id: 'lead_1', sequenceKind: 'quote_followup' }, now: NOW },
    { db: asDb(db), env: NOTICE_ENV, testIdentity: notTest },
  )
  assert.deepEqual(d, { eligible: true, basis: 'notice', basisEventId: 'evt_q1' })

  //  The same facts with the flag unset (production today): disabled.
  const off = await promotionalEligibility(
    { context: 'scenario_flow', email: EMAIL, subject: { type: 'lead', id: 'lead_1', sequenceKind: 'quote_followup' }, now: NOW },
    { db: asDb(db), env: {}, testIdentity: notTest },
  )
  assert.equal(reason(off), 'notice_basis_disabled')
})

test('loader: a lead whose STORED basis is a contact_support, contact, tracker or popup notice is eligible for lead_nurture only', async () => {
  for (const surface of ['contact_support', 'contact', 'tracker', 'popup'] as const) {
    const db = createFakeConsentDb()
    const version = versionFor(surface)
    seedNoticeEvent(db, { id: 'evt_form', requestId: `req_${surface}`, surface, noticeVersion: version, noticeCopySha256: NOTICE_VERSIONS[version].copySha256.es, locale: 'es' })
    db.tables.leads.push({ id: 'lead_1', email: EMAIL, emailMarketingConsent: null, marketingConsentAt: null, basisEventId: 'evt_form' })
    const run = (sequenceKind: SequenceKind, env: Record<string, string> = NOTICE_ENV) =>
      promotionalEligibility(
        { context: 'scenario_flow', email: EMAIL, subject: { type: 'lead', id: 'lead_1', sequenceKind }, now: NOW },
        { db: asDb(db), env, testIdentity: notTest },
      )
    assert.deepEqual(await run('lead_nurture'), { eligible: true, basis: 'notice', basisEventId: 'evt_form' }, surface)
    assert.deepEqual(await run('quote_followup'), NOT_IN_SCENARIO, `${surface} → quote_followup`)
    assert.deepEqual(await run('abandoned_checkout'), NOT_IN_SCENARIO, `${surface} → abandoned_checkout`)
    //  Flag unset (production today): disabled.
    assert.equal(reason(await run('lead_nurture', {})), 'notice_basis_disabled', surface)
    //  An unsubscribe wins over the stored basis.
    db.tables.suppressions.push({ email: EMAIL, reason: 'UNSUBSCRIBED', scope: 'promotional' })
    assert.equal(reason(await run('lead_nurture')), 'suppressed', surface)
  }
  //  A quote notice permits both lead sequences; a booking notice permits lead_nurture for its lead.
  for (const [surface, kinds] of [['quote', ['quote_followup', 'lead_nurture']], ['booking', ['lead_nurture']]] as const) {
    const db = createFakeConsentDb()
    const version = versionFor(surface)
    seedNoticeEvent(db, { id: 'evt_form', surface, noticeVersion: version, noticeCopySha256: NOTICE_VERSIONS[version].copySha256.en })
    db.tables.leads.push({ id: 'lead_1', email: EMAIL, emailMarketingConsent: null, marketingConsentAt: null, basisEventId: 'evt_form' })
    for (const sequenceKind of kinds) {
      const d = await promotionalEligibility(
        { context: 'scenario_flow', email: EMAIL, subject: { type: 'lead', id: 'lead_1', sequenceKind }, now: NOW },
        { db: asDb(db), env: NOTICE_ENV, testIdentity: notTest },
      )
      assert.deepEqual(d, { eligible: true, basis: 'notice', basisEventId: 'evt_form' }, `${surface} → ${sequenceKind}`)
    }
  }
})

test('loader: the caller cannot supply a basis for a lead — the stored column is authoritative', async () => {
  const db = createFakeConsentDb()
  seedNoticeEvent(db)
  db.tables.leads.push({ id: 'lead_old', email: EMAIL, emailMarketingConsent: null, marketingConsentAt: null, basisEventId: null })
  const d = await promotionalEligibility(
    { context: 'scenario_flow', email: EMAIL, subject: { type: 'lead', id: 'lead_old', sequenceKind: 'quote_followup', basisEventId: 'evt_q1' }, now: NOW },
    { db: asDb(db), env: NOTICE_ENV, testIdentity: notTest },
  )
  assert.equal(reason(d), 'no_marketing_basis')
})

test('loader: an in-session address change voids the basis (basis_email_mismatch)', async () => {
  const db = createFakeConsentDb()
  seedNoticeEvent(db, { emailNormalized: 'typo@example.com' })
  db.tables.leads.push({ id: 'lead_1', email: EMAIL, emailMarketingConsent: null, marketingConsentAt: null, basisEventId: 'evt_q1' })
  const d = await promotionalEligibility(
    { context: 'scenario_flow', email: EMAIL, subject: { type: 'lead', id: 'lead_1', sequenceKind: 'quote_followup' }, now: NOW },
    { db: asDb(db), env: NOTICE_ENV, testIdentity: notTest },
  )
  assert.equal(reason(d), 'basis_email_mismatch')
})

test('loader: PRE-POLICY ROWS SHAPED LIKE PRODUCTION ARE NEVER ELIGIBLE, even after a new notice for the same person', async () => {
  const db = createFakeConsentDb()
  //  Production today: leads with consent null (never asked), quoted weeks ago,
  //  no basis column value; a blocked retryable send would re-check exactly this.
  db.tables.leads.push(
    { id: 'lead_july', email: EMAIL, emailMarketingConsent: null, marketingConsentAt: null, basisEventId: null, quotedAt: T('2026-07-10T00:00:00Z') },
    { id: 'lead_aug', email: EMAIL.toUpperCase(), emailMarketingConsent: null, marketingConsentAt: null, basisEventId: null },
  )
  //  A NEW submission records a notice for a NEW lead.
  seedNoticeEvent(db)
  db.tables.leads.push({ id: 'lead_new', email: EMAIL, emailMarketingConsent: null, marketingConsentAt: null, basisEventId: 'evt_q1' })

  for (const id of ['lead_july', 'lead_aug']) {
    for (const context of ELIGIBILITY_CONTEXTS) {
      for (const sequenceKind of SEQUENCE_KINDS) {
        const d = await promotionalEligibility(
          { context, email: EMAIL, subject: { type: 'lead', id, sequenceKind }, now: NOW },
          { db: asDb(db), env: { ...NOTICE_ENV, EMAIL_EBR_BASIS_ENABLED: 'true' }, testIdentity: notTest },
        )
        assert.equal(d.eligible, false, `${id} ${context} ${sequenceKind} must not borrow the new lead's notice`)
      }
    }
  }
  //  And a notice recorded with a pre-policy timestamp is not a basis even for its own lead.
  db.tables.events[0].occurredAt = T('2026-09-01T00:00:00Z')
  const own = await promotionalEligibility(
    { context: 'scenario_flow', email: EMAIL, subject: { type: 'lead', id: 'lead_new', sequenceKind: 'quote_followup' }, now: NOW },
    { db: asDb(db), env: NOTICE_ENV, testIdentity: notTest },
  )
  assert.equal(reason(own), 'no_marketing_basis')
})

test('loader: legacy consent keeps today\'s scoping across two leads and a customer', async () => {
  const db = createFakeConsentDb()
  db.tables.leads.push(
    { id: 'lead_a', email: EMAIL, emailMarketingConsent: true, marketingConsentAt: T('2026-08-01T00:00:00Z'), basisEventId: null },
    { id: 'lead_b', email: EMAIL, emailMarketingConsent: null, marketingConsentAt: null, basisEventId: null },
  )
  const run = (context: 'scenario_flow' | 'campaign', id: string) =>
    promotionalEligibility({ context, email: EMAIL, subject: { type: 'lead', id, sequenceKind: 'quote_followup' }, now: NOW }, { db: asDb(db), env: {}, testIdentity: notTest })
  assert.equal(reason(await run('scenario_flow', 'lead_a')), 'eligible:express')
  assert.equal(reason(await run('scenario_flow', 'lead_b')), 'no_marketing_basis')
  assert.equal(reason(await run('campaign', 'lead_b')), 'eligible:express')

  //  A booking reads its CUSTOMER's own column, as bookingEligibility does today.
  db.tables.customers.push({ id: 'cust_1', email: EMAIL, emailMarketingConsent: null, marketingConsentAt: null, marketingOptOut: false })
  db.tables.bookings.push({ id: 'bk_1', customerId: 'cust_1', basisEventId: null, isInternalTest: false, status: 'PENDING_PAYMENT', depositPaid: false, createdAt: NOW, completedAt: null })
  const booking = await promotionalEligibility(
    { context: 'scenario_flow', email: EMAIL, subject: { type: 'booking', id: 'bk_1', sequenceKind: 'abandoned_checkout' }, now: NOW },
    { db: asDb(db), env: {}, testIdentity: notTest },
  )
  assert.equal(reason(booking), 'no_marketing_basis', 'a lead\'s legacy consent is not the customer\'s')
  db.tables.customers[0].emailMarketingConsent = true
  db.tables.customers[0].marketingConsentAt = T('2026-08-02T00:00:00Z')
  const booking2 = await promotionalEligibility(
    { context: 'scenario_flow', email: EMAIL, subject: { type: 'booking', id: 'bk_1', sequenceKind: 'abandoned_checkout' }, now: NOW },
    { db: asDb(db), env: {}, testIdentity: notTest },
  )
  assert.equal(reason(booking2), 'eligible:express')
})

test('loader: an old consent=true is withdrawn by a later unsubscribe (suppression) and by marketingOptOut', async () => {
  const db = createFakeConsentDb()
  db.tables.leads.push({ id: 'lead_a', email: EMAIL, emailMarketingConsent: true, marketingConsentAt: T('2026-08-01T00:00:00Z'), basisEventId: null })
  db.tables.suppressions.push({ email: EMAIL, reason: 'UNSUBSCRIBED', scope: 'promotional' })
  const d = await promotionalEligibility({ context: 'campaign', email: EMAIL, now: NOW }, { db: asDb(db), env: {}, testIdentity: notTest })
  assert.equal(reason(d), 'suppressed')

  db.tables.suppressions.length = 0
  db.tables.customers.push({ id: 'cust_1', email: EMAIL, emailMarketingConsent: true, marketingConsentAt: T('2026-08-01T00:00:00Z'), marketingOptOut: true })
  assert.equal(reason(await promotionalEligibility({ context: 'campaign', email: EMAIL, now: NOW }, { db: asDb(db), env: {}, testIdentity: notTest })), 'opted_out')
})

test('loader: status withdrawals and express are read per person', async () => {
  const db = createFakeConsentDb()
  db.tables.status.push({ emailNormalized: EMAIL, expressOptInAt: T('2026-09-20T00:00:00Z'), expressEventId: 'evt_c', optedOutAt: null, declinedAt: null, lastNoticeAt: null, lastNoticeEventId: null, updatedAt: NOW })
  const ok = await promotionalEligibility({ context: 'automation', email: EMAIL, subject: { type: 'none' }, now: NOW }, { db: asDb(db), env: {}, testIdentity: notTest })
  assert.deepEqual(ok, { eligible: true, basis: 'express', basisEventId: 'evt_c' })
  db.tables.status[0].optedOutAt = T('2026-09-21T00:00:00Z')
  assert.equal(reason(await promotionalEligibility({ context: 'automation', email: EMAIL, now: NOW }, { db: asDb(db), env: {}, testIdentity: notTest })), 'opted_out')
})

// ── loader, campaign context: the latest notice via email_marketing_status ──

type FakeDb = ReturnType<typeof createFakeConsentDb>

function statusRow(db: FakeDb, over: Record<string, unknown> = {}) {
  const row = {
    emailNormalized: EMAIL,
    expressOptInAt: null,
    expressEventId: null,
    optedOutAt: null,
    declinedAt: null,
    lastNoticeAt: T('2026-09-20T12:00:00Z'),
    lastNoticeEventId: 'evt_q1',
    updatedAt: NOW,
    ...over,
  }
  db.tables.status.push(row)
  return row
}

/** Record every emailConsentEvent.findUnique the loader makes. */
function spyEventReads(db: FakeDb): Array<{ where: Record<string, unknown>; select: unknown }> {
  const reads: Array<{ where: Record<string, unknown>; select: unknown }> = []
  const real = db.emailConsentEvent.findUnique
  db.emailConsentEvent.findUnique = async (args: { where: Record<string, unknown>; select: unknown }) => {
    reads.push({ where: args.where, select: args.select })
    return real(args)
  }
  return reads
}

test('loader (campaign): the event status.lastNoticeEventId points at is read and decides', async () => {
  const db = createFakeConsentDb()
  seedNoticeEvent(db)
  statusRow(db)
  const reads = spyEventReads(db)
  const d = await promotionalEligibility({ context: 'campaign', email: ' Person@Example.com', now: NOW }, { db: asDb(db), env: NOTICE_ENV, testIdentity: notTest })
  assert.deepEqual(d, { eligible: true, basis: 'notice', basisEventId: 'evt_q1' })
  assert.deepEqual(reads, [{ where: { id: 'evt_q1' }, select: BASIS_EVENT_SELECT }], 'exactly one read, by the status pointer')

  //  Flag unset (production today): disabled.
  assert.equal(reason(await promotionalEligibility({ context: 'campaign', email: EMAIL, now: NOW }, { db: asDb(db), env: {}, testIdentity: notTest })), 'notice_basis_disabled')
})

test('loader (campaign): the POINTER decides, not the newest event — a newer unreferenced event is never read', async () => {
  const db = createFakeConsentDb()
  //  The status points at a support message; a newer quote notice exists but is not the pointer.
  seedNoticeEvent(db, {
    id: 'evt_support',
    requestId: 'req_s',
    surface: 'contact_support',
    noticeVersion: 'contact-2026-09-16-r2',
    noticeCopySha256: NOTICE_VERSIONS['contact-2026-09-16-r2'].copySha256.en,
  })
  seedNoticeEvent(db, { id: 'evt_newer_quote', requestId: 'req_n', occurredAt: T('2026-09-28T12:00:00Z') })
  statusRow(db, { lastNoticeEventId: 'evt_support' })
  const reads = spyEventReads(db)
  //  A support message is a normal basis now — under ITS id, not the newer event's.
  const d = await promotionalEligibility({ context: 'campaign', email: EMAIL, now: NOW }, { db: asDb(db), env: NOTICE_ENV, testIdentity: notTest })
  assert.deepEqual(d, { eligible: true, basis: 'notice', basisEventId: 'evt_support' })
  assert.deepEqual(reads.map((r) => r.where.id), ['evt_support'])

  //  The pointer decides a REFUSAL too: a non-NANP pointed-at event refuses even
  //  though a newer valid notice exists for the same address.
  seedNoticeEvent(db, { id: 'evt_foreign', requestId: 'req_f', regionSignal: 'non_nanp' })
  db.tables.status[0].lastNoticeEventId = 'evt_foreign'
  const foreign = await promotionalEligibility({ context: 'campaign', email: EMAIL, now: NOW }, { db: asDb(db), env: NOTICE_ENV, testIdentity: notTest })
  assert.ok(!foreign.eligible && foreign.reason === 'no_marketing_basis' && foreign.detail === 'non_nanp')
  assert.deepEqual(reads.map((r) => r.where.id), ['evt_support', 'evt_foreign'], 'the newer quote notice was never read')

  //  Move the pointer: the quote notice is now the basis.
  db.tables.status[0].lastNoticeEventId = 'evt_newer_quote'
  assert.deepEqual(
    await promotionalEligibility({ context: 'campaign', email: EMAIL, now: NOW }, { db: asDb(db), env: NOTICE_ENV, testIdentity: notTest }),
    { eligible: true, basis: 'notice', basisEventId: 'evt_newer_quote' },
  )
  //  No pointer (or no status row): events alone are never a campaign basis.
  db.tables.status[0].lastNoticeEventId = null
  assert.equal(reason(await promotionalEligibility({ context: 'campaign', email: EMAIL, now: NOW }, { db: asDb(db), env: NOTICE_ENV, testIdentity: notTest })), 'no_marketing_basis')
  db.tables.status.length = 0
  assert.equal(reason(await promotionalEligibility({ context: 'campaign', email: EMAIL, now: NOW }, { db: asDb(db), env: NOTICE_ENV, testIdentity: notTest })), 'no_marketing_basis')
  //  A pointer to an event that is not there.
  statusRow(db, { lastNoticeEventId: 'evt_gone' })
  assert.equal(reason(await promotionalEligibility({ context: 'campaign', email: EMAIL, now: NOW }, { db: asDb(db), env: NOTICE_ENV, testIdentity: notTest })), 'no_marketing_basis')
})

test('loader: the latest notice is loaded ONLY in campaign context', async () => {
  const db = createFakeConsentDb()
  seedNoticeEvent(db)
  statusRow(db)
  const reads = spyEventReads(db)
  const env = { ...NOTICE_ENV, EMAIL_EBR_BASIS_ENABLED: 'true' }
  for (const context of ['scenario_flow', 'automation', 'post_move'] as const) {
    for (const subject of [undefined, { type: 'none' as const }, { type: 'customer' as const, id: 'cust_x' }]) {
      const d = await promotionalEligibility({ context, email: EMAIL, subject, now: NOW }, { db: asDb(db), env, testIdentity: notTest })
      assert.equal(reason(d), 'no_marketing_basis', `${context} ${JSON.stringify(subject)}`)
    }
  }
  assert.equal(reads.length, 0, 'no consent event was read outside a campaign')
  //  A lead in a scenario flow reads ITS stored basis, never the status pointer.
  db.tables.leads.push({ id: 'lead_1', email: EMAIL, emailMarketingConsent: null, marketingConsentAt: null, basisEventId: null })
  await promotionalEligibility({ context: 'scenario_flow', email: EMAIL, subject: { type: 'lead', id: 'lead_1', sequenceKind: 'quote_followup' }, now: NOW }, { db: asDb(db), env, testIdentity: notTest })
  assert.equal(reads.length, 0)
  await promotionalEligibility({ context: 'campaign', email: EMAIL, now: NOW }, { db: asDb(db), env, testIdentity: notTest })
  assert.deepEqual(reads.map((r) => r.where.id), ['evt_q1'])
})

test('loader (campaign): prohibitions still beat a valid latest notice; a failed event read fails closed', async () => {
  const withSuppression = createFakeConsentDb()
  seedNoticeEvent(withSuppression)
  statusRow(withSuppression)
  withSuppression.tables.suppressions.push({ email: EMAIL, reason: 'UNSUBSCRIBED', scope: 'promotional' })
  assert.equal(reason(await promotionalEligibility({ context: 'campaign', email: EMAIL, now: NOW }, { db: asDb(withSuppression), env: NOTICE_ENV, testIdentity: notTest })), 'suppressed')

  //  An opt-out recorded BEFORE the latest notice still wins: a form never resubscribes.
  const optedOut = createFakeConsentDb()
  seedNoticeEvent(optedOut)
  statusRow(optedOut, { optedOutAt: T('2026-09-19T00:00:00Z') })
  assert.equal(reason(await promotionalEligibility({ context: 'campaign', email: EMAIL, now: NOW }, { db: asDb(optedOut), env: NOTICE_ENV, testIdentity: notTest })), 'opted_out')

  //  The customer's marketingOptOut.
  const custOut = createFakeConsentDb()
  seedNoticeEvent(custOut)
  statusRow(custOut)
  custOut.tables.customers.push({ id: 'cust_1', email: EMAIL, emailMarketingConsent: null, marketingConsentAt: null, marketingOptOut: true })
  assert.equal(reason(await promotionalEligibility({ context: 'campaign', email: EMAIL, now: NOW }, { db: asDb(custOut), env: NOTICE_ENV, testIdentity: notTest })), 'opted_out')

  //  Expired by the time of the campaign.
  const old = createFakeConsentDb()
  seedNoticeEvent(old)
  statusRow(old)
  const later = new Date(T('2026-09-20T12:00:00Z').getTime() + NOTICE_BASIS_DAYS * DAY + 1)
  assert.equal(reason(await promotionalEligibility({ context: 'campaign', email: EMAIL, now: later }, { db: asDb(old), env: NOTICE_ENV, testIdentity: notTest })), 'notice_expired')

  const down = createFakeConsentDb({ failModels: new Set(['emailConsentEvent']) })
  statusRow(down)
  const d = await promotionalEligibility({ context: 'campaign', email: EMAIL, now: NOW }, { db: asDb(down), env: NOTICE_ENV, testIdentity: notTest })
  assert.ok(!d.eligible && d.reason === 'eligibility_read_failed' && d.terminal === false)
})

test('loader: the default identity check runs — a reserved or staff address is a test identity', async () => {
  const db = createFakeConsentDb()
  db.tables.status.push({ emailNormalized: EMAIL, expressOptInAt: T('2026-09-20T00:00:00Z'), expressEventId: 'e', optedOutAt: null, declinedAt: null, lastNoticeAt: null, lastNoticeEventId: null, updatedAt: NOW })
  const d = await promotionalEligibility({ context: 'campaign', email: EMAIL, now: NOW }, { db: asDb(db), env: {} })
  assert.ok(!d.eligible && d.reason === 'test_identity' && d.detail === 'reserved_domain')
})

test('loader: ebr reads real paid/completed bookings, never internal tests, only with its flag', async () => {
  const db = createFakeConsentDb()
  db.tables.customers.push({ id: 'cust_1', email: EMAIL, emailMarketingConsent: null, marketingConsentAt: null, marketingOptOut: false })
  db.tables.bookings.push({ id: 'bk_test', customerId: 'cust_1', isInternalTest: true, status: 'COMPLETED', depositPaid: true, createdAt: T('2026-05-01T00:00:00Z'), completedAt: T('2026-05-02T00:00:00Z'), basisEventId: null })
  const req = { context: 'post_move' as const, email: EMAIL, subject: { type: 'customer' as const, id: 'cust_1' }, now: NOW }
  const on = { EMAIL_EBR_BASIS_ENABLED: 'true' }
  assert.equal(reason(await promotionalEligibility(req, { db: asDb(db), env: on, testIdentity: notTest })), 'no_marketing_basis', 'internal test booking')
  db.tables.bookings.push({ id: 'bk_real', customerId: 'cust_1', isInternalTest: false, status: 'COMPLETED', depositPaid: true, createdAt: T('2026-05-01T00:00:00Z'), completedAt: T('2026-05-02T00:00:00Z'), basisEventId: null })
  assert.equal(reason(await promotionalEligibility(req, { db: asDb(db), env: on, testIdentity: notTest })), 'eligible:ebr')
  assert.equal(reason(await promotionalEligibility(req, { db: asDb(db), env: {}, testIdentity: notTest })), 'no_marketing_basis', 'flag unset = express only, as today')
})

test('loader: FAILS CLOSED — a read error is eligibility_read_failed and retryable, never a send', async () => {
  for (const model of ['emailSuppression', 'customer', 'lead', 'emailMarketingStatus', 'emailConsentEvent']) {
    const db = createFakeConsentDb({ failModels: new Set([model]) })
    db.tables.status.push({ emailNormalized: EMAIL, expressOptInAt: T('2026-09-20T00:00:00Z'), expressEventId: 'e', optedOutAt: null, declinedAt: null, lastNoticeAt: null, lastNoticeEventId: null, updatedAt: NOW })
    db.tables.leads.push({ id: 'lead_1', email: EMAIL, emailMarketingConsent: null, marketingConsentAt: null, basisEventId: 'evt_q1' })
    const d = await promotionalEligibility(
      { context: 'scenario_flow', email: EMAIL, subject: { type: 'lead', id: 'lead_1', sequenceKind: 'quote_followup' }, now: NOW },
      { db: asDb(db), env: NOTICE_ENV, testIdentity: notTest },
    )
    //  Even with an express opt-in on file, an unreadable table is not a send.
    assert.ok(!d.eligible && d.reason === 'eligibility_read_failed' && d.terminal === false, model)
  }
  const throwingIdentity = async () => {
    throw new Error('boom')
  }
  const db = createFakeConsentDb()
  const d = await promotionalEligibility({ context: 'campaign', email: EMAIL, now: NOW }, { db: asDb(db), env: {}, testIdentity: throwingIdentity })
  assert.equal(reason(d), 'eligibility_read_failed')
})
