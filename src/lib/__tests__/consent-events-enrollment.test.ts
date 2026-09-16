// ════════════════════════════════════════════════════════════════════════
//  consent-events-enrollment.test.ts — the append-only consent record, the
//  forward-only per-person status, and per-person enrollment idempotency
//  (DESIGN-v2 §2 and §7). OFFLINE, against an in-memory fake Prisma.
//
//  The race-proof versions of these guarantees are database constraints and
//  a trigger; consent-db.test.ts proves those against a disposable Postgres.
//  This suite proves the application logic around them, and pins the
//  migration text so the constraint, trigger and ordering cannot be dropped.
// ════════════════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { assertNoProductionCredentials, assertTestRecipient } from './_disposable-test-env'
import { createFakeConsentDb } from './_consent-fake-db'
import {
  CONSENT_EVENT_KINDS,
  GRANT_EVENT_KINDS,
  WITHDRAWAL_EVENT_KINDS,
  readMarketingStatus,
  recordConsentEvent,
  sanitizePageUrl,
  type ConsentEventInput,
  type ConsentEventsDb,
} from '../consent/consent-events'
import {
  ENROLLMENT_WINDOW_DAYS,
  activeEnrollment,
  enrollSequence,
  personBookedSince,
  stopEnrollmentsForPerson,
  windowStartFor,
  type BookingHistoryDb,
  type EnrollmentDb,
} from '../consent/sequence-enrollment'
import { NOTICE_VERSIONS } from '../consent/notice-registry'

assertNoProductionCredentials()

const EMAIL = 'someone@example.com'
assertTestRecipient(EMAIL)
const DAY = 24 * 60 * 60 * 1000
const T = (iso: string) => new Date(iso)
type Fake = ReturnType<typeof createFakeConsentDb>
const cdb = (db: Fake) => db as unknown as ConsentEventsDb
const edb = (db: Fake) => db as unknown as EnrollmentDb

let reqSeq = 0
function notice(over: Partial<ConsentEventInput> = {}): ConsentEventInput {
  return {
    email: EMAIL,
    kind: 'notice_accepted',
    surface: 'quote',
    requestId: `req_${++reqSeq}`,
    noticeVersion: 'quote-2026-09-16-r2',
    noticeCopySha256: NOTICE_VERSIONS['quote-2026-09-16-r2'].copySha256.en,
    locale: 'en',
    trigger: 'submit',
    optOutBox: false,
    occurredAt: T('2026-09-20T12:00:00Z'),
    ...over,
  }
}
/** The token-authenticated resubscribe page is the only writer of express_opt_in. */
const RESUBSCRIBE = { surface: 'resubscribe_page' }
const simple = (kind: ConsentEventInput['kind'], at: string, over: Partial<ConsentEventInput> = {}): ConsentEventInput => ({
  email: EMAIL,
  kind,
  surface: 'quote',
  requestId: `req_${++reqSeq}`,
  occurredAt: T(at),
  ...over,
})

// ── recordConsentEvent ─────────────────────────────────────────────────────

test('the kind vocabulary: no pending/confirm kind; a notice is the ONLY capture-time grant', () => {
  assert.deepEqual([...CONSENT_EVENT_KINDS], [
    'notice_accepted',
    'express_opt_in',
    'opted_out_at_capture',
    'declined_at_capture',
    'unsubscribed',
    'resubscribed',
    'basis_withheld',
  ])
  assert.ok(!(CONSENT_EVENT_KINDS as readonly string[]).includes('express_opt_in_pending'))
  assert.deepEqual([...GRANT_EVENT_KINDS], ['notice_accepted'], 'what the per-IP and global throttles count')
  assert.deepEqual([...WITHDRAWAL_EVENT_KINDS].sort(), ['declined_at_capture', 'opted_out_at_capture', 'unsubscribed'])
})

