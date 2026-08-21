// ════════════════════════════════════════════════════════════════════════════
//  move-date.test.ts — THE regression suite for the wrong-day bug.
//  ------------------------------------------------------------------------
//  REPORTED 2026-08-20, link SACBX6T8SZHB: the owner entered Saturday
//  22 August 2026 and the customer's deposit page rendered "August 21, 2026".
//
//  Everything here is offline: no database, no network, no Stripe. The whole
//  point of move-date.ts is that the rule is pure and can be proven at a desk.
//
//  THE SHAPE OF THE BUG, so a future reader does not have to reconstruct it:
//    · <input type="date">  emits "2026-08-22"
//    · new Date("2026-08-22") is UTC MIDNIGHT (ECMA-262 treats a date-ONLY
//      form as UTC, and a date-TIME form without an offset as LOCAL — that
//      inconsistency is the trap)
//    · rendering that instant in America/New_York is 8:00 PM the PREVIOUS day
//
//  Both halves are covered: new writes are anchored at noon UTC, and rows
//  already in production at 00:00 UTC still read back as the correct day.
// ════════════════════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseCalendarDate,
  parseMoveTime,
  moveDateParts,
  moveDateInputValue,
  moveTimeInputValue,
  formatMoveDateLong,
  formatMoveDatePlain,
  formatMoveWhen,
  formatMoveTime,
  anchorFromInstant,
  easternTimeMinutes,
  parseEtDateTimeLocal,
  etWallClockToInstant,
  wouldShiftDay,
  MAX_TIME_MINUTES,
} from '../move-date'
import { publicDepositView, parseExpiry, alreadyPaidCents, parseMoveDetails, cleanCustomerText } from '../deposit-links'

// ── THE REPORTED FAILURE ────────────────────────────────────────────────────

test('THE BUG: admin picks 2026-08-22, the customer sees August 22 — never August 21', () => {
  const stored = parseCalendarDate('2026-08-22')
  assert.ok(stored, 'the admin form value must parse')

  const shown = formatMoveDateLong(stored, 'en')
  assert.equal(shown, 'Saturday, August 22, 2026')
  assert.ok(!shown!.includes('August 21'), 'the reported defect must not recur')
  assert.equal(formatMoveDatePlain(stored, 'en'), 'August 22, 2026')

  // And the day the owner typed is the day that comes back out.
  assert.deepEqual(moveDateParts(stored!), { year: 2026, month: 8, day: 22 })
  assert.equal(moveDateInputValue(stored), '2026-08-22')
})

test('THE LEGACY ROW: a value already stored at 00:00 UTC still reads as its own day', () => {
  // This is EXACTLY what `new Date("2026-08-22")` wrote before the fix, and
  // what the reported link holds in production right now. It is repaired by the
  // read rule, so no customer's row has to be edited by hand.
  const legacy = new Date('2026-08-22T00:00:00.000Z')

  // What the page used to do, reproduced here so the regression is unmistakable:
  const oldRendering = legacy.toLocaleDateString('en-US', {
    timeZone: 'America/New_York',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })
  assert.equal(oldRendering, 'August 21, 2026', 'this is the bug, reproduced')

  // What it does now:
  assert.equal(formatMoveDateLong(legacy, 'en'), 'Saturday, August 22, 2026')
  assert.ok(wouldShiftDay(legacy), 'and the repair rule correctly identifies this shape')
})

test('a noon-UTC anchor is NOT flagged as a shifting value', () => {
  const anchored = parseCalendarDate('2026-08-22')!
  assert.equal(anchored.toISOString(), '2026-08-22T12:00:00.000Z')
  assert.equal(wouldShiftDay(anchored), false, 'noon UTC is the same day in Eastern')
})

// ── DST AND YEAR BOUNDARIES ─────────────────────────────────────────────────

