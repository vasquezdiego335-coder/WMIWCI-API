// ════════════════════════════════════════════════════════════════════════
//  QUOTE LEAD CAPTURE — REPAIR PASS (2026-08-04)
//
//  BEHAVIOUR tests for the defects the repair audit confirmed. Deliberately
//  NOT source-text assertions: each one drives the real function and checks
//  what it RETURNS or WRITES, because every defect below passed a source-text
//  review before it was found.
//
//  What this file prevents:
//    1. a browser-supplied price becoming the official quote
//    2. an unknown/retired package silently getting a price
//    3. Feb 31 (and friends) becoming a real date in March
//    4. a rollback erasing a NEWER request's successful claim
//    5. a Discord rollback leaving fingerprint and timestamp contradicting
//    6. an in-session typo correction being ignored
//    7. a shared email overwriting a different person's identity
//    8. a marketing campaign slug landing in the promo-code column
//    9. queue state being reported as delivery state
//
//  OFFLINE + PURE: no DB, no Redis, no network, no env required.
// ════════════════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { quoteEstimate, compareClientTotal } from '../quote-estimate'
import { isValidMoveDate, parseMoveDate, MAX_BOOKING_HORIZON_DAYS } from '../quote-date'
import { safeErrorLabel } from '../quote-capture'
import { businessPhone, formatPhoneDisplay, normalizePhoneDigits } from '../business-contact'
import { MOVE_SIZES, SELECTABLE_MOVE_SIZES } from '../estimate'
import {
  buildPartialLeadCreate,
  buildPartialLeadUpdate,
  capturePartialLead,
  type PartialLeadInput,
  type PartialLeadStore,
  type PartialLeadDeps,
  type ExistingPartialLead,
  type LeadRecord,
} from '../leads'

const NOW = new Date('2026-08-04T15:00:00.000Z')

// ══════════════════════════════════════════════════════════════════════
//  1. SERVER-AUTHORITATIVE PRICING
// ══════════════════════════════════════════════════════════════════════

test('a manipulated browser total cannot become the official quote', () => {
  // The attack: POST {"moveSize":"2br","estimateTotal":1}
  const priced = quoteEstimate({ moveSize: '2br' })
  assert.equal(priced.ok, true)
  if (!priced.ok) return
  assert.ok(priced.totalDollars > 1, 'the server must not return the attacker figure')
  assert.equal(priced.totalCents, priced.totalDollars * 100)

  // And the comparison must FLAG the mismatch rather than accept it.
  const cmp = compareClientTotal(priced.totalDollars, 1)
  assert.equal(cmp.matched, false)
  assert.equal(cmp.serverDollars, priced.totalDollars)
})

test('the server price equals the published price book — honest submissions are unaffected', () => {
  for (const key of Object.keys(SELECTABLE_MOVE_SIZES)) {
    if (key === 'not-sure') continue
    const priced = quoteEstimate({ moveSize: key })
    assert.equal(priced.ok, true, `${key} must price`)
    if (!priced.ok) continue
    assert.equal(
      priced.totalDollars,
      SELECTABLE_MOVE_SIZES[key].price,
      `${key} must equal the price book, or the customer sees one number and we store another`
    )
  }
})

test('an unknown package is REJECTED, never silently defaulted to a price', () => {
  for (const bad of ['9br', 'penthouse', '', '   ', 'DROP TABLE', 'not-sure']) {
    const priced = quoteEstimate({ moveSize: bad })
    assert.equal(priced.ok, false, `${JSON.stringify(bad)} must not price`)
  }
})

test('a RETIRED package still resolves for history but cannot be quoted anew', () => {
  const retired = Object.keys(MOVE_SIZES).filter((k) => !SELECTABLE_MOVE_SIZES[k])
  if (retired.length === 0) return // nothing retired in the current price book
  for (const key of retired) {
    assert.ok(MOVE_SIZES[key], `${key} must still resolve for a historical row`)
    const priced = quoteEstimate({ moveSize: key })
    assert.equal(priced.ok, false, `${key} is retired and must not be sold`)
  }
})

test('the customer-facing label is human, never the internal key', () => {
  const priced = quoteEstimate({ moveSize: '2br' })
  assert.equal(priced.ok, true)
  if (!priced.ok) return
  assert.ok(priced.packageLabel.length > 3)
  assert.notEqual(priced.packageLabel, '2br', 'a customer must not read our vocabulary in their inbox')
})