test('a notice is recorded with its evidence and moves last_notice forward in the same transaction', async () => {
  const db = createFakeConsentDb()
  const r = await recordConsentEvent(
    notice({ email: '  SomeOne@Example.COM ', pageUrl: 'https://www.moveitclearit.com/quote.html?email=someone%40example.com#top', ipHmac: 'h', uaHash: 'u', turnstileOk: true, emailUserTyped: true, regionSignal: 'nanp' }),
    cdb(db),
  )
  assert.ok(r.ok && r.created)
  const [ev] = db.tables.events
  assert.equal(ev.emailNormalized, EMAIL)
  assert.equal(ev.pageUrl, 'https://www.moveitclearit.com/quote.html', 'the query string (which can hold the address) is dropped')
  assert.equal(ev.turnstileOk, true)
  assert.equal(ev.emailUserTyped, true)
  const status = await readMarketingStatus(EMAIL, db as never)
  assert.ok(status)
  assert.equal(status!.lastNoticeEventId, ev.id)
  assert.equal(status!.lastNoticeAt!.toISOString(), '2026-09-20T12:00:00.000Z')
  assert.equal(status!.expressOptInAt, null, 'a notice is NEVER express consent')
})

test('the event never touches Lead/Customer consent columns or suppressions', async () => {
  const db = createFakeConsentDb()
  db.tables.leads.push({ id: 'lead_1', email: EMAIL, emailMarketingConsent: null })
  db.tables.customers.push({ id: 'cust_1', email: EMAIL, emailMarketingConsent: null, marketingOptOut: false })
  for (const kind of CONSENT_EVENT_KINDS) {
    const input =
      kind === 'notice_accepted'
        ? notice({ leadId: 'lead_1' })
        : simple(kind, '2026-09-21T00:00:00Z', { withheldReason: kind === 'basis_withheld' ? 'honeypot' : null, leadId: 'lead_1' })
    const r = await recordConsentEvent(input, cdb(db))
    assert.ok(r.ok, `${kind}: ${JSON.stringify(r)}`)
  }
  assert.equal(db.tables.leads[0].emailMarketingConsent, null)
  assert.equal(db.tables.customers[0].emailMarketingConsent, null)
  assert.equal(db.tables.customers[0].marketingOptOut, false)
  assert.equal(db.tables.suppressions.length, 0)
})

test('status timestamps only move FORWARD — a late or replayed older event cannot undo a withdrawal', async () => {
  const db = createFakeConsentDb()
  assert.ok((await recordConsentEvent(simple('opted_out_at_capture', '2026-09-25T00:00:00Z'), cdb(db))).ok)
  assert.ok((await recordConsentEvent(simple('opted_out_at_capture', '2026-09-22T00:00:00Z'), cdb(db))).ok, 'older event still recorded as evidence')
  assert.equal(db.tables.events.length, 2)
  assert.equal(db.tables.status[0].optedOutAt.toISOString(), '2026-09-25T00:00:00.000Z')

  assert.ok((await recordConsentEvent(simple('express_opt_in', '2026-09-28T00:00:00Z', RESUBSCRIBE), cdb(db))).ok)
  const expressId = db.tables.status[0].expressEventId
  assert.ok((await recordConsentEvent(simple('express_opt_in', '2026-09-26T00:00:00Z', RESUBSCRIBE), cdb(db))).ok)
  assert.equal(db.tables.status[0].expressOptInAt.toISOString(), '2026-09-28T00:00:00.000Z')
  assert.equal(db.tables.status[0].expressEventId, expressId, 'the event id moves only with its timestamp')

  assert.ok((await recordConsentEvent(simple('unsubscribed', '2026-09-30T00:00:00Z', { surface: 'unsubscribe' }), cdb(db))).ok)
  assert.equal(db.tables.status[0].optedOutAt.toISOString(), '2026-09-30T00:00:00.000Z')
  assert.ok((await recordConsentEvent(simple('declined_at_capture', '2026-09-19T00:00:00Z'), cdb(db))).ok)
  assert.equal(db.tables.status[0].declinedAt.toISOString(), '2026-09-19T00:00:00.000Z')
  assert.equal(db.tables.status.length, 1, 'one status row per person')
})

