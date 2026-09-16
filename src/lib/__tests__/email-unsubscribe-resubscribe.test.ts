// ════════════════════════════════════════════════════════════════════════
//  email-unsubscribe-resubscribe.test.ts — withdrawals stay withdrawn
//  (email consent release 2026-09-16, DESIGN-v2 §8).
//
//  What this pins:
//    • an unsubscribe writes the suppression row AND an 'unsubscribed' consent
//      event, and stops the person's active scenario enrollments;
//    • the ~13-month unsubscribe token can no longer resubscribe anyone;
//    • resubscribe needs a 'resubscribe' purpose token (~1 hour), minted only
//      on the page returned after a NEW unsubscribe, accepted only by POST,
//      single use; it writes resubscribed + express_opt_in and lifts only a
//      promotional UNSUBSCRIBED row;
//    • suppress() escalation never overwrites the original reason;
//    • an operator can never lift an unsubscribe;
//    • an SMS "START" never re-enables email marketing.
//
//  Offline: an in-memory fake Prisma on globalThis (installed before any
//  module that reads db.ts is imported), no network, no Redis, no provider.
//  Every address is @example.com; nothing is sent.
// ════════════════════════════════════════════════════════════════════════
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { assertNoProductionCredentials, assertTestRecipient } from './_disposable-test-env'
import { createFakeConsentDb } from './_consent-fake-db'

assertNoProductionCredentials()

process.env.EMAIL_TOKEN_SECRET = 'test-secret-for-unsubscribe-resubscribe-0123456789'
process.env.APP_URL = 'https://app.example.com'

type Row = Record<string, any>

const EMAIL = 'leaver@example.com'
assertTestRecipient(EMAIL)

// ── The fake database ───────────────────────────────────────────────────
const state = {
  suppressions: [] as Row[],
  customerUpdates: [] as Row[],
  queryRawCalls: 0,
  enrollmentStops: 0,
}

let fake: Row

function buildFake(): Row {
  const db = createFakeConsentDb()
  const t = db.tables
  Object.assign(db, {
    emailSuppression: {
      async findUnique({ where, select }: Row) {
        const row = state.suppressions.find((s) => s.email === where.email)
        if (!row) return null
        if (!select) return { ...row }
        const out: Row = {}
        for (const k of Object.keys(select)) out[k] = row[k] ?? null
        return out
      },
      async create({ data }: Row) {
        if (state.suppressions.some((s) => s.email === data.email)) throw Object.assign(new Error('dup'), { code: 'P2002' })
        const row = { id: `sup_${state.suppressions.length + 1}`, createdAt: new Date(), ...data }
        state.suppressions.push(row)
        return { ...row }
      },
      async upsert({ where, create, update }: Row) {
        const existing = state.suppressions.find((s) => s.email === where.email)
        if (existing) {
          for (const [k, v] of Object.entries(update)) if (v !== undefined) existing[k] = v
          return { ...existing }
        }
        const row = { id: `sup_${state.suppressions.length + 1}`, createdAt: new Date(), ...create }
        state.suppressions.push(row)
        return { ...row }
      },
      async deleteMany({ where }: Row) {
        const before = state.suppressions.length
        state.suppressions = state.suppressions.filter(
          (s) => !(s.email === where.email && (where.scope === undefined || s.scope === where.scope) && (where.reason === undefined || s.reason === where.reason))
        )
        return { count: before - state.suppressions.length }
      },
      async updateMany({ where, data }: Row) {
        let count = 0
        for (const s of state.suppressions) {
          if (s.email !== where.email) continue
          if (where.reason?.in && !where.reason.in.includes(s.reason)) continue
          for (const [k, v] of Object.entries(data)) if (v !== undefined) s[k] = v
          count++
        }
        return { count }
      },
    },
    customer: {
      ...db.customer,
      async updateMany({ where, data }: Row) {
        state.customerUpdates.push({ where, data })
        let count = 0
        for (const c of t.customers) {
          if (c.email === where.email || (where.id?.in ?? []).includes(c.id)) {
            Object.assign(c, data)
            count++
          }
        }
        return { count }
      },
    },
    emailAutomationEnrollment: {
      async updateMany() {
        state.enrollmentStops++
        return { count: 0 }
      },
    },
    async $queryRaw() {
      state.queryRawCalls++
      return t.customers.map((c: Row) => ({ id: c.id }))
    },
  })
  db.emailConsentEvent.findFirst = async ({ where }: Row) => {
    const row = t.events.find((e: Row) => e.emailNormalized === where.emailNormalized && e.kind === where.kind)
    return row ? { id: row.id } : null
  }
  return db
}

fake = buildFake()
;(globalThis as unknown as { prisma: unknown }).prisma = new Proxy(
  {},
  { get: (_t, key) => (fake as Row)[key as string] }
)

beforeEach(() => {
  state.suppressions = []
  state.customerUpdates = []
  state.queryRawCalls = 0
  state.enrollmentStops = 0
  fake = buildFake()
})

const settle = () => new Promise<void>((r) => setTimeout(r, 20))

const tokens = () => import('../email-tokens')
const suppression = () => import('../email-suppression')

async function route() {
  const { NextRequest } = await import('next/server')
  const mod = await import('../../../app/api/email/unsubscribe/route')
  return { NextRequest, ...mod }
}

