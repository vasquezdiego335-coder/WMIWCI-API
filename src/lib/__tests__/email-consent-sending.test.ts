// ════════════════════════════════════════════════════════════════════════
//  email-consent-sending.test.ts — every promotional gate asks the shared
//  per-person question (email consent release 2026-09-16, DESIGN-v2 §5, §7).
//
//  What this pins:
//    • guardedSend refuses a PROMOTIONAL send without an eligible basis — the
//      caller's decision or its own — and records the basis it DID use on
//      EmailSend (marketingBasis / basisEventId);
//    • suppressed addresses never get promotional mail through any gate
//      (guard, booking recheck, campaign audience, enrollCustomer);
//    • a form notice serves the sequences listed for its surface (lead_nurture
//      on every surface) and relevant campaigns (the person's latest form
//      submission, a support message included), never automations or post-move;
//    • List-Unsubscribe + List-Unsubscribe-Post on promotional mail only;
//    • EXISTING TEMPLATES ARE SENT AS RENDERED (owner direction 2026-09-16: no
//      new templates; the one copy change is the lead-nurture footer, which no
//      longer claims an opt-in): the guard inserts nothing, lead-nurture is sent
//      on a notice basis, and no template in src/emails says "opted in";
//    • quote-request-received carries no offer content;
//    • test sends of promotional templates need a basis or an internal
//      recipient; enrollCustomer is express-only and skips test bookings;
//    • automations and follow-ups use the shared gate (express / post-move).
//
//  Offline: an in-memory fake Prisma on globalThis, a mocked Resend client
//  with asserted call counts, no network, no Redis, no database. Every
//  recipient is @example.com. Because @example.com is a reserved (test)
//  identity, the send-path tests list their recipients EXACTLY in
//  EMAIL_PROMOTIONAL_ALLOWLIST — the canary rehearsal exemption — and the
//  loader-level tests inject a testIdentity dependency.
// ════════════════════════════════════════════════════════════════════════
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import * as React from 'react'
import { render } from '@react-email/render'
import { assertNoProductionCredentials, assertTestRecipient } from './_disposable-test-env'
import { createFakeConsentDb } from './_consent-fake-db'
import type { NoticeSurface, SequenceKind } from '../consent/notice-registry'

assertNoProductionCredentials()

// Not example.com: the send guard's URL-safety gate refuses example domains in
// links, and the unsubscribe link is built from APP_URL. Nothing is contacted.
process.env.APP_URL = 'https://app.moveitclearit.test'
process.env.EMAIL_TOKEN_SECRET = 'test-secret-for-email-consent-sending-0123456789'
process.env.BUSINESS_POSTAL_ADDRESS = '123 Test Street, Testville, NJ 00000'
// Quiet hours can never apply: the tests must not depend on the wall clock.
process.env.EMAIL_QUIET_END_HOUR = '0'
process.env.EMAIL_QUIET_START_HOUR = '24'
process.env.EMAIL_TRANSACTIONAL_GAP_MINUTES = '0'
delete process.env.EMAIL_SENDING_ENABLED
delete process.env.EMAIL_NOTICE_BASIS_ENABLED
delete process.env.EMAIL_EBR_BASIS_ENABLED

type Row = Record<string, any>

const OPTED_IN = 'opted-in@example.com'
const NO_BASIS = 'no-basis@example.com'
const WITHDRAWN = 'withdrawn@example.com'
const SUPPRESSED = 'suppressed@example.com'
const DECLINED_LATER = 'declined-later@example.com'
const STATUS_EXPRESS = 'confirmed@example.com'
const NOT_LISTED = 'not-listed@example.com'
for (const e of [OPTED_IN, NO_BASIS, WITHDRAWN, SUPPRESSED, DECLINED_LATER, STATUS_EXPRESS, NOT_LISTED]) assertTestRecipient(e)
const CANARY = [OPTED_IN, NO_BASIS, WITHDRAWN, SUPPRESSED, DECLINED_LATER, STATUS_EXPRESS]
process.env.EMAIL_PROMOTIONAL_ALLOWLIST = CANARY.join(',')

// ── The fake database ───────────────────────────────────────────────────
let fake: Row

function matchesWhere(row: Row, where: Row): boolean {
  for (const [k, cond] of Object.entries(where)) {
    const v = row[k]
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('notIn' in cond && (cond.notIn as unknown[]).includes(v)) return false
      if ('in' in cond && !(cond.in as unknown[]).includes(v)) return false
      continue
    }
    if (cond === null ? v != null : v !== cond) return false
  }
  return true
}

function buildFake(): Row {
  const db = createFakeConsentDb()
  const t = db.tables as Row
  t.sends = []
  let seq = 0
  Object.assign(db, {
    emailSend: {
      async create({ data }: Row) {
        if (t.sends.some((r: Row) => r.idempotencyKey === data.idempotencyKey)) throw Object.assign(new Error('dup'), { code: 'P2002' })
        const row = { attempts: 0, nextAttemptAt: null, ...data, id: `es_${++seq}`, createdAt: new Date(), updatedAt: new Date() }
        t.sends.push(row)
        return { ...row }
      },
      async findUnique({ where }: Row) {
        const row = t.sends.find((r: Row) => r.idempotencyKey === where.idempotencyKey)
        return row ? { ...row } : null
      },
      async update({ where, data }: Row) {
        const row = t.sends.find((r: Row) => r.id === where.id)
        Object.assign(row, data, { updatedAt: new Date() })
        return { ...row }
      },
      async updateMany({ where, data }: Row) {
        const hits = t.sends.filter((r: Row) => matchesWhere(r, where))
        for (const h of hits) Object.assign(h, data, { updatedAt: new Date() })
        return { count: hits.length }
      },
      async upsert({ where, create }: Row) {
        const existing = t.sends.find((r: Row) => r.idempotencyKey === where.idempotencyKey)
        if (existing) return { ...existing }
        return (db.emailSend as Row).create({ data: create })
      },
      async count() {
        return 0
      },
    },
  })
  db.emailSuppression.findMany = async ({ where }: Row) =>
    t.suppressions.filter((s: Row) => where.email.in.includes(s.email)).map((s: Row) => ({ ...s }))
  db.emailMarketingStatus.findMany = async ({ where }: Row) =>
    t.status.filter((s: Row) => where.emailNormalized.in.includes(s.emailNormalized)).map((s: Row) => ({ ...s }))
  const bookingFindUnique = db.booking.findUnique
  db.booking.findUnique = async (args: Row) => {
    if (args.where.displayId) {
      const row = t.bookings.find((b: Row) => b.displayId === args.where.displayId)
      return row ? { isInternalTest: row.isInternalTest } : null
    }
    return bookingFindUnique(args)
  }
  return db
}

fake = buildFake()
;(globalThis as unknown as { prisma: unknown }).prisma = new Proxy({}, { get: (_t, key) => (fake as Row)[key as string] })

const DAY = 24 * 60 * 60 * 1000
const LONG_AGO = new Date('2026-08-01T12:00:00Z')

function seedPeople() {
  const t = fake.tables
  t.leads.push({ id: 'lead_opted', email: OPTED_IN, emailMarketingConsent: true, marketingConsentAt: LONG_AGO, basisEventId: null })
  t.customers.push({ id: 'cus_opted', email: OPTED_IN, emailMarketingConsent: true, marketingConsentAt: LONG_AGO, marketingOptOut: false })
  t.leads.push({ id: 'lead_none', email: NO_BASIS, emailMarketingConsent: null, marketingConsentAt: null, basisEventId: null })
  t.customers.push({ id: 'cus_withdrawn', email: WITHDRAWN, emailMarketingConsent: true, marketingConsentAt: LONG_AGO, marketingOptOut: false })
  t.status.push({ emailNormalized: WITHDRAWN, expressOptInAt: null, expressEventId: null, optedOutAt: new Date(LONG_AGO.getTime() + 10 * DAY), declinedAt: null, lastNoticeAt: null, lastNoticeEventId: null })
  t.customers.push({ id: 'cus_supp', email: SUPPRESSED, emailMarketingConsent: true, marketingConsentAt: LONG_AGO, marketingOptOut: false })
  t.leads.push({ id: 'lead_supp', email: SUPPRESSED, emailMarketingConsent: true, marketingConsentAt: LONG_AGO, basisEventId: null })
  // A Lead said yes in August; the same person's Customer row said no later.
  t.leads.push({ id: 'lead_dl', email: DECLINED_LATER, emailMarketingConsent: true, marketingConsentAt: LONG_AGO, basisEventId: null })
  t.customers.push({ id: 'cus_dl', email: DECLINED_LATER, emailMarketingConsent: false, marketingConsentAt: new Date(LONG_AGO.getTime() + 5 * DAY), marketingOptOut: false })
  // A confirmed express opt-in (e.g. a confirmed popup) and nothing else.
  t.customers.push({ id: 'cus_status', email: STATUS_EXPRESS, emailMarketingConsent: null, marketingConsentAt: null, marketingOptOut: false })
  t.status.push({ emailNormalized: STATUS_EXPRESS, expressOptInAt: LONG_AGO, expressEventId: 'evt_express', optedOutAt: null, declinedAt: null, lastNoticeAt: null, lastNoticeEventId: null })
  t.leads.push({ id: 'lead_nl', email: NOT_LISTED, emailMarketingConsent: true, marketingConsentAt: LONG_AGO, basisEventId: null })
}

beforeEach(() => {
  fake = buildFake()
  seedPeople()
  process.env.EMAIL_PROMOTIONAL_ALLOWLIST = CANARY.join(',')
  delete process.env.EMAIL_NOTICE_BASIS_ENABLED
  delete process.env.EMAIL_EBR_BASIS_ENABLED
})

const SUPPRESSION_REASONS = ['UNSUBSCRIBED', 'HARD_BOUNCE', 'SPAM_COMPLAINT', 'INVALID_ADDRESS', 'ADMIN_BLOCK', 'PROVIDER_REJECTED'] as const
const scopeOf = (reason: string) => (reason === 'UNSUBSCRIBED' ? 'promotional' : 'all')

const guard = async () => {
  const g = await import('../email-guard')
  const { resend } = await import('../resend')
  return { ...g, resend }
}