test('a withdrawal REPEATED under the same request id after a newer opt-in takes effect again — once per opt-in', async () => {
  //  The booking form re-sends a ticked opt-out on every ping of a session with
  //  one request id. A confirmed opt-in in between (a token resubscribe) must
  //  not swallow it.
  const db = createFakeConsentDb()
  const optOut = (at: string) => simple('opted_out_at_capture', at, { surface: 'booking', requestId: 'booking:continue:sess1:abcd' })
  assert.ok((await recordConsentEvent(optOut('2026-09-20T10:00:00Z'), cdb(db))).ok)
  assert.ok((await recordConsentEvent(simple('express_opt_in', '2026-09-20T11:00:00Z', RESUBSCRIBE), cdb(db))).ok)
  const firstOptInId = db.tables.status[0].expressEventId

  //  A delayed ping from BEFORE the opt-in is a plain replay: the opt-in stands.
  const early = await recordConsentEvent(optOut('2026-09-20T10:30:00Z'), cdb(db))
  assert.ok(early.ok && !early.created)
  assert.equal(db.tables.status[0].optedOutAt.toISOString(), '2026-09-20T10:00:00.000Z')

  //  The same box, still ticked, pinged AFTER the opt-in: recorded again, and it wins.
  const again = await recordConsentEvent(optOut('2026-09-20T12:00:00Z'), cdb(db))
  assert.ok(again.ok && again.created, 'the repeat is a new withdrawal event')
  assert.match(again.event.requestId, /^booking:continue:sess1:abcd:after:/)
  assert.equal(again.event.requestId, `booking:continue:sess1:abcd:after:${firstOptInId}`, 'derived from the intervening opt-in event')
  assert.equal(db.tables.status[0].optedOutAt.toISOString(), '2026-09-20T12:00:00.000Z')
  assert.ok(db.tables.status[0].optedOutAt.getTime() >= db.tables.status[0].expressOptInAt.getTime(), 'the opt-out now outranks the opt-in')

  //  Every later ping is idempotent again: no third event.
  const later = await recordConsentEvent(optOut('2026-09-20T13:00:00Z'), cdb(db))
  assert.ok(later.ok && !later.created)
  assert.equal(db.tables.events.filter((e: any) => e.kind === 'opted_out_at_capture').length, 2)

  //  A SECOND opt-in, then the box again: one more event, under that opt-in's id.
  assert.ok((await recordConsentEvent(simple('express_opt_in', '2026-09-21T09:00:00Z', RESUBSCRIBE), cdb(db))).ok)
  const third = await recordConsentEvent(optOut('2026-09-21T10:00:00Z'), cdb(db))
  assert.ok(third.ok && third.created)
  assert.equal(db.tables.events.filter((e: any) => e.kind === 'opted_out_at_capture').length, 3)
  assert.ok(!/:after:.*:after:/.test(third.event.requestId), 'derived ids never chain')
})

test('a NOTICE between two opt-out pings is not an opt-in: the replay stays a replay', async () => {
  //  Only a confirmed express opt-in re-arms a repeated withdrawal. A later form
  //  notice (last_notice_at) never outranks the opt-out it follows.
  const db = createFakeConsentDb()
  const optOut = (at: string) => simple('opted_out_at_capture', at, { surface: 'booking', requestId: 'booking:continue:sess2:abcd' })
  assert.ok((await recordConsentEvent(optOut('2026-09-20T10:00:00Z'), cdb(db))).ok)
  assert.ok((await recordConsentEvent(notice({ occurredAt: T('2026-09-20T11:00:00Z') }), cdb(db))).ok)
  const again = await recordConsentEvent(optOut('2026-09-20T12:00:00Z'), cdb(db))
  assert.ok(again.ok && !again.created)
  assert.equal(db.tables.events.filter((e: any) => e.kind === 'opted_out_at_capture').length, 1)
  assert.equal(db.tables.status[0].expressOptInAt, null)
})

test('evidence-only kinds write no status row: resubscribed, withheld (including a withheld popup notice)', async () => {
  const db = createFakeConsentDb()
  assert.ok((await recordConsentEvent(simple('resubscribed', '2026-09-21T00:00:00Z', { surface: 'resubscribe_page' }), cdb(db))).ok)
  assert.ok((await recordConsentEvent(simple('basis_withheld', '2026-09-21T00:00:00Z', { withheldReason: 'ip_throttle' }), cdb(db))).ok)
  //  The popup with OFFER_SIGNUP_ENABLED off: the claimed copy is kept as evidence, nothing moves.
  assert.ok(
    (
      await recordConsentEvent(
        simple('basis_withheld', '2026-09-21T00:00:00Z', {
          surface: 'popup',
          withheldReason: 'offer_signup_disabled',
          noticeVersion: 'popup-2026-09-16-r2',
          noticeCopySha256: NOTICE_VERSIONS['popup-2026-09-16-r2'].copySha256.es,
          locale: 'es',
        }),
        cdb(db),
      )
    ).ok,
  )
  assert.equal(db.tables.events.length, 3)
  assert.equal(db.tables.status.length, 0)
  assert.equal(await readMarketingStatus(EMAIL, db as never), null)
})

