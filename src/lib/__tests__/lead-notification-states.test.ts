// ════════════════════════════════════════════════════════════════════════
//  lead-notification-states.test.ts — the OWNER-FACING wording, per scenario.
//
//  THE INCIDENT (2026-08-25). A real lead notice went out as:
//
//      New lead — <customer>
//      • 1 Bedroom · $550 package subtotal
//      • Transportation pending — $3 per routed mile, fuel included.
//      • Marketing: not asked
//      • From: OTHER
//
//  The customer had been shown the marketing checkbox (it is on card1, the
//  step that created the lead) and had never reached the "How did you hear
//  about us?" question (card4). Two of those four lines were false.
//
//  These tests walk the scenarios the owner actually sees and assert the exact
//  distinctions, through the PRODUCTION formatter. lead-state.test.ts pins the
//  states; this pins what the owner reads.
//
//  All data is SYNTHETIC — Test Customer / (862) 555-0100 /
//  test.customer@example.com. No production customer appears in this file.
// ════════════════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatLeadAlert, type LeadAlertInput } from '../lead-alert'
import { MILEAGE_STATUS } from '../lead-state'
import { PACKAGES, TRANSPORTATION_MILEAGE } from '../pricing-config'

const RATE = TRANSPORTATION_MILEAGE.ratePerMileCents
const ONE_BR = PACKAGES['1br']!
const ONE_BR_CENTS = (ONE_BR.price.amount ?? 0) * 100

/** The synthetic customer. Never a real one. */
const CUSTOMER = {
  name: 'Test Customer',
  phone: '(862) 555-0100',
  email: 'test.customer@example.com',
}

/**
 * The EXACT production shape of the incident lead: a booking-form contact-step
 * capture. 1 Bedroom picked, server-priced subtotal, no addresses yet, the
 * marketing checkbox on screen, the source question four steps away.
 */
function partialLead(over: Partial<LeadAlertInput> = {}): LeadAlertInput {
  return {
    id: 'lead_test',
    ...CUSTOMER,
    moveSize: '1br',
    lifecycle: 'PARTIAL',
    formStep: 'card1',
    marketingConsentSource: 'BOOKING_FORM',
    quoteTotalCents: ONE_BR_CENTS,
    quoteBaseCents: ONE_BR_CENTS,
    quoteTruckCents: 0,
    quoteMileageStatus: MILEAGE_STATUS.pending,
    quotePriceBookVersion: '2026-08-22.3',
    ...over,
  }
}

const render = (lead: LeadAlertInput): string => {
  const { title, lines } = formatLeadAlert(lead)
  return [title, ...lines.map((l) => l.message)].join('\n')
}

// ── THE INCIDENT ITSELF ─────────────────────────────────────────────────

test('FLOW A — the incident lead, told truthfully', () => {
  const text = render(
    partialLead({ marketingConsentPrompted: true, emailMarketingConsent: false, foundUsPrompted: false }),
  )

  // The two lines that were false are now right.
  assert.match(text, /Marketing email: Not opted in/)
  assert.match(text, /Customer-reported source: Not reached yet/)

  // And the two that were right are unchanged in substance.
  assert.match(text, new RegExp(ONE_BR.label))
  assert.match(text, /\$550 package subtotal/)
  assert.match(text, /awaiting pickup and destination addresses/i)
  assert.match(text, /\$3 per routed mile/)
  assert.match(text, /fuel included/i)

  // The exact phrases from the incident must be gone.
  assert.doesNotMatch(text, /not asked/i)
  assert.doesNotMatch(text, /From: OTHER/)
  assert.doesNotMatch(text, /\bOTHER\b/)
})

test('the incident lead still reads honestly from an OLD client that sends no flags', () => {
  //  A browser cached before the fix sends neither marketingConsentPresented
  //  nor foundUsPresented. It must not go back to inventing answers.
  const text = render(partialLead())

  assert.doesNotMatch(text, /not asked/i, 'a missing flag is not proof we never asked')
  assert.doesNotMatch(text, /\bOTHER\b/)
  assert.match(text, /Marketing email: Unknown/i)
  //  The FORM CONTRACT still proves the source question was out of reach at
  //  card1, so this one is answerable without the client's help.
  assert.match(text, /Customer-reported source: Not reached yet/)
})

// ── CONSENT ─────────────────────────────────────────────────────────────

test('FLOW B — an opt-in is visibly distinct, in the title as well as the body', () => {
  const { title, lines } = formatLeadAlert(
    partialLead({ marketingConsentPrompted: true, emailMarketingConsent: true }),
  )
  assert.match(title, /opted in/i)
  assert.match(lines.map((l) => l.message).join('\n'), /Marketing email: Opted in/)
})

test('FLOW C — a channel that genuinely does not ask may say so', () => {
  const text = render(partialLead({ marketingConsentPrompted: false }))
  assert.match(text, /Marketing email: Not asked/)
  assert.match(text, /no marketing checkbox/i, 'and says WHY, so it cannot be read as a customer decision')
})