test('every calendar day of 2026 survives a round trip, DST included', () => {
  // 2026 US DST: forward Sunday 8 March, back Sunday 1 November.
  let checked = 0
  for (let month = 1; month <= 12; month++) {
    const daysInMonth = new Date(Date.UTC(2026, month, 0)).getUTCDate()
    for (let day = 1; day <= daysInMonth; day++) {
      const iso = `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
      const anchored = parseCalendarDate(iso)
      assert.ok(anchored, `${iso} must parse`)
      assert.equal(moveDateInputValue(anchored), iso, `${iso} must round-trip`)

      // And the legacy shape for the same day reads back as the same day.
      const legacy = new Date(`${iso}T00:00:00.000Z`)
      assert.equal(moveDateInputValue(legacy), iso, `legacy ${iso} must read back as ${iso}`)
      checked++
    }
  }
  assert.equal(checked, 365, '2026 is not a leap year')
})

test('the DST transition days themselves render correctly', () => {
  const cases: Array<[string, string]> = [
    ['2026-03-07', 'Saturday, March 7, 2026'],
    ['2026-03-08', 'Sunday, March 8, 2026'], // clocks spring forward
    ['2026-03-09', 'Monday, March 9, 2026'],
    ['2026-10-31', 'Saturday, October 31, 2026'],
    ['2026-11-01', 'Sunday, November 1, 2026'], // clocks fall back
    ['2026-11-02', 'Monday, November 2, 2026'],
  ]
  for (const [iso, expected] of cases) {
    assert.equal(formatMoveDateLong(parseCalendarDate(iso), 'en'), expected, iso)
    // The legacy midnight-UTC shape of the same day, too.
    assert.equal(formatMoveDateLong(new Date(`${iso}T00:00:00.000Z`), 'en'), expected, `legacy ${iso}`)
  }
})

test('year boundaries do not roll backwards', () => {
  assert.equal(formatMoveDateLong(parseCalendarDate('2026-01-01'), 'en'), 'Thursday, January 1, 2026')
  assert.equal(formatMoveDateLong(parseCalendarDate('2026-12-31'), 'en'), 'Thursday, December 31, 2026')
  assert.equal(formatMoveDateLong(new Date('2027-01-01T00:00:00.000Z'), 'en'), 'Friday, January 1, 2027')
})

test('a leap day is accepted in a leap year and refused in a common one', () => {
  assert.ok(parseCalendarDate('2028-02-29'), '2028 is a leap year')
  assert.equal(parseCalendarDate('2027-02-29'), null, 'Feb 29 2027 does not exist')
  // Date.UTC would silently roll these over into the next month.
  assert.equal(parseCalendarDate('2026-02-31'), null)
  assert.equal(parseCalendarDate('2026-04-31'), null)
  assert.equal(parseCalendarDate('2026-13-01'), null)
  assert.equal(parseCalendarDate('2026-00-10'), null)
})

test('garbage never becomes a date', () => {
  for (const bad of ['', '  ', 'tomorrow', '08/22/2026', '2026-8-2', '26-08-22', null, undefined, 42, {}]) {
    assert.equal(parseCalendarDate(bad as unknown), null, String(bad))
  }
  assert.equal(parseCalendarDate('1999-08-22'), null, 'out of the supported range')
  assert.equal(parseCalendarDate('2101-08-22'), null, 'out of the supported range')
})

// ── REAL INSTANTS (a booking's requestedDate) ───────────────────────────────

test('an instant carrying a real Eastern time keeps its Eastern day', () => {
  // 7:00 AM ET on 22 Aug 2026 (EDT, UTC-4).
  const morning = new Date('2026-08-22T11:00:00.000Z')
  assert.deepEqual(moveDateParts(morning), { year: 2026, month: 8, day: 22 })
  assert.equal(easternTimeMinutes(morning), 7 * 60)

  // 8:30 PM ET the same day is already the 23rd in UTC — and must still be the
  // 22nd to the customer.
  const evening = new Date('2026-08-23T00:30:00.000Z')
  assert.equal(formatMoveDateLong(evening, 'en'), 'Saturday, August 22, 2026')
  assert.equal(easternTimeMinutes(evening), 20 * 60 + 30)
})

test('inheriting from a booking re-anchors the date and splits out the time', () => {
  const requested = new Date('2026-08-23T00:30:00.000Z') // 8:30 PM ET, 22 Aug
  const anchor = anchorFromInstant(requested)
  assert.equal(anchor!.toISOString(), '2026-08-22T12:00:00.000Z', 'stored as a calendar date')
  assert.equal(easternTimeMinutes(requested), 1230, 'the time is kept separately')
  assert.equal(formatMoveWhen(anchor, 1230, 'en'), 'Saturday, August 22 · 8:30 PM')
})

// ── THE MOVE TIME ───────────────────────────────────────────────────────────

test('a move time parses from every shape the owner might type', () => {
  assert.equal(parseMoveTime('07:00'), 420)
  assert.equal(parseMoveTime('7:00 AM'), 420)
  assert.equal(parseMoveTime('7 am'), 420)
  assert.equal(parseMoveTime('7 pm'), 1140)
  assert.equal(parseMoveTime('12:00 AM'), 0, 'midnight is zero, not 720')
  assert.equal(parseMoveTime('12:00 PM'), 720, 'noon is 720, not zero')
  assert.equal(parseMoveTime('23:59'), MAX_TIME_MINUTES)
  assert.equal(parseMoveTime(420), 420)
})

test('an impossible time is refused rather than guessed', () => {
  for (const bad of ['24:00', '25:00', '7:60', '13:00 PM', 'noon', '', 'abc', -1, 1440, 7.5, null]) {
    assert.equal(parseMoveTime(bad as unknown), null, String(bad))
  }
})

test('the time round-trips to the <input type="time"> value', () => {
  assert.equal(moveTimeInputValue(420), '07:00')
  assert.equal(moveTimeInputValue(0), '00:00')
  assert.equal(moveTimeInputValue(MAX_TIME_MINUTES), '23:59')
  assert.equal(moveTimeInputValue(null), '')
  assert.equal(moveTimeInputValue(1440), '', 'out of range yields no value, never a wrong one')
})

test('the headline line reads the way the owner asked for it', () => {
  const at = parseCalendarDate('2026-08-22')
  assert.equal(formatMoveWhen(at, 420, 'en'), 'Saturday, August 22 · 7:00 AM')
  // No time recorded ⇒ the year stays, because a bare weekday is ambiguous.
  assert.equal(formatMoveWhen(at, null, 'en'), 'Saturday, August 22, 2026')
  assert.equal(formatMoveWhen(null, 420, 'en'), null, 'a time with no date says nothing')
})

// ── SPANISH ─────────────────────────────────────────────────────────────────

test('Spanish renders the date and time naturally, not as translated English', () => {
  const at = parseCalendarDate('2026-08-22')
  const long = formatMoveDateLong(at, 'es')!
  assert.match(long, /s[áa]bado/i, 'the weekday is Spanish')
  assert.match(long, /agosto/, 'the month is Spanish')
  assert.match(long, /22/, 'and it is still the 22nd')
  assert.ok(!/August|Saturday/.test(long), 'no English leaks through')

  // Spanish does not capitalise weekday or month names.
  assert.ok(!/^[A-ZÁÉÍÓÚÑ]/.test(long), `es weekday must be lower case, got "${long}"`)

  const when = formatMoveWhen(at, 420, 'es')!
  assert.match(when, /7:00/, 'the time is present')
  assert.match(when, /·/, 'the separator is shared with English')
  assert.ok(!/AM|PM/.test(when), 'Spanish uses a. m. / p. m., not AM/PM')
  assert.match(formatMoveTime(1140, 'es')!, /p\.?\s?m/i)
})

test('both languages agree on WHICH DAY it is', () => {
  for (const iso of ['2026-08-22', '2026-03-08', '2026-11-01', '2026-12-31']) {
    const at = parseCalendarDate(iso)
    const day = String(Number(iso.slice(8, 10)))
    assert.match(formatMoveDateLong(at, 'en')!, new RegExp(`\\b${day}\\b`), `en ${iso}`)
    assert.match(formatMoveDateLong(at, 'es')!, new RegExp(`\\b${day}\\b`), `es ${iso}`)
  }
})

// ── THE LINK EXPIRY (a different concept, on purpose) ───────────────────────

test('THE SECOND TIMEZONE BUG: an expiry the owner picks is EASTERN, not the server clock', () => {
  // The admin field is <input type="datetime-local">, which emits no offset.
  // `new Date("2026-08-22T23:00")` is server-local — UTC in production — so an
  // 11 PM expiry died at 7 PM Eastern while the customer was trying to pay.
  const at = parseEtDateTimeLocal('2026-08-22T23:00')
  assert.ok(at)
  // 11 PM EDT = 03:00 UTC the next day.
  assert.equal(at!.toISOString(), '2026-08-23T03:00:00.000Z')

  // In winter the same wall clock is EST (UTC-5).
  assert.equal(parseEtDateTimeLocal('2026-01-15T23:00')!.toISOString(), '2026-01-16T04:00:00.000Z')
})

test('the expiry parser is DST-correct on both transition days', () => {
  // 2026-03-08: clocks jump 2am -> 3am EST->EDT.
  assert.equal(etWallClockToInstant(2026, 3, 8, 1, 0).toISOString(), '2026-03-08T06:00:00.000Z')
  assert.equal(etWallClockToInstant(2026, 3, 8, 12, 0).toISOString(), '2026-03-08T16:00:00.000Z')
  // 2026-11-01: clocks fall back 2am -> 1am EDT->EST.
  assert.equal(etWallClockToInstant(2026, 11, 1, 12, 0).toISOString(), '2026-11-01T17:00:00.000Z')
})

test('a value that already carries an offset is left alone', () => {
  assert.equal(parseEtDateTimeLocal('2026-08-22T23:00:00Z')!.toISOString(), '2026-08-22T23:00:00.000Z')
})

test('parseExpiry keeps its bounds and now reads Eastern', () => {
  const now = new Date('2026-08-20T12:00:00.000Z')
  const ok = parseExpiry('2026-08-22T23:00', now)
  assert.ok(ok.ok && ok.at)
  assert.equal((ok as { at: Date }).at.toISOString(), '2026-08-23T03:00:00.000Z')

  assert.equal(parseExpiry('', now).ok, true, 'blank means no expiry')
  assert.equal((parseExpiry('', now) as { at: Date | null }).at, null)
  assert.equal(parseExpiry('2020-01-01T10:00', now).ok, false, 'the past is refused')
  assert.equal(parseExpiry('2030-01-01T10:00', now).ok, false, 'more than a year out is refused')
  assert.equal(parseExpiry('not a date', now).ok, false)
})

test('the move date and the link expiry are genuinely independent', () => {
  // A link that expires long before the move is legitimate — pay now, move later
  // — and nothing in either parser couples them.
  const move = parseCalendarDate('2026-12-24')
  const expiry = parseExpiry('2026-08-25T17:00', new Date('2026-08-20T12:00:00.000Z'))
  assert.ok(expiry.ok && expiry.at)
  assert.ok(move!.getTime() > (expiry as { at: Date }).at.getTime())
  assert.equal(formatMoveDateLong(move, 'en'), 'Thursday, December 24, 2026')
})

// ── THE PUBLIC VIEW: what a customer can and cannot be shown ────────────────

const ROW = {
  publicToken: 'SACBX6T8SZHB',
  customerName: 'Rosey Alvarez',
  quoteTotalCents: 49500,
  balanceBeforeCents: 49500,
  amountCents: 4900,
  serviceSummary: 'Labor-Only Move · 2 Movers',
  moveDetails: ['Apartment next door', '15 stairs at pickup · 7 stairs at drop-off'],
  customerNote: 'Customer to provide all necessary hardware/screws.',
  internalNote: 'Job Note: Saturday, 7:00 AM — 2 workers, labor-only move, park in the rear lot, code 4417.',
  moveDate: new Date('2026-08-22T00:00:00.000Z'), // the LEGACY shape, on purpose
  moveTimeMinutes: 420,
  status: 'ACTIVE',
  expiresAt: null,
  paidAt: null,
}

test('the public view renders the owner-entered day, from a legacy row', () => {
  const view = publicDepositView(ROW, new Date('2026-08-20T12:00:00.000Z'))
  assert.equal(formatMoveWhen(view.moveDate, view.moveTimeMinutes, 'en'), 'Saturday, August 22 · 7:00 AM')
})

test('THE INTERNAL NOTE CANNOT REACH THE CUSTOMER', () => {
  const view = publicDepositView(ROW, new Date('2026-08-20T12:00:00.000Z'))
  // Not by name...
  assert.ok(!('internalNote' in view), 'the projection has no internalNote field at all')
  // ...and not by value, anywhere in the object.
  const serialized = JSON.stringify(view)
  assert.ok(!serialized.includes('Job Note'), 'the crew note must not appear in the public view')
  assert.ok(!serialized.includes('4417'), 'nor any part of it')
  // The customer-facing fields ARE there.
  assert.equal(view.serviceSummary, 'Labor-Only Move · 2 Movers')
  assert.deepEqual(view.moveDetails, ['Apartment next door', '15 stairs at pickup · 7 stairs at drop-off'])
  assert.equal(view.customerNote, 'Customer to provide all necessary hardware/screws.')
})

test('the public view still carries no contact detail or internal id', () => {
  const view = publicDepositView(
    { ...ROW, customerName: 'Rosey Alvarez' },
    new Date('2026-08-20T12:00:00.000Z')
  )
  const serialized = JSON.stringify(view)
  for (const leak of ['Alvarez', '@', 'bookingId', 'stripe', 'customerEmail', 'customerPhone']) {
    assert.ok(!serialized.toLowerCase().includes(leak.toLowerCase()), `${leak} must not be in the public view`)
  }
  assert.equal(view.firstName, 'Rosey', 'only the first name is public')
})

// ── CUSTOMER-FACING TEXT IS BOUNDED ─────────────────────────────────────────

test('move details are a bounded LIST, so the page cannot grow a wall of text', () => {
  const typed = [
    '- Apartment next door',
    '* Old wooden bed frame removal',
    '• New queen bed frame assembly',
    '15 stairs at pickup · 7 stairs at drop-off',
    '',
    '   ',
    'Fifth line',
    'Sixth line',
    'Seventh line — beyond the cap',
  ].join('\n')
  const parsed = parseMoveDetails(typed)
  assert.equal(parsed.length, 6, 'capped at six bullets')
  assert.equal(parsed[0], 'Apartment next door', 'a typed bullet character is stripped')
  assert.equal(parsed[2], 'New queen bed frame assembly')
  assert.ok(!parsed.includes(''), 'blank lines are dropped')
  assert.ok(!parsed.some((d) => d.includes('Seventh')), 'the cap is enforced')
})

test('a pasted paragraph cannot break the layout', () => {
  const pasted = 'Job Note:\r\n\tSaturday, 7:00 AM — 2 workers,   labor-only   move'
  const cleaned = cleanCustomerText(pasted, 80)!
  assert.ok(!/[\r\n\t]/.test(cleaned), 'newlines and tabs are collapsed')
  assert.ok(!/ {2}/.test(cleaned), 'runs of spaces are collapsed')
  assert.ok(cleaned.length <= 80, 'and it is bounded')

  const long = 'x'.repeat(500)
  assert.equal(cleanCustomerText(long, 80)!.length, 80)
  assert.equal(cleanCustomerText('   ', 80), null, 'whitespace-only is nothing')
  assert.equal(cleanCustomerText(null, 80), null)
})

// ── THE MONEY ON THE PAGE MUST SUBTRACT ─────────────────────────────────────

test('THE WORKED EXAMPLE: 495 total, 49 deposit, 446 remaining', () => {
  const view = publicDepositView(
    { ...ROW, quoteTotalCents: 49500, balanceBeforeCents: 49500 },
    new Date('2026-08-20T12:00:00.000Z')
  )
  assert.equal(view.quoteTotalCents, 49500)
  assert.equal(view.depositCents, 4900)
  assert.equal(view.remainingCents, 44600)
  assert.equal(view.alreadyPaidCents, null, 'nothing collected yet, so no row is shown')
  // The three visible figures reconcile exactly.
  assert.equal(view.quoteTotalCents! - view.depositCents, view.remainingCents)
})

test('when money was already collected, the page names it so the figures still subtract', () => {
  // An approved booking has already captured the $49 hold: finalBilled 49500,
  // outstanding 44600. The page used to show 495 / 49 / 397 and account for
  // nothing in between.
  const view = publicDepositView(
    { ...ROW, quoteTotalCents: 49500, balanceBeforeCents: 44600 },
    new Date('2026-08-20T12:00:00.000Z')
  )
  assert.equal(view.quoteTotalCents, 49500)
  assert.equal(view.alreadyPaidCents, 4900, 'the money already in is named')
  assert.equal(view.depositCents, 4900)
  assert.equal(view.remainingCents, 39700)
  assert.equal(
    view.quoteTotalCents! - view.alreadyPaidCents! - view.depositCents,
    view.remainingCents,
    'quote - already paid - deposit = remaining'
  )
})

test('alreadyPaid stays silent when there is nothing honest to say', () => {
  assert.equal(alreadyPaidCents({ quoteTotalCents: null, balanceBeforeCents: null, amountCents: 4900 }), null)
  assert.equal(alreadyPaidCents({ quoteTotalCents: 49500, balanceBeforeCents: null, amountCents: 4900 }), null)
  assert.equal(alreadyPaidCents({ quoteTotalCents: 49500, balanceBeforeCents: 49500, amountCents: 4900 }), null)
  // A balance LARGER than the total is a data problem, not a negative payment.
  assert.equal(alreadyPaidCents({ quoteTotalCents: 40000, balanceBeforeCents: 49500, amountCents: 4900 }), null)
})

test('with no quote total the money section simply says less', () => {
  const view = publicDepositView(
    { ...ROW, quoteTotalCents: null, balanceBeforeCents: null },
    new Date('2026-08-20T12:00:00.000Z')
  )
  assert.equal(view.quoteTotalCents, null)
  assert.equal(view.remainingCents, null, 'hidden, never rendered as $0.00')
  assert.equal(view.alreadyPaidCents, null)
  assert.equal(view.showsBalance, false)
  assert.equal(view.depositCents, 4900, 'the deposit is still stated')
})

// ── MISSING AND EMPTY VALUES ────────────────────────────────────────────────

test('a sparse row renders nothing rather than something wrong', () => {
  const view = publicDepositView(
    {
      publicToken: 'SACBX6T8SZHB',
      amountCents: 4900,
      status: 'ACTIVE',
    },
    new Date('2026-08-20T12:00:00.000Z')
  )
  assert.equal(view.firstName, null)
  assert.equal(view.serviceSummary, null)
  assert.deepEqual(view.moveDetails, [])
  assert.equal(view.customerNote, null)
  assert.equal(view.moveDate, null)
  assert.equal(view.moveTimeMinutes, null)
  assert.equal(formatMoveWhen(view.moveDate, view.moveTimeMinutes, 'en'), null)
  assert.equal(formatMoveWhen(view.moveDate, view.moveTimeMinutes, 'es'), null)
})

test('an out-of-range stored time is ignored rather than displayed', () => {
  const view = publicDepositView(
    { ...ROW, moveTimeMinutes: 9999 },
    new Date('2026-08-20T12:00:00.000Z')
  )
  assert.equal(view.moveTimeMinutes, null)
  assert.equal(formatMoveWhen(view.moveDate, view.moveTimeMinutes, 'en'), 'Saturday, August 22, 2026')
})

test('null and invalid dates never throw and never invent a day', () => {
  assert.equal(formatMoveDateLong(null, 'en'), null)
  assert.equal(formatMoveDateLong(undefined, 'en'), null)
  assert.equal(formatMoveDateLong(new Date('nonsense'), 'en'), null)
  assert.equal(moveDateParts(new Date('nonsense')), null)
  assert.equal(moveDateInputValue(new Date('nonsense')), '')
  assert.equal(anchorFromInstant(null), null)
  assert.equal(easternTimeMinutes(null), null)
})