test('idempotent per (requestId, kind): a retry returns the original and changes nothing', async () => {
  const db = createFakeConsentDb()
  const input = notice({ requestId: 'req_fixed' })
  const a = await recordConsentEvent(input, cdb(db))
  const b = await recordConsentEvent({ ...input, occurredAt: T('2026-09-29T00:00:00Z') }, cdb(db))
  assert.ok(a.ok && a.created)
  assert.ok(b.ok && !b.created)
  assert.equal(b.ok && b.event.id, a.ok && a.event.id)
  assert.equal(db.tables.events.length, 1)
  assert.equal(db.tables.status[0].lastNoticeAt.toISOString(), '2026-09-20T12:00:00.000Z', 'the rolled-back retry did not move status')
  //  The same request id may carry a different kind (a withheld grant + an opt-out in one submit).
  assert.ok((await recordConsentEvent(simple('opted_out_at_capture', '2026-09-20T12:00:00Z', { requestId: 'req_fixed' }), cdb(db))).ok)
  //  But never a different address.
  const other = await recordConsentEvent({ ...input, email: 'different@example.com' }, cdb(db))
  assert.deepEqual(other, { ok: false, reason: 'invalid_input', detail: 'requestId already used for a different address' })
})

test('a grant must describe registered copy for its route surface and locale, and cannot carry a ticked opt-out', async () => {
  const db = createFakeConsentDb()
  const refuse = async (over: Partial<ConsentEventInput>) => {
    const r = await recordConsentEvent(notice(over), cdb(db))
    return r.ok ? 'recorded' : r.reason
  }
  assert.equal(await refuse({ noticeVersion: '2026-07-v1' }), 'unregistered_notice')
  assert.equal(await refuse({ noticeVersion: null }), 'unregistered_notice')
  assert.equal(await refuse({ noticeVersion: 'quote-2026-09-16' }), 'unregistered_notice', 'a removed first-release id')
  assert.equal(await refuse({ surface: 'contact' }), 'unregistered_notice')
  assert.equal(await refuse({ surface: 'popup' }), 'unregistered_notice')
  assert.equal(await refuse({ locale: 'es' }), 'unregistered_notice', 'EN hash claimed for an ES page')
  assert.equal(await refuse({ noticeCopySha256: 'f'.repeat(64) }), 'unregistered_notice')
  assert.equal(await refuse({ optOutBox: true }), 'opt_out_box_ticked')
  assert.equal(db.tables.events.length, 0)
  //  A pending/confirm kind no longer exists at all.
  const pending = await recordConsentEvent(notice({ kind: 'express_opt_in_pending' as never, surface: 'popup' }), cdb(db))
  assert.deepEqual(pending, { ok: false, reason: 'invalid_input', detail: 'unknown kind' })
  assert.equal(db.tables.events.length, 0)

  //  Every registered version records a notice on each of its own surfaces —
  //  the popup and a support message included — and never an opt-in.
  for (const [version, entry] of Object.entries(NOTICE_VERSIONS)) {
    for (const surface of entry.surfaces) {
      const r = await recordConsentEvent(
        notice({ surface, noticeVersion: version, noticeCopySha256: entry.copySha256.es, locale: 'es', email: `${surface}.grant@example.com` }),
        cdb(db),
      )
      assert.ok(r.ok && r.created && r.event.kind === 'notice_accepted', `${version} on ${surface}: ${JSON.stringify(r)}`)
    }
  }
  assert.equal(db.tables.events.length, 6)
  assert.ok(db.tables.status.every((s: any) => s.expressOptInAt === null && s.lastNoticeEventId), 'a notice moves last_notice only')
})

