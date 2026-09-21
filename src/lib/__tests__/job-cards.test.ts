import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildBookingRequestCard,
  buildCrewJobCard,
  buildDailyDigest,
  buildOwnerJobCard,
  crewFromAssignments,
  toCrewView,
  type JobBookingInput,
} from '../job-cards'
import { approvalCardDataFromBooking } from '../booking-display'
import { TONE, bookingStage, fieldIf, holdLine, isBlank, moveDayLabel, moveTimeLabel, cityState } from '../discord-ui'

// ════════════════════════════════════════════════════════════════════════════
//  One job, two audiences.
//
//  The crew card lives in a channel every 📦 Mover can read, so the tests below
//  do not check a list of fields that SHOULD be absent — they walk EVERY string
//  the card produces and fail on anything shaped like money, contact details, a
//  street address, an access code or a Stripe id.
// ════════════════════════════════════════════════════════════════════════════

/** A booking carrying every sensitive value the schema can hold. */
const SECRETS = {
  email: 'john.smith@example.com',
  phone: '9735550142',
  street: '48 Lindsley Avenue',
  destStreet: '1200 Walnut Street',
  accessCode: '#4471',
  paymentIntent: 'pi_3QxSecretIntent99',
  checkout: 'cs_live_SecretCheckout',
  internalNote: 'Customer haggled — do not discount further',
}

function booking(over: Partial<JobBookingInput> & Record<string, unknown> = {}): JobBookingInput {
  return {
    id: 'ckbooking000000000000001019',
    displayId: 'WMIC-1019',
    bookingReference: 'WMIC-1019',
    status: 'CONFIRMED',
    customer: { name: 'John Smith', phone: SECRETS.phone, email: SECRETS.email },
    // 2:00 PM Eastern on Tuesday 22 September 2026 (EDT = UTC−4).
    requestedDate: new Date('2026-09-22T18:00:00Z'),
    originAddress: `${SECRETS.street}, Orange, NJ 07050`,
    destAddress: `${SECRETS.destStreet}, Philadelphia, PA 19107`,
    originCity: 'Orange',
    originState: 'NJ',
    destCity: 'Philadelphia',
    destState: 'PA',
    originUnit: '4B',
    originFloor: 2,
    originStairCount: 15,
    originHasElevator: false,
    destFloor: 1,
    destHasElevator: true,
    serviceTypeKey: 'full_service',
    moveSizeKey: '2br',
    truckSize: '15-ft',
    laborWorkers: 3,
    hasSafe: true,
    hasAppliances: true,
    needsDisassembly: true,
    disassemblyItems: 'king bed frame',
    needsPacking: true,
    equipmentNeeds: 'Appliance dolly, moving straps',
    crewInstructions: 'Use the side entrance. Dog in the yard.',
    totalEstimate: 1250,
    baseRate: 1250,
    depositAmount: 4900,
    depositPaid: true,
    payments: [{ amount: 4900, status: 'COMPLETED', receiptUrl: 'https://pay.stripe.com/receipts/secret-receipt' }],
    // Sensitive columns a careless spread would carry along:
    originAccessCode: SECRETS.accessCode,
    destAccessCode: SECRETS.accessCode,
    stripePaymentIntentId: SECRETS.paymentIntent,
    stripeCheckoutId: SECRETS.checkout,
    internalNotes: SECRETS.internalNote,
    customerNotes: `call me on ${SECRETS.phone}`,
    job: {
      crewNotes: 'Bring extra blankets.',
      staffingReq: { requiredWorkers: 3 },
      crew: [
        { assignmentStatus: 'ASSIGNED', role: 'CREW_MEMBER', user: { name: 'Marcus Reed' }, isDriver: true },
        { assignmentStatus: 'ACCEPTED', role: 'CREW_LEADER', user: { name: 'Diego Vasquez' }, reportTime: new Date('2026-09-22T17:30:00Z') },
        { assignmentStatus: 'DECLINED', role: 'CREW_MEMBER', user: { name: 'Nobody Here' } },
      ],
    },
    ...over,
  } as JobBookingInput
}

