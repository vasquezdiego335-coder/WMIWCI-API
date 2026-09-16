// ════════════════════════════════════════════════════════════════════════
//  consent-db.test.ts — the consent guarantees that only a REAL database can
//  prove (email consent release 2026-09-16).
//
//   • two concurrent enrollSequence() calls for one person create EXACTLY ONE
//     sequence_enrollments row (the UNIQUE constraint, not a read-then-write);
//   • email_consent_events is append-only: UPDATE and DELETE are refused by the
//     trigger, through Prisma and through raw SQL, and redact_email_consent()
//     is the one sanctioned exception;
//   • the kind CHECK constraint and UNIQUE (request_id, kind) hold;
//   • concurrent events for one person produce one status row whose timestamps
//     are the maximum, never a later-committed older value;
//   • deleting a lead is not blocked (no foreign keys).
//
//  A mocked store cannot exhibit a race or a trigger, which is why this runs
//  against the disposable PostgreSQL CI builds from source control
//  (scripts/bootstrap-fresh-database.sh EXECUTES the migration). Skips without
//  DATABASE_URL; a production-looking URL is a hard failure.
//
//  Synthetic @example.com data only. Events cannot be deleted by design, so
//  every run uses unique addresses and request ids.
// ════════════════════════════════════════════════════════════════════════
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { assertTestRecipient, dbSkip } from './_disposable-test-env'
import { recordConsentEvent, readMarketingStatus } from '../consent/consent-events'
import { enrollSequence } from '../consent/sequence-enrollment'
import { NOTICE_VERSIONS } from '../consent/notice-registry'

const skip = dbSkip()

let prisma: PrismaClient
before(async () => {
  if (skip) return
  prisma = new PrismaClient()
  await prisma.$connect()
})
after(async () => {
  if (skip) return
  await prisma.$disconnect()
})

const run = randomUUID().slice(0, 8)
const address = (label: string) => {
  const email = `consent-db-${label}-${run}@example.com`
  assertTestRecipient(email)
  return email
}

test('two concurrent enrollSequence calls create exactly ONE row, every round', { skip }, async () => {
  for (let round = 1; round <= 5; round++) {
    const email = address(`enroll-${round}`)
    const now = new Date()
    const results = await Promise.all(
      Array.from({ length: 2 }, (_, i) =>
        enrollSequence({ email, sequenceKind: 'quote_followup', subjectType: 'lead', subjectId: `lead-${round}-${i}`, basisEventId: null, now }, prisma),
      ),
    )
    const rows = await prisma.sequenceEnrollment.findMany({ where: { emailNormalized: email, sequenceKind: 'quote_followup' } })
    assert.equal(rows.length, 1, `round ${round}: expected ONE enrollment row, found ${rows.length}`)
    assert.equal(results.filter((r) => r.outcome === 'created').length, 1, `round ${round}: exactly one caller creates`)
    assert.equal(results.filter((r) => r.outcome === 'already_enrolled').length, 1, `round ${round}: the other is told already_enrolled`)
    await prisma.sequenceEnrollment.deleteMany({ where: { emailNormalized: email } })
  }
})

test('a burst of 20 concurrent enrollments for one person still yields ONE row', { skip }, async () => {
  const email = address('burst')
  const now = new Date()
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      enrollSequence({ email, sequenceKind: 'abandoned_checkout', subjectType: 'booking', subjectId: `booking-${i}`, basisEventId: null, now }, prisma),
    ),
  )
  assert.equal(await prisma.sequenceEnrollment.count({ where: { emailNormalized: email } }), 1)
  assert.equal(results.filter((r) => r.outcome === 'created').length, 1)
  assert.equal(results.filter((r) => r.outcome === 'error').length, 0, 'a lost race is already_enrolled, never an error')
  await prisma.sequenceEnrollment.deleteMany({ where: { emailNormalized: email } })
})

async function seedEvent(email: string) {
  const r = await recordConsentEvent(
    {
      email,
      kind: 'notice_accepted',
      surface: 'quote',
      requestId: `req-${randomUUID()}`,
      noticeVersion: 'quote-2026-09-16-r2',
      noticeCopySha256: NOTICE_VERSIONS['quote-2026-09-16-r2'].copySha256.en,
      locale: 'en',
      trigger: 'submit',
      optOutBox: false,
      ipHmac: 'a'.repeat(64),
      uaHash: 'b'.repeat(32),
      pageUrl: 'https://www.moveitclearit.com/quote.html',
    },
    prisma,
  )
  assert.ok(r.ok && r.created, JSON.stringify(r))
  return r.event
}