test('input validation', async () => {
  const db = createFakeConsentDb()
  const reasonOf = async (input: ConsentEventInput) => {
    const r = await recordConsentEvent(input, cdb(db))
    return r.ok ? 'recorded' : r.reason
  }
  assert.equal(await reasonOf(simple('unsubscribed', '2026-09-21T00:00:00Z', { email: 'nope' })), 'invalid_email')
  assert.equal(await reasonOf(simple('bogus' as never, '2026-09-21T00:00:00Z')), 'invalid_input')
  assert.equal(await reasonOf(simple('express_opt_in_pending' as never, '2026-09-21T00:00:00Z', { surface: 'popup' })), 'invalid_input')
  assert.equal(await reasonOf(simple('unsubscribed', '2026-09-21T00:00:00Z', { surface: 'Quote Form' })), 'invalid_input')
  assert.equal(await reasonOf(simple('unsubscribed', '2026-09-21T00:00:00Z', { requestId: '  ' })), 'invalid_input')
  assert.equal(await reasonOf(simple('basis_withheld', '2026-09-21T00:00:00Z')), 'invalid_input', 'withheld needs a reason')
  assert.equal(await reasonOf(simple('unsubscribed', '2026-09-21T00:00:00Z', { regionSignal: 'mars' as never })), 'invalid_input')
  assert.equal(await reasonOf({ ...simple('unsubscribed', '2026-09-21T00:00:00Z'), occurredAt: new Date('nope') }), 'invalid_input')
  assert.equal(db.tables.events.length, 0)
})

test('a database failure is a result, never a throw, and leaves nothing half-written', async () => {
  const db = createFakeConsentDb({ failModels: new Set(['emailMarketingStatus']) })
  const r = await recordConsentEvent(notice(), cdb(db))
  assert.equal(r.ok, false)
  assert.equal(!r.ok && r.reason, 'db_error')
  assert.equal(db.tables.events.length, 0, 'the event insert rolled back with the status write')
})

test('sanitizePageUrl keeps origin + path only', () => {
  assert.equal(sanitizePageUrl('https://moveitclearit.com/booking-form.html?name=Jane&phone=1#step2'), 'https://moveitclearit.com/booking-form.html')
  assert.equal(sanitizePageUrl('javascript:alert(1)'), null)
  assert.equal(sanitizePageUrl('not a url'), null)
  assert.equal(sanitizePageUrl(undefined), null)
})

test('WITHDRAWALS stop the person\'s active enrollments in the same transaction and report them', async () => {
  for (const kind of ['opted_out_at_capture', 'declined_at_capture', 'unsubscribed'] as const) {
    const db = createFakeConsentDb()
    await enrollSequence({ email: EMAIL, sequenceKind: 'quote_followup', subjectType: 'lead', subjectId: 'lead_1', basisEventId: 'evt_1', now: T('2026-09-20T00:00:00Z') }, edb(db))
    await enrollSequence({ email: EMAIL, sequenceKind: 'abandoned_checkout', subjectType: 'booking', subjectId: 'bk_2', basisEventId: 'evt_2', now: T('2026-09-20T00:00:00Z') }, edb(db))
    await enrollSequence({ email: 'bystander@example.com', sequenceKind: 'quote_followup', subjectType: 'lead', subjectId: 'lead_3', basisEventId: 'evt_3', now: T('2026-09-20T00:00:00Z') }, edb(db))
    const r = await recordConsentEvent(simple(kind, '2026-09-21T00:00:00Z'), cdb(db))
    assert.ok(r.ok, kind)
    assert.deepEqual(r.ok && r.stoppedEnrollments.map((s) => s.subjectId).sort(), ['bk_2', 'lead_1'], kind)
    assert.deepEqual(db.tables.enrollments.map((e) => e.status), ['stopped', 'stopped', 'active'], kind)
    assert.equal(db.tables.enrollments[0].stopReason, kind)
  }
  //  A notice or an express opt-in stops nothing.
  const db = createFakeConsentDb()
  await enrollSequence({ email: EMAIL, sequenceKind: 'abandoned_checkout', subjectType: 'booking', subjectId: 'bk_1', basisEventId: null, now: T('2026-09-20T00:00:00Z') }, edb(db))
  const r = await recordConsentEvent(notice(), cdb(db))
  assert.ok(r.ok && r.stoppedEnrollments.length === 0)
  const x = await recordConsentEvent(simple('express_opt_in', '2026-09-22T00:00:00Z', RESUBSCRIBE), cdb(db))
  assert.ok(x.ok && x.stoppedEnrollments.length === 0)
  assert.equal(db.tables.enrollments[0].status, 'active')
})