test('the four consent outcomes are four different sentences', () => {
  const said = [
    render(partialLead({ marketingConsentPrompted: true, emailMarketingConsent: true })),
    render(partialLead({ marketingConsentPrompted: true, emailMarketingConsent: false })),
    render(partialLead({ marketingConsentPrompted: false })),
    render(partialLead()),
  ].map((t) => /Marketing email: (.*)/.exec(t)?.[1])

  assert.equal(new Set(said).size, 4, `four states must read four ways, got ${JSON.stringify(said)}`)
  assert.ok(said.every(Boolean), 'every card must carry a marketing line')
})

// ── THE CUSTOMER'S OWN SOURCE ANSWER ────────────────────────────────────

test('FLOW D — not reached is not an answer', () => {
  const text = render(partialLead({ foundUsPrompted: false }))
  assert.match(text, /Customer-reported source: Not reached yet/)
  assert.doesNotMatch(text, /\bOTHER\b/)
})

test('FLOW E — presented and skipped reads as skipped, not as "Other"', () => {
  const text = render(partialLead({ formStep: 'card4', foundUsPrompted: true }))
  assert.match(text, /Customer-reported source: Not provided/)
  assert.doesNotMatch(text, /Customer-reported source: Other/)
})

test('FLOW F — an explicit "Other" is the ONE case that may say Other', () => {
  const text = render(partialLead({ formStep: 'card4', foundUsPrompted: true, foundUs: 'Other' }))
  assert.match(text, /Customer-reported source: Other/)
})

test('a known answer is quoted back verbatim', () => {
  const text = render(partialLead({ formStep: 'card4', foundUsPrompted: true, foundUs: 'Google' }))
  assert.match(text, /Customer-reported source: Google/)
})

// ── TRACKED ACQUISITION vs WHAT THEY SAID ───────────────────────────────

test('FLOW G — tracked acquisition and the customer answer are SEPARATE lines', () => {
  const text = render(
    partialLead({
      utmSource: 'google',
      utmMedium: 'cpc',
      utmCampaign: 'essex_test',
      formStep: 'card4',
      foundUsPrompted: true,
    }),
  )
  const acq = /Tracked acquisition: (.*)/.exec(text)?.[1] ?? ''
  const self = /Customer-reported source: (.*)/.exec(text)?.[1] ?? ''

  assert.match(acq, /google/)
  assert.match(acq, /cpc/)
  assert.match(acq, /essex_test/)
  assert.match(self, /Not provided/)

  //  THE POINT: our tracking and their answer must never be merged into one
  //  ambiguous "From:" field. That merge is what let a column default be read
  //  as a customer's choice.
  assert.notEqual(acq, self)
  assert.doesNotMatch(text, /^From:/m)
})

test('FLOW H — door-hanger attribution survives intact', () => {
  const text = render(
    partialLead({ source: 'DOOR_HANGER', utmCampaign: 'door_hanger_5000_batch', attributionId: 'b'.repeat(32) }),
  )
  assert.match(text, /Tracked acquisition: .*Door hanger/)
  assert.match(text, /door_hanger_5000_batch/)
})

test('a lead with no tracking says UNKNOWN, never DIRECT and never OTHER', () => {
  const text = render(partialLead({ source: 'OTHER' }))
  assert.match(text, /Tracked acquisition: Unknown/)
  assert.doesNotMatch(text, /Direct/i)
  assert.doesNotMatch(text, /\bOTHER\b/)
})

// ── TRANSPORTATION ──────────────────────────────────────────────────────

test('FLOW I — no addresses yet is a valid partial state, and says so', () => {
  const text = render(partialLead())
  assert.match(text, /Transportation: Pending — awaiting pickup and destination addresses/)
})

test('FLOW J — a routed lead shows the miles and the money', () => {
  const miles = 13
  const text = render(
    partialLead({
      lifecycle: 'SUBMITTED',
      quoteMileageStatus: MILEAGE_STATUS.calculated,
      quoteBillableMiles: miles,
      quoteMileageCents: miles * RATE,
      quoteTotalCents: ONE_BR_CENTS + miles * RATE,
      pickupAddressComplete: true,
      destinationAddressComplete: true,
    }),
  )
  assert.match(text, /Transportation: 13 routed miles · \$39 · fuel included/)
  assert.doesNotMatch(text, /pending/i)
})

test('FLOW K — a routing FAILURE is never dressed up as "awaiting addresses"', () => {
  const { title, lines } = formatLeadAlert(
    partialLead({
      lifecycle: 'SUBMITTED',
      quoteMileageStatus: MILEAGE_STATUS.routingFailed,
      pickupAddressComplete: true,
      destinationAddressComplete: true,
    }),
  )
  const text = [title, ...lines.map((l) => l.message)].join('\n')

  assert.match(text, /Transportation: Manual review — route calculation unavailable/)
  assert.doesNotMatch(text, /awaiting/i)
  //  It is OUR problem, so it is flagged where a phone will show it.
  assert.match(title, /manual travel review/i)

  //  And no default travel price is ever substituted for the missing one.
  assert.doesNotMatch(text, /\$50\b/)
})