let eventSeq = 0
const promo = (to: string, extra: Row = {}) => ({
  to,
  subject: 'Test subject',
  html: '<html><head></head><body><p>Hello</p></body></html>',
  text: 'Hello',
  template: 'quote-followup-1',
  journey: 'quote',
  eventId: `evt_${++eventSeq}`,
  leadId: extra.leadId,
  ...extra,
})

const ok = async () => ({ data: { id: 'prov_1' }, error: null })

// ════════════════════════════════════════════════════════════════════════
//  1. Classification
// ════════════════════════════════════════════════════════════════════════

test('classification: the existing reply is transactional, the lifecycle families promotional; refusals are terminal except a read failure', async () => {
  const g = await guard()
  const { classifyTemplate, classifyBlock } = g
  const { INELIGIBLE_REASONS } = await import('../consent/marketing-eligibility')
  assert.equal(classifyTemplate('quote-request-received'), 'transactional')
  for (const t of ['quote-followup-1', 'lead-nurture-1', 'lead-nurture-2', 'lead-nurture-final', 'abandoned-checkout']) assert.equal(classifyTemplate(t), 'promotional', t)
  // The lead-nurture footer no longer claims an opt-in, so the send gate has no
  // "template claims an opt-in" list or refusal any more.
  assert.equal((g as Row).TEMPLATES_CLAIMING_OPT_IN, undefined, 'the opt-in-claim list is removed')
  assert.ok(!readFileSync(resolve(__dirname, '../email-guard.ts'), 'utf8').includes('template_claims_opt_in'), 'the opt-in-claim refusal is removed')
  // A support message is a normal notice for campaigns: no 'support_request' refusal.
  assert.ok(!(INELIGIBLE_REASONS as readonly string[]).includes('support_request'))
  for (const r of ['suppressed', 'opted_out', 'declined', 'test_identity', 'no_marketing_basis', 'notice_expired', 'notice_basis_disabled', 'basis_email_mismatch', 'invalid_email']) {
    assert.equal(classifyBlock(r), 'terminal', r)
  }
  assert.equal(classifyBlock('eligibility_read_failed'), 'retryable')
  // Today's legacy classifications are unchanged.
  assert.equal(classifyBlock('no_marketing_consent'), 'retryable')
  assert.equal(classifyBlock('marketing_opted_out'), 'terminal')
})

test('derivedEligibilityRequest: campaigns are campaign, post-job is post_move, only the three named scenario journeys get a sequence kind', async () => {
  const { derivedEligibilityRequest } = await guard()
  assert.deepEqual(derivedEligibilityRequest({ journey: 'campaign', leadId: 'l' }), { context: 'campaign', subject: { type: 'lead', id: 'l' } })
  assert.deepEqual(derivedEligibilityRequest({ journey: 'post-job', bookingId: 'b' }), { context: 'post_move', subject: { type: 'booking', id: 'b' } })
  assert.deepEqual(derivedEligibilityRequest({ journey: 'abandoned', bookingId: 'b' }), {
    context: 'scenario_flow',
    subject: { type: 'booking', id: 'b', sequenceKind: 'abandoned_checkout' },
  })
  assert.deepEqual(derivedEligibilityRequest({ journey: 'quote', leadId: 'l' }), {
    context: 'scenario_flow',
    subject: { type: 'lead', id: 'l', sequenceKind: 'quote_followup' },
  })
  //  The general follow-up is a scenario sequence now (every genuine form
  //  submission enters an existing sequence).
  assert.deepEqual(derivedEligibilityRequest({ journey: 'lead-nurture', leadId: 'l' }), {
    context: 'scenario_flow',
    subject: { type: 'lead', id: 'l', sequenceKind: 'lead_nurture' },
  })
  // Anything unrecognised is express-only automation, never a scenario.
  for (const journey of ['automation:abc', 'admin-test', 'lead_nurture', 'nurture', undefined]) {
    assert.equal(derivedEligibilityRequest({ journey, leadId: 'l' }).context, 'automation', String(journey))
  }
  // A scenario journey with no subject cannot use a notice.
  for (const journey of ['quote', 'abandoned', 'lead-nurture']) {
    assert.deepEqual(derivedEligibilityRequest({ journey }), { context: 'automation', subject: { type: 'none' } }, journey)
  }
  // The removed popup offer is no scenario journey any more.
  assert.equal(derivedEligibilityRequest({ journey: 'offer', leadId: 'l' }).context, 'automation')
})

// ════════════════════════════════════════════════════════════════════════
//  2. guardedSend — promotional sends REQUIRE an eligible basis
// ════════════════════════════════════════════════════════════════════════

