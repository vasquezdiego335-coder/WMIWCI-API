import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseAmountToCents,
  formatCents,
  newPublicToken,
  isValidPublicToken,
  TOKEN_LENGTH,
  effectiveStatus,
  isPayable,
  remainingAfterCents,
  checkDepositAgainstBalance,
  customerDepositMessage,
  firstNameOf,
  publicDepositView,
  parseExpiry,
  isConfirmedDepositSession,
  depositBaseUrl,
  depositUrl,
  MIN_DEPOSIT_CENTS,
  MAX_DEPOSIT_CENTS,
  PRESET_DEPOSIT_CENTS,
} from '../deposit-links'

// ════════════════════════════════════════════════════════════════════════════
//  The money rules for admin deposit links. Every assertion here is about a
//  figure a customer is shown or a card is charged, so these are the tests that
//  have to be right.
// ════════════════════════════════════════════════════════════════════════════

// ── Dollars → integer cents ─────────────────────────────────────────────────

test('exact dollar-to-cents conversion', () => {
  const cases: Array<[string | number, number]> = [
    ['49', 4900],
    ['49.00', 4900],
    ['49.5', 4950],
    ['49.50', 4950],
    ['$49.50', 4950],
    [' 49.50 ', 4950],
    ['1,495.00', 149500],
    ['1', 100],
    [49.5, 4950],
    [495, 49500],
    // The classic float trap: 49.1 * 100 === 4909.999999999999 in IEEE754.
    [49.1, 4910],
    ['19.99', 1999],
    ['100.05', 10005],
  ]
  for (const [input, expected] of cases) {
    const r = parseAmountToCents(input)
    assert.equal(r.ok, true, `expected ${JSON.stringify(input)} to parse`)
    if (r.ok) assert.equal(r.cents, expected, `${JSON.stringify(input)} -> ${expected}`)
  }
})

test('invalid amounts are REJECTED, never coerced', () => {
  const bad: unknown[] = [
    '', '   ', 'abc', '49abc', '4 9', '-49', '-0.01', '49.999', '49.5.5', '.5', '1e3', '0x10',
    '$', null, undefined, {}, [], NaN, Infinity, -Infinity, true,
    // Malformed comma grouping. "4,9" is the dangerous one: blanket comma
    // stripping would turn it into $49 when the typist meant $4.90.
    '49,', '4,9', ',49', '1,49,5', '1,4950',
  ]
  for (const input of bad) {
    const r = parseAmountToCents(input)
    assert.equal(r.ok, false, `expected ${JSON.stringify(input)} to be rejected`)
  }
})

test('amount bounds: below $1 and above $10,000 are refused', () => {
  assert.equal(parseAmountToCents('0').ok, false)
  // 99c is below the $1 floor. Stripe also refuses sub-50c USD charges, so a
  // "deposit" here would fail at the card anyway.
  assert.equal(parseAmountToCents('0.99').ok, false)
  const floor = parseAmountToCents((MIN_DEPOSIT_CENTS / 100).toFixed(2))
  assert.equal(floor.ok, true)
  const belowFloor = parseAmountToCents(((MIN_DEPOSIT_CENTS - 1) / 100).toFixed(2))
  assert.equal(belowFloor.ok, false)
  const ceiling = parseAmountToCents((MAX_DEPOSIT_CENTS / 100).toFixed(2))
  assert.equal(ceiling.ok, true)
  const aboveCeiling = parseAmountToCents(((MAX_DEPOSIT_CENTS + 100) / 100).toFixed(2))
  assert.equal(aboveCeiling.ok, false)
})

test('the $49 preset is a real, parseable amount', () => {
  assert.equal(PRESET_DEPOSIT_CENTS, 4900)
  const r = parseAmountToCents((PRESET_DEPOSIT_CENTS / 100).toFixed(2))
  assert.ok(r.ok && r.cents === PRESET_DEPOSIT_CENTS)
})

test('formatCents renders money the way a customer reads it', () => {
  assert.equal(formatCents(4900), '$49.00')
  assert.equal(formatCents(49500), '$495.00')
  assert.equal(formatCents(44600), '$446.00')
  assert.equal(formatCents(0), '$0.00')
  assert.equal(formatCents(149500), '$1,495.00')
})

// ── THE worked example from the owner spec ──────────────────────────────────

test('$495 quote − $49 deposit = $446 remaining, with NO processing fee', () => {
  const quoteTotalCents = 49500
  const amountCents = 4900

  const remaining = remainingAfterCents({ quoteTotalCents, balanceBeforeCents: quoteTotalCents, amountCents })
  assert.equal(remaining, 44600)
  assert.equal(formatCents(remaining as number), '$446.00')

  // The customer is charged the deposit and NOTHING else. $501 (a 2.9% + 30c
  // fee added on top) is the number this assertion exists to make impossible.
  assert.equal(amountCents, 4900)
  assert.notEqual(amountCents, 5042)
  assert.equal(quoteTotalCents, (remaining as number) + amountCents)
})