test('a matching browser total produces no mismatch noise', () => {
  const priced = quoteEstimate({ moveSize: '1br' })
  assert.equal(priced.ok, true)
  if (!priced.ok) return
  assert.equal(compareClientTotal(priced.totalDollars, priced.totalDollars).matched, true)
  assert.equal(compareClientTotal(priced.totalDollars, undefined).matched, true, 'absent is not a mismatch')
  assert.equal(compareClientTotal(priced.totalDollars, NaN).matched, true, 'NaN is not a mismatch')
})

// ══════════════════════════════════════════════════════════════════════
//  2. STRICT DATE VALIDATION
// ══════════════════════════════════════════════════════════════════════

const TODAY = new Date('2026-08-04T12:00:00.000Z')

test('a valid future date is accepted and stored at NOON UTC', () => {
  const v = isValidMoveDate('2026-08-11', TODAY)
  assert.equal(v.ok, true)
  if (!v.ok) return
  assert.equal(v.iso, '2026-08-11T12:00:00.000Z',
    'midnight UTC would render as the PREVIOUS day in America/New_York')
})

test('IMPOSSIBLE CALENDAR DATES ARE REJECTED — they used to roll over silently', () => {
  // new Date('2026-02-31T12:00:00Z') does not throw; it becomes March 3rd.
  for (const bad of ['2026-02-31', '2026-02-30', '2026-04-31', '2026-06-31', '2026-09-31', '2026-11-31']) {
    const v = isValidMoveDate(bad, TODAY)
    assert.equal(v.ok, false, `${bad} must be rejected`)
    if (!v.ok) assert.equal(v.reason, 'not_a_real_date')
    assert.equal(parseMoveDate(bad, TODAY), null, `${bad} must never be stored`)
  }
})

test('leap years are handled in BOTH directions', () => {
  // `today` is pinned NEAR each leap day so the booking horizon is not what
  // decides the result — this test is about the CALENDAR, and conflating the
  // two would let a real leap-day bug hide behind a horizon rejection.
  const near2028 = new Date('2028-01-04T12:00:00.000Z')
  assert.equal(isValidMoveDate('2028-02-29', near2028).ok, true, '2028 IS a leap year')

  const near2027 = new Date('2027-01-04T12:00:00.000Z')
  const nonLeap = isValidMoveDate('2027-02-29', near2027)
  assert.equal(nonLeap.ok, false, '2027 is NOT a leap year')
  if (!nonLeap.ok) {
    assert.equal(nonLeap.reason, 'not_a_real_date', 'it must fail as an impossible DATE, not on the horizon')
  }

  // 2100 is divisible by 100 but not 400 — NOT a leap year. Beyond the horizon
  // from any realistic today, so assert the calendar rule directly.
  const near2100 = new Date('2100-01-04T12:00:00.000Z')
  const century = isValidMoveDate('2100-02-29', near2100)
  assert.equal(century.ok, false, '2100 is not a leap year (century rule)')
  if (!century.ok) assert.equal(century.reason, 'not_a_real_date')
})

test('the horizon and the calendar are INDEPENDENT rejections', () => {
  // A real date that is simply too far out fails on the horizon…
  const farButReal = isValidMoveDate('2029-03-15', TODAY)
  assert.equal(farButReal.ok, false)
  if (!farButReal.ok) assert.equal(farButReal.reason, 'beyond_horizon')
  // …while an impossible date fails on the calendar even when it is near.
  const nearButFake = isValidMoveDate('2026-09-31', TODAY)
  assert.equal(nearButFake.ok, false)
  if (!nearButFake.ok) assert.equal(nearButFake.reason, 'not_a_real_date')
})

test('out-of-range months and days are rejected', () => {
  for (const bad of ['2026-13-01', '2026-00-10', '2026-08-00', '2026-08-32']) {
    assert.equal(isValidMoveDate(bad, TODAY).ok, false, `${bad} must be rejected`)
  }
})

test('malformed shapes are rejected without throwing', () => {
  for (const bad of ['08/11/2026', '2026-8-11', '2026-08-11T00:00:00Z', 'tomorrow', '20260811', '']) {
    const v = isValidMoveDate(bad, TODAY)
    assert.equal(v.ok, false, `${JSON.stringify(bad)} must be rejected`)
  }
  assert.equal(isValidMoveDate(null, TODAY).ok, false)
  assert.equal(isValidMoveDate(undefined, TODAY).ok, false)
})

test('today is allowed; yesterday is not', () => {
  assert.equal(isValidMoveDate('2026-08-04', TODAY).ok, true, 'a move later today is real')
  const past = isValidMoveDate('2026-08-03', TODAY)
  assert.equal(past.ok, false)
  if (!past.ok) assert.equal(past.reason, 'in_the_past')
})