test('the append-only trigger refuses UPDATE and DELETE — through Prisma and raw SQL', { skip }, async () => {
  const email = address('append-only')
  const ev = await seedEvent(email)

  await assert.rejects(() => prisma.emailConsentEvent.update({ where: { id: ev.id }, data: { surface: 'contact' } }), /append-only/)
  await assert.rejects(() => prisma.emailConsentEvent.delete({ where: { id: ev.id } }), /append-only/)
  await assert.rejects(() => prisma.emailConsentEvent.deleteMany({ where: { emailNormalized: email } }), /append-only/)
  await assert.rejects(() => prisma.$executeRawUnsafe(`UPDATE "email_consent_events" SET "kind" = 'express_opt_in' WHERE "id" = $1`, ev.id), /append-only/)
  await assert.rejects(() => prisma.$executeRawUnsafe(`DELETE FROM "email_consent_events" WHERE "id" = $1`, ev.id), /append-only/)
  //  Even with the redaction flag set by hand, only a redaction-shaped change passes.
  await assert.rejects(
    () =>
      prisma.$transaction([
        prisma.$executeRawUnsafe(`SELECT set_config('email_consent.redacting', 'on', true)`),
        prisma.$executeRawUnsafe(`UPDATE "email_consent_events" SET "kind" = 'express_opt_in' WHERE "id" = $1`, ev.id),
      ]),
    /append-only/,
  )

  const still = await prisma.emailConsentEvent.findUnique({ where: { id: ev.id } })
  assert.equal(still?.kind, 'notice_accepted')
  assert.equal(still?.surface, 'quote')
})

test('redact_email_consent() is the one sanctioned change: personal data out, evidence kept', { skip }, async () => {
  const email = address('erasure')
  const ev = await seedEvent(email)
  assert.ok(await readMarketingStatus(email, prisma))

  const [{ redacted }] = await prisma.$queryRawUnsafe<Array<{ redacted: number }>>(`SELECT "redact_email_consent"($1) AS redacted`, email.toUpperCase())
  assert.equal(Number(redacted), 1)

  const row = await prisma.emailConsentEvent.findUnique({ where: { id: ev.id } })
  assert.ok(row)
  assert.match(row!.emailNormalized, /^redacted:sha256:[0-9a-f]{64}$/)
  assert.equal(row!.ipHmac, null)
  assert.equal(row!.uaHash, null)
  assert.equal(row!.pageUrl, null)
  assert.equal(row!.kind, 'notice_accepted')
  assert.equal(row!.noticeVersion, 'quote-2026-09-16-r2')
  assert.equal(row!.occurredAt.getTime(), ev.occurredAt.getTime())
  assert.equal(await readMarketingStatus(email, prisma), null, 'the status row is re-keyed to the hash')
  assert.equal(await prisma.emailMarketingStatus.count({ where: { emailNormalized: row!.emailNormalized } }), 1)
  //  And the trigger is armed again afterwards.
  await assert.rejects(() => prisma.emailConsentEvent.delete({ where: { id: ev.id } }), /append-only/)
})

test('the kind CHECK constraint and UNIQUE (request_id, kind) hold in the database', { skip }, async () => {
  const email = address('constraints')
  await assert.rejects(
    () =>
      prisma.emailConsentEvent.create({
        data: { emailNormalized: email, kind: 'marketing_blast', surface: 'quote', requestId: `req-${randomUUID()}` },
      }),
    /email_consent_events_kind_check|check constraint/i,
  )
  //  The removed pending/confirm kind is not in the database vocabulary either.
  await assert.rejects(
    () =>
      prisma.emailConsentEvent.create({
        data: { emailNormalized: email, kind: 'express_opt_in_pending', surface: 'popup', requestId: `req-${randomUUID()}` },
      }),
    /email_consent_events_kind_check|check constraint/i,
  )

  const requestId = `req-${randomUUID()}`
  const input = { email, kind: 'opted_out_at_capture' as const, surface: 'contact', requestId }
  const a = await recordConsentEvent(input, prisma)
  const b = await recordConsentEvent(input, prisma)
  assert.ok(a.ok && a.created)
  assert.ok(b.ok && !b.created)
  assert.equal(await prisma.emailConsentEvent.count({ where: { requestId } }), 1)
})

test('concurrent events for one person: one status row, and the LATEST timestamp wins', { skip }, async () => {
  const email = address('forward-only')
  const base = Date.now() - 60 * 60 * 1000
  const times = Array.from({ length: 6 }, (_, i) => new Date(base + i * 1000))
  //  Shuffle so commit order does not match time order.
  const shuffled = [...times].sort(() => Math.random() - 0.5)
  const results = await Promise.all(
    shuffled.map((occurredAt) =>
      recordConsentEvent({ email, kind: 'opted_out_at_capture', surface: 'quote', requestId: `req-${randomUUID()}`, occurredAt }, prisma),
    ),
  )
  assert.equal(results.filter((r) => !r.ok).length, 0, JSON.stringify(results.filter((r) => !r.ok)))
  assert.equal(await prisma.emailMarketingStatus.count({ where: { emailNormalized: email } }), 1)
  const status = await readMarketingStatus(email, prisma)
  assert.equal(status?.optedOutAt?.getTime(), times[times.length - 1].getTime())
})

test('deleting a lead that carries a basisEventId is not blocked (no foreign keys)', { skip }, async () => {
  const email = address('lead-delete')
  const ev = await seedEvent(email)
  const lead = await prisma.lead.create({ data: { name: 'Consent Test', email, basisEventId: ev.id } })
  await prisma.lead.delete({ where: { id: lead.id } })
  assert.ok(await prisma.emailConsentEvent.findUnique({ where: { id: ev.id } }), 'the evidence survives the lead')
})