// ── enrollment ─────────────────────────────────────────────────────────────

test('windowStartFor: fixed 30-day UTC buckets anchored on 2026-09-16', () => {
  assert.equal(windowStartFor(T('2026-09-16T00:00:00Z')).toISOString(), '2026-09-16T00:00:00.000Z')
  assert.equal(windowStartFor(T('2026-10-15T23:59:59Z')).toISOString(), '2026-09-16T00:00:00.000Z')
  assert.equal(windowStartFor(T('2026-10-16T00:00:00Z')).toISOString(), '2026-10-16T00:00:00.000Z')
  assert.equal(windowStartFor(T('2026-09-15T12:00:00Z')).toISOString(), '2026-08-17T00:00:00.000Z')
  assert.equal(ENROLLMENT_WINDOW_DAYS, 30)
})

test('enrollSequence is idempotent per person: created, then already_enrolled — never two rows', async () => {
  const db = createFakeConsentDb()
  const input = { email: EMAIL, sequenceKind: 'quote_followup' as const, subjectType: 'lead' as const, subjectId: 'lead_1', basisEventId: 'evt_1', now: T('2026-09-20T00:00:00Z') }
  const a = await enrollSequence(input, edb(db))
  const b = await enrollSequence({ ...input, subjectId: 'lead_2', email: 'SOMEONE@example.com' }, edb(db))
  assert.equal(a.outcome, 'created')
  assert.equal(b.outcome, 'already_enrolled')
  assert.equal(b.outcome === 'already_enrolled' && b.enrollment?.subjectId, 'lead_1', 'the existing enrollment is returned')
  assert.equal(db.tables.enrollments.length, 1)

  //  Concurrency in the fake: every call passes the pre-read, and the UNIQUE insert decides.
  const racing = createFakeConsentDb()
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => enrollSequence({ ...input, subjectId: `lead_${i}` }, edb(racing))))
  assert.equal(results.filter((r) => r.outcome === 'created').length, 1)
  assert.equal(results.filter((r) => r.outcome === 'already_enrolled').length, 9)
  assert.equal(racing.tables.enrollments.length, 1)
})

test('enrollSequence: another kind is independent; the same kind is blocked for 30 days across a bucket edge', async () => {
  const db = createFakeConsentDb()
  const base = { email: EMAIL, subjectType: 'lead' as const, subjectId: 'lead_1', basisEventId: 'evt_1' }
  //  Enrolled on the last day of a bucket…
  assert.equal((await enrollSequence({ ...base, sequenceKind: 'quote_followup', now: T('2026-10-15T20:00:00Z') }, edb(db))).outcome, 'created')
  //  …the next day is a new bucket, but still inside 30 days.
  assert.equal((await enrollSequence({ ...base, sequenceKind: 'quote_followup', now: T('2026-10-17T20:00:00Z') }, edb(db))).outcome, 'already_enrolled')
  assert.equal((await enrollSequence({ ...base, sequenceKind: 'abandoned_checkout', now: T('2026-10-17T20:00:00Z') }, edb(db))).outcome, 'created')
  assert.equal(db.tables.enrollments.length, 2)
})