async function postUnsubscribe(token: string, html = true) {
  const { NextRequest, POST } = await route()
  const req = new NextRequest(`http://localhost/api/email/unsubscribe?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: html ? { accept: 'text/html' } : { 'content-type': 'application/x-www-form-urlencoded' },
    body: html ? undefined : 'List-Unsubscribe=One-Click',
  })
  const res = await POST(req)
  return { status: res.status, body: await res.text() }
}

async function postAction(path: string) {
  const { NextRequest, POST } = await route()
  const res = await POST(new NextRequest(`http://localhost${path}`, { method: 'POST', headers: { accept: 'text/html' } }))
  return { status: res.status, body: await res.text() }
}

/** The "keep me subscribed" form action rendered on a page, HTML-decoded. */
function resubscribeActionFrom(html: string): string | null {
  const m = /<form method="POST" action="([^"]*action=resubscribe[^"]*)"/.exec(html)
  return m ? m[1].replace(/&amp;/g, '&') : null
}

const tokenOf = (path: string) => decodeURIComponent(new URL(`http://localhost${path}`).searchParams.get('token') as string)

// ════════════════════════════════════════════════════════════════════════
//  1. Purpose tokens
// ════════════════════════════════════════════════════════════════════════

test('a resubscribe token lives about an hour and no caller can widen that', async () => {
  const { signToken, verifyPurposeToken, verifyToken, RESUBSCRIBE_TOKEN_MAX_AGE_MS, PURPOSE_MAX_AGE_MS } = await tokens()
  const now = Date.now()
  assert.equal(RESUBSCRIBE_TOKEN_MAX_AGE_MS, 60 * 60 * 1000)
  assert.equal(PURPOSE_MAX_AGE_MS.resubscribe, RESUBSCRIBE_TOKEN_MAX_AGE_MS)
  assert.ok(verifyPurposeToken(signToken(EMAIL, 'resubscribe', now - 59 * 60_000), 'resubscribe', now))
  assert.equal(verifyPurposeToken(signToken(EMAIL, 'resubscribe', now - 61 * 60_000), 'resubscribe', now), null)
  // verifyToken still accepts maxAge 0 ("no expiry") — which is exactly why a
  // grant must use verifyPurposeToken.
  assert.ok(verifyToken(signToken(EMAIL, 'resubscribe', now - 61 * 60_000), 'resubscribe', 0, now))
})

test('an unsubscribe token never verifies as a resubscribe token (and vice versa)', async () => {
  const { signToken, verifyPurposeToken, verifyToken } = await tokens()
  const unsub = signToken(EMAIL, 'unsubscribe')
  assert.equal(verifyPurposeToken(unsub, 'resubscribe'), null)
  assert.equal(verifyToken(signToken(EMAIL, 'resubscribe'), 'unsubscribe'), null)
})

test('resubscribe is the ONLY granting purpose; an unknown purpose has no lifetime and never verifies', async () => {
  const { signToken, verifyPurposeToken, GRANTING_PURPOSES, PURPOSE_MAX_AGE_MS } = await tokens()
  assert.deepEqual([...GRANTING_PURPOSES], ['resubscribe'])
  assert.deepEqual(Object.keys(PURPOSE_MAX_AGE_MS).sort(), ['preferences', 'resubscribe', 'unsubscribe'])
  //  The popup's short-lived 'confirm' purpose was removed with its confirmation
  //  step (owner direction 2026-09-16): nothing may verify under it.
  const unknown = 'confirm' as never
  assert.equal(verifyPurposeToken(signToken(EMAIL, unknown), unknown), null)
})

test('purposeTokenUseId is stable per minted token and null for an invalid one', async () => {
  const { signToken, purposeTokenUseId } = await tokens()
  const a = signToken(EMAIL, 'resubscribe', Date.now() - 1000)
  const b = signToken(EMAIL, 'resubscribe', Date.now() - 2000)
  assert.match(purposeTokenUseId(a, 'resubscribe') as string, /^resubscribe:[0-9a-f]{64}$/)
  assert.equal(purposeTokenUseId(a, 'resubscribe'), purposeTokenUseId(a, 'resubscribe'))
  assert.notEqual(purposeTokenUseId(a, 'resubscribe'), purposeTokenUseId(b, 'resubscribe'))
  assert.equal(purposeTokenUseId(signToken(EMAIL, 'unsubscribe'), 'resubscribe'), null)
  assert.equal(purposeTokenUseId('garbage', 'resubscribe'), null)
})

test('purposeTokenUseId: every lenient ENCODING of one token is the same use — a token is spent once, however it is spelled', async () => {
  const { signToken, verifyPurposeToken, purposeTokenUseId } = await tokens()
  for (const purpose of ['resubscribe'] as const) {
    const token = signToken(EMAIL, purpose, Date.now() - 1000)
    const [payload, mac] = token.split('.')
    const variants = [`${payload}=.${mac}`, `${payload}==.${mac}`, `${payload}!.${mac}`]
    const id = purposeTokenUseId(token, purpose)
    for (const v of variants) {
      if (!verifyPurposeToken(v, purpose)) continue // a stricter decoder may refuse it outright, which is fine too
      assert.equal(purposeTokenUseId(v, purpose), id, `${purpose}: ${JSON.stringify(v.slice(payload.length, payload.length + 3))} must not be a fresh use`)
    }
  }
})

test('a re-spelled resubscribe token cannot be spent a second time', async () => {
  const { signToken } = await tokens()
  subscribedBefore()
  const { body } = await postUnsubscribe(signToken(EMAIL, 'unsubscribe'))
  const action = resubscribeActionFrom(body) as string
  assert.equal((await postAction(action)).status, 200)
  //  Unsubscribe again, then replay the SAME token with padding appended.
  await postUnsubscribe(signToken(EMAIL, 'unsubscribe'))
  const token = tokenOf(action)
  const [payload, mac] = token.split('.')
  const respelled = `/api/email/unsubscribe?action=resubscribe&token=${encodeURIComponent(`${payload}==.${mac}`)}`
  const replay = await postAction(respelled)
  assert.equal(replay.status, 400, 'the padded spelling is the same, already-spent token')
  assert.equal(state.suppressions.length, 1, 'nothing lifted')
  await settle()
})

test('link builders: the resubscribe action is a relative POST path that never shows the address', async () => {
  const { resubscribeActionPath, verifyPurposeToken } = await tokens()
  const path = resubscribeActionPath(EMAIL) as string
  assert.ok(path.startsWith('/api/email/unsubscribe?action=resubscribe&token='))
  assert.ok(verifyPurposeToken(tokenOf(path), 'resubscribe'))
  assert.ok(!path.includes(EMAIL) && !path.includes(encodeURIComponent(EMAIL)))
})

// ════════════════════════════════════════════════════════════════════════
//  2. Suppression writes
// ════════════════════════════════════════════════════════════════════════

test('escalating an UNSUBSCRIBED row to scope all keeps the ORIGINAL reason', async () => {
  const { suppress } = await suppression()
  assert.equal((await suppress({ email: EMAIL, reason: 'UNSUBSCRIBED', source: 'unsubscribe-link' })).status, 'created')
  const r = await suppress({ email: EMAIL, reason: 'ADMIN_BLOCK', source: 'leadtracking' })
  assert.equal(r.status, 'escalated')
  assert.equal(state.suppressions.length, 1)
  assert.equal(state.suppressions[0].reason, 'UNSUBSCRIBED', 'the reason must never be relabelled')
  assert.equal(state.suppressions[0].scope, 'all')
  assert.equal(state.suppressions[0].source, 'unsubscribe-link', 'the original source is kept too')
  assert.match(String(state.suppressions[0].detail), /escalated to all by ADMIN_BLOCK/)
  await settle()
})

test('a hard bounce or complaint landing on an operator-liftable row RELABELS it, so the admin can no longer lift it', async () => {
  const { suppress } = await suppression()
  const { canRestoreSuppression } = await import('../email-admin')
  for (const [start, incoming] of [
    ['ADMIN_BLOCK', 'HARD_BOUNCE'],
    ['ADMIN_BLOCK', 'SPAM_COMPLAINT'],
    ['INVALID_ADDRESS', 'SPAM_COMPLAINT'],
    ['INVALID_ADDRESS', 'PROVIDER_REJECTED'],
  ] as const) {
    state.suppressions = [{ email: EMAIL, reason: start, scope: 'all', source: 'admin' }]
    assert.equal(canRestoreSuppression(start).allow, true, `${start} starts liftable`)
    const r = await suppress({ email: EMAIL, reason: incoming, source: 'resend-webhook' })
    assert.equal(r.status, 'already_suppressed', 'the scope was already all')
    assert.equal(state.suppressions.length, 1)
    assert.equal(state.suppressions[0].reason, incoming, `${incoming} on ${start} must carry the stronger label`)
    assert.equal(canRestoreSuppression(state.suppressions[0].reason).allow, false, `the admin can no longer lift a ${incoming}`)
    assert.match(String(state.suppressions[0].detail), new RegExp(`relabelled from ${start} to ${incoming}`))
  }
  await settle()
})

test('a WEAKER reason never relabels a stronger row, and UNSUBSCRIBED is never relabelled at all', async () => {
  const { suppress } = await suppression()
  for (const [start, incoming] of [
    ['SPAM_COMPLAINT', 'ADMIN_BLOCK'],
    ['HARD_BOUNCE', 'INVALID_ADDRESS'],
    ['PROVIDER_REJECTED', 'ADMIN_BLOCK'],
    ['UNSUBSCRIBED', 'HARD_BOUNCE'],
    ['UNSUBSCRIBED', 'SPAM_COMPLAINT'],
  ] as const) {
    state.suppressions = [{ email: EMAIL, reason: start, scope: start === 'UNSUBSCRIBED' ? 'promotional' : 'all' }]
    await suppress({ email: EMAIL, reason: incoming, source: 'test' })
    assert.equal(state.suppressions[0].reason, start, `${incoming} must not relabel ${start}`)
    assert.equal(state.suppressions[0].scope, 'all', 'the scope still widens')
  }
  await settle()
})

test('suppressionLabelAfter / labelsReplacedBy: the label only ever gets harder to lift', async () => {
  const { suppressionLabelAfter, labelsReplacedBy } = await suppression()
  assert.equal(suppressionLabelAfter('ADMIN_BLOCK', 'HARD_BOUNCE'), 'HARD_BOUNCE')
  assert.equal(suppressionLabelAfter('HARD_BOUNCE', 'SPAM_COMPLAINT'), 'SPAM_COMPLAINT')
  assert.equal(suppressionLabelAfter('SPAM_COMPLAINT', 'HARD_BOUNCE'), 'SPAM_COMPLAINT')
  assert.equal(suppressionLabelAfter('UNSUBSCRIBED', 'SPAM_COMPLAINT'), 'UNSUBSCRIBED')
  assert.equal(suppressionLabelAfter('ADMIN_BLOCK', 'UNSUBSCRIBED'), 'UNSUBSCRIBED')
  assert.deepEqual(labelsReplacedBy('SPAM_COMPLAINT').sort(), ['ADMIN_BLOCK', 'HARD_BOUNCE', 'INVALID_ADDRESS', 'PROVIDER_REJECTED'])
  assert.deepEqual(labelsReplacedBy('INVALID_ADDRESS'), [], 'the weakest label replaces nothing')
  for (const r of ['UNSUBSCRIBED', 'HARD_BOUNCE', 'SPAM_COMPLAINT', 'ADMIN_BLOCK', 'INVALID_ADDRESS', 'PROVIDER_REJECTED'] as const) {
    assert.equal(labelsReplacedBy(r).includes('UNSUBSCRIBED'), false, `${r} must never replace UNSUBSCRIBED`)
  }
})

test('resubscribe() lifts ONLY a promotional UNSUBSCRIBED row', async () => {
  const { resubscribe } = await suppression()
  // A legacy promotional row with another reason (written before the scope
  // rule, or by hand) is not the person's own unsubscribe: it stays.
  state.suppressions.push({ email: EMAIL, reason: 'ADMIN_BLOCK', scope: 'promotional' })
  assert.equal((await resubscribe(EMAIL)).status, 'hard_suppression_refused')
  assert.equal(state.suppressions.length, 1)

  state.suppressions = [{ email: EMAIL, reason: 'UNSUBSCRIBED', scope: 'all' }]
  assert.equal((await resubscribe(EMAIL)).status, 'hard_suppression_refused', 'an escalated unsubscribe is a hard block now')
  assert.equal(state.suppressions.length, 1)

  state.suppressions = [{ email: EMAIL, reason: 'UNSUBSCRIBED', scope: 'promotional' }]
  assert.deepEqual(await resubscribe(EMAIL), { status: 'removed', mirrored: true })
  assert.equal(state.suppressions.length, 0)
})

// ════════════════════════════════════════════════════════════════════════
//  3. The unsubscribe route
// ════════════════════════════════════════════════════════════════════════

test('GET only renders a confirmation — never mutates, never resubscribes', async () => {
  const { signToken } = await tokens()
  const { NextRequest, GET } = await route()
  state.suppressions.push({ email: EMAIL, reason: 'UNSUBSCRIBED', scope: 'promotional' })
  for (const [purpose, action] of [['unsubscribe', ''], ['resubscribe', '&action=resubscribe']] as const) {
    const token = signToken(EMAIL, purpose)
    const res = await GET(new NextRequest(`http://localhost/api/email/unsubscribe?token=${encodeURIComponent(token)}${action}`))
    await res.text()
  }
  assert.equal(state.suppressions.length, 1, 'a GET must not lift the suppression')
  assert.equal(fake.tables.events.length, 0, 'a GET must not write consent events')
})

/** The address had opted in (a ticked box on an older form) before it unsubscribed. */
const subscribedBefore = () =>
  fake.tables.customers.push({ id: 'cus_sub', email: EMAIL, emailMarketingConsent: true, marketingConsentAt: new Date('2026-08-01T00:00:00Z'), marketingOptOut: false })

test('POST unsubscribe: suppression + unsubscribed event + opted_out_at + enrollments stopped + a short-lived resubscribe form', async () => {
  const { signToken, verifyPurposeToken, verifyToken } = await tokens()
  subscribedBefore()
  fake.tables.enrollments.push({
    id: 'enr_1', emailNormalized: EMAIL, sequenceKind: 'quote_followup', subjectType: 'lead', subjectId: 'lead_1',
    basisEventId: null, windowStart: new Date('2026-09-16T00:00:00Z'), status: 'active', stopReason: null,
    createdAt: new Date(), updatedAt: new Date(),
  })
  const unsubToken = signToken(EMAIL, 'unsubscribe')
  const { status, body } = await postUnsubscribe(unsubToken)
  assert.equal(status, 200)
  assert.match(body, /You're unsubscribed/)

  assert.equal(state.suppressions.length, 1)
  assert.equal(state.suppressions[0].reason, 'UNSUBSCRIBED')
  const events = fake.tables.events.filter((e: Row) => e.kind === 'unsubscribed')
  assert.equal(events.length, 1)
  assert.equal(events[0].emailNormalized, EMAIL)
  assert.equal(events[0].surface, 'unsubscribe_link')
  assert.ok(fake.tables.status[0].optedOutAt instanceof Date)
  assert.equal(fake.tables.enrollments[0].status, 'stopped')

  const action = resubscribeActionFrom(body)
  assert.ok(action, 'a new unsubscribe offers the undo')
  const embedded = tokenOf(action as string)
  assert.ok(verifyPurposeToken(embedded, 'resubscribe'), 'the undo carries a resubscribe-purpose token')
  assert.equal(verifyToken(embedded, 'unsubscribe'), null)
  assert.ok(!body.includes(encodeURIComponent(unsubToken) + '&amp;action=resubscribe'), 'the unsubscribe token is never the undo token')
  await settle()
})

test('the unsubscribe token ALONE cannot resubscribe', async () => {
  const { signToken } = await tokens()
  const unsubToken = signToken(EMAIL, 'unsubscribe')
  await postUnsubscribe(unsubToken)
  assert.equal(state.suppressions.length, 1)

  const { status, body } = await postAction(`/api/email/unsubscribe?action=resubscribe&token=${encodeURIComponent(unsubToken)}`)
  assert.equal(status, 400)
  assert.match(body, /expired/i)
  assert.equal(state.suppressions.length, 1, 'still unsubscribed')
  assert.equal(fake.tables.events.filter((e: Row) => e.kind === 'resubscribed' || e.kind === 'express_opt_in').length, 0)
  await settle()
})

const DAY_MS = 24 * 60 * 60 * 1000

/** A status row as the consent record would hold it. */
const statusRow = (fields: Row) => ({
  emailNormalized: EMAIL,
  expressOptInAt: null,
  expressEventId: null,
  optedOutAt: null,
  declinedAt: null,
  lastNoticeAt: null,
  lastNoticeEventId: null,
  updatedAt: new Date(),
  ...fields,
})

test('the undo is offered ONLY to an address that was on a marketing path: never to one with no basis at all', async () => {
  const { signToken } = await tokens()
  const { NOTICE_BASIS_DAYS } = await import('../consent/marketing-eligibility')
  assert.equal(NOTICE_BASIS_DAYS, 183)

  /** A fresh database, arranged by `arrange`, then one HTML unsubscribe. */
  const unsubscribeWith = async (arrange: () => void) => {
    state.suppressions = []
    fake = buildFake()
    arrange()
    const res = await postUnsubscribe(signToken(EMAIL, 'unsubscribe'))
    assert.match(res.body, /You're unsubscribed/, 'the unsubscribe itself always succeeds')
    await settle()
    return resubscribeActionFrom(res.body)
  }

  //  No basis at all (no status, no notice, no consent column): the email that
  //  carried the link was not marketing they were on, so "keep me subscribed"
  //  would CREATE a subscription. Not offered.
  const noBasis = await postUnsubscribe(signToken(EMAIL, 'unsubscribe'))
  assert.match(noBasis.body, /You're unsubscribed/)
  assert.equal(resubscribeActionFrom(noBasis.body), null, 'no undo for someone who was never on a marketing path')
  assert.equal(fake.tables.events.filter((e: Row) => e.kind === 'unsubscribed').length, 1, 'the unsubscribe itself is recorded as normal')
  await settle()

  //  A confirmed express opt-in on record (an earlier resubscribe): offered.
  assert.ok(
    await unsubscribeWith(() => fake.tables.status.push(statusRow({ expressOptInAt: new Date('2026-09-17T00:00:00Z'), expressEventId: 'evt_x' }))),
    'an express subscriber may undo',
  )

  //  A form submission whose notice is inside the 183-day window: since the
  //  owner direction of 2026-09-16 such a person was on a marketing path. Offered.
  assert.ok(
    await unsubscribeWith(() => fake.tables.status.push(statusRow({ lastNoticeAt: new Date(Date.now() - 10 * DAY_MS), lastNoticeEventId: 'evt_n' }))),
    'a recent form notice may undo',
  )
  assert.ok(
    await unsubscribeWith(() => fake.tables.status.push(statusRow({ lastNoticeAt: new Date(Date.now() - (NOTICE_BASIS_DAYS * DAY_MS - 60_000)), lastNoticeEventId: 'evt_n' }))),
    'a notice just inside 183 days may undo',
  )

  //  A notice older than the window no longer put them on a path. Not offered.
  assert.equal(
    await unsubscribeWith(() => fake.tables.status.push(statusRow({ lastNoticeAt: new Date(Date.now() - (NOTICE_BASIS_DAYS + 1) * DAY_MS), lastNoticeEventId: 'evt_old' }))),
    null,
    'a notice older than 183 days offers no undo',
  )

  //  A ticked box on an older form (legacy column true on a lead): offered.
  assert.ok(
    await unsubscribeWith(() => fake.tables.leads.push({ id: 'lead_legacy', email: EMAIL.toUpperCase(), emailMarketingConsent: true })),
    'a legacy opt-in may undo (matched case-insensitively)',
  )

  //  The prior permission cannot be read: nothing is offered.
  assert.equal(
    await unsubscribeWith(() => {
      subscribedBefore()
      fake.customer.findMany = async () => {
        throw new Error('pool timeout')
      }
    }),
    null,
    'a legacy-column read failure offers no undo',
  )
  assert.equal(
    await unsubscribeWith(() => {
      fake.tables.status.push(statusRow({ lastNoticeAt: new Date(Date.now() - DAY_MS), lastNoticeEventId: 'evt_n' }))
      fake.emailMarketingStatus.findUnique = async () => {
        throw new Error('pool timeout')
      }
    }),
    null,
    'a status read failure offers no undo, even for a recent notice',
  )
})

// ── No undo for a person who had ALREADY opted out (review fix 2026-09-16) ──
//  hadMarketingPath used to return true for any recent form notice or legacy
//  opt-in box, so a person who had opted out, declined, or carried a
//  customer-level opt-out was offered "keep me subscribed" — a brand-new
//  subscription minted from a page anyone holding a forwarded email can reach.
//  An opt-out or decline yields only to a NEWER express opt-in (the same rule
//  the shared gate applies); a customer-level opt-out always withholds it.

const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS)

const arrangeStatus = (fields: Row) => fake.tables.status.push(statusRow(fields))

/** A ticked box on an older form, on a lead (no recorded consent time). */
const legacyLeadOptIn = () => fake.tables.leads.push({ id: 'lead_legacy', email: EMAIL, emailMarketingConsent: true, marketingConsentAt: null })

/** A ticked box on an older form, on a customer row. */
const legacyCustomerOptIn = (fields: Row = {}) =>
  fake.tables.customers.push({ id: 'cus_legacy', email: EMAIL, emailMarketingConsent: true, marketingConsentAt: daysAgo(60), marketingOptOut: false, ...fields })

/** A fresh database arranged by `arrange`, then ONE HTML unsubscribe. */
async function unsubscribeFresh(arrange: () => void) {
  const { signToken } = await tokens()
  state.suppressions = []
  state.customerUpdates = []
  fake = buildFake()
  arrange()
  const res = await postUnsubscribe(signToken(EMAIL, 'unsubscribe'))
  await settle()
  return { ...res, undo: resubscribeActionFrom(res.body) }
}

/** Every token on a page that verifies as a RESUBSCRIBE token, wherever it appears. */
async function resubscribeTokensOn(html: string): Promise<string[]> {
  const { verifyPurposeToken } = await tokens()
  const found: string[] = []
  for (const m of html.matchAll(/token=([^"&\s<]+)/g)) {
    const candidate = decodeURIComponent(m[1])
    if (verifyPurposeToken(candidate, 'resubscribe')) found.push(candidate)
  }
  return found
}

const campaignGate = async () => {
  const { promotionalEligibility } = await import('../consent/marketing-eligibility')
  return promotionalEligibility({ context: 'campaign', email: EMAIL }, { db: fake as never, testIdentity: async () => null })
}

const WITHHELD: Array<[string, () => void]> = [
  ['opted out yesterday, with a form notice 10 days ago', () => arrangeStatus({ optedOutAt: daysAgo(1), lastNoticeAt: daysAgo(10), lastNoticeEventId: 'evt_n' })],
  ['opted out 30 days ago, with a NEWER form notice 2 days ago', () => arrangeStatus({ optedOutAt: daysAgo(30), lastNoticeAt: daysAgo(2), lastNoticeEventId: 'evt_n' })],
  ['opted out yesterday, with a legacy opt-in on a lead', () => {
    arrangeStatus({ optedOutAt: daysAgo(1) })
    legacyLeadOptIn()
  }],
  ['opted out yesterday, with a legacy opt-in on a customer AND a recent notice', () => {
    arrangeStatus({ optedOutAt: daysAgo(1), lastNoticeAt: daysAgo(3), lastNoticeEventId: 'evt_n' })
    legacyCustomerOptIn()
  }],
  ['opted out AFTER an express opt-in, with a notice newer than both', () =>
    arrangeStatus({ expressOptInAt: daysAgo(20), expressEventId: 'evt_x', optedOutAt: daysAgo(5), lastNoticeAt: daysAgo(1), lastNoticeEventId: 'evt_n' })],
  ['opted out at the SAME instant as the express opt-in', () => {
    const at = daysAgo(4)
    arrangeStatus({ expressOptInAt: at, expressEventId: 'evt_x', optedOutAt: new Date(at.getTime()) })
  }],
  ['declined yesterday, with a form notice 10 days ago', () => arrangeStatus({ declinedAt: daysAgo(1), lastNoticeAt: daysAgo(10), lastNoticeEventId: 'evt_n' })],
  ['declined AFTER an express opt-in, with a notice newer than both', () =>
    arrangeStatus({ expressOptInAt: daysAgo(20), expressEventId: 'evt_x', declinedAt: daysAgo(3), lastNoticeAt: daysAgo(1), lastNoticeEventId: 'evt_n' })],
  ['declined at the SAME instant as the express opt-in', () => {
    const at = daysAgo(4)
    arrangeStatus({ expressOptInAt: at, expressEventId: 'evt_x', declinedAt: new Date(at.getTime()) })
  }],
  ['declined yesterday, with a legacy opt-in on a lead', () => {
    arrangeStatus({ declinedAt: daysAgo(1) })
    legacyLeadOptIn()
  }],
  ['a customer-level opt-out, with a form notice 10 days ago and no status opt-out', () => {
    arrangeStatus({ lastNoticeAt: daysAgo(10), lastNoticeEventId: 'evt_n' })
    fake.tables.customers.push({ id: 'cus_out', email: EMAIL, emailMarketingConsent: null, marketingOptOut: true })
  }],
  ['a customer-level opt-out on the very row that holds a legacy opt-in', () => legacyCustomerOptIn({ marketingOptOut: true })],
  ['a customer-level opt-out on a differently-cased address, with a legacy opt-in on a lead', () => {
    fake.tables.customers.push({ id: 'cus_case', email: 'Leaver@EXAMPLE.com', emailMarketingConsent: null, marketingOptOut: true })
    legacyLeadOptIn()
  }],
]

test('no undo for a person who had already opted out, declined, or opted out as a customer — whatever notice or legacy box they also have', async () => {
  for (const [name, arrange] of WITHHELD) {
    //  The premise: the shared gate had ALREADY stopped their marketing, so
    //  "keep me subscribed" could not be an undo.
    state.suppressions = []
    fake = buildFake()
    arrange()
    const before = await campaignGate()
    assert.equal(before.eligible, false, `${name}: premise — the gate already refused marketing`)
    assert.ok(['opted_out', 'declined'].includes((before as { reason: string }).reason), `${name}: premise reason ${JSON.stringify(before)}`)

    const { status, body, undo } = await unsubscribeFresh(arrange)
    assert.equal(status, 200, name)
    assert.match(body, /You're unsubscribed/, `${name}: the unsubscribe itself is new and succeeds`)
    assert.equal(undo, null, `${name}: no "keep me subscribed" form`)
    assert.ok(!/action=resubscribe/.test(body), `${name}: no resubscribe action anywhere on the page`)
    assert.deepEqual(await resubscribeTokensOn(body), [], `${name}: no resubscribe token anywhere on the page`)
    assert.equal(state.suppressions.length, 1, `${name}: the suppression row is written`)
    assert.equal(fake.tables.events.filter((e: Row) => e.kind === 'unsubscribed').length, 1, `${name}: the withdrawal is recorded`)
  }
})

const OFFERED: Array<[string, () => void]> = [
  ['an express opt-in NEWER than an earlier opt-out', () => arrangeStatus({ optedOutAt: daysAgo(30), expressOptInAt: daysAgo(2), expressEventId: 'evt_x' })],
  ['an express opt-in one millisecond after the opt-out', () => {
    const at = daysAgo(4)
    arrangeStatus({ optedOutAt: at, expressOptInAt: new Date(at.getTime() + 1), expressEventId: 'evt_x' })
  }],
  ['an express opt-in newer than a decline', () => arrangeStatus({ declinedAt: daysAgo(30), expressOptInAt: daysAgo(2), expressEventId: 'evt_x' })],
  ['an express opt-in newer than both an opt-out and a decline, with a recent notice', () =>
    arrangeStatus({ optedOutAt: daysAgo(30), declinedAt: daysAgo(25), expressOptInAt: daysAgo(2), expressEventId: 'evt_x', lastNoticeAt: daysAgo(10), lastNoticeEventId: 'evt_n' })],
  ['an express opt-in and no opt-out anywhere', () => arrangeStatus({ expressOptInAt: daysAgo(20), expressEventId: 'evt_x' })],
  ['a form notice 10 days ago, no opt-out, and a customer row with marketingOptOut false', () => {
    arrangeStatus({ lastNoticeAt: daysAgo(10), lastNoticeEventId: 'evt_n' })
    fake.tables.customers.push({ id: 'cus_in', email: EMAIL, emailMarketingConsent: null, marketingOptOut: false })
  }],
  ['a legacy opt-in on a customer with marketingOptOut false and no status row', () => legacyCustomerOptIn()],
]

test('the undo IS still offered when an express opt-in is newer than the opt-out, and to a notice/express person with no opt-out — and it works', async () => {
  const { verifyPurposeToken } = await tokens()
  for (const [name, arrange] of OFFERED) {
    const { status, body, undo } = await unsubscribeFresh(arrange)
    assert.equal(status, 200, name)
    assert.match(body, /You're unsubscribed/, name)
    assert.ok(undo, `${name}: the undo is offered`)
    assert.ok(verifyPurposeToken(tokenOf(undo as string), 'resubscribe'), `${name}: it carries a resubscribe token`)

    const back = await postAction(undo as string)
    assert.equal(back.status, 200, `${name}: the undo is accepted`)
    assert.equal(state.suppressions.length, 0, `${name}: the promotional row is lifted`)
    assert.equal(fake.tables.events.filter((e: Row) => e.kind === 'express_opt_in').length, 1, `${name}: one express opt-in recorded`)
    await settle()
  }
})

test('REVIEW SCENARIO: opted out yesterday + a notice 10 days ago + no suppression row — POST unsubscribe offers no undo, and no forged resubscribe produces express_opt_in', async () => {
  const { signToken } = await tokens()

  //  Control: the SAME notice without the opt-out is on a path and does get the undo.
  const control = await unsubscribeFresh(() => arrangeStatus({ lastNoticeAt: daysAgo(10), lastNoticeEventId: 'evt_notice' }))
  assert.ok(control.undo, 'control: a notice with no opt-out offers the undo')

  //  The reviewer's scenario.
  state.suppressions = []
  fake = buildFake()
  const optedOutAt = daysAgo(1)
  arrangeStatus({ optedOutAt, lastNoticeAt: daysAgo(10), lastNoticeEventId: 'evt_notice' })
  assert.equal(state.suppressions.length, 0, 'premise: no suppression row')

  const unsubToken = signToken(EMAIL, 'unsubscribe')
  const { status, body } = await postUnsubscribe(unsubToken)
  assert.equal(status, 200)
  assert.match(body, /You're unsubscribed/, 'a NEW unsubscribe: the suppression row did not exist')
  assert.equal(resubscribeActionFrom(body), null, 'no "keep me subscribed" form')
  assert.ok(!/action=resubscribe/.test(body), 'no resubscribe action anywhere on the page')
  assert.deepEqual(await resubscribeTokensOn(body), [], 'no resubscribe token anywhere on the page')
  assert.equal(state.suppressions.length, 1)
  assert.equal(state.suppressions[0].reason, 'UNSUBSCRIBED')
  assert.ok(fake.tables.status[0].optedOutAt.getTime() > optedOutAt.getTime(), 'the new withdrawal moved opted_out_at forward')
  await settle()

  //  Whoever holds the forwarded email now tries to fabricate the undo.
  const [payloadPart, unsubMac] = unsubToken.split('.')
  const payload = Buffer.from(payloadPart.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
  assert.match(payload, /:unsubscribe:leaver@example\.com:\d+$/, 'premise: the payload layout the forgeries rewrite')
  const relabelled = payload.replace(':unsubscribe:', ':resubscribe:')
  const b64url = (s: string | Buffer) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const guessedMac = b64url(createHmac('sha256', 'a-guessed-secret').update(relabelled).digest())
  const forgeries: Array<[string, string]> = [
    ['the unsubscribe token itself', unsubToken],
    ['the payload relabelled to resubscribe, keeping the unsubscribe MAC', `${b64url(relabelled)}.${unsubMac}`],
    ['a resubscribe payload signed with a guessed secret', `${b64url(relabelled)}.${guessedMac}`],
    ['a resubscribe payload with no MAC', `${b64url(relabelled)}.`],
    ['an empty token', ''],
  ]
  for (const [name, forged] of forgeries) {
    const r = await postAction(`/api/email/unsubscribe?action=resubscribe&token=${encodeURIComponent(forged)}`)
    assert.equal(r.status, 400, `${name}: refused`)
    assert.match(r.body, /expired/i, `${name}: the invalid-resubscribe page`)
  }
  assert.equal((await postAction('/api/email/unsubscribe?action=resubscribe')).status, 400, 'no token at all: refused')
  //  A GET with action=resubscribe never resubscribes either.
  const { NextRequest, GET } = await route()
  await (await GET(new NextRequest(`http://localhost/api/email/unsubscribe?action=resubscribe&token=${encodeURIComponent(unsubToken)}`))).text()

  assert.equal(state.suppressions.length, 1, 'still unsubscribed')
  assert.equal(
    fake.tables.events.filter((e: Row) => e.kind === 'resubscribed' || e.kind === 'express_opt_in').length,
    0,
    'no resubscribed or express_opt_in event',
  )
  assert.equal(fake.tables.status[0].expressOptInAt, null, 'the status row holds no express opt-in')

  //  Even with the suppression row gone, the consent record keeps them out.
  state.suppressions = []
  const d = await campaignGate()
  assert.equal(d.eligible, false)
  assert.equal((d as { reason: string }).reason, 'opted_out')
  await settle()
})

test('a real cycle: undo, unsubscribe again (still an undo — the opt-in is newer), then a forwarded link after the row is gone offers nothing', async () => {
  const { signToken } = await tokens()
  arrangeStatus({ lastNoticeAt: daysAgo(10), lastNoticeEventId: 'evt_notice' })

  const first = await postUnsubscribe(signToken(EMAIL, 'unsubscribe'))
  const undo1 = resubscribeActionFrom(first.body)
  assert.ok(undo1, 'a notice person may undo')
  await settle()
  assert.equal((await postAction(undo1 as string)).status, 200)
  assert.equal(state.suppressions.length, 0)
  await settle()

  const second = await postUnsubscribe(signToken(EMAIL, 'unsubscribe'))
  assert.match(second.body, /You're unsubscribed/)
  assert.ok(resubscribeActionFrom(second.body), 'the opt-in from the undo is newer than the first opt-out: still an undo')
  const s = fake.tables.status[0]
  assert.ok(s.optedOutAt.getTime() > s.expressOptInAt.getTime(), 'the second unsubscribe now outranks that opt-in')
  await settle()

  //  The suppression row disappears out of band; someone holding a forwarded
  //  email POSTs the old link.
  state.suppressions = []
  const third = await postUnsubscribe(signToken(EMAIL, 'unsubscribe'))
  assert.match(third.body, /You're unsubscribed/, 'recorded as a new unsubscribe')
  assert.equal(resubscribeActionFrom(third.body), null, 'the person had opted out again: no undo')
  assert.deepEqual(await resubscribeTokensOn(third.body), [])
  assert.equal(fake.tables.events.filter((e: Row) => e.kind === 'express_opt_in').length, 1, 'only the one genuine opt-in')
  await settle()
})

test('resubscribe with the minted token: POST lifts the row and records resubscribed + express_opt_in, once', async () => {
  const { signToken } = await tokens()
  subscribedBefore()
  const { body } = await postUnsubscribe(signToken(EMAIL, 'unsubscribe'))
  const action = resubscribeActionFrom(body) as string

  const first = await postAction(action)
  assert.equal(first.status, 200)
  assert.match(first.body, /You are back on the list/)
  assert.equal(state.suppressions.length, 0)
  const kinds = fake.tables.events.map((e: Row) => e.kind).sort()
  assert.deepEqual(kinds, ['express_opt_in', 'resubscribed', 'unsubscribed'])
  const status = fake.tables.status[0]
  assert.ok(status.expressOptInAt.getTime() >= status.optedOutAt.getTime())

  // SINGLE USE: the person unsubscribes again; replaying the old undo link
  // must not lift the new row.
  const again = await postUnsubscribe(signToken(EMAIL, 'unsubscribe'))
  assert.match(again.body, /unsubscribed/i)
  assert.equal(state.suppressions.length, 1)
  const replay = await postAction(action)
  assert.equal(replay.status, 400)
  assert.equal(state.suppressions.length, 1, 'a replayed resubscribe token lifts nothing')
  assert.equal(fake.tables.events.filter((e: Row) => e.kind === 'express_opt_in').length, 1)
  await settle()
})

// ── A withdrawal recorded AFTER the undo was minted kills it (review fix) ──
//  handleResubscribe used to accept any UNSPENT resubscribe token inside its
//  hour. A person who unsubscribed and then withdrew again without using the
//  undo — a second unsubscribe, a ticked opt-out box, a decline — could still be
//  re-subscribed by the older link on the first page. A token issued before the
//  latest opted_out_at / declined_at is now refused, and so is one whose
//  withdrawal record cannot be read.

/** A notice person (on a marketing path) unsubscribes on the HTML page; the undo it was offered. */
async function mintUndo() {
  const { verifyPurposeToken } = await tokens()
  const { body, undo } = await unsubscribeFresh(() => arrangeStatus({ lastNoticeAt: daysAgo(10), lastNoticeEventId: 'evt_notice' }))
  assert.match(body, /You're unsubscribed/)
  assert.ok(undo, 'premise: a notice person is offered the undo')
  const verified = verifyPurposeToken(tokenOf(undo as string), 'resubscribe')
  assert.ok(verified, 'premise: the undo carries a resubscribe token')
  assert.ok(fake.tables.status[0].optedOutAt.getTime() <= verified.issuedAt, 'premise: the minting unsubscribe recorded its own opt-out first')
  //  Whatever happens next must land on a LATER millisecond than the mint.
  while (Date.now() <= verified.issuedAt) await settle()
  return { undo: undo as string, issuedAt: verified.issuedAt }
}

const resubscribeEvents = () => fake.tables.events.filter((e: Row) => e.kind === 'resubscribed' || e.kind === 'express_opt_in')

/** POST the undo and prove it was refused before anything was spent or lifted. */
async function assertUndoRefused(undo: string, label: string) {
  const r = await postAction(undo)
  assert.equal(r.status, 400, `${label}: refused`)
  assert.match(r.body, /expired/i, `${label}: the invalid-resubscribe page`)
  assert.equal(state.suppressions.length, 1, `${label}: the suppression row remains`)
  assert.equal(state.suppressions[0].reason, 'UNSUBSCRIBED', label)
  assert.equal(resubscribeEvents().length, 0, `${label}: no resubscribed or express_opt_in event — the token was not even spent`)
  assert.equal(fake.tables.status[0].expressOptInAt, null, `${label}: no express opt-in on the status row`)
}

test('REVIEW SCENARIO: an undo token minted BEFORE a second unsubscribe is dead — POST action=resubscribe with it lifts nothing and records nothing', async () => {
  const { signToken } = await tokens()
  const { undo, issuedAt } = await mintUndo()

  //  The person unsubscribes again (another email's link) without using the undo.
  const again = await postUnsubscribe(signToken(EMAIL, 'unsubscribe'))
  assert.equal(again.status, 200)
  assert.match(again.body, /already unsubscribed/, 'the row exists, so this is a repeat')
  assert.equal(resubscribeActionFrom(again.body), null, 'a repeat mints no new undo')
  assert.equal(fake.tables.events.filter((e: Row) => e.kind === 'unsubscribed').length, 2, 'the repeat withdrawal is recorded')
  assert.ok(fake.tables.status[0].optedOutAt.getTime() > issuedAt, 'premise: opted_out_at is now LATER than the token')
  await settle()

  await assertUndoRefused(undo, 'after a second unsubscribe')
  //  A retry of the same dead link changes nothing either.
  await assertUndoRefused(undo, 'retried')
  await settle()
})

test('an undo token is dead once an opt-out box or a decline is recorded after it was minted; a withdrawal stamped AT the mint instant (the minting unsubscribe itself) does not kill it', async () => {
  const { recordConsentEvent } = await import('../consent/consent-events')
  for (const kind of ['opted_out_at_capture', 'declined_at_capture'] as const) {
    const { undo, issuedAt } = await mintUndo()
    const r = await recordConsentEvent({ email: EMAIL, kind, surface: 'booking', requestId: `req_${kind}`, occurredAt: new Date(issuedAt + 1) }, fake as never)
    assert.ok(r.ok && r.created, `${kind}: recorded`)
    await assertUndoRefused(undo, kind)
    await settle()
  }

  //  The boundary: withdrawn at exactly issuedAt is not LATER than the token.
  const { undo, issuedAt } = await mintUndo()
  const tie = await recordConsentEvent({ email: EMAIL, kind: 'opted_out_at_capture', surface: 'booking', requestId: 'req_same_instant', occurredAt: new Date(issuedAt) }, fake as never)
  assert.ok(tie.ok && tie.created)
  assert.equal(fake.tables.status[0].optedOutAt.getTime(), issuedAt, 'premise: opted_out_at equals the mint instant')
  const back = await postAction(undo)
  assert.equal(back.status, 200, 'same instant: the undo is accepted')
  assert.equal(state.suppressions.length, 0, 'same instant: the promotional row is lifted')
  assert.equal(fake.tables.events.filter((e: Row) => e.kind === 'express_opt_in').length, 1)
  await settle()
})

test('an undo is refused when the withdrawal record cannot be read — nothing spent, nothing lifted; once readable, the same unspent token is a genuine undo', async () => {
  const { undo } = await mintUndo()
  const readable = fake.emailMarketingStatus.findUnique
  fake.emailMarketingStatus.findUnique = async () => {
    throw new Error('pool timeout')
  }
  await assertUndoRefused(undo, 'status unreadable')

  fake.emailMarketingStatus.findUnique = readable
  const back = await postAction(undo)
  assert.equal(back.status, 200, 'no later withdrawal: the undo works')
  assert.equal(state.suppressions.length, 0)
  assert.deepEqual(resubscribeEvents().map((e: Row) => e.kind).sort(), ['express_opt_in', 'resubscribed'])
  await settle()
})

test('an expired resubscribe token is refused and changes nothing', async () => {
  const { signToken } = await tokens()
  state.suppressions.push({ email: EMAIL, reason: 'UNSUBSCRIBED', scope: 'promotional' })
  const old = signToken(EMAIL, 'resubscribe', Date.now() - 2 * 60 * 60 * 1000)
  const { status } = await postAction(`/api/email/unsubscribe?action=resubscribe&token=${encodeURIComponent(old)}`)
  assert.equal(status, 400)
  assert.equal(state.suppressions.length, 1)
  assert.equal(fake.tables.events.length, 0)
})

test('resubscribe never lifts a hard block and records no opt-in for it', async () => {
  const { signToken } = await tokens()
  state.suppressions.push({ email: EMAIL, reason: 'HARD_BOUNCE', scope: 'all' })
  const token = signToken(EMAIL, 'resubscribe')
  const { body } = await postAction(`/api/email/unsubscribe?action=resubscribe&token=${encodeURIComponent(token)}`)
  assert.match(body, /can't re-add/)
  assert.equal(state.suppressions.length, 1)
  assert.equal(fake.tables.events.filter((e: Row) => e.kind === 'express_opt_in').length, 0)
})

test('a repeat POST of an old link does not mint an undo token', async () => {
  const { signToken } = await tokens()
  state.suppressions.push({ email: EMAIL, reason: 'UNSUBSCRIBED', scope: 'promotional' })
  const { status, body } = await postUnsubscribe(signToken(EMAIL, 'unsubscribe'))
  assert.equal(status, 200)
  assert.match(body, /already unsubscribed/)
  assert.equal(resubscribeActionFrom(body), null)
  // ...but the withdrawal is still recorded.
  assert.equal(fake.tables.events.filter((e: Row) => e.kind === 'unsubscribed').length, 1)
  await settle()
})

test('RFC 8058 one-click (no HTML) unsubscribes, records the event and returns no token', async () => {
  const { signToken } = await tokens()
  const { status, body } = await postUnsubscribe(signToken(EMAIL, 'unsubscribe'), false)
  assert.equal(status, 200)
  assert.deepEqual(JSON.parse(body), { ok: true, status: 'unsubscribed' })
  assert.equal(fake.tables.events.filter((e: Row) => e.kind === 'unsubscribed').length, 1)
  assert.ok(!/token/i.test(body))
  await settle()
})

test('after an unsubscribe the shared gate refuses promotional mail, even with an old consent column', async () => {
  const { signToken } = await tokens()
  fake.tables.customers.push({ id: 'cus_1', email: EMAIL, emailMarketingConsent: true, marketingConsentAt: new Date('2026-08-01T00:00:00Z'), marketingOptOut: false })
  await postUnsubscribe(signToken(EMAIL, 'unsubscribe'))
  // The suppression row is removed out of band (e.g. an old admin lift); the
  // consent record still says the person withdrew.
  state.suppressions = []
  const { promotionalEligibility } = await import('../consent/marketing-eligibility')
  const d = await promotionalEligibility(
    { context: 'campaign', email: EMAIL },
    { db: fake as never, testIdentity: async () => null }
  )
  assert.equal(d.eligible, false)
  assert.equal((d as { reason: string }).reason, 'opted_out')
  await settle()
})

// ════════════════════════════════════════════════════════════════════════
//  4. Operators cannot lift an unsubscribe
// ════════════════════════════════════════════════════════════════════════

test('adminLiftRefusal: UNSUBSCRIBED is refused outright', async () => {
  const { adminLiftRefusal } = await suppression()
  const v = await adminLiftRefusal(EMAIL, 'UNSUBSCRIBED', fake as never)
  assert.equal(v.allow, false)
  assert.equal((v as { code: string }).code, 'unsubscribed')
})

test('adminLiftRefusal: a relabelled row with an unsubscribe on record is refused', async () => {
  const { adminLiftRefusal } = await suppression()
  fake.tables.events.push({ id: 'evt_u', emailNormalized: EMAIL, kind: 'unsubscribed', requestId: 'r1', occurredAt: new Date() })
  const v = await adminLiftRefusal(EMAIL, 'ADMIN_BLOCK', fake as never)
  assert.equal(v.allow, false)
  assert.equal((v as { code: string }).code, 'unsubscribe_on_record')
})

test('adminLiftRefusal: a plain admin block with no unsubscribe may be lifted; a read failure refuses', async () => {
  const { adminLiftRefusal } = await suppression()
  assert.deepEqual(await adminLiftRefusal(EMAIL, 'ADMIN_BLOCK', fake as never), { allow: true })
  const broken = { emailConsentEvent: { findFirst: async () => { throw new Error('db down') } } }
  const v = await adminLiftRefusal(EMAIL, 'INVALID_ADDRESS', broken)
  assert.equal(v.allow, false)
  assert.equal((v as { code: string }).code, 'check_failed')
})

test('the admin DELETE route checks adminLiftRefusal BEFORE it deletes anything', () => {
  const s = readFileSync(resolve(__dirname, '../../../app/api/admin/email-marketing/suppressions/route.ts'), 'utf8')
  const del = s.slice(s.indexOf('export async function DELETE'))
  const check = del.indexOf('await adminLiftRefusal(')
  const deleteAt = del.indexOf('prisma.emailSuppression.deleteMany(')
  assert.ok(check > -1, 'the route must call adminLiftRefusal')
  assert.ok(deleteAt > check, 'the refusal must precede the delete')
  assert.match(del.slice(check, deleteAt), /if \(!lift\.allow\) return NextResponse\.json/)
})

// ════════════════════════════════════════════════════════════════════════
//  5. SMS START does not re-enable email marketing
// ════════════════════════════════════════════════════════════════════════

async function sms(body: string) {
  const { NextRequest } = await import('next/server')
  const { POST } = await import('../../../app/api/sms/inbound/route')
  const req = new NextRequest('http://localhost/api/sms/inbound', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ From: '+15555550100', Body: body }).toString(),
  })
  const res = await POST(req)
  return { status: res.status, text: await res.text() }
}

test('SMS START / YES / UNSTOP never touch the email opt-out', async () => {
  fake.tables.customers.push({ id: 'cus_sms', email: 'texter@example.com', phone: '+15555550100', marketingOptOut: true, emailMarketingConsent: true })
  for (const word of ['START', 'yes', 'unstop', 'optin']) {
    const r = await sms(word)
    assert.equal(r.status, 200)
  }
  assert.equal(state.customerUpdates.length, 0, 'no customer row may be written')
  assert.equal(state.queryRawCalls, 0, 'START does not even look the customer up')
  assert.equal(fake.tables.customers[0].marketingOptOut, true)
})

test('SMS STOP still records the opt-out (the safe direction)', async () => {
  fake.tables.customers.push({ id: 'cus_sms', email: 'texter@example.com', phone: '+15555550100', marketingOptOut: false })
  await sms('STOP')
  assert.equal(state.customerUpdates.length, 1)
  assert.deepEqual(state.customerUpdates[0].data, { marketingOptOut: true })
})

test('the SMS route can only ever write marketingOptOut: true', () => {
  const s = readFileSync(resolve(__dirname, '../../../app/api/sms/inbound/route.ts'), 'utf8')
  const code = s.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
  assert.ok(!/marketingOptOut: false/.test(code))
  assert.ok(!/marketingOptOut: optOut/.test(code))
  assert.ok(!/START_WORDS/.test(code))
})