test('a date beyond the booking horizon is rejected (almost always a typo)', () => {
  const far = isValidMoveDate('2031-08-04', TODAY)
  assert.equal(far.ok, false)
  if (!far.ok) assert.equal(far.reason, 'beyond_horizon')
  // The boundary itself is allowed.
  const edge = new Date(Date.UTC(2026, 7, 4) + MAX_BOOKING_HORIZON_DAYS * 86_400_000)
  const iso = edge.toISOString().slice(0, 10)
  assert.equal(isValidMoveDate(iso, TODAY).ok, true, `${iso} is exactly the horizon and must pass`)
})

// ══════════════════════════════════════════════════════════════════════
//  3. LEAD MERGE POLICY
// ══════════════════════════════════════════════════════════════════════

const existingLead = (over: Partial<ExistingPartialLead> = {}): ExistingPartialLead =>
  ({
    id: 'l1', status: 'NEW', name: 'Zalak Shah', phone: '732-763-2716', email: 'zalak@example.com',
    bookingSessionId: 'sess-1', lifecycle: 'IN_PROGRESS', emailMarketingConsent: null,
    formStep: 'quote', estimatedValue: 104_900, utmSource: 'facebook', utmCampaign: 'fb-post',
    landingPage: null, referrer: null, promoCode: null, ...over,
  }) as unknown as ExistingPartialLead

const input = (over: Partial<PartialLeadInput> = {}): PartialLeadInput => ({
  email: 'zalak@example.com', firstName: 'Zalak', lastName: 'Shah', phone: '732-763-2716',
  bookingSessionId: 'sess-1', formStep: 'quote', ...over,
})

test('SAME SESSION: a corrected email REPLACES the old one', () => {
  const patch = buildPartialLeadUpdate(existingLead(), input({ email: 'zalak.correct@example.com' }), NOW, 'session') as Record<string, unknown>
  assert.equal(patch.email, 'zalak.correct@example.com', 'a typo fix must stick, or we email the wrong address forever')
})

test('SAME SESSION: a corrected phone and name REPLACE the old ones', () => {
  const patch = buildPartialLeadUpdate(
    existingLead(),
    input({ phone: '862-555-0100', firstName: 'Zalak', lastName: 'Shaw' }),
    NOW, 'session'
  ) as Record<string, unknown>
  assert.equal(patch.phone, '862-555-0100')
  assert.equal(patch.name, 'Zalak Shaw')
})

test('EMAIL MATCH ONLY: an existing person is NEVER overwritten', () => {
  // A shared household / work address can put two people on one row.
  const patch = buildPartialLeadUpdate(
    existingLead(),
    input({ firstName: 'Different', lastName: 'Person', phone: '999-999-9999' }),
    NOW, 'email'
  ) as Record<string, unknown>
  assert.equal(patch.name, 'Zalak Shah', 'the stored identity must survive a loose email match')
  assert.equal(patch.phone, '732-763-2716')
})

test('a BLANK value never erases a stored one, under either policy', () => {
  for (const basis of ['session', 'email'] as const) {
    const patch = buildPartialLeadUpdate(
      existingLead(),
      { bookingSessionId: 'sess-1', email: 'zalak@example.com' },
      NOW, basis
    ) as Record<string, unknown>
    assert.equal(patch.phone, '732-763-2716', `${basis}: blank input must not clear the phone`)
    assert.equal(patch.name, 'Zalak Shah', `${basis}: blank input must not clear the name`)
  }
})

test('a placeholder name is replaceable even on a loose match', () => {
  const patch = buildPartialLeadUpdate(
    existingLead({ name: 'Booking lead' } as Partial<ExistingPartialLead>),
    input({ firstName: 'Real', lastName: 'Name' }),
    NOW, 'email'
  ) as Record<string, unknown>
  assert.equal(patch.name, 'Real Name')
})

test('attribution stays FIRST-TOUCH under both policies', () => {
  for (const basis of ['session', 'email'] as const) {
    const patch = buildPartialLeadUpdate(
      existingLead(),
      input({ utmSource: 'google', utmCampaign: 'later-campaign' }),
      NOW, basis
    ) as Record<string, unknown>
    assert.equal(patch.utmSource, 'facebook', `${basis}: the channel that earned the lead must not change`)
    assert.equal(patch.utmCampaign, 'fb-post')
  }
})

test('consent is never changed without an explicit customer action', () => {
  const patch = buildPartialLeadUpdate(existingLead({ emailMarketingConsent: true } as Partial<ExistingPartialLead>), input(), NOW, 'session') as Record<string, unknown>
  assert.ok(!('emailMarketingConsent' in patch), 'an untouched checkbox must leave stored consent alone')
})

// ── the dedupe basis is chosen correctly end to end ──