test('enrollSequence refuses bad input and reports a database error without scheduling', async () => {
  const db = createFakeConsentDb()
  const ok = { email: EMAIL, sequenceKind: 'abandoned_checkout' as const, subjectType: 'email' as const, subjectId: EMAIL, basisEventId: null }
  assert.deepEqual(await enrollSequence({ ...ok, email: 'x' }, edb(db)), { outcome: 'refused', reason: 'invalid_email' })
  assert.deepEqual(await enrollSequence({ ...ok, sequenceKind: 'weekly_blast' as never }, edb(db)), { outcome: 'refused', reason: 'invalid_kind' })
  //  The removed scenario kinds (no existing truthful template) are not sequences any more.
  for (const removed of ['offer', 'lead_nurture_contact', 'lead_nurture_quote_request', 'lead_nurture_booking_form']) {
    assert.deepEqual(await enrollSequence({ ...ok, sequenceKind: removed as never }, edb(db)), { outcome: 'refused', reason: 'invalid_kind' }, removed)
  }
  assert.deepEqual(await enrollSequence({ ...ok, subjectId: ' ' }, edb(db)), { outcome: 'refused', reason: 'invalid_subject' })
  assert.deepEqual(await enrollSequence({ ...ok, subjectType: 'campaign' as never }, edb(db)), { outcome: 'refused', reason: 'invalid_subject' })
  const down = createFakeConsentDb({ failModels: new Set(['sequenceEnrollment']) })
  const r = await enrollSequence(ok, edb(down))
  assert.equal(r.outcome, 'error')
})

test('stopEnrollmentsForPerson and activeEnrollment', async () => {
  const db = createFakeConsentDb()
  const now = T('2026-09-20T00:00:00Z')
  await enrollSequence({ email: EMAIL, sequenceKind: 'quote_followup', subjectType: 'lead', subjectId: 'lead_1', basisEventId: 'e', now }, edb(db))
  assert.equal((await activeEnrollment('Someone@Example.com', 'quote_followup', edb(db)))?.subjectId, 'lead_1')
  assert.equal(await activeEnrollment(EMAIL, 'abandoned_checkout', edb(db)), null)
  assert.equal(await activeEnrollment(EMAIL, 'offer' as never, edb(db)), null, 'a removed kind is never active')

  const stopped = await stopEnrollmentsForPerson(EMAIL, 'person_booked', edb(db))
  assert.ok(stopped.ok && stopped.stopped.length === 1)
  assert.equal(await activeEnrollment(EMAIL, 'quote_followup', edb(db)), null)
  const again = await stopEnrollmentsForPerson(EMAIL, 'person_booked', edb(db))
  assert.ok(again.ok && again.stopped.length === 0, 'stopping twice is a no-op')
  assert.equal(db.tables.enrollments[0].stopReason, 'person_booked', 'the first reason is kept')

  const down = createFakeConsentDb({ failModels: new Set(['sequenceEnrollment']) })
  assert.equal((await stopEnrollmentsForPerson(EMAIL, 'x', edb(down))).ok, false)
  await assert.rejects(() => activeEnrollment(EMAIL, 'quote_followup', edb(down)), 'unknown must not read as not enrolled')
})

test('personBookedSince: real bookings after the anchor only; test bookings never; FAILS CLOSED', async () => {
  const db = createFakeConsentDb()
  const bdb = db as unknown as BookingHistoryDb
  const since = T('2026-09-20T00:00:00Z')
  db.tables.customers.push({ id: 'c1', email: EMAIL })
  db.tables.bookings.push({ id: 'b_old', customerId: 'c1', isInternalTest: false, createdAt: T('2026-09-01T00:00:00Z'), status: 'COMPLETED' })
  db.tables.bookings.push({ id: 'b_test', customerId: 'c1', isInternalTest: true, createdAt: T('2026-09-25T00:00:00Z'), status: 'CONFIRMED' })
  assert.equal(await personBookedSince(EMAIL, since, bdb), false, 'a booking before the enrollment and a test booking do not count')
  db.tables.bookings.push({ id: 'b_new', customerId: 'c1', isInternalTest: false, createdAt: T('2026-09-22T00:00:00Z'), status: 'PENDING_PAYMENT' })
  assert.equal(await personBookedSince('SOMEONE@example.com', since, bdb), true, 'an unpaid checkout after the enrollment counts')
  const down = createFakeConsentDb({ failModels: new Set(['booking']) })
  assert.equal(await personBookedSince(EMAIL, since, down as unknown as BookingHistoryDb), true)
  assert.equal(await personBookedSince('nope', since, bdb), false)
  assert.ok(DAY > 0)
})

// ── the migration, as text ─────────────────────────────────────────────────