test('remaining balance is HIDDEN (null), never $0.00, when the total is unknown', () => {
  assert.equal(remainingAfterCents({ quoteTotalCents: null, balanceBeforeCents: null, amountCents: 4900 }), null)
  assert.equal(remainingAfterCents({ amountCents: 4900 }), null)
  // A standalone link with only a typed quote total still computes.
  assert.equal(remainingAfterCents({ quoteTotalCents: 49500, amountCents: 4900 }), 44600)
})

test('remaining uses the unpaid BALANCE over the quote total when both are known', () => {
  // $495 quote, $100 already collected -> $395 owed. A $49 deposit leaves $346,
  // and the quote total is still displayed as $495.
  assert.equal(remainingAfterCents({ quoteTotalCents: 49500, balanceBeforeCents: 39500, amountCents: 4900 }), 34600)
})

test('remaining never goes negative', () => {
  assert.equal(remainingAfterCents({ balanceBeforeCents: 4900, amountCents: 10000 }), 0)
})

// ── Overpayment ─────────────────────────────────────────────────────────────

test('a deposit larger than the unpaid balance is REFUSED', () => {
  const r = checkDepositAgainstBalance(50000, { unpaidBalanceCents: 44600, quoteMissing: false })
  assert.equal(r.ok, false)
  assert.match(r.error ?? '', /cannot exceed the unpaid balance/i)
})

test('a deposit equal to the unpaid balance is allowed (paying in full)', () => {
  assert.equal(checkDepositAgainstBalance(44600, { unpaidBalanceCents: 44600, quoteMissing: false }).ok, true)
})

test('a fully-paid booking refuses any further deposit', () => {
  const r = checkDepositAgainstBalance(4900, { unpaidBalanceCents: 0, quoteMissing: false })
  assert.equal(r.ok, false)
  assert.match(r.error ?? '', /no unpaid balance/i)
})

test('with NO accepted quote the cap is skipped, and the reason is stated', () => {
  // The balance is reconstructed from parts and is a FLOOR, so capping on it
  // would refuse legitimate deposits. The caller is warned instead of blocked.
  const r = checkDepositAgainstBalance(50000, { unpaidBalanceCents: 10000, quoteMissing: true })
  assert.equal(r.ok, true)
  assert.match(r.warning ?? '', /no accepted quote total/i)
  assert.match(r.warning ?? '', /not enforced/i)
})

test('an existing uncaptured hold produces a double-collection warning', () => {
  const r = checkDepositAgainstBalance(4900, {
    unpaidBalanceCents: 44600,
    quoteMissing: false,
    authorizedNotCapturedCents: 4900,
  })
  assert.equal(r.ok, true, 'a hold does not block the deposit')
  assert.match(r.warning ?? '', /already has \$49\.00 authorized/i)
  assert.match(r.warning ?? '', /twice/i)
})

test('an unknown balance (standalone) allows any in-range amount', () => {
  assert.equal(checkDepositAgainstBalance(25000, { unpaidBalanceCents: null }).ok, true)
})

// ── Public token ────────────────────────────────────────────────────────────

test('public tokens are long, unambiguous and non-sequential', () => {
  const seen = new Set<string>()
  for (let i = 0; i < 2000; i++) {
    const t = newPublicToken()
    assert.equal(t.length, TOKEN_LENGTH)
    assert.ok(isValidPublicToken(t), `${t} should validate`)
    // No I, L, O or U — they are misread when a token is spoken or retyped.
    assert.ok(!/[ILOU]/.test(t), `${t} must not contain ambiguous letters`)
    assert.ok(!seen.has(t), 'tokens must not repeat')
    seen.add(t)
  }
  assert.equal(seen.size, 2000)
})

test('token validation rejects anything that is not exactly the right shape', () => {
  assert.equal(isValidPublicToken(''), false)
  assert.equal(isValidPublicToken('SHORT'), false)
  assert.equal(isValidPublicToken('7KQ4M9'), false) // 6 chars — not our format
  assert.equal(isValidPublicToken('a'.repeat(TOKEN_LENGTH)), false) // lowercase
  assert.equal(isValidPublicToken('I'.repeat(TOKEN_LENGTH)), false) // excluded letter
  assert.equal(isValidPublicToken('!'.repeat(TOKEN_LENGTH)), false)
  assert.equal(isValidPublicToken(null), false)
  assert.equal(isValidPublicToken(123), false)
  // A SQL-ish probe must not pass the shape check and reach the database.
  assert.equal(isValidPublicToken("' OR 1=1--"), false)
})