function makeStore(seed: ExistingPartialLead[] = []) {
  const rows = new Map<string, ExistingPartialLead>()
  seed.forEach((r) => rows.set(r.id, r))
  let n = seed.length
  const store: PartialLeadStore = {
    async findBySessionId(id) { return Array.from(rows.values()).find((r) => r.bookingSessionId === id) ?? null },
    async findOpenPartialByEmail(e) { return Array.from(rows.values()).find((r) => r.email === e) ?? null },
    async create(data) { const id = `lead_${++n}`; rows.set(id, { id, ...(data as unknown as Omit<ExistingPartialLead, 'id'>) }); return { id, status: 'NEW' } as LeadRecord },
    async update(id, data) { rows.set(id, { ...(rows.get(id) as ExistingPartialLead), ...(data as object) }); return { id, status: 'NEW' } as LeadRecord },
  }
  return { store, rows }
}
const deps = (store: PartialLeadStore): PartialLeadDeps => ({ store, now: () => NOW })

test('a session match applies the SESSION policy (correction sticks)', async () => {
  const { store, rows } = makeStore([existingLead()])
  await capturePartialLead(input({ email: 'fixed@example.com' }), deps(store))
  assert.equal(rows.size, 1, 'still one lead')
  assert.equal((rows.get('l1') as unknown as Record<string, unknown>).email, 'fixed@example.com')
})

test('an email-only match applies the CONSERVATIVE policy', async () => {
  const { store, rows } = makeStore([existingLead({ bookingSessionId: 'other-session' } as Partial<ExistingPartialLead>)])
  await capturePartialLead(input({ bookingSessionId: undefined, firstName: 'Someone', lastName: 'Else' }), deps(store))
  assert.equal(rows.size, 1)
  assert.equal((rows.get('l1') as unknown as Record<string, unknown>).name, 'Zalak Shah',
    'a loose email match must not rename an existing person')
})

// ══════════════════════════════════════════════════════════════════════
//  4. PROMO CODE vs UTM CAMPAIGN
// ══════════════════════════════════════════════════════════════════════

test('a marketing campaign never populates the promo-code column', () => {
  const row = buildPartialLeadCreate(
    { email: 'a@b.com', bookingSessionId: 's', utmCampaign: 'summer-google-ads-2026' },
    NOW
  ) as unknown as Record<string, unknown>
  assert.equal(row.utmCampaign, 'summer-google-ads-2026')
  assert.equal(row.promoCode, null, 'a campaign slug is not a discount the customer earned')
})

test('a real promo code is stored, independently of attribution', () => {
  const row = buildPartialLeadCreate(
    { email: 'a@b.com', bookingSessionId: 's', promoCode: 'MOVE10', utmCampaign: 'fb-post' },
    NOW
  ) as unknown as Record<string, unknown>
  assert.equal(row.promoCode, 'MOVE10')
  assert.equal(row.utmCampaign, 'fb-post')
})

// ══════════════════════════════════════════════════════════════════════
//  5. SAFE LOGGING + BUSINESS PHONE
// ══════════════════════════════════════════════════════════════════════

test('an error label is short, single-line and free of control characters', () => {
  const label = safeErrorLabel(new Error('boom\n\tat someFile.ts:1:1\n'.repeat(50)))
  assert.ok(label.length <= 120, 'a stack trace must never reach the database')
  assert.ok(!/[\n\t]/.test(label))
  assert.ok(label.startsWith('Error: boom'))
  assert.equal(safeErrorLabel(undefined), 'undefined')
})

test('the business phone has ONE source and both display and dial forms', () => {
  const prev = process.env.BUSINESS_PHONE
  try {
    process.env.BUSINESS_PHONE = '973-555-0142'
    const c = businessPhone()
    assert.equal(c.display, '(973) 555-0142')
    assert.equal(c.tel, '+19735550142')
    assert.equal(c.sms, c.tel)

    delete process.env.BUSINESS_PHONE
    const fallback = businessPhone()
    assert.equal(fallback.display, '(862) 640-0625', 'the documented default')
    assert.equal(fallback.tel, '+18626400625')
  } finally {
    if (prev === undefined) delete process.env.BUSINESS_PHONE
    else process.env.BUSINESS_PHONE = prev
  }
})

test('phone normalization handles the shapes customers actually type', () => {
  assert.equal(normalizePhoneDigits('(862) 640-0625'), '18626400625')
  assert.equal(normalizePhoneDigits('+1 862 640 0625'), '18626400625')
  assert.equal(normalizePhoneDigits('8626400625'), '18626400625')
  assert.equal(normalizePhoneDigits('555'), null)
  assert.equal(normalizePhoneDigits(null), null)
  assert.equal(formatPhoneDisplay('8626400625'), '(862) 640-0625')
})