/**
 * Every string a READER can see anywhere in the payload, including button
 * labels and URLs.
 *
 * `timestamp` is skipped: Discord renders it as a relative time, never as text,
 * and its value is the wall clock. Scanning it made the "no bare 49" check below
 * fail whenever the test ran at second or minute :49 — observed in CI on
 * 2026-09-21 at 11:13:49.996Z, on a card that contained no money at all.
 */
function everyString(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const v of value) everyString(v, out)
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) if (k !== 'timestamp') everyString(v, out)
  }
  return out
}

/** The exact instant the unscoped scan failed in CI — a timestamp full of "49". */
const CLOCK_FULL_OF_49 = '2026-09-21T11:13:49.996Z'

const field = (card: { embeds: Array<{ fields?: Array<{ name: string; value: string }> }> }, name: string): string | undefined =>
  card.embeds[0].fields?.find((f) => f.name === name)?.value

// ── CREW CARD: what it must never carry ─────────────────────────────────────

test('the crew card contains NO money — no $ anywhere, no total, deposit, balance or fee', () => {
  const card = buildCrewJobCard(booking({ waitingMinutes: 42 } as never), { waitingFeeLine: 'Waiting fee $25.00 (move day)' })
  // Pin the clock to the value that made this test flaky, so the assertions
  // below are deterministic and prove the SCAN — not the time of day — is right.
  card.embeds[0].timestamp = CLOCK_FULL_OF_49
  const text = everyString(card).join('\n')
  assert.doesNotMatch(text, /\$/, 'a dollar sign on the crew card is a leak')
  assert.doesNotMatch(text, /\b(total|deposit|balance|remaining|paid|captured|authorized|estimate|fee|refund|profit|margin)\b/i)
  assert.doesNotMatch(text, /1,?250|\b49\b/, 'the job total and the hold amount must not appear as bare numbers either')
})

test('the crew card contains NO customer contact details and only the FIRST name', () => {
  const text = everyString(buildCrewJobCard(booking())).join('\n')
  assert.ok(!text.includes(SECRETS.email), 'customer email')
  assert.doesNotMatch(text, /973[\s().-]*555[\s.-]*0142/, 'customer phone, in any formatting')
  assert.ok(!text.includes('Smith'), 'surname')
  assert.match(text, /\bJohn\b/)
})

test('the crew card contains NO street address — city and state only, and no navigation link', () => {
  const card = buildCrewJobCard(booking())
  const text = everyString(card).join('\n')
  assert.ok(!text.includes(SECRETS.street) && !text.includes('Lindsley'), 'pickup street')
  assert.ok(!text.includes(SECRETS.destStreet) && !text.includes('Walnut'), 'drop-off street')
  assert.doesNotMatch(text, /maps|google\.com/i, 'a maps link would carry the street address')
  assert.equal(field(card, 'ROUTE'), 'Orange, NJ\n→ Philadelphia, PA')
})

test('the crew card contains NO access codes, Stripe ids, receipts, internal notes or admin links', () => {
  const text = everyString(buildCrewJobCard(booking(), { adminUrl: 'https://admin.example/admin/bookings' })).join('\n')
  assert.ok(!text.includes(SECRETS.accessCode), 'gate / lockbox code')
  assert.doesNotMatch(text, /\b(pi|cs|ch|cus|pm)_[A-Za-z0-9]/, 'Stripe identifier')
  assert.doesNotMatch(text, /stripe|receipt/i)
  assert.ok(!text.includes(SECRETS.internalNote), 'private owner note')
  assert.ok(!text.includes('call me on'), "the customer's free-text notes are not crew notes")
  assert.doesNotMatch(text, /admin/i, 'crew have no admin login; the link is owner-only')
})

test('the crew view TYPE has nowhere to put money or contact details', () => {
  const keys = Object.keys(toCrewView(booking()))
  for (const banned of ['total', 'price', 'amount', 'deposit', 'balance', 'email', 'phone', 'address', 'accesscode', 'stripe', 'payment']) {
    assert.ok(!keys.some((k) => k.toLowerCase().includes(banned)), `CrewJobView must not grow a "${banned}" field`)
  }
})

// ── CREW CARD: what it must carry ───────────────────────────────────────────