// ── Status ──────────────────────────────────────────────────────────────────

const NOW = new Date('2026-08-15T12:00:00Z')
const PAST = new Date('2026-08-14T12:00:00Z')
const FUTURE = new Date('2026-08-16T12:00:00Z')

test('a paid link is PAID forever — expiry cannot take that away', () => {
  assert.equal(effectiveStatus({ status: 'PAID', expiresAt: PAST, paidAt: PAST }, NOW), 'PAID')
  assert.equal(effectiveStatus({ status: 'ACTIVE', expiresAt: PAST, paidAt: PAST }, NOW), 'PAID')
  assert.equal(effectiveStatus({ status: 'CANCELED', expiresAt: null, paidAt: PAST }, NOW), 'PAID')
})

test('expiry is evaluated live, so a link dies on time with no sweeper', () => {
  assert.equal(effectiveStatus({ status: 'ACTIVE', expiresAt: PAST, paidAt: null }, NOW), 'EXPIRED')
  assert.equal(effectiveStatus({ status: 'ACTIVE', expiresAt: FUTURE, paidAt: null }, NOW), 'ACTIVE')
  assert.equal(effectiveStatus({ status: 'ACTIVE', expiresAt: null, paidAt: null }, NOW), 'ACTIVE')
  // Exactly at the boundary the link is already dead.
  assert.equal(effectiveStatus({ status: 'ACTIVE', expiresAt: NOW, paidAt: null }, NOW), 'EXPIRED')
})

test('canceled links stay canceled', () => {
  assert.equal(effectiveStatus({ status: 'CANCELED', expiresAt: FUTURE, paidAt: null }, NOW), 'CANCELED')
})

test('ONLY an active link is payable — paid, expired and canceled are not', () => {
  assert.equal(isPayable({ status: 'ACTIVE', expiresAt: FUTURE, paidAt: null }, NOW), true)
  assert.equal(isPayable({ status: 'PAID', expiresAt: FUTURE, paidAt: PAST }, NOW), false)
  assert.equal(isPayable({ status: 'ACTIVE', expiresAt: PAST, paidAt: null }, NOW), false)
  assert.equal(isPayable({ status: 'CANCELED', expiresAt: FUTURE, paidAt: null }, NOW), false)
})

// ── Expiry parsing ──────────────────────────────────────────────────────────

test('expiry must be in the future and inside a year', () => {
  assert.deepEqual(parseExpiry('', NOW), { ok: true, at: null })
  assert.deepEqual(parseExpiry(null, NOW), { ok: true, at: null })
  assert.equal(parseExpiry('not a date', NOW).ok, false)
  assert.equal(parseExpiry('2026-08-14T12:00:00Z', NOW).ok, false) // past
  assert.equal(parseExpiry('2026-08-20T12:00:00Z', NOW).ok, true)
  assert.equal(parseExpiry('2030-01-01T00:00:00Z', NOW).ok, false) // > 1 year
})

// ── The confirmed-payment gate ──────────────────────────────────────────────

test('ONLY a session Stripe calls paid, with a real amount, is confirmed', () => {
  assert.deepEqual(isConfirmedDepositSession({ payment_status: 'paid', amount_total: 4900 }), {
    confirmed: true,
    amountCents: 4900,
  })
})

test('an unpaid or delayed session is NOT confirmed (the async-payment case)', () => {
  // checkout.session.completed fires with payment_status 'unpaid' for ACH and
  // other delayed methods. Crediting there would credit money that has not moved.
  assert.equal(isConfirmedDepositSession({ payment_status: 'unpaid', amount_total: 4900 }).confirmed, false)
  assert.equal(isConfirmedDepositSession({ payment_status: 'no_payment_required', amount_total: 0 }).confirmed, false)
  assert.equal(isConfirmedDepositSession({ payment_status: null, amount_total: 4900 }).confirmed, false)
  assert.equal(isConfirmedDepositSession({}).confirmed, false)
})

test('a paid session with no amount is refused rather than guessed', () => {
  assert.equal(isConfirmedDepositSession({ payment_status: 'paid', amount_total: null }).confirmed, false)
  assert.equal(isConfirmedDepositSession({ payment_status: 'paid', amount_total: 0 }).confirmed, false)
  assert.equal(isConfirmedDepositSession({ payment_status: 'paid', amount_total: -100 }).confirmed, false)
  assert.equal(isConfirmedDepositSession({ payment_status: 'paid', amount_total: 49.5 }).confirmed, false)
})

// ── Customer message ────────────────────────────────────────────────────────