test('guard: an opted-in person is sent to; basis recorded; one-click headers; the rendered email is sent UNCHANGED', async (t) => {
  const { guardedSend, resend } = await guard()
  const send = t.mock.method(resend.emails, 'send', ok)
  const input = promo(OPTED_IN, { leadId: 'lead_opted' })
  const out = await guardedSend(input)
  assert.equal(out.sent, true, JSON.stringify(out))
  assert.equal(send.mock.callCount(), 1)
  const args = send.mock.calls[0].arguments[0] as Row
  assert.match(args.headers['List-Unsubscribe'], /^<https:\/\/app\.moveitclearit\.test\/api\/email\/unsubscribe\?token=/)
  assert.equal(args.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click')
  // Owner direction 2026-09-16: existing email copy is not rewritten — the
  // guard inserts no line into the template's html or text.
  assert.equal(args.html, input.html)
  assert.equal(args.text, input.text)
  assert.ok(!args.html.includes('Offer from Move It Clear It'))
  const row = fake.tables.sends[0]
  assert.equal(row.marketingBasis, 'express')
  assert.equal(row.basisEventId, null)
})

// ── The lead-nurture sequence on a form notice ──────────────────────────
//  Owner direction 2026-09-16: every genuine form submission enters an
//  EXISTING sequence, and the lead-nurture footer was corrected so it no longer
//  claims an opt-in. The guard therefore sends lead-nurture on a notice basis —
//  as rendered, with the one-click headers — and every prohibition still wins.

const LEAD_NURTURE_STAGES = [
  { template: 'lead-nurture-1', stage: 1 },
  { template: 'lead-nurture-2', stage: 2 },
  { template: 'lead-nurture-final', stage: 3 },
] as const
const QUOTE_URL = 'https://www.moveitclearit.com/quote.html'

const NOTICE_VERSION_FOR: Record<NoticeSurface, string> = {
  quote: 'quote-2026-09-16-r2',
  booking: 'booking-2026-09-16-r2',
  contact: 'contact-2026-09-16-r2',
  contact_support: 'contact-2026-09-16-r2',
  tracker: 'tracker-2026-09-16-r2',
  popup: 'popup-2026-09-16-r2',
}

/** Record a valid notice_accepted event and point the lead's stored basis at it. */
async function seedLeadNotice(o: { id: string; email: string; leadId: string; surface: NoticeSurface; locale?: 'en' | 'es' }) {
  const { NOTICE_VERSIONS, NOTICE_POLICY_START } = await import('../consent/notice-registry')
  const locale = o.locale ?? 'en'
  const version = NOTICE_VERSION_FOR[o.surface]
  const at = new Date(Math.max(Date.now() - 60_000, NOTICE_POLICY_START.getTime()))
  fake.tables.events.push({
    id: o.id, emailNormalized: o.email, kind: 'notice_accepted', surface: o.surface, occurredAt: at, regionSignal: 'nanp',
    noticeVersion: version, noticeCopySha256: NOTICE_VERSIONS[version].copySha256[locale], locale, requestId: `r_${o.id}`,
  })
  const lead = fake.tables.leads.find((l: Row) => l.id === o.leadId)
  if (lead) lead.basisEventId = o.id
  else fake.tables.leads.push({ id: o.leadId, email: o.email, emailMarketingConsent: null, marketingConsentAt: null, basisEventId: o.id })
  return at
}

/** The existing lead-nurture template, rendered the way the worker renders it (full compliance context). */
async function renderLeadNurture(to: string, stage: number, locale: 'en' | 'es') {
  const Email = (await import('../../emails/lead-nurture')).default
  const { buildMarketingContext } = await import('../marketing-context')
  const ctx = buildMarketingContext(to, 'lead-nurture-1', locale)
  if (!ctx.ok) throw new Error(`marketing context missing: ${ctx.missing.join(',')}`)
  const props = { customerName: 'Sam', quoteUrl: QUOTE_URL, unsubscribeUrl: ctx.context.unsubscribeUrl, postalAddress: ctx.context.postalAddress, locale, stage }
  return {
    html: render(React.createElement(Email, props)),
    text: render(React.createElement(Email, props), { plainText: true }),
  }
}

test('guard: lead-nurture is SENT on a notice basis — rendered html/text unchanged, one-click headers, basis "notice" recorded', async (t) => {
  process.env.EMAIL_NOTICE_BASIS_ENABLED = 'true'
  const { guardedSend, resend } = await guard()
  const send = t.mock.method(resend.emails, 'send', ok)
  //  A contact-form notice: lead_nurture is listed on every surface now. No
  //  caller decision — the guard derives scenario_flow / lead_nurture itself
  //  from the journey and the lead's stored basis.
  await seedLeadNotice({ id: 'evt_contact_notice', email: NO_BASIS, leadId: 'lead_none', surface: 'contact' })
  for (const { template, stage } of LEAD_NURTURE_STAGES) {
    const rendered = await renderLeadNurture(NO_BASIS, stage, 'en')
    const input = promo(NO_BASIS, { template, journey: 'lead-nurture', leadId: 'lead_none', subject: 'A few details for your estimate', ...rendered, payload: { quoteUrl: QUOTE_URL } })
    const before = send.mock.callCount()
    const out = await guardedSend(input)
    assert.equal(out.sent, true, `${template}: ${JSON.stringify(out)}`)
    assert.equal(send.mock.callCount(), before + 1, template)
    const args = send.mock.calls[before].arguments[0] as Row
    assert.equal(args.to, NO_BASIS)
    assert.match(args.headers['List-Unsubscribe'], /^<https:\/\/app\.moveitclearit\.test\/api\/email\/unsubscribe\?token=/, template)
    assert.equal(args.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click', template)
    //  Sent exactly as rendered: the guard inserts nothing.
    assert.equal(args.html, input.html, template)
    assert.equal(args.text, input.text, template)
    assert.ok(!/opted in/i.test(args.html) && !/opted in/i.test(args.text), `${template}: no opt-in claim reaches the provider`)
    const row = fake.tables.sends.find((r: Row) => r.template === template)
    assert.equal(row.status, 'delivered', template)
    assert.equal(row.marketingBasis, 'notice', template)
    assert.equal(row.basisEventId, 'evt_contact_notice', template)
  }
  assert.equal(send.mock.callCount(), LEAD_NURTURE_STAGES.length)

  //  A caller's own notice decision is honoured the same way.
  const caller = await guardedSend(
    promo(NO_BASIS, { template: 'lead-nurture-1', journey: 'lead-nurture', leadId: 'lead_none', eligibility: { eligible: true, basis: 'notice', basisEventId: 'evt_contact_notice' }, payload: { quoteUrl: QUOTE_URL } })
  )
  assert.equal(caller.sent, true, JSON.stringify(caller))
  //  The same template to an EXPRESS opt-in is sent as today.
  const expressInput = promo(OPTED_IN, { template: 'lead-nurture-1', journey: 'lead-nurture', leadId: 'lead_opted', payload: { quoteUrl: QUOTE_URL } })
  const expressOut = await guardedSend(expressInput)
  assert.equal(expressOut.sent, true, JSON.stringify(expressOut))
  assert.equal(fake.tables.sends.find((r: Row) => r.email === OPTED_IN).marketingBasis, 'express')
  assert.equal(send.mock.callCount(), LEAD_NURTURE_STAGES.length + 2)
  //  Duplicate prevention is unchanged: the same logical send is never sent twice.
  const again = await guardedSend(expressInput)
  assert.equal(again.sent, false, JSON.stringify(again))
  assert.equal(send.mock.callCount(), LEAD_NURTURE_STAGES.length + 2, 'a repeat of the same send never reaches the provider')
})

test('guard: lead-nurture on a notice is still REFUSED for every suppression reason and for an opted-out person — provider never called', async (t) => {
  process.env.EMAIL_NOTICE_BASIS_ENABLED = 'true'
  const { guardedSend, resend } = await guard()
  const send = t.mock.method(resend.emails, 'send', ok)
  await seedLeadNotice({ id: 'evt_supp_notice', email: SUPPRESSED, leadId: 'lead_supp_notice', surface: 'popup' })
  for (const reason of SUPPRESSION_REASONS) {
    fake.tables.suppressions.length = 0
    fake.tables.suppressions.push({ email: SUPPRESSED, reason, scope: scopeOf(reason) })
    for (const { template, stage } of LEAD_NURTURE_STAGES) {
      const rendered = await renderLeadNurture(SUPPRESSED, stage, 'en')
      //  Derived from the stored notice, and with a caller decision that claims eligibility.
      for (const eligibility of [undefined, { eligible: true as const, basis: 'notice' as const, basisEventId: 'evt_supp_notice' }]) {
        const out = await guardedSend(
          promo(SUPPRESSED, { template, journey: 'lead-nurture', leadId: 'lead_supp_notice', ...rendered, payload: { quoteUrl: QUOTE_URL }, ...(eligibility ? { eligibility } : {}) })
        )
        const label = `${reason} ${template} ${eligibility ? 'caller decision' : 'derived'}`
        assert.equal(out.sent, false, label)
        assert.equal((out as Row).reason, reason.toLowerCase(), label)
        assert.equal((out as Row).outcomeClass, 'terminal', label)
      }
    }
  }
  assert.equal(send.mock.callCount(), 0, 'no suppressed address is ever sent lead-nurture')

  //  An opted-out person (a token unsubscribe on the consent record) who then
  //  submits a form: the new notice never lifts the opt-out.
  await seedLeadNotice({ id: 'evt_w_notice', email: WITHDRAWN, leadId: 'lead_w_notice', surface: 'contact' })
  //  …and a Customer row marked marketingOptOut, with an otherwise valid notice.
  await seedLeadNotice({ id: 'evt_oo_notice', email: NO_BASIS, leadId: 'lead_none', surface: 'quote' })
  fake.tables.customers.push({ id: 'cus_oo', email: NO_BASIS, emailMarketingConsent: null, marketingConsentAt: null, marketingOptOut: true })
  for (const [to, leadId] of [[WITHDRAWN, 'lead_w_notice'], [NO_BASIS, 'lead_none']] as const) {
    for (const { template, stage } of LEAD_NURTURE_STAGES) {
      const rendered = await renderLeadNurture(to, stage, 'en')
      const out = await guardedSend(promo(to, { template, journey: 'lead-nurture', leadId, ...rendered, payload: { quoteUrl: QUOTE_URL } }))
      assert.equal(out.sent, false, `${to} ${template}`)
      assert.equal((out as Row).reason, 'opted_out', `${to} ${template}`)
      assert.equal((out as Row).outcomeClass, 'terminal', `${to} ${template}`)
    }
  }
  assert.equal(send.mock.callCount(), 0)
  assert.ok(!fake.tables.sends.some((r: Row) => r.status === 'delivered'), 'nothing recorded as delivered')
})

test('guard: no basis on any record → refused no_marketing_basis, terminal, provider never called', async (t) => {
  const { guardedSend, resend } = await guard()
  const send = t.mock.method(resend.emails, 'send', ok)
  const out = await guardedSend(promo(NO_BASIS, { leadId: 'lead_none' }))
  assert.equal(out.sent, false)
  assert.equal((out as Row).reason, 'no_marketing_basis')
  assert.equal((out as Row).outcomeClass, 'terminal')
  assert.equal(send.mock.callCount(), 0)
  assert.equal(fake.tables.sends[0].status, 'blocked_terminal')
})

test('guard: a withdrawal on the consent record beats an old consent column', async (t) => {
  const { guardedSend, resend } = await guard()
  const send = t.mock.method(resend.emails, 'send', ok)
  const out = await guardedSend(promo(WITHDRAWN, { template: 'review-request', journey: 'post-job', bookingId: undefined }))
  assert.equal((out as Row).reason, 'opted_out')
  assert.equal(send.mock.callCount(), 0)
})

test('guard: a later UNTICKED box on another row does not revoke an older opt-in (today\'s consent.ts rule)', async (t) => {
  //  The repeat customer: opted in once, later left a form's box unticked. No
  //  production path writes a withdrawal as a `false` column (withdrawals are
  //  suppressions, marketingOptOut and consent events), so a legacy false is an
  //  unticked box — "not an unsubscribe, so it does not revoke consent".
  const { guardedSend, resend } = await guard()
  const send = t.mock.method(resend.emails, 'send', ok)
  const out = await guardedSend(promo(DECLINED_LATER, { journey: 'campaign', leadId: 'lead_dl' }))
  assert.equal(out.sent, true, JSON.stringify(out))
  assert.equal(send.mock.callCount(), 1)
})

test('guard: a test identity outside the canary list is refused before anything else', async (t) => {
  const { guardedSend, resend } = await guard()
  const send = t.mock.method(resend.emails, 'send', ok)
  const out = await guardedSend(promo(NOT_LISTED, { leadId: 'lead_nl' }))
  assert.equal((out as Row).reason, 'test_identity')
  assert.equal(send.mock.callCount(), 0)
})

test('guard: suppressed addresses NEVER get promotional mail — every reason, every scope', async (t) => {
  const { guardedSend, resend } = await guard()
  const send = t.mock.method(resend.emails, 'send', ok)
  for (const reason of SUPPRESSION_REASONS) {
    fake.tables.suppressions.length = 0
    fake.tables.suppressions.push({ email: SUPPRESSED, reason, scope: scopeOf(reason) })
    for (const extra of [{ journey: 'campaign', leadId: 'lead_supp' }, { journey: 'quote', leadId: 'lead_supp' }, { journey: 'automation:x' }]) {
      const out = await guardedSend(promo(SUPPRESSED, extra))
      assert.equal(out.sent, false, `${reason} ${extra.journey}`)
    }
    // Even with a caller that claims the person is eligible.
    const forced = await guardedSend(promo(SUPPRESSED, { eligibility: { eligible: true, basis: 'express', basisEventId: null } }))
    assert.equal(forced.sent, false, `${reason} with a forged decision`)
  }
  assert.equal(send.mock.callCount(), 0)
})

test('guard: the caller decision is honoured and its basis recorded (a notice, with its event id)', async (t) => {
  const { guardedSend, resend } = await guard()
  const send = t.mock.method(resend.emails, 'send', ok)
  const out = await guardedSend(promo(NO_BASIS, { leadId: 'lead_none', eligibility: { eligible: true, basis: 'notice', basisEventId: 'evt_notice_1' } }))
  assert.equal(out.sent, true)
  assert.equal(send.mock.callCount(), 1)
  assert.equal(fake.tables.sends[0].marketingBasis, 'notice')
  assert.equal(fake.tables.sends[0].basisEventId, 'evt_notice_1')

  const refused = await guardedSend(promo(OPTED_IN, { leadId: 'lead_opted', eligibility: { eligible: false, reason: 'basis_email_mismatch', terminal: true } }))
  assert.equal((refused as Row).reason, 'basis_email_mismatch')
  assert.equal(send.mock.callCount(), 1)
})

test('guard: an internal rehearsal permission only works on a test send, and records no basis', async (t) => {
  const { guardedSend, resend } = await guard()
  const send = t.mock.method(resend.emails, 'send', ok)
  const rehearsal = { eligible: true as const, basis: 'internal_rehearsal' as const, basisEventId: null }
  const live = await guardedSend(promo(NO_BASIS, { eligibility: rehearsal }))
  assert.equal((live as Row).reason, 'no_marketing_basis')
  assert.equal(send.mock.callCount(), 0)
  const test1 = await guardedSend(promo(NO_BASIS, { eligibility: rehearsal, isTest: true, journey: 'admin-test' }))
  assert.equal(test1.sent, true)
  assert.equal(fake.tables.sends.find((r: Row) => r.isTest).marketingBasis, null)
})

test('guard: an eligibility READ failure is retryable and sends nothing', async (t) => {
  const { guardedSend, resend } = await guard()
  const send = t.mock.method(resend.emails, 'send', ok)
  fake.emailMarketingStatus.findUnique = async () => {
    throw new Error('simulated status outage')
  }
  const out = await guardedSend(promo(OPTED_IN, { leadId: 'lead_opted' }))
  assert.equal((out as Row).reason, 'eligibility_read_failed')
  assert.equal((out as Row).outcomeClass, 'retryable')
  assert.equal(send.mock.callCount(), 0)
})

test('guard: transactional quote-request-received needs no basis, records "transactional", and is sent exactly as rendered (no unsubscribe headers)', async (t) => {
  const { guardedSend, resend } = await guard()
  const send = t.mock.method(resend.emails, 'send', ok)
  // Even to a promotionally unsubscribed address: it answers their own request.
  fake.tables.suppressions.push({ email: NO_BASIS, reason: 'UNSUBSCRIBED', scope: 'promotional' })
  const input = { ...promo(NO_BASIS), template: 'quote-request-received', journey: 'lead-intake' }
  const out = await guardedSend(input)
  assert.equal(out.sent, true, JSON.stringify(out))
  const args = send.mock.calls[0].arguments[0] as Row
  assert.equal(args.headers, undefined, 'a transactional reply carries no marketing unsubscribe headers (as in production)')
  assert.equal(args.html, input.html)
  assert.equal(args.text, input.text)
  assert.equal(fake.tables.sends[0].marketingBasis, 'transactional')
})

test('guard: other transactional mail carries no one-click header and is sent as rendered', async (t) => {
  const { guardedSend, resend } = await guard()
  const send = t.mock.method(resend.emails, 'send', ok)
  const input = { ...promo(NO_BASIS), template: 'information-required', journey: 'booking' }
  await guardedSend(input)
  const args = send.mock.calls[0].arguments[0] as Row
  assert.equal(args.headers, undefined)
  assert.equal(args.html, input.html)
})

// ════════════════════════════════════════════════════════════════════════
//  3. A notice serves its scenario and relevant campaigns — nothing else
// ════════════════════════════════════════════════════════════════════════

test('a valid quote notice permits its surface\'s sequences (quote follow-up AND lead nurture) and relevant campaigns, and NOTHING else', async () => {
  process.env.EMAIL_NOTICE_BASIS_ENABLED = 'true'
  const { promotionalEligibility } = await import('../consent/marketing-eligibility')
  const { derivedEligibilityRequest } = await guard()
  const at = await seedLeadNotice({ id: 'evt_quote_notice', email: NO_BASIS, leadId: 'lead_none', surface: 'quote' })
  fake.tables.status.push({ emailNormalized: NO_BASIS, expressOptInAt: null, expressEventId: null, optedOutAt: null, declinedAt: null, lastNoticeAt: at, lastNoticeEventId: 'evt_quote_notice' })
  const deps = { testIdentity: async () => null }
  const notice = { eligible: true, basis: 'notice', basisEventId: 'evt_quote_notice' }

  const scenario = await promotionalEligibility({ ...derivedEligibilityRequest({ journey: 'quote', leadId: 'lead_none' }), email: NO_BASIS }, deps)
  assert.deepEqual(scenario, notice)
  //  A quote with no price enters the general follow-up on the same notice.
  const nurture = await promotionalEligibility({ ...derivedEligibilityRequest({ journey: 'lead-nurture', leadId: 'lead_none' }), email: NO_BASIS }, deps)
  assert.deepEqual(nurture, notice)

  //  Relevant offers: a campaign may use the person's latest form submission.
  const campaign = await promotionalEligibility({ ...derivedEligibilityRequest({ journey: 'campaign', leadId: 'lead_none' }), email: NO_BASIS }, deps)
  assert.deepEqual(campaign, notice)

  //  Nothing else: automations and post-move mail are express/EBR only, and a
  //  sequence the quote surface does not list is refused.
  for (const journey of ['automation:a1', 'post-job', 'admin-test']) {
    const d = await promotionalEligibility({ ...derivedEligibilityRequest({ journey, leadId: 'lead_none' }), email: NO_BASIS }, deps)
    assert.equal(d.eligible, false, `${journey} must not use a notice`)
  }
  const abandoned = await promotionalEligibility(
    { context: 'scenario_flow', subject: { type: 'lead', id: 'lead_none', sequenceKind: 'abandoned_checkout' }, email: NO_BASIS },
    deps
  )
  assert.equal(abandoned.eligible, false, 'a quote notice never starts abandoned-checkout mail')
  assert.equal((abandoned as Row).reason, 'no_marketing_basis')
  //  A scenario request that names no sequence cannot use a notice either.
  const unnamed = await promotionalEligibility({ context: 'scenario_flow', subject: { type: 'lead', id: 'lead_none' }, email: NO_BASIS }, deps)
  assert.equal(unnamed.eligible, false)
})

test('every form surface\'s notice permits lead nurture; quote follow-up and abandoned checkout only on their own surface', async () => {
  process.env.EMAIL_NOTICE_BASIS_ENABLED = 'true'
  const { NOTICE_SURFACES, SEQUENCE_KINDS, SURFACE_SEQUENCE_KINDS } = await import('../consent/notice-registry')
  const { promotionalEligibility } = await import('../consent/marketing-eligibility')
  const deps = { testIdentity: async () => null }
  assert.deepEqual([...SEQUENCE_KINDS].sort(), ['abandoned_checkout', 'lead_nurture', 'quote_followup'])
  //  Which sequence each surface's notice may serve — pinned in full.
  const expected: Record<SequenceKind, NoticeSurface[]> = {
    quote_followup: ['quote'],
    abandoned_checkout: ['booking'],
    lead_nurture: ['quote', 'booking', 'contact', 'contact_support', 'tracker', 'popup'],
  }
  for (const surface of NOTICE_SURFACES) {
    const id = `evt_${surface}`
    await seedLeadNotice({ id, email: NO_BASIS, leadId: 'lead_none', surface })
    for (const kind of SEQUENCE_KINDS) {
      const d = await promotionalEligibility({ context: 'scenario_flow', subject: { type: 'lead', id: 'lead_none', sequenceKind: kind }, email: NO_BASIS }, deps)
      const permitted = expected[kind].includes(surface)
      assert.equal(SURFACE_SEQUENCE_KINDS[surface].includes(kind), permitted, `registry: ${surface} → ${kind}`)
      if (permitted) assert.deepEqual(d, { eligible: true, basis: 'notice', basisEventId: id }, `${surface} → ${kind}`)
      else assert.equal((d as Row).reason, 'no_marketing_basis', `${surface} must not start ${kind}`)
    }
  }
  //  Flag off: no notice serves anything, lead nurture included.
  delete process.env.EMAIL_NOTICE_BASIS_ENABLED
  const off = await promotionalEligibility({ context: 'scenario_flow', subject: { type: 'lead', id: 'lead_none', sequenceKind: 'lead_nurture' }, email: NO_BASIS }, deps)
  assert.equal((off as Row).reason, 'notice_basis_disabled')
})

test('campaign audience decisions: per person, suppression and test identities excluded; a status pointing at no event is no basis', async () => {
  process.env.EMAIL_NOTICE_BASIS_ENABLED = 'true'
  const { campaignEligibilityDecisions } = await import('../email-audience')
  fake.tables.suppressions.push({ email: SUPPRESSED, reason: 'HARD_BOUNCE', scope: 'all' })
  // A status row whose latest notice event does not exist is no basis.
  fake.tables.status.push({ emailNormalized: NO_BASIS, expressOptInAt: null, expressEventId: null, optedOutAt: null, declinedAt: null, lastNoticeAt: new Date(), lastNoticeEventId: 'evt_x' })
  const decisions = await campaignEligibilityDecisions([OPTED_IN, NO_BASIS, WITHDRAWN, SUPPRESSED, DECLINED_LATER, STATUS_EXPRESS, NOT_LISTED])
  const reason = (e: string) => {
    const d = decisions.get(e) as Row
    return d.eligible ? `eligible:${d.basis}` : d.reason
  }
  assert.equal(reason(OPTED_IN), 'eligible:express')
  assert.equal(reason(STATUS_EXPRESS), 'eligible:express')
  assert.equal(reason(NO_BASIS), 'no_marketing_basis')
  assert.equal(reason(WITHDRAWN), 'opted_out')
  assert.equal(reason(SUPPRESSED), 'suppressed')
  assert.equal(reason(DECLINED_LATER), 'eligible:express', 'a later unticked box never revokes an opt-in (today\'s rule, unchanged)')
  assert.equal(reason(NOT_LISTED), 'test_identity')
})

test('campaign audience decisions: a valid latest form notice — a support message included — is a basis for offers; prohibitions still win', async () => {
  process.env.EMAIL_NOTICE_BASIS_ENABLED = 'true'
  const { NOTICE_VERSIONS, NOTICE_POLICY_START } = await import('../consent/notice-registry')
  const { campaignEligibilityDecisions } = await import('../email-audience')
  const at = new Date(Math.max(Date.now() - 60_000, NOTICE_POLICY_START.getTime()))
  const QUOTE_PERSON = 'quote-person@example.com'
  const SUPPORT_PERSON = 'support-person@example.com'
  const SUPPORT_UNSUBSCRIBED = 'support-unsubscribed@example.com'
  const SUPPORT_BOUNCED = 'support-bounced@example.com'
  const SUPPORT_DECLINED = 'support-declined@example.com'
  const SUPPORT_OPTED_OUT = 'support-opted-out@example.com'
  const SUPPORT_PEOPLE = [SUPPORT_UNSUBSCRIBED, SUPPORT_BOUNCED, SUPPORT_DECLINED, SUPPORT_OPTED_OUT]
  for (const e of [QUOTE_PERSON, SUPPORT_PERSON, ...SUPPORT_PEOPLE]) assertTestRecipient(e)
  const event = (id: string, email: string, surface: string, version: string) => ({
    id, emailNormalized: email, kind: 'notice_accepted', surface, occurredAt: at, regionSignal: 'nanp',
    noticeVersion: version, noticeCopySha256: NOTICE_VERSIONS[version].copySha256.en, locale: 'en', requestId: `r_${id}`,
  })
  const status = (email: string, id: string, over: Row = {}) => ({ emailNormalized: email, expressOptInAt: null, expressEventId: null, optedOutAt: null, declinedAt: null, lastNoticeAt: at, lastNoticeEventId: id, ...over })
  fake.tables.events.push(event('evt_q', QUOTE_PERSON, 'quote', 'quote-2026-09-16-r2'))
  fake.tables.events.push(event('evt_s', SUPPORT_PERSON, 'contact_support', 'contact-2026-09-16-r2'))
  fake.tables.events.push(event('evt_w', WITHDRAWN, 'quote', 'quote-2026-09-16-r2'))
  fake.tables.status.push(status(QUOTE_PERSON, 'evt_q'), status(SUPPORT_PERSON, 'evt_s'))
  //  Support messages from people who said no (or whose address is dead) earlier.
  SUPPORT_PEOPLE.forEach((email, i) => fake.tables.events.push(event(`evt_sp${i}`, email, 'contact_support', 'contact-2026-09-16-r2')))
  const before = new Date(at.getTime() - DAY)
  fake.tables.status.push(
    status(SUPPORT_UNSUBSCRIBED, 'evt_sp0'),
    status(SUPPORT_BOUNCED, 'evt_sp1'),
    status(SUPPORT_DECLINED, 'evt_sp2', { declinedAt: before }),
    status(SUPPORT_OPTED_OUT, 'evt_sp3', { optedOutAt: before }),
  )
  fake.tables.suppressions.push(
    { email: SUPPORT_UNSUBSCRIBED, reason: 'UNSUBSCRIBED', scope: 'promotional' },
    { email: SUPPORT_BOUNCED, reason: 'HARD_BOUNCE', scope: 'all' },
  )
  // WITHDRAWN already opted out; point their status at a newer notice too.
  const w = fake.tables.status.find((r: Row) => r.emailNormalized === WITHDRAWN)
  Object.assign(w, { lastNoticeAt: at, lastNoticeEventId: 'evt_w' })
  process.env.EMAIL_PROMOTIONAL_ALLOWLIST = [...CANARY, QUOTE_PERSON, SUPPORT_PERSON, ...SUPPORT_PEOPLE].join(',')
  const decisions = await campaignEligibilityDecisions([QUOTE_PERSON, SUPPORT_PERSON, WITHDRAWN, ...SUPPORT_PEOPLE])
  const reason = (e: string) => {
    const d = decisions.get(e) as Row
    return d.eligible ? `eligible:${d.basis}:${d.basisEventId}` : d.reason
  }
  assert.equal(reason(QUOTE_PERSON), 'eligible:notice:evt_q')
  assert.equal(reason(SUPPORT_PERSON), 'eligible:notice:evt_s', 'a support message is a notice like any other form submission')
  assert.equal(reason(WITHDRAWN), 'opted_out', 'a form submission never lifts an opt-out')
  assert.equal(reason(SUPPORT_UNSUBSCRIBED), 'suppressed', 'a support message never re-subscribes an unsubscribed address')
  assert.equal(reason(SUPPORT_BOUNCED), 'suppressed', 'a hard bounce still wins')
  assert.equal(reason(SUPPORT_DECLINED), 'declined', 'an earlier decline still wins')
  assert.equal(reason(SUPPORT_OPTED_OUT), 'opted_out', 'an earlier opt-out still wins')
  delete process.env.EMAIL_NOTICE_BASIS_ENABLED
  const off = await campaignEligibilityDecisions([QUOTE_PERSON, SUPPORT_PERSON])
  assert.equal((off.get(QUOTE_PERSON) as Row).reason, 'notice_basis_disabled')
  assert.equal((off.get(SUPPORT_PERSON) as Row).reason, 'notice_basis_disabled')
})

test('campaign audience decisions: every suppression reason excludes', async () => {
  const { campaignEligibilityDecisions } = await import('../email-audience')
  for (const r of SUPPRESSION_REASONS) {
    fake.tables.suppressions.length = 0
    fake.tables.suppressions.push({ email: OPTED_IN, reason: r, scope: scopeOf(r) })
    const d = (await campaignEligibilityDecisions([OPTED_IN])).get(OPTED_IN) as Row
    assert.equal(d.reason, 'suppressed', r)
  }
})

test('campaign audience decisions: a staff lookup failure THROWS (the dispatch refuses and retries; nobody is marked skipped)', async () => {
  const { campaignEligibilityDecisions } = await import('../email-audience')
  process.env.EMAIL_PROMOTIONAL_ALLOWLIST = ''
  fake.user.findMany = async () => {
    throw new Error('simulated user table outage')
  }
  //  Swallowed, the failure used to become a terminal per-person verdict, so a
  //  campaign dispatched during a pool timeout skipped its whole audience.
  await assert.rejects(() => campaignEligibilityDecisions([OPTED_IN]), /simulated user table outage/)
})

test('the audience applies the shared decision on BOTH preview and dispatch, after the SQL prefilter', () => {
  const s = readFileSync(resolve(__dirname, '../email-audience.ts'), 'utf8')
  assert.equal((s.match(/campaignEligibilityDecisions\(emails\)/g) ?? []).length, 2)
  const preview = s.slice(s.indexOf('export async function previewAudience'), s.indexOf('export async function resolveAudienceDetailed'))
  assert.ok(preview.indexOf('!consenting.has(c.email)') < preview.indexOf('base.excluded.ineligible'), 'preview: prefilter, then the decision')
  const dispatch = s.slice(s.indexOf('export async function resolveAudienceDetailed'))
  assert.ok(dispatch.indexOf("reason: 'no_consent'") < dispatch.indexOf('ineligible:'), 'dispatch: prefilter, then the decision')
  assert.match(s, /context: 'campaign'/)
})

// ════════════════════════════════════════════════════════════════════════
//  4. Booking-scoped rechecks
// ════════════════════════════════════════════════════════════════════════

function seedBooking(over: Row = {}) {
  const t = fake.tables
  const customer = t.customers.find((c: Row) => c.id === (over.customerId ?? 'cus_opted'))
  const row: Row = {
    id: 'bk_1', displayId: 'MIC-1', status: 'COMPLETED', isInternalTest: false, depositPaid: true, completedAt: new Date(Date.now() - DAY),
    requestedDate: new Date(Date.now() + 10 * DAY), confirmedDate: null, scheduledStart: null, customerId: 'cus_opted', basisEventId: null,
    createdAt: new Date(Date.now() - 20 * DAY),
    ...over,
  }
  row.customer = customer
  t.bookings.push(row)
  return row
}

const noTestIdentity = { testIdentity: async () => null }

test('bookingEligibility: post-move follow-up for an opted-in customer passes; the person-level prohibitions refuse', async () => {
  const { bookingEligibility } = await import('../email-eligibility')
  seedBooking()
  assert.equal(await bookingEligibility('review-request', 'bk_1', { deps: { db: fake as never, ...noTestIdentity } }), null)

  seedBooking({ id: 'bk_w', customerId: 'cus_withdrawn' })
  assert.equal(await bookingEligibility('review-request', 'bk_w', { deps: { db: fake as never, ...noTestIdentity } }), 'opted_out')

  seedBooking({ id: 'bk_s', customerId: 'cus_supp' })
  for (const r of SUPPRESSION_REASONS) {
    fake.tables.suppressions.length = 0
    fake.tables.suppressions.push({ email: SUPPRESSED, reason: r, scope: scopeOf(r) })
    assert.equal(await bookingEligibility('review-request', 'bk_s', { deps: { db: fake as never, ...noTestIdentity } }), 'suppressed', r)
  }
})

test('bookingEligibility: without the deps override the test identity is refused (reserved domain)', async () => {
  const { bookingEligibility } = await import('../email-eligibility')
  process.env.EMAIL_PROMOTIONAL_ALLOWLIST = ''
  seedBooking()
  assert.equal(await bookingEligibility('review-request', 'bk_1', { deps: { db: fake as never } }), 'test_identity')
})

test('bookingEligibility: a never-asked customer keeps today\'s retryable reason; transactional templates ignore consent', async () => {
  const { bookingEligibility } = await import('../email-eligibility')
  seedBooking({ id: 'bk_n', customerId: 'cus_status' })
  // cus_status has a CONFIRMED express opt-in on the consent record: permitted.
  assert.equal(await bookingEligibility('review-request', 'bk_n', { deps: { db: fake as never, ...noTestIdentity } }), null)
  fake.tables.status.length = 0
  assert.equal(await bookingEligibility('review-request', 'bk_n', { deps: { db: fake as never, ...noTestIdentity } }), 'no_marketing_consent')
  assert.equal(await bookingEligibility('job-completion', 'bk_n', { deps: { db: fake as never, ...noTestIdentity } }), null)
})

test('bookingEligibility: abandoned checkout may use its booking notice only when the flag is on', async () => {
  const { bookingEligibility } = await import('../email-eligibility')
  const { NOTICE_VERSIONS, NOTICE_POLICY_START } = await import('../consent/notice-registry')
  fake.tables.customers.push({ id: 'cus_notice', email: NO_BASIS, emailMarketingConsent: null, marketingConsentAt: null, marketingOptOut: false })
  fake.tables.events.push({
    id: 'evt_bk_notice', emailNormalized: NO_BASIS, kind: 'notice_accepted', surface: 'booking',
    occurredAt: new Date(Math.max(Date.now() - 60_000, NOTICE_POLICY_START.getTime())), regionSignal: 'nanp',
    noticeVersion: 'booking-2026-09-16-r2', noticeCopySha256: NOTICE_VERSIONS['booking-2026-09-16-r2'].copySha256.en, locale: 'en', requestId: 'r_b',
  })
  seedBooking({ id: 'bk_ab', customerId: 'cus_notice', status: 'PENDING_PAYMENT', depositPaid: false, completedAt: null, basisEventId: 'evt_bk_notice' })
  const deps = { db: fake as never, ...noTestIdentity }
  assert.equal(await bookingEligibility('abandoned-checkout', 'bk_ab', { deps }), 'no_marketing_consent', 'flag off: today\'s answer')
  process.env.EMAIL_NOTICE_BASIS_ENABLED = 'true'
  assert.equal(await bookingEligibility('abandoned-checkout', 'bk_ab', { deps }), null)
  // The same notice never serves a post-move follow-up or a campaign recheck.
  assert.equal(await bookingEligibility('abandoned-checkout', 'bk_ab', { deps, context: 'campaign' }), 'no_marketing_consent')
  assert.equal(await bookingMarketingBlock('bk_ab', deps), 'no_marketing_consent', 'the default schedule-time context is express only')
})

async function bookingMarketingBlock(id: string, deps: Row, context?: string) {
  const { bookingMarketingBlockReason } = await import('../email-eligibility')
  return bookingMarketingBlockReason(id, { deps: deps as never, ...(context ? { context: context as never } : {}) })
}

test('bookingEligibility: a read failure fails closed', async () => {
  const { bookingEligibility } = await import('../email-eligibility')
  seedBooking()
  fake.emailMarketingStatus.findUnique = async () => {
    throw new Error('simulated outage')
  }
  assert.equal(await bookingEligibility('review-request', 'bk_1', { deps: { db: fake as never, ...noTestIdentity } }), 'eligibility_read_failed')
})

test('combinePromotional: prohibitions are reported over a legacy reason; permission lifts only the legacy column requirement', async () => {
  const { combinePromotional } = await import('../email-eligibility')
  const no = (reason: string) => ({ eligible: false as const, reason: reason as never, terminal: true })
  assert.equal(combinePromotional('no_marketing_consent', no('opted_out')), 'opted_out')
  assert.equal(combinePromotional('no_marketing_consent', no('no_marketing_basis')), 'no_marketing_consent')
  assert.equal(combinePromotional(null, no('no_marketing_basis')), 'no_marketing_basis')
  assert.equal(combinePromotional('no_marketing_consent', { eligible: true, basis: 'express', basisEventId: 'e' }), null)
})

// ── A LATER booking supersedes an abandoned checkout ────────────────────
//  "Finish your booking" must never reach someone who re-did the form and
//  paid (or moved past checkout) on a NEW booking. The recovery sequence
//  belongs to the first booking, so the later booking's payment never touches
//  it: the recheck asks supersededByLaterBooking() instead.

const ABANDONED_TEMPLATES = ['abandoned-checkout', 'abandoned-checkout-2', 'abandoned-checkout-3'] as const
/** Booking statuses that are past checkout on their own, with no captured deposit. */
const PAST_CHECKOUT_STATUSES = ['PENDING_APPROVAL', 'CONFIRMED', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'ARCHIVED'] as const

/** A customer whose only basis is a valid booking-form notice (flag on). */
async function seedNoticeCustomer() {
  const { NOTICE_VERSIONS, NOTICE_POLICY_START } = await import('../consent/notice-registry')
  process.env.EMAIL_NOTICE_BASIS_ENABLED = 'true'
  fake.tables.customers.push({ id: 'cus_notice', email: NO_BASIS, emailMarketingConsent: null, marketingConsentAt: null, marketingOptOut: false })
  fake.tables.events.push({
    id: 'evt_bk_notice_sup', emailNormalized: NO_BASIS, kind: 'notice_accepted', surface: 'booking',
    occurredAt: new Date(Math.max(Date.now() - 60_000, NOTICE_POLICY_START.getTime())), regionSignal: 'nanp',
    noticeVersion: 'booking-2026-09-16-r2', noticeCopySha256: NOTICE_VERSIONS['booking-2026-09-16-r2'].copySha256.en, locale: 'en', requestId: 'r_b_sup',
  })
  return 'evt_bk_notice_sup'
}

/** The unpaid checkout B1: PENDING_PAYMENT, no deposit, created two days ago. */
function seedUnpaidCheckout(customerId: string, basisEventId: string | null = null) {
  return seedBooking({
    id: 'bk_b1', displayId: 'MIC-B1', customerId, status: 'PENDING_PAYMENT', depositPaid: false, completedAt: null, basisEventId,
    createdAt: new Date(Date.now() - 2 * DAY),
  })
}

function removeBooking(id: string) {
  const i = fake.tables.bookings.findIndex((b: Row) => b.id === id)
  if (i >= 0) fake.tables.bookings.splice(i, 1)
}

test('bookingEligibility: an unpaid checkout is eligible for abandoned-checkout until the SAME customer\'s LATER booking is paid or past checkout → booking_superseded (express and notice bases)', async () => {
  const { bookingEligibility, supersededByLaterBooking } = await import('../email-eligibility')
  for (const basis of ['express', 'notice'] as const) {
    fake = buildFake()
    seedPeople()
    const customerId = basis === 'express' ? 'cus_opted' : 'cus_notice'
    const basisEventId = basis === 'notice' ? await seedNoticeCustomer() : null
    const b1 = seedUnpaidCheckout(customerId, basisEventId)
    const deps = { db: fake as never, ...noTestIdentity }

    for (const template of ABANDONED_TEMPLATES) {
      assert.equal(await bookingEligibility(template, 'bk_b1', { deps }), null, `${basis}: ${template} is eligible before any later booking`)
    }
    assert.equal(await supersededByLaterBooking(fake as never, 'bk_b1'), false, `${basis}: nothing later yet`)

    const superseding = [
      { label: 'deposit paid, status not yet moved', status: 'PENDING_PAYMENT', depositPaid: true },
      ...PAST_CHECKOUT_STATUSES.map((status) => ({ label: `${status} (status alone, no captured deposit)`, status, depositPaid: false })),
    ]
    for (const later of superseding) {
      const label = `${basis}: later ${later.label}`
      seedBooking({
        id: 'bk_later', displayId: 'MIC-LATER', customerId, status: later.status, depositPaid: later.depositPaid, completedAt: null,
        createdAt: new Date(b1.createdAt.getTime() + DAY),
      })
      assert.equal(await supersededByLaterBooking(fake as never, 'bk_b1'), true, label)
      for (const template of ABANDONED_TEMPLATES) {
        assert.equal(await bookingEligibility(template, 'bk_b1', { deps }), 'booking_superseded', `${label} → ${template}`)
      }
      //  The later booking itself is not superseded by anything.
      assert.equal(await supersededByLaterBooking(fake as never, 'bk_later'), false, `${label}: nothing after the later booking`)
      removeBooking('bk_later')
      assert.equal(await bookingEligibility('abandoned-checkout', 'bk_b1', { deps }), null, `${label}: removed again → eligible again`)
    }
    delete process.env.EMAIL_NOTICE_BASIS_ENABLED
  }
})

test('supersededByLaterBooking: a later UNPAID (PENDING_PAYMENT / DRAFT), CANCELLED or internal-test booking, an EARLIER paid one, or another customer\'s paid booking never supersedes', async () => {
  const { bookingEligibility, supersededByLaterBooking } = await import('../email-eligibility')
  const b1 = seedUnpaidCheckout('cus_opted')
  const deps = { db: fake as never, ...noTestIdentity }
  const after = new Date(b1.createdAt.getTime() + DAY)
  const cases: Array<{ label: string; over: Row }> = [
    { label: 'later PENDING_PAYMENT, unpaid (the form re-done, abandoned again)', over: { status: 'PENDING_PAYMENT', depositPaid: false, createdAt: after } },
    { label: 'later DRAFT, unpaid', over: { status: 'DRAFT', depositPaid: false, createdAt: after } },
    { label: 'later CANCELLED, unpaid (a declined booking)', over: { status: 'CANCELLED', depositPaid: false, createdAt: after } },
    { label: 'later internal test booking, paid and CONFIRMED', over: { status: 'CONFIRMED', depositPaid: true, isInternalTest: true, createdAt: after } },
    { label: 'EARLIER booking, paid and COMPLETED', over: { status: 'COMPLETED', depositPaid: true, createdAt: new Date(b1.createdAt.getTime() - 10 * DAY) } },
    { label: 'another customer\'s later booking, paid and CONFIRMED', over: { customerId: 'cus_status', status: 'CONFIRMED', depositPaid: true, createdAt: after } },
  ]
  for (const { label, over } of cases) {
    seedBooking({ id: 'bk_other', displayId: 'MIC-OTHER', completedAt: null, ...over })
    assert.equal(await supersededByLaterBooking(fake as never, 'bk_b1'), false, label)
    for (const template of ABANDONED_TEMPLATES) {
      assert.equal(await bookingEligibility(template, 'bk_b1', { deps }), null, `${label} → ${template}`)
    }
    removeBooking('bk_other')
  }
  //  All of them at once still supersede nothing.
  cases.forEach(({ over }, i) => seedBooking({ id: `bk_other_${i}`, displayId: `MIC-O${i}`, completedAt: null, ...over }))
  assert.equal(await supersededByLaterBooking(fake as never, 'bk_b1'), false, 'no combination of non-superseding bookings supersedes')
  assert.equal(await bookingEligibility('abandoned-checkout', 'bk_b1', { deps }), null)
  //  A booking that does not exist has nothing to be superseded.
  assert.equal(await supersededByLaterBooking(fake as never, 'bk_missing'), false)
})

test('booking_superseded: only abandoned-checkout templates ask; prohibitions and booking state are reported first; a read failure fails closed', async () => {
  const { bookingEligibility, supersededByLaterBooking } = await import('../email-eligibility')
  const deps = { db: fake as never, ...noTestIdentity }
  //  A COMPLETED job with a LATER paid booking by the same customer: post-move
  //  and transactional mail about the first job are unaffected.
  seedBooking({ id: 'bk_done', createdAt: new Date(Date.now() - 20 * DAY) })
  seedBooking({ id: 'bk_next', displayId: 'MIC-NEXT', status: 'CONFIRMED', depositPaid: true, completedAt: null, createdAt: new Date(Date.now() - DAY) })
  assert.equal(await supersededByLaterBooking(fake as never, 'bk_done'), true, 'the helper itself sees the later booking')
  assert.equal(await bookingEligibility('review-request', 'bk_done', { deps }), null, 'review-request is not superseded')
  assert.equal(await bookingEligibility('job-completion', 'bk_done', { deps }), null, 'transactional job-completion is not superseded')

  //  B1 superseded, but other reasons win: the prohibition, the paid deposit, the passed move date.
  seedUnpaidCheckout('cus_opted')
  assert.equal(await bookingEligibility('abandoned-checkout', 'bk_b1', { deps }), 'booking_superseded')
  const b1 = fake.tables.bookings.find((b: Row) => b.id === 'bk_b1')
  fake.tables.suppressions.push({ email: OPTED_IN, reason: 'UNSUBSCRIBED', scope: 'promotional' })
  assert.equal(await bookingEligibility('abandoned-checkout', 'bk_b1', { deps }), 'suppressed', 'a prohibition is reported over a supersede')
  fake.tables.suppressions.length = 0
  b1.depositPaid = true
  assert.equal(await bookingEligibility('abandoned-checkout', 'bk_b1', { deps }), 'deposit_already_paid')
  b1.depositPaid = false
  b1.requestedDate = new Date(Date.now() - 3 * DAY)
  assert.equal(await bookingEligibility('abandoned-checkout', 'bk_b1', { deps }), 'move_date_passed')
  b1.requestedDate = new Date(Date.now() + 10 * DAY)
  assert.equal(await bookingEligibility('abandoned-checkout', 'bk_b1', { deps }), 'booking_superseded')

  //  The supersede query failing: the recheck FAILS CLOSED (and never runs for other templates).
  fake.booking.findMany = async () => {
    throw new Error('simulated later-booking read outage')
  }
  await assert.rejects(() => supersededByLaterBooking(fake as never, 'bk_b1'), /simulated later-booking read outage/)
  removeBooking('bk_next')
  assert.equal(await bookingEligibility('abandoned-checkout', 'bk_b1', { deps }), 'eligibility_read_failed', 'a read failure is never "not superseded"')
  assert.equal(await bookingEligibility('review-request', 'bk_done', { deps }), null, 'post-move mail never runs the supersede query')
})

test('guard: booking_superseded is TERMINAL — a queued abandoned-checkout stage whose recheck finds a later paid booking dies without a provider call', async (t) => {
  const { guardedSend, classifyBlock, resend } = await guard()
  const { bookingEligibility } = await import('../email-eligibility')
  assert.equal(classifyBlock('booking_superseded'), 'terminal')
  const send = t.mock.method(resend.emails, 'send', ok)
  const b1 = seedUnpaidCheckout('cus_opted')
  seedBooking({ id: 'bk_later', displayId: 'MIC-LATER', status: 'PENDING_APPROVAL', depositPaid: false, completedAt: null, createdAt: new Date(b1.createdAt.getTime() + DAY) })
  const deps = { db: fake as never, ...noTestIdentity }
  const out = await guardedSend(
    promo(OPTED_IN, {
      template: 'abandoned-checkout-2', journey: 'abandoned', leadId: undefined, bookingId: 'bk_b1',
      recheck: () => bookingEligibility('abandoned-checkout-2', 'bk_b1', { deps }),
    })
  )
  assert.equal(out.sent, false, JSON.stringify(out))
  assert.equal((out as Row).reason, 'booking_superseded')
  assert.equal((out as Row).outcomeClass, 'terminal')
  assert.equal(send.mock.callCount(), 0, 'the provider is never called')
  assert.equal(fake.tables.sends[0].status, 'blocked_terminal')
})

test('scheduled worker: the abandoned-checkout stage handler asks supersededByLaterBooking and stops BEFORE queueing the email', () => {
  const s = readFileSync(resolve(__dirname, '../../workers/scheduled.worker.ts'), 'utf8')
  const code = s.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
  assert.match(code, /import \{[^}]*\bsupersededByLaterBooking\b[^}]*\} from '\.\.\/lib\/email-eligibility'/)
  const start = code.indexOf("case 'abandoned-checkout-recovery':")
  assert.ok(start > -1, 'the abandoned stage handler is found')
  const handler = code.slice(start, code.indexOf('emailQueue.add(', start) + 'emailQueue.add('.length)
  //  One handler for all three stages: the three labels fall through to it.
  for (const label of ["case 'abandoned-checkout-recovery-2':", "case 'abandoned-checkout-recovery-3':"]) {
    assert.ok(handler.includes(label), label)
  }
  assert.equal((handler.match(/\bcase '/g) ?? []).length, 3, 'no other case sits between the labels and the queueing')
  const call = handler.indexOf('supersededByLaterBooking(')
  assert.ok(call > -1, 'the handler calls supersededByLaterBooking')
  assert.ok(call < handler.indexOf('emailQueue.add('), 'the supersede check runs before the email is queued')
  assert.ok(handler.indexOf("booking.status !== 'PENDING_PAYMENT'") < call, 'after the booking is loaded and still unpaid')
  assert.match(handler, /if \(await supersededByLaterBooking\(prisma as never, bookingId\)\) \{[\s\S]{0,200}?\bbreak\b/, 'a superseded booking skips the stage')
})

// ════════════════════════════════════════════════════════════════════════
//  5. Test sends, enrollCustomer, follow-ups, automations, fulfillment
// ════════════════════════════════════════════════════════════════════════

test('testSendPermission: the test recipient and internal identities rehearse; a customer needs a real basis', async () => {
  const { testSendPermission } = await import('../email-test-send')
  process.env.EMAIL_TEST_RECIPIENT = 'rehearsal@example.com'
  try {
    assert.equal(((await testSendPermission('rehearsal@example.com')) as Row).basis, 'internal_rehearsal')
    assert.equal(((await testSendPermission('someone@moveitclearit.com')) as Row).basis, 'internal_rehearsal')
    // An ordinary customer (classified as nobody internal) with no basis.
    const customer = await testSendPermission(NO_BASIS, { testIdentity: async () => null })
    assert.equal(customer.eligible, false)
    assert.equal((customer as Row).reason, 'no_marketing_basis')
    // ...and with express consent on record.
    assert.deepEqual(await testSendPermission(OPTED_IN, { testIdentity: async () => null }), { eligible: true, basis: 'express', basisEventId: null })
    // A role mailbox is somebody else's inbox, not an internal rehearsal.
    const role = await testSendPermission('info@acme-movers.example', { testIdentity: async () => 'role_account' })
    assert.notEqual((role as Row).basis, 'internal_rehearsal')
  } finally {
    delete process.env.EMAIL_TEST_RECIPIENT
  }
})

test('sendTestEmail hands the permission to the guard for promotional templates only', () => {
  const s = readFileSync(resolve(__dirname, '../email-test-send.ts'), 'utf8')
  const fn = s.slice(s.indexOf('export async function sendTestEmail'))
  assert.match(fn, /emailClass === 'promotional' \? await testSendPermission\(input\.to\) : undefined/)
  assert.match(fn, /\.\.\.\(eligibility \? \{ eligibility \} : \{\}\)/)
  assert.ok(fn.indexOf('testSendPermission(') < fn.indexOf('await guardedSend('))
})

test('enrollCustomer: express only, never a test booking, never a suppressed or test identity', async () => {
  const { enrollCustomer } = await import('../marketing')
  const saved = { key: process.env.MARKETING_API_KEY, list: process.env.MARKETING_LIST_ID }
  try {
    delete process.env.MARKETING_API_KEY
    assert.deepEqual(await enrollCustomer({ email: OPTED_IN }, { db: fake as never }), { status: 'not_configured' })
    process.env.MARKETING_API_KEY = 'test-key-not-real'
    process.env.MARKETING_LIST_ID = 'test-list'
    seedBooking({ id: 'bk_int', displayId: 'MIC-INT', isInternalTest: true })
    const deps = { db: fake as never, testIdentity: async () => null }
    assert.deepEqual(await enrollCustomer({ email: OPTED_IN, displayId: 'MIC-INT' }, deps), { status: 'refused', reason: 'internal_test_booking' })
    assert.deepEqual(await enrollCustomer({ email: NO_BASIS }, deps), { status: 'refused', reason: 'no_marketing_basis' })
    assert.deepEqual(await enrollCustomer({ email: WITHDRAWN }, deps), { status: 'refused', reason: 'opted_out' })
    fake.tables.suppressions.push({ email: SUPPRESSED, reason: 'UNSUBSCRIBED', scope: 'promotional' })
    assert.deepEqual(await enrollCustomer({ email: SUPPRESSED }, deps), { status: 'refused', reason: 'suppressed' })
    assert.deepEqual(await enrollCustomer({ email: OPTED_IN }, { db: fake as never }), { status: 'refused', reason: 'test_identity' })
    assert.deepEqual(await enrollCustomer({ email: OPTED_IN, displayId: 'MIC-1' }, deps), { status: 'enrolled' })
  } finally {
    if (saved.key === undefined) delete process.env.MARKETING_API_KEY
    else process.env.MARKETING_API_KEY = saved.key
    if (saved.list === undefined) delete process.env.MARKETING_LIST_ID
    else process.env.MARKETING_LIST_ID = saved.list
  }
})

test('fulfillment never sends an internal test booking to the tracker or the marketing list', () => {
  const s = readFileSync(resolve(__dirname, '../fulfillment.ts'), 'utf8')
  assert.match(s, /if \(!booking\.isInternalTest\) tasks\.push\(\s*ingestBookingToTracker\(/)
  assert.match(s, /if \(!booking\.isInternalTest\) fanout\.push\(\s*enqueueFanout\('marketing:enroll'/)
})

test('follow-ups ask the shared gate in the post-move context, and retry a read failure', () => {
  const s = readFileSync(resolve(__dirname, '../followups.ts'), 'utf8')
  const run = s.slice(s.indexOf('export async function runFollowup'))
  assert.match(run, /promotionalEligibility\(\s*\{ context: 'post_move'/)
  assert.ok(run.indexOf('promotionalEligibility(') < run.indexOf('prisma.followUpLedger.create('), 'the gate runs before the claim')
  assert.match(run, /consentBlock === 'eligibility_read_failed'[\s\S]{0,200}throw new Error/)
  assert.match(s, /marketingBlock: \(bookingId\) => bookingMarketingBlockReason\(bookingId, \{ context: 'post_move' \}\)/)
  assert.match(s, /eligibilityRequest: \{ context: 'post_move'/)
})

test('automation stop rules: the shared decision stops a stage and cannot be switched off; a read failure is not a stop', async () => {
  const { evaluateStopRules, automationEligibilityRequest } = await import('../email-automation-runtime')
  const def = { trigger: 'booking_started', audience: null, stages: [], stopRules: { stopAfterBooking: false, stopAfterCancellation: false, stopAfterPayment: false, stopAfterReview: false, stopAfterReferral: false } } as never
  const booking = { status: 'PENDING_PAYMENT', depositPaid: false, moveDate: null, hasReview: false, cancelled: false }
  const no = (reason: string) => ({ eligible: false as const, reason: reason as never, terminal: reason !== 'eligibility_read_failed' })
  assert.deepEqual(evaluateStopRules(def, { booking, marketing: { consent: true, optOut: false }, eligibility: no('declined') }), { stop: true, reason: 'declined' })
  assert.deepEqual(evaluateStopRules(def, { booking, eligibility: no('test_identity') }), { stop: true, reason: 'test_identity' })
  assert.deepEqual(evaluateStopRules(def, { booking, eligibility: no('eligibility_read_failed') }), { stop: false })
  assert.deepEqual(evaluateStopRules(def, { booking, eligibility: { eligible: true, basis: 'express', basisEventId: null } }), { stop: false })
  // Today's legacy reasons still come first.
  assert.deepEqual(evaluateStopRules(def, { booking, marketing: { consent: null, optOut: false }, eligibility: no('opted_out') }), { stop: true, reason: 'no_marketing_consent' })

  assert.deepEqual(automationEligibilityRequest({ bookingId: 'b', leadId: 'l' }), { context: 'automation', subject: { type: 'booking', id: 'b' } })
  assert.deepEqual(automationEligibilityRequest({ customerId: 'c' }), { context: 'automation', subject: { type: 'customer', id: 'c' } })
  assert.deepEqual(automationEligibilityRequest({}), { context: 'automation', subject: { type: 'none' } })
})

test('automations: every enrollment path — including the 15-minute sweep — passes the shared gate first', () => {
  const s = readFileSync(resolve(__dirname, '../email-automation-runtime.ts'), 'utf8')
  const code = s.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
  const booking = code.slice(code.indexOf('export async function fireBookingTrigger'), code.indexOf('export function mayEnrollLeadSubject'))
  assert.ok(booking.indexOf('automationEligibility(') > -1 && booking.indexOf('automationEligibility(') < booking.indexOf('fireAutomationTrigger('))
  const lead = code.slice(code.indexOf('export async function fireLeadTrigger'), code.indexOf('async function scheduleStageJob'))
  assert.ok(lead.indexOf('automationEligibility(') > -1 && lead.indexOf('automationEligibility(') < lead.indexOf('fireAutomationTrigger('))
  const sweep = code.slice(code.indexOf('export async function sweepAutomationEnrollments'), code.indexOf('export async function automationRuntimeStats'))
  assert.ok(!/fireAutomationTrigger\(trigger, subject\)/.test(sweep), 'the sweep no longer enrolls ungated')
  assert.match(sweep, /fireGatedSweepSubject\(trigger, subject\)/)
  const loader = code.slice(code.indexOf('async function loadLiveState'), code.indexOf('async function loadPinnedDefinition'))
  assert.match(loader, /state\.eligibility = await automationEligibility\(enrollment\)/)
  const stage = code.slice(code.indexOf('export async function executeAutomationStage'))
  assert.match(stage, /eligibilityRequest: automationEligibilityRequest\(enrollment\)/)
})

// ════════════════════════════════════════════════════════════════════════
//  6. Existing templates: sent as rendered, no offers in the reply
// ════════════════════════════════════════════════════════════════════════

const OFFER_WORDS = /MOVE10|\b\d{1,2}\s?% off\b|\bdiscount\b|\bcoupon\b|\bpromo code\b|\boffer\b|\boferta\b|\bdescuento\b|\bcup[oó]n\b|book now|reserve ahora|limited time/i

test('quote-request-received (the existing reply): strictly no promotional content and no marketing footer (EN and ES)', async () => {
  const Email = (await import('../../emails/quote-request-received')).default
  for (const locale of ['en', 'es']) {
    for (const inPerson of [false, true]) {
      const html = render(React.createElement(Email, { firstName: 'Sam', estimatedPrice: '$1,049', inPerson, locale, moveSize: '2 Bedrooms' }))
      const text = render(React.createElement(Email, { firstName: 'Sam', estimatedPrice: '$1,049', inPerson, locale }), { plainText: true })
      assert.ok(!/api\/email\/unsubscribe/.test(html), `${locale}: the reply carries no marketing unsubscribe row`)
      assert.ok(!OFFER_WORDS.test(text), `${locale}${inPerson ? ' in-person' : ''}: no offer content — found ${String(text.match(OFFER_WORDS))}`)
    }
  }
  const src = readFileSync(resolve(__dirname, '../../emails/quote-request-received.tsx'), 'utf8')
  assert.ok(!/MarketingFooter/.test(src))
})

//  The one copy change of this release: the lead-nurture footer tells the truth
//  about why the person is hearing from us, and no longer claims an opt-in.
const LEAD_NURTURE_FOOTER = {
  en: "You're receiving this because you gave us your email about a move on moveitclearit.com. To stop these emails, use the Unsubscribe link below.",
  es: 'Te escribimos porque nos diste tu correo sobre una mudanza en moveitclearit.com. Para dejar de recibir estos correos, usa el enlace «Cancelar suscripción» de abajo.',
} as const
const OPT_IN_CLAIM = /opted[\s-]+in|aceptaste\s+recibir/i

/** Rendered markup → comparable prose: entities decoded, tags dropped, whitespace collapsed. */
const prose = (s: string) =>
  s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;|&apos;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&laquo;/g, '«')
    .replace(/&raquo;/g, '»')
    .replace(/&nbsp;|&#160;|&#xA0;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')

test('lead-nurture (EN and ES, every stage): the footer carries the corrected sentence, an unsubscribe link, and NO opt-in claim', async () => {
  for (const locale of ['en', 'es'] as const) {
    for (const { template, stage } of LEAD_NURTURE_STAGES) {
      const { html, text } = await renderLeadNurture(NO_BASIS, stage, locale)
      const label = `${template} ${locale}`
      assert.ok(prose(html).includes(LEAD_NURTURE_FOOTER[locale]), `${label}: html footer sentence`)
      assert.ok(prose(text).includes(LEAD_NURTURE_FOOTER[locale]), `${label}: text footer sentence`)
      assert.ok(!OPT_IN_CLAIM.test(html) && !OPT_IN_CLAIM.test(prose(html)), `${label}: html must not claim an opt-in`)
      assert.ok(!OPT_IN_CLAIM.test(text) && !OPT_IN_CLAIM.test(prose(text)), `${label}: text must not claim an opt-in`)
      //  The other locale's sentence is not mixed in.
      assert.ok(!prose(html).includes(LEAD_NURTURE_FOOTER[locale === 'en' ? 'es' : 'en']), `${label}: one language`)
      //  The unsubscribe link and postal address are still rendered in the message.
      assert.match(html, /https:\/\/app\.moveitclearit\.test\/api\/email\/unsubscribe\?token=/, `${label}: visible unsubscribe link`)
      assert.ok(html.includes('123 Test Street, Testville, NJ 00000'), `${label}: postal address`)
    }
  }
})

test('no template in src/emails says "opted in" or "aceptaste recibir"', () => {
  const root = resolve(__dirname, '../../emails')
  const files: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      //  The template tests may name the retired phrase in a negative assertion;
      //  every template, component and helper is scanned.
      if (statSync(path).isDirectory()) {
        if (name !== '__tests__') walk(path)
      } else files.push(path)
    }
  }
  walk(root)
  assert.ok(files.some((f) => f.endsWith('lead-nurture.tsx')) && files.some((f) => f.endsWith('_ui.tsx')), 'the scan reaches the templates')
  const offenders = files.filter((f) => OPT_IN_CLAIM.test(readFileSync(f, 'utf8')))
  assert.deepEqual(offenders, [], `opt-in claims found in: ${offenders.join(', ')}`)
})

// ════════════════════════════════════════════════════════════════════════
//  7. The agent's consent monitor judges the recorded basis
// ════════════════════════════════════════════════════════════════════════

test('promotionalBasisHolds: a recorded basis must match a consent event for the same address', async () => {
  const { promotionalBasisHolds } = await import('../email-agent/checks/consent')
  const events = new Map([
    ['evt_n', { kind: 'notice_accepted', emailNormalized: NO_BASIS }],
    ['evt_e', { kind: 'express_opt_in', emailNormalized: STATUS_EXPRESS }],
  ])
  const legacyConsenting = new Set([OPTED_IN])
  const holds = (email: string, marketingBasis: string | null, basisEventId: string | null) =>
    promotionalBasisHolds({ email, marketingBasis, basisEventId }, { legacyConsenting, events })
  assert.equal(holds(NO_BASIS, 'notice', 'evt_n'), true, 'a lawful notice send is not flagged')
  assert.equal(holds(OPTED_IN, 'notice', 'evt_n'), false, 'another address')
  assert.equal(holds(NO_BASIS, 'express', 'evt_n'), false, 'wrong kind')
  assert.equal(holds(NO_BASIS, 'notice', 'evt_missing'), false)
  assert.equal(holds(STATUS_EXPRESS, 'express', 'evt_e'), true)
  assert.equal(holds(OPTED_IN, 'express', null), true, 'a legacy checkbox still counts')
  assert.equal(holds(NO_BASIS, null, null), false, 'a pre-release send with no consent is still flagged')
  assert.equal(holds(OPTED_IN, null, null), true)
  assert.equal(holds(NO_BASIS, 'transactional', null), false)
  assert.equal(holds(NO_BASIS, 'ebr', null), true)
})

test('no email copy is inserted anywhere on the send path: the worker and the guard send the existing templates as rendered', () => {
  const worker = readFileSync(resolve(__dirname, '../../workers/email.worker.ts'), 'utf8')
  const guardSrc = readFileSync(resolve(__dirname, '../email-guard.ts'), 'utf8')
  for (const [name, src] of [['email.worker.ts', worker], ['email-guard.ts', guardSrc]] as const) {
    assert.ok(!/hybridFooterContext|HYBRID_UNSUBSCRIBE_TEMPLATES|ensureAdvertisement|emails\/advertisement|offer-welcome|offer-confirm/.test(src), `${name} must not insert copy or name a removed template`)
  }
  assert.ok(!require('node:fs').existsSync(resolve(__dirname, '../../emails/offer-welcome.tsx')), 'no new popup template')
  assert.ok(!require('node:fs').existsSync(resolve(__dirname, '../../emails/advertisement.ts')), 'no inserted advertisement line')
})