const ROOT = resolve(__dirname, '../../..')
const MIGRATIONS = resolve(ROOT, 'prisma/migrations')
const NAME = '20260916120000_email_consent_enrollment'
const sql = () => readFileSync(resolve(MIGRATIONS, NAME, 'migration.sql'), 'utf8')
const statements = () =>
  sql()
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')

test('migration: the CHECK constraint lists exactly CONSENT_EVENT_KINDS', () => {
  const m = /CHECK \("kind" IN \(([\s\S]*?)\)\)/.exec(statements())
  assert.ok(m, 'the kind CHECK constraint exists')
  const kinds = (m![1].match(/'([a-z_]+)'/g) ?? []).map((k) => k.slice(1, -1))
  assert.deepEqual([...kinds].sort(), [...CONSENT_EVENT_KINDS].sort())
  assert.doesNotMatch(statements(), /express_opt_in_pending/, 'no pending/confirm kind in the database vocabulary')
})

test('migration: additive, re-runnable, append-only trigger, redaction function, the unique keys', () => {
  const s = statements()
  assert.ok(!/\bDROP\s+(TABLE|COLUMN)\b/i.test(s), 'no DROP TABLE/COLUMN outside the rollback comment')
  assert.ok(!/\b(UPDATE|DELETE FROM)\s+"(crm_leads|bookings|customers|email_sends|email_suppressions)"/i.test(s), 'no data changes to existing tables')
  for (const m of s.matchAll(/CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/g)) assert.fail(`non-idempotent index: ${m[0]}`)
  for (const m of s.matchAll(/CREATE TABLE (?!IF NOT EXISTS)/g)) assert.fail(`non-idempotent table: ${m[0]}`)
  for (const m of s.matchAll(/ADD COLUMN (?!IF NOT EXISTS)/g)) assert.fail(`non-idempotent column: ${m[0]}`)
  assert.match(s, /CREATE UNIQUE INDEX IF NOT EXISTS "email_consent_events_request_id_kind_key" ON "email_consent_events"\("request_id", "kind"\)/)
  assert.match(s, /ON "sequence_enrollments"\("email_normalized", "sequence_kind", "window_start"\)/)
  assert.match(s, /"email_normalized", "occurred_at" DESC/)
  assert.match(s, /ON "email_consent_events"\("ip_hmac", "occurred_at"\)/)
  assert.match(s, /BEFORE UPDATE OR DELETE ON "email_consent_events"/)
  assert.match(s, /CREATE OR REPLACE FUNCTION "redact_email_consent"\(p_email TEXT\)/)
  assert.ok(!/REFERENCES/i.test(s), 'no foreign keys: the append-only trigger would break ON DELETE SET NULL')
  //  The four nullable columns, no defaults.
  assert.match(s, /ALTER TABLE "crm_leads" ADD COLUMN IF NOT EXISTS "basis_event_id" TEXT;/)
  assert.match(s, /ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "basis_event_id" TEXT;/)
  assert.match(s, /ALTER TABLE "email_sends" ADD COLUMN IF NOT EXISTS "basis_event_id" TEXT;/)
  assert.match(s, /ALTER TABLE "email_sends" ADD COLUMN IF NOT EXISTS "marketing_basis" TEXT;/)
  assert.match(sql(), /ROLLBACK/, 'rollback SQL is documented in the header')
})

test('migration: sorts after every other migration and is EXECUTED in CI (not represented by the baseline)', () => {
  assert.ok(existsSync(resolve(MIGRATIONS, NAME, 'migration.sql')))
  const dirs = readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
  const represented = readFileSync(resolve(ROOT, 'prisma/baseline/REPRESENTED_MIGRATIONS.txt'), 'utf8')
    .split('\n')
    .map((l) => l.replace(/\r$/, '').replace(/#.*$/, '').trim())
    .filter(Boolean)
  assert.ok(!represented.includes(NAME), 'a represented migration is recorded as applied WITHOUT running')
  const lastRepresented = [...represented].sort().pop() as string
  assert.ok(NAME > lastRepresented, 'unlisted migrations must sort after the last represented one')
  const earlier = dirs.filter((d) => d !== NAME)
  assert.ok(earlier.every((d) => d < NAME), `must sort after ${earlier[earlier.length - 1]}`)
})