test('the crew card answers: where, when, who with, what truck, what equipment, stairs, heavy items, assembly', () => {
  const card = buildCrewJobCard(booking())
  const e = card.embeds[0]
  assert.equal(e.title, '🚚 MOVE IT CLEAR IT')
  assert.match(String(e.description), /🟢 \*\*CONFIRMED\*\*/)
  assert.match(String(e.description), /## Tuesday, September 22/, 'the date is the largest line on the card')
  assert.match(String(e.description), /2:00 PM/)
  assert.equal(field(card, 'CUSTOMER'), 'John')
  assert.match(String(field(card, 'JOB')), /Full-Service Move · 2 Bedrooms/)
  assert.match(String(field(card, 'JOB')), /15-ft truck/)
  assert.equal(field(card, 'PICKUP ACCESS'), '2nd floor · 15 stairs · No elevator · Unit 4B')
  assert.equal(field(card, 'DROP-OFF ACCESS'), 'Ground floor · Elevator')
  assert.equal(field(card, 'HEAVY / SPECIAL ITEMS'), 'Safe · Appliances')
  assert.match(String(field(card, 'SERVICES')), /Packing/)
  assert.match(String(field(card, 'SERVICES')), /Disassembly — king bed frame/)
  assert.equal(field(card, 'EQUIPMENT'), 'Appliance dolly, moving straps')
  assert.match(String(field(card, 'CREW NOTES')), /side entrance/)
  assert.match(String(field(card, 'CREW NOTES')), /extra blankets/)
})

test('assigned crew come from JobCrew: lead first, driver tagged, declined people dropped, first names only', () => {
  const crew = crewFromAssignments(booking().job?.crew)
  assert.deepEqual(crew.map((c) => c.name), ['Diego', 'Marcus'])
  assert.equal(crew[0].lead, true)
  assert.equal(crew[0].reportTime, '1:30 PM')
  assert.equal(crew[1].driver, true)
  const value = String(field(buildCrewJobCard(booking()), 'CREW'))
  assert.equal(value, '3 movers\nDiego (lead) · report 1:30 PM\nMarcus (driver)')
  assert.ok(!value.includes('Nobody'), 'a DECLINED assignment is not on the job')
})

test('crew size is never invented: laborWorkers is a COUNT, and no count means no line', () => {
  const none = booking({ laborWorkers: null, job: { crew: [] } } as never)
  assert.equal(field(buildCrewJobCard(none), 'CREW'), undefined, 'no count and nobody assigned ⇒ the field does not exist')
  const countOnly = booking({ laborWorkers: 2, job: { crew: [] } } as never)
  assert.equal(field(buildCrewJobCard(countOnly), 'CREW'), '2 movers', 'a count names nobody')
})

test('the move-day buttons keep the custom_ids the interactions route already handles', () => {
  const ids = (status: string): string[] => buildCrewJobCard(booking({ status })).components.flatMap((r) => r.components.map((c) => c.custom_id ?? ''))
  assert.deepEqual(ids('CONFIRMED').slice(0, 2), ['job_start:ckbooking000000000000001019', 'job_complete:ckbooking000000000000001019'])
  assert.ok(ids('CONFIRMED').includes('crew_arrived:ckbooking000000000000001019'))
  assert.deepEqual(ids('IN_PROGRESS')[0], 'job_complete:ckbooking000000000000001019')
  assert.deepEqual(ids('COMPLETED'), ['archive_job:ckbooking000000000000001019'])
  assert.deepEqual(ids('CANCELLED'), [], 'a cancelled job offers no actions')
})

// ── Optional fields are OMITTED, never rendered as noise ────────────────────

test('a sparse booking renders no null / undefined / N/A / empty headings on either card', () => {
  const sparse: JobBookingInput = { id: 'ck_sparse', status: 'CONFIRMED', customer: { name: 'Ana' } }
  for (const card of [buildCrewJobCard(sparse), buildOwnerJobCard(sparse)]) {
    const text = everyString(card).join('\n')
    assert.doesNotMatch(text, /\b(null|undefined|NaN)\b/)
    assert.doesNotMatch(text, /\bN\/A\b/i)
    for (const f of card.embeds[0].fields ?? []) {
      assert.ok(f.value.trim().length > 0, `field "${f.name}" is empty`)
      assert.notEqual(f.value.trim(), '—')
    }
    assert.match(String(card.embeds[0].description), /## Date to be confirmed/, 'an unknown date says so rather than printing nothing')
  }
  const names = (buildCrewJobCard(sparse).embeds[0].fields ?? []).map((f) => f.name)
  assert.deepEqual(names, ['CUSTOMER', 'JOB'], 'only what is known: the first name, and the service type the booking resolves to')
})

test('an elevator that was never asked about is not reported as "No elevator"', () => {
  const unknown = booking({ originHasElevator: null, originFloor: null, originStairCount: null, originUnit: null } as never)
  assert.equal(field(buildCrewJobCard(unknown), 'PICKUP ACCESS'), undefined)
})

test('fieldIf / isBlank: the optional-field rule itself', () => {
  for (const noise of [null, undefined, '', '  ', 'null', 'undefined', 'N/A', 'n/a', '—', '-', 'Unknown', 'TBD', Number.NaN]) {
    assert.equal(isBlank(noise), true, `${String(noise)} is noise`)
  }
  assert.equal(fieldIf('X', null), null)
  assert.equal(fieldIf('X', 'N/A'), null)
  assert.deepEqual(fieldIf('X', 'Piano', true), { name: 'X', value: 'Piano', inline: true })
})

// ── OWNER CARD ──────────────────────────────────────────────────────────────

test('the owner card leads with status, then date, then customer, route, job, access, payment', () => {
  const card = buildOwnerJobCard(booking(), { adminUrl: 'https://admin.example/admin/bookings' })
  const e = card.embeds[0]
  assert.equal(e.color, TONE.success)
  assert.match(String(e.description), /^🟢 \*\*JOB CONFIRMED\*\*\n\$49 captured\n## Tuesday, September 22\n2:00 PM$/)
  const order = (e.fields ?? []).map((f) => f.name)
  assert.deepEqual(order.slice(0, 3), ['CUSTOMER', 'ROUTE', 'JOB'])
  assert.ok(order.indexOf('PICKUP ACCESS') < order.indexOf('PAYMENT'), 'difficulty before money')
  assert.equal(field(card, 'CUSTOMER'), 'John Smith\n(973) 555-0142')
  assert.equal(field(card, 'PAYMENT'), 'Total: $1,250\nPaid: $49\nRemaining: $1,201')
  assert.match(String(field(card, 'ADDRESSES')), /48 Lindsley Avenue/)
  assert.equal((e.footer as { text: string }).text, 'Move It Clear It • WMIC-1019')
})

test('the owner card flags a confirmed job with nobody assigned', () => {
  const card = buildOwnerJobCard(booking({ job: { crew: [] } } as never))
  assert.match(String(field(card, 'NEEDS ATTENTION')), /No crew assigned yet/)
  assert.equal(field(buildOwnerJobCard(booking()), 'NEEDS ATTENTION'), undefined, 'a staffed, clean job has nothing to flag')
})

test('the owner card never offers Approve / Deny — those exist only on a REQUEST', () => {
  const ids = buildOwnerJobCard(booking()).components.flatMap((r) => r.components.map((c) => c.custom_id ?? ''))
  assert.ok(!ids.some((id) => /^(approve|deny)_booking|offer_reschedule/.test(id)))
  assert.ok(ids.includes('view_full_booking:ckbooking000000000000001019'))
})

test('the waiting FEE appears on the owner card and only there', () => {
  const opts = { waitingFeeLine: 'Waiting fee $25.00 (move day)' }
  assert.match(String(field(buildOwnerJobCard(booking(), opts), 'MOVE DAY LOG')), /\$25\.00/)
  assert.doesNotMatch(everyString(buildCrewJobCard(booking(), opts)).join('\n'), /\$25/)
})

test('a test booking says TEST on both cards', () => {
  for (const card of [buildCrewJobCard(booking({ isInternalTest: true })), buildOwnerJobCard(booking({ isInternalTest: true }))]) {
    assert.match(String(card.embeds[0].description), /^🧪 \*\*TEST BOOKING/)
  }
})

// ── THE $49: AUTHORIZED IS NOT PAID ─────────────────────────────────────────

const requestCard = (over: Record<string, unknown> = {}) =>
  buildBookingRequestCard(
    approvalCardDataFromBooking(
      { ...booking({ status: 'PENDING_APPROVAL', depositPaid: false, payments: [{ amount: 4900, status: 'PENDING' }] } as never), ...over } as never,
      { adminUrl: 'https://admin.example/admin/bookings' },
    ),
  )

test('a $49 AUTHORIZATION is a booking REQUEST — never "paid", "deposit paid" or "confirmed"', () => {
  const e = requestCard().embeds[0]
  assert.equal(e.title, '🚚 MOVE IT CLEAR IT')
  assert.equal(e.color, TONE.pending, 'orange = pending')
  assert.match(String(e.description), /^🟠 \*\*BOOKING REQUEST\*\*\n\$49 authorized · awaiting approval\n## Tuesday, September 22\n2:00 PM/)
  const header = String(e.description).split('\n').slice(0, 2).join(' ')
  assert.doesNotMatch(header, /\bpaid\b|confirmed|captured\b(?! on)/i)
  assert.doesNotMatch(String(e.title), /paid|confirmed/i)
})

test('the request card keeps the approval body and its owner actions intact', () => {
  const card = requestCard()
  const ids = card.components.flatMap((r) => r.components.map((c) => c.custom_id ?? ''))
  for (const action of ['approve_booking', 'offer_reschedule', 'deny_booking', 'view_full_booking']) {
    assert.ok(ids.includes(`${action}:ckbooking000000000000001019`), `${action} must survive the restyle`)
  }
  const pricing = String(field(card, '💰 Pricing'))
  assert.match(pricing, /Deposit authorized: \$49 — captured on approval/)
  assert.match(pricing, /Amount captured so far: \$0/)
  assert.doesNotMatch(pricing, /Deposit paid/)
})

test('holdLine is decided by BOOKING STATUS — the truth about the money at each stage', () => {
  assert.equal(holdLine('PENDING_APPROVAL', 4900, 0), '$49 authorized · awaiting approval')
  assert.equal(holdLine('CONFIRMED', 4900, 4900), '$49 captured')
  assert.equal(holdLine('IN_PROGRESS', 4900, 4900), '$49 captured')
  assert.equal(holdLine('CANCELLED', 4900, 0), '$49 hold released · not charged')
  assert.equal(holdLine('PENDING_PAYMENT', 4900, 0), null, 'before checkout finishes there is nothing to say')
})

test('successful capture produces JOB CONFIRMED; the same booking before capture does not', () => {
  const before = bookingStage('PENDING_APPROVAL')
  const after = bookingStage('CONFIRMED')
  assert.deepEqual([before.label, before.tone], ['BOOKING REQUEST', 'pending'])
  assert.deepEqual([after.label, after.tone], ['JOB CONFIRMED', 'success'])
  assert.match(String(buildOwnerJobCard(booking({ status: 'CONFIRMED' })).embeds[0].description), /JOB CONFIRMED\*\*\n\$49 captured/)
})

test('a crew-visible card for an UNAPPROVED request never says CONFIRMED', () => {
  const e = buildCrewJobCard(booking({ status: 'PENDING_APPROVAL' })).embeds[0]
  assert.match(String(e.description), /NOT CONFIRMED/)
  assert.doesNotMatch(String(e.description), /🟢/)
})

test('every BookingStatus maps to a stage — there is no Discord-only status', () => {
  const expected: Record<string, string> = {
    DRAFT: 'AWAITING CHECKOUT', PENDING_PAYMENT: 'AWAITING CHECKOUT', PENDING_APPROVAL: 'BOOKING REQUEST',
    CONFIRMED: 'JOB CONFIRMED', SCHEDULED: 'JOB CONFIRMED', IN_PROGRESS: 'IN PROGRESS',
    COMPLETED: 'COMPLETED', ARCHIVED: 'ARCHIVED', CANCELLED: 'CANCELLED',
  }
  for (const [status, label] of Object.entries(expected)) assert.equal(bookingStage(status).label, label)
  assert.equal(bookingStage('CANCELLED').tone, 'danger')
  assert.equal(bookingStage('IN_PROGRESS').tone, 'info')
})

// ── Dates and places ────────────────────────────────────────────────────────

test('dates are human and Eastern — never ISO', () => {
  assert.equal(moveDayLabel(new Date('2026-09-22T18:00:00Z')), 'Tuesday, September 22')
  assert.equal(moveTimeLabel(new Date('2026-09-22T18:00:00Z')), '2:00 PM')
  // 03:30 UTC on the 23rd is still 11:30 PM on the 22nd in New Jersey.
  assert.equal(moveDayLabel(new Date('2026-09-23T03:30:00Z')), 'Tuesday, September 22')
  assert.equal(moveDayLabel(null), null)
  assert.equal(moveDayLabel('not a date'), null)
  assert.doesNotMatch(everyString(buildOwnerJobCard(booking()).embeds[0].fields).join('\n'), /\d{4}-\d{2}-\d{2}T/)
})

test('cityState never yields a street address and never yields "null"', () => {
  assert.equal(cityState('Orange', 'NJ'), 'Orange, NJ')
  assert.equal(cityState('Orange', null), 'Orange')
  assert.equal(cityState(null, null), null)
})

// ── Safety is not weakened ──────────────────────────────────────────────────

test('customer-controlled text cannot ping the server from either card', () => {
  const hostile = booking({ customer: { name: '@everyone Smith' }, crewInstructions: 'hi @here <@123456789012345678>', equipmentNeeds: '<@&999999999999999999> dolly' } as never)
  for (const card of [buildCrewJobCard(hostile), buildOwnerJobCard(hostile)]) {
    const text = everyString(card).join('\n')
    assert.doesNotMatch(text, /(^|[^​])@everyone/)
    assert.doesNotMatch(text, /(^|[^​])@here/)
    assert.doesNotMatch(text, /<@[!&]?\d+>/)
  }
})

// ── DAILY DIGEST ────────────────────────────────────────────────────────────

test('the daily digest is crew-safe and answers how many, when, where, who, truck, equipment, heads-up, status', () => {
  const digest = buildDailyDigest('today', 'Tuesday, September 22', [toCrewView(booking())])
  const e = digest.embeds[0]
  assert.equal(e.title, "☀️ TODAY'S JOBS")
  assert.equal(e.description, '## Tuesday, September 22\n1 job')
  const f = (e.fields ?? [])[0]
  assert.equal(f.name, '2:00 PM · John · Orange, NJ → Philadelphia, PA')
  assert.match(f.value, /Full-Service Move · 2 Bedrooms/)
  assert.match(f.value, /Crew: 3 movers, Diego \(lead\) · report 1:30 PM, Marcus \(driver\)/)
  assert.match(f.value, /Truck: 15-ft truck/)
  assert.match(f.value, /Equipment: Appliance dolly/)
  assert.match(f.value, /Heads-up: Safe · Appliances · 15 stairs at pickup · No elevator at pickup · Packing · Disassembly/)
  assert.match(f.value, /🟢 CONFIRMED/)

  const text = everyString(digest).join('\n')
  assert.doesNotMatch(text, /\$/, 'no business financial information in a crew-visible digest')
  assert.ok(!text.includes('Smith') && !text.includes(SECRETS.street) && !text.includes(SECRETS.email))
  assert.doesNotMatch(text, /973[\s().-]*555/)
})

test('an empty day says so, and an unstaffed job is visible as unstaffed', () => {
  const empty = buildDailyDigest('tomorrow', 'Wednesday, September 23', [])
  assert.equal(empty.embeds[0].title, "🌙 TOMORROW'S JOBS")
  assert.equal(empty.embeds[0].description, '## Wednesday, September 23\nNo jobs scheduled.')
  assert.deepEqual(empty.embeds[0].fields, [])

  const unstaffed = buildDailyDigest('today', 'Tuesday, September 22', [toCrewView(booking({ laborWorkers: null, job: { crew: [] } } as never))])
  assert.match((unstaffed.embeds[0].fields ?? [])[0].value, /Crew: not assigned yet/)
})

test('a very busy day stays inside Discord\'s 25-field limit', () => {
  const many = Array.from({ length: 30 }, () => toCrewView(booking()))
  const fields = buildDailyDigest('today', 'Tuesday, September 22', many).embeds[0].fields ?? []
  assert.equal(fields.length, 21)
  assert.equal(fields[20].name, '+ 10 more')
})