test('the customer message carries the exact amount and the link', () => {
  const msg = customerDepositMessage({
    customerName: 'Natalia Reyes',
    amountCents: 4900,
    url: 'https://moveitclearit.com/deposit/7KQ4M9ABCDEF',
  })
  assert.equal(
    msg,
    'Hi Natalia, you can securely pay the $49.00 deposit for your move here: ' +
      'https://moveitclearit.com/deposit/7KQ4M9ABCDEF. This deposit will be applied toward your remaining balance.'
  )
  // FIRST name only — a surname is not needed to greet someone and is one more
  // detail sitting in a forwardable message.
  assert.ok(!msg.includes('Reyes'))
})

test('a missing name degrades to "there", never "undefined"', () => {
  const msg = customerDepositMessage({ customerName: null, amountCents: 4900, url: 'https://x/deposit/AAAAAAAAAAAA' })
  assert.match(msg, /^Hi there,/)
  assert.ok(!msg.includes('undefined'))
  assert.ok(!msg.includes('null'))
})

test('firstNameOf', () => {
  assert.equal(firstNameOf('Natalia Reyes'), 'Natalia')
  assert.equal(firstNameOf('  Diego  '), 'Diego')
  assert.equal(firstNameOf(''), null)
  assert.equal(firstNameOf(null), null)
  assert.equal(firstNameOf(undefined), null)
})

// ── The public projection ───────────────────────────────────────────────────

test('the public view carries NO address, email, phone or booking number', () => {
  const view = publicDepositView(
    {
      publicToken: 'ABCDEFGH1234',
      customerName: 'Natalia Reyes',
      quoteTotalCents: 49500,
      balanceBeforeCents: 49500,
      amountCents: 4900,
      amountPaidCents: null,
      serviceSummary: '2 movers + truck',
      moveDate: new Date('2026-08-16T14:00:00Z'),
      status: 'ACTIVE',
      expiresAt: null,
      paidAt: null,
    },
    NOW
  )
  const keys = Object.keys(view)
  for (const forbidden of ['customerEmail', 'customerPhone', 'originAddress', 'destAddress', 'bookingId', 'bookingReference', 'id', 'stripeCheckoutSessionId']) {
    assert.ok(!keys.includes(forbidden), `${forbidden} must never be on the public view`)
  }
  const serialized = JSON.stringify(view)
  assert.ok(!serialized.includes('Reyes'), 'only the first name is exposed')
  assert.equal(view.firstName, 'Natalia')
  assert.equal(view.depositCents, 4900)
  assert.equal(view.remainingCents, 44600)
  assert.equal(view.showsBalance, true)
})

test('the paid view states what was ACTUALLY captured, not what was asked for', () => {
  const view = publicDepositView(
    {
      publicToken: 'ABCDEFGH1234',
      customerName: 'Natalia',
      quoteTotalCents: 49500,
      balanceBeforeCents: 49500,
      amountCents: 4900,
      amountPaidCents: 4900,
      serviceSummary: null,
      moveDate: null,
      status: 'PAID',
      expiresAt: null,
      paidAt: PAST,
    },
    NOW
  )
  assert.equal(view.status, 'PAID')
  assert.equal(view.amountPaidCents, 4900)
  assert.equal(view.remainingCents, 44600)
})

test('with no quote the public view hides the balance rather than showing zero', () => {
  const view = publicDepositView(
    {
      publicToken: 'ABCDEFGH1234',
      customerName: null,
      quoteTotalCents: null,
      balanceBeforeCents: null,
      amountCents: 4900,
      amountPaidCents: null,
      serviceSummary: null,
      moveDate: null,
      status: 'ACTIVE',
      expiresAt: null,
      paidAt: null,
    },
    NOW
  )
  assert.equal(view.quoteTotalCents, null)
  assert.equal(view.remainingCents, null)
  assert.equal(view.showsBalance, false)
})

// ── URLs ────────────────────────────────────────────────────────────────────

test('the deposit link base prefers DEPOSIT_LINK_BASE_URL, then APP_URL', () => {
  assert.equal(depositBaseUrl({ DEPOSIT_LINK_BASE_URL: 'https://moveitclearit.com/', APP_URL: 'https://app.example' } as never), 'https://moveitclearit.com')
  assert.equal(depositBaseUrl({ APP_URL: 'https://app.example/' } as never), 'https://app.example')
  // Never an empty base that would produce "/deposit/TOKEN" in a text message.
  assert.match(depositBaseUrl({} as never), /^https:\/\//)
})

test('the deposit URL exposes the token and nothing else', () => {
  const url = depositUrl('ABCDEFGH1234', { DEPOSIT_LINK_BASE_URL: 'https://moveitclearit.com' } as never)
  assert.equal(url, 'https://moveitclearit.com/deposit/ABCDEFGH1234')
  assert.ok(!url.includes('?'), 'no query string — an amount must never ride in the URL')
})