test('labor-only never grows routed miles', () => {
  const text = render(partialLead({ moveSize: null, jobType: 'loading_only', quoteMileageStatus: null }))
  assert.match(text, /Transportation: Not applicable — labor only/)
  assert.doesNotMatch(text, /routed mile/)
})

test('a pre-snapshot legacy lead states nothing about the drive', () => {
  //  Better a missing line than an invented one.
  const text = render({ id: 'lead_legacy', ...CUSTOMER, estimatedValue: 55_000 })
  assert.doesNotMatch(text, /Transportation:/)
  assert.match(text, /est\. \$550/, 'a historical lead keeps the wording it always had')
})

// ── STAGE ───────────────────────────────────────────────────────────────

test('a partial capture and a completed request are distinguishable at a glance', () => {
  const partial = formatLeadAlert(partialLead())
  const done = formatLeadAlert(partialLead({ lifecycle: 'SUBMITTED' }))

  assert.match(partial.title, /New partial lead/)
  assert.match(done.title, /Move request completed/)
  assert.notEqual(partial.title, done.title)

  assert.match(partial.lines.map((l) => l.message).join('\n'), /Stage: Contact captured/)
})

test('a completed request never shows a stale partial stage line', () => {
  const text = render(partialLead({ lifecycle: 'CONVERTED', convertedBookingId: 'bk_1' }))
  assert.match(text, /Stage: Move request completed/)
  assert.doesNotMatch(text, /Contact captured/)
})

test('an in-person request keeps its own identity', () => {
  const { title } = formatLeadAlert(partialLead({ formStep: 'quote_in_person' }))
  assert.match(title, /In-Person Estimate Requested/)
})

// ── THE BLANKET RULE ────────────────────────────────────────────────────

test('NO raw enum or state name ever reaches the owner, in any scenario', () => {
  const scenarios: LeadAlertInput[] = [
    partialLead(),
    partialLead({ source: 'OTHER' }),
    partialLead({ source: 'UNKNOWN' }),
    partialLead({ marketingConsentPrompted: true, emailMarketingConsent: false }),
    partialLead({ marketingConsentPrompted: false }),
    partialLead({ foundUsPrompted: false }),
    partialLead({ foundUsPrompted: true }),
    partialLead({ lifecycle: 'SUBMITTED', quoteMileageStatus: MILEAGE_STATUS.routingFailed }),
    partialLead({ jobType: 'loading_only' }),
    { id: 'bare' },
  ]

  //  The state names this system uses internally. None is owner-facing English.
  const leaks = [
    /\bOTHER\b/,
    /\bUNKNOWN_LEGACY\b/,
    /\bNOT_ASKED\b/,
    /\bNOT_OPTED_IN\b/,
    /\bOPTED_IN\b/,
    /\bNOT_REACHED\b/,
    /\bPRESENTED_NOT_ANSWERED\b/,
    /\bANSWERED_OTHER\b/,
    /\bROUTING_FAILED\b/,
    /\bWAITING_FOR_ADDRESSES\b/,
    /\bNOT_APPLICABLE\b/,
    /\bTRANSPORTATION_PENDING\b/,
    /\bDIRECT\b/,
    /\bCONTACT_CAPTURED\b/,
    /\bPARTIAL\b/,
  ]
  for (const lead of scenarios) {
    const text = render(lead)
    for (const leak of leaks) {
      assert.doesNotMatch(text, leak, `${leak} leaked for ${JSON.stringify(lead.id)}: ${text}`)
    }
  }
})

test('every card carries the four facts the owner needs, always', () => {
  //  A line that disappears when a value is missing is how a disclosure gets
  //  silently dropped. These four are unconditional.
  for (const lead of [partialLead(), { id: 'bare' } as LeadAlertInput]) {
    const text = render(lead)
    assert.match(text, /Marketing email: /, 'consent state')
    assert.match(text, /Tracked acquisition: /, 'what our tracking saw')
    assert.match(text, /Customer-reported source: /, 'what the customer said')
  }
})

test('PRICING IS UNCHANGED: 1 Bedroom is $550 and the drive is $3 per routed mile', () => {
  assert.equal(ONE_BR.price.amount, 550, '1 Bedroom package subtotal')
  assert.equal(ONE_BR.label, '1 Bedroom')
  assert.equal(RATE, 300, '$3 per routed mile')
  assert.equal(TRANSPORTATION_MILEAGE.fuelIncluded, true)

  const text = render(partialLead())
  assert.match(text, /1 Bedroom/)
  assert.match(text, /\$550 package subtotal/)
  assert.match(text, /\$3 per routed mile, fuel included/)
})
