// ════════════════════════════════════════════════════════════════════════
//  lead-concurrency.test.ts — one browser session, one CRM lead.
//
//  THE DEFECT THIS PINS.
//
//  `capturePartialLead` does a lookup, then a create, and its own comment says
//  the create failing is what protects it:
//
//      "If the create fails for ANY reason, re-run the lookup: the sibling
//       request has almost certainly committed its row by now"
//
//  That assumption was FALSE. `booking_session_id` carried only
//  `@@index([bookingSessionId])` — an ordinary, non-unique index — so there was
//  no database invariant for the insert to violate. Two concurrent requests
//  both missed the lookup, both inserted, and both returned `isNew: true`.
//  The booking form fires capture from FIVE triggers (debounce, blur, nav,
//  consent toggle, exit beacon), several of which land within milliseconds, so
//  this is an everyday occurrence rather than a theoretical race.
//
//  A duplicate lead is not cosmetic: it splits one customer's consent,
//  attribution and enrichment across two rows, and it produces two owner
//  notifications for one person.
//
//  This runs against a REAL PostgreSQL through the REAL Prisma store. A mocked
//  store cannot exhibit a race, which is exactly why the bug survived.
//
//  Synthetic data only.
// ════════════════════════════════════════════════════════════════════════
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { PrismaClient } from '@prisma/client'
import { capturePartialLead, defaultPartialLeadDeps } from '../leads'
import { dedupeKeyFor } from '../lead-notification-outbox'

const skip = process.env.DATABASE_URL ? false : 'set DATABASE_URL to a disposable PostgreSQL'

let prisma: PrismaClient
const EMAIL = 'concurrency.test@example.com'

before(async () => {
  if (skip) return
  prisma = new PrismaClient()
  await prisma.$connect()
})
after(async () => {
  if (skip) return
  await prisma.$disconnect()
})
beforeEach(async () => {
  if (skip) return
  //  SCOPED to this suite's own leads — see the note in the outbox suite:
  //  parallel test files sharing one database must not truncate each other.
  const mine = await prisma.lead.findMany({ where: { email: EMAIL }, select: { id: true } })
  if (mine.length) await prisma.leadNotification.deleteMany({ where: { leadId: { in: mine.map((m) => m.id) } } })
  await prisma.lead.deleteMany({ where: { email: EMAIL } })
})

/** One capture, through the REAL production store — no injected fake. */
const capture = (sessionId: string) =>
  capturePartialLead(
    {
      email: EMAIL,
      firstName: 'Test',
      lastName: 'Customer',
      bookingSessionId: sessionId,
      formStep: 'card1',
      marketingConsent: false,
      marketingConsentPrompted: true,
      consentSource: 'BOOKING_FORM',
    },
    defaultPartialLeadDeps(),
  )

/** The invariant, checked the same way every round. */
async function assertSingleLead(sessionId: string, results: Awaited<ReturnType<typeof capture>>[]) {
  const rows = await prisma.lead.findMany({ where: { bookingSessionId: sessionId } })
  assert.equal(rows.length, 1, `expected ONE crm_leads row for the session, found ${rows.length}`)

  const settled = results.filter(Boolean)
  assert.ok(settled.length > 0, 'at least one capture must succeed')

  const ids = new Set(settled.map((r) => r!.lead.id))
  assert.equal(ids.size, 1, `every response must refer to the SAME lead, saw ${ids.size} distinct ids`)
  assert.equal(Array.from(ids)[0], rows[0].id)

  const newCount = settled.filter((r) => r!.isNew).length
  assert.equal(newCount, 1, `exactly ONE request may report the lead as new, got ${newCount}`)
  return rows[0].id
}

test('20 concurrent captures on one session produce exactly ONE lead', { skip }, async () => {
  //  Repeated, because a race that fails one time in ten is still a race.
  for (let round = 1; round <= 5; round++) {
    const sessionId = `concurrency-round-${round}-${Date.now()}`
    await prisma.lead.deleteMany({ where: { email: EMAIL } })

    const results = await Promise.all(Array.from({ length: 20 }, () => capture(sessionId)))
    const leadId = await assertSingleLead(sessionId, results)

    //  And exactly one owner notification for that one lead state.
    const events = await prisma.leadNotification.findMany({
      where: { dedupeKey: dedupeKeyFor(leadId, 'lead_created') },
    })
    assert.ok(events.length <= 1, `expected at most ONE lead_created event, found ${events.length}`)
  }
})

test('a burst mixed with the form\'s other triggers still yields ONE lead', { skip }, async () => {
  //  Mirrors the real page: several near-simultaneous sends carrying slightly
  //  different form state, which is what the five triggers actually produce.
  const sessionId = `mixed-${Date.now()}`
  const variants: Array<Promise<unknown>> = []
  for (let i = 0; i < 20; i++) {
    variants.push(
      capturePartialLead(
        {
          email: EMAIL,
          bookingSessionId: sessionId,
          formStep: i % 2 ? 'card1' : 'card2',
          phone: i % 3 ? '8625550100' : undefined,
          marketingConsent: i % 4 === 0 ? true : false,
          marketingConsentPrompted: true,
          consentSource: 'BOOKING_FORM',
        },
        defaultPartialLeadDeps(),
      ),
    )
  }
  await Promise.all(variants)
  const rows = await prisma.lead.findMany({ where: { bookingSessionId: sessionId } })
  assert.equal(rows.length, 1, `expected ONE row, found ${rows.length}`)
})

test('a session id is required for the invariant — a null one is never collapsed', { skip }, async () => {
  //  Two DIFFERENT people can both arrive with no session id at all. The
  //  uniqueness rule must be PARTIAL, or they would collide with each other.
  const a = await capturePartialLead(
    { email: 'null-session-a@example.com', formStep: 'card1' },
    defaultPartialLeadDeps(),
  )
  const b = await capturePartialLead(
    { email: 'null-session-b@example.com', formStep: 'card1' },
    defaultPartialLeadDeps(),
  )
  assert.ok(a && b, 'both captures must succeed')
  assert.notEqual(a!.lead.id, b!.lead.id, 'two different people must not be merged by a shared NULL')
  await prisma.lead.deleteMany({ where: { email: { in: ['null-session-a@example.com', 'null-session-b@example.com'] } } })
})

test('the database, not the application, enforces the invariant', { skip }, async () => {
  //  Proves the constraint EXISTS. An application-only guard is what failed:
  //  the previous code caught an insert error that could never happen.
  const rows = await prisma.$queryRawUnsafe<Array<{ indexdef: string }>>(
    `SELECT indexdef FROM pg_indexes
     WHERE tablename = 'crm_leads' AND indexdef ILIKE '%booking_session_id%'`,
  )
  const defs = rows.map((r) => r.indexdef).join('\n')
  assert.match(defs, /UNIQUE/i, 'crm_leads must carry a UNIQUE invariant on the booking session')
  assert.match(defs, /WHERE/i, 'and it must be PARTIAL, so NULL sessions and closed leads are exempt')
})
