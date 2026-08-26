// ════════════════════════════════════════════════════════════════════════
//  lead-state.test.ts — the states themselves, pinned one at a time.
//
//  THE INCIDENT (2026-08-25). A real owner card said "Marketing: not asked"
//  and "From: OTHER" about a customer who had been shown the marketing
//  checkbox and had never been asked where they heard about us. Both lines
//  were an ABSENCE rendered as an ANSWER.
//
//  Every test below is one version of the same rule: absence is not an answer.
//  A state may only be asserted from evidence — an explicit value the client
//  sent, or a form contract that proves what a surface does and does not ask.
//
//  All data here is SYNTHETIC. No production customer appears in this file.
// ════════════════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  acquisition,
  acquisitionLabel,
  formContract,
  FORM_CONTRACTS,
  hasReachedStep,
  isPartialStage,
  isRealChannel,
  isSendableConsent,
  leadStage,
  MARKETING_CONSENT_LABEL,
  marketingConsentState,
  MILEAGE_STATUS,
  selfReportedSource,
  selfReportedSourceLabel,
  transportation,
  transportationLabel,
} from '../lead-state'
import { TRANSPORTATION_MILEAGE } from '../pricing-config'

// ── MARKETING CONSENT ───────────────────────────────────────────────────

test('an explicit answer is read as the answer, whatever else is on the row', () => {
  assert.equal(marketingConsentState({ emailMarketingConsent: true }), 'OPTED_IN')
  assert.equal(marketingConsentState({ emailMarketingConsent: false }), 'NOT_OPTED_IN')
  // The customer's own answer outranks any claim about the form.
  assert.equal(
    marketingConsentState({ emailMarketingConsent: true, marketingConsentPrompted: false }),
    'OPTED_IN',
  )
})

test('THE INCIDENT: a displayed-but-unchecked box is NOT OPTED IN, never "not asked"', () => {
  //  The exact production shape: the booking form showed the checkbox on the
  //  step that created the lead, the visitor left it alone, and the old client
  //  sent nothing — so the row carried a bare null.
  const shown = marketingConsentState({
    emailMarketingConsent: null,
    marketingConsentPrompted: true,
    marketingConsentSource: 'BOOKING_FORM',
  })
  assert.equal(shown, 'NOT_OPTED_IN')
  assert.doesNotMatch(MARKETING_CONSENT_LABEL[shown], /not asked/i)
})

test('"not asked" requires PROOF that the surface has no checkbox', () => {
  // The client saying so outright.
  assert.equal(marketingConsentState({ marketingConsentPrompted: false }), 'NOT_ASKED')

  // Or a form contract that says the surface carries no such question.
  // (None of the shipped contracts do today; this proves the mechanism.)
  const surfaces = Object.entries(FORM_CONTRACTS).filter(([, c]) => !c.presentsMarketingConsent)
  for (const [name] of surfaces) {
    assert.equal(marketingConsentState({ captureSurface: name }), 'NOT_ASKED', name)
  }
})

test('a bare null on a surface we KNOW asks stays unknown rather than guessing', () => {
  //  PREVENTS the incident's exact regression: borrowing "not asked" from the
  //  absence of a value. BOOKING_FORM demonstrably presents the checkbox, so a
  //  row with no prompted flag cannot say either way.
  assert.equal(
    marketingConsentState({ emailMarketingConsent: null, marketingConsentSource: 'BOOKING_FORM' }),
    'UNKNOWN_LEGACY',
  )
  // No provenance at all is likewise unknown, not "not asked".
  assert.equal(marketingConsentState({}), 'UNKNOWN_LEGACY')
  assert.equal(marketingConsentState({ emailMarketingConsent: null }), 'UNKNOWN_LEGACY')
})

test('only an explicit opt-in is sendable — no state leaks marketing permission', () => {
  assert.equal(isSendableConsent('OPTED_IN'), true)
  for (const s of ['NOT_OPTED_IN', 'NOT_ASKED', 'UNKNOWN_LEGACY'] as const) {
    assert.equal(isSendableConsent(s), false, `${s} must never permit marketing`)
  }
})

test('every consent state has owner-facing wording, and none of it is a raw state name', () => {
  for (const [state, label] of Object.entries(MARKETING_CONSENT_LABEL)) {
    assert.ok(label.length > 0, state)
    assert.doesNotMatch(label, /[A-Z]{2,}_[A-Z]/, `${state} label leaks an enum: ${label}`)
  }
})

// ── THE CUSTOMER'S OWN SOURCE ANSWER ────────────────────────────────────

test('a real answer is reported as the answer', () => {
  const s = selfReportedSource({ foundUs: 'Google' })
  assert.equal(s.state, 'ANSWERED_KNOWN')
  assert.equal(s.answer, 'Google')
  assert.match(selfReportedSourceLabel(s), /Google/)
})

test('ONLY an explicit choice may be reported as "Other"', () => {
  const chose = selfReportedSource({ foundUs: 'Other' })
  assert.equal(chose.state, 'ANSWERED_OTHER')
  assert.match(selfReportedSourceLabel(chose), /other/i)

  //  Everything that is NOT a choice must be a different state. This is the
  //  "From: OTHER" half of the incident: the value never came from a customer.
  for (const row of [
    {},
    { foundUs: null },
    { foundUs: '' },
    { foundUs: '   ' },
    { foundUsPrompted: false, captureSurface: 'BOOKING_FORM' },
    { foundUsPrompted: true, captureSurface: 'BOOKING_FORM' },
    { formStep: 'card1', captureSurface: 'BOOKING_FORM' },
  ]) {
    const s = selfReportedSource(row)
    assert.notEqual(s.state, 'ANSWERED_OTHER', `${JSON.stringify(row)} is not a customer choosing Other`)
    assert.equal(s.answer, null)
    assert.doesNotMatch(selfReportedSourceLabel(s), /^Other/i)
  }
})

test('not reached, skipped and not-on-this-form are three different facts', () => {
  assert.equal(selfReportedSource({ foundUsPrompted: false, captureSurface: 'BOOKING_FORM' }).state, 'NOT_REACHED')
  assert.equal(
    selfReportedSource({ foundUsPrompted: true, captureSurface: 'BOOKING_FORM' }).state,
    'PRESENTED_NOT_ANSWERED',
  )
  //  The quick quote genuinely never asks, so it can say so with no per-lead flag.
  assert.equal(selfReportedSource({ captureSurface: 'QUICK_QUOTE_FORM' }).state, 'NOT_ON_FORM')

  const labels = new Set(
    (['NOT_REACHED', 'PRESENTED_NOT_ANSWERED', 'NOT_ON_FORM', 'UNKNOWN_LEGACY'] as const).map((state) =>
      selfReportedSourceLabel({ state, answer: null }),
    ),
  )
  assert.equal(labels.size, 4, 'four distinct facts must read as four distinct sentences')
})

test('a multi-step form PROVES the question was out of reach, without guessing', () => {
  //  #foundUs is on card4. A capture recorded at card1 demonstrably never saw
  //  it, so an old client that sends no flag still gets the right answer.
  assert.equal(selfReportedSource({ captureSurface: 'BOOKING_FORM', formStep: 'card1' }).state, 'NOT_REACHED')
  assert.equal(selfReportedSource({ captureSurface: 'BOOKING_FORM', formStep: 'cardsvc' }).state, 'NOT_REACHED')
  //  At or past card4 the step alone proves nothing about whether they answered.
  assert.equal(selfReportedSource({ captureSurface: 'BOOKING_FORM', formStep: 'card4' }).state, 'UNKNOWN_LEGACY')
  //  An unrecognised step is not evidence in either direction.
  assert.equal(selfReportedSource({ captureSurface: 'BOOKING_FORM', formStep: 'nonsense' }).state, 'UNKNOWN_LEGACY')
})

test('hasReachedStep answers null when it cannot know', () => {
  const bf = formContract('BOOKING_FORM')
  assert.equal(hasReachedStep(bf, 'card1', 'card4'), false)
  assert.equal(hasReachedStep(bf, 'card4', 'card4'), true)
  assert.equal(hasReachedStep(bf, 'card5', 'card4'), true)
  assert.equal(hasReachedStep(bf, 'unknown-step', 'card4'), null)
  assert.equal(hasReachedStep(null, 'card1', 'card4'), null)
  //  A single-page surface has no order, so it can never answer positionally.
  assert.equal(hasReachedStep(formContract('QUICK_QUOTE_FORM'), 'card1', 'card4'), null)
})

// ── TRACKED ACQUISITION, kept apart from the customer's answer ──────────

test('OTHER and UNKNOWN are not channels and never render as provenance', () => {
  for (const source of ['OTHER', 'other', 'UNKNOWN', ' unknown ', '', null, undefined]) {
    assert.equal(isRealChannel(source), false, `${String(source)} is not a channel`)
  }
  assert.equal(isRealChannel('DOOR_HANGER'), true)

  //  THE INCIDENT, from the acquisition side: a lead whose only "channel" is
  //  the column default must read as unknown, and must not print the enum.
  const a = acquisition({ source: 'OTHER' })
  assert.equal(a.state, 'UNKNOWN')
  assert.equal(a.channel, null)
  assert.doesNotMatch(acquisitionLabel(a), /\bOTHER\b/)
  assert.match(acquisitionLabel(a), /unknown/i)
})

test('a tracked visit reports its campaign, and a known channel gets a human label', () => {
  const a = acquisition({ utmSource: 'google', utmMedium: 'cpc', utmCampaign: 'essex_test' })
  assert.equal(a.state, 'TRACKED')
  const label = acquisitionLabel(a)
  assert.match(label, /google/)
  assert.match(label, /cpc/)
  assert.match(label, /essex_test/)

  assert.match(acquisitionLabel(acquisition({ source: 'DOOR_HANGER' })), /Door hanger/)
})

test('an unrecognised channel is shown RAW rather than given an invented name', () => {
  //  A mis-tagged form the owner can SEE is fixable; a friendly label invented
  //  for it hides the mistake. (OTHER/UNKNOWN never reach here — see above.)
  assert.match(acquisitionLabel(acquisition({ source: 'SOME_NEW_FORM' })), /SOME_NEW_FORM/)
})

test('DIRECT is never inferred from missing tracking', () => {
  //  Losing the query string is not evidence that somebody typed the URL. The
  //  system must say "we do not know", not invent an acquisition channel.
  for (const row of [{}, { landingPage: 'https://moveitclearit.com/' }, { source: 'OTHER', promoCode: 'X' }]) {
    assert.notEqual(acquisition(row).state, 'DIRECT', JSON.stringify(row))
  }
})

test('an attribution id alone is enough to call a visit tracked', () => {
  //  A door-hanger scan carries no UTM at all — the id IS the tracking.
  const a = acquisition({ attributionId: 'a'.repeat(32) })
  assert.equal(a.state, 'TRACKED')
  assert.equal(a.attributionId, 'a'.repeat(32))
})

// ── TRANSPORTATION ──────────────────────────────────────────────────────

const RATE = TRANSPORTATION_MILEAGE.ratePerMileCents

test('missing addresses and a routing FAILURE are different sentences', () => {
  const waiting = transportation({ quoteMileageStatus: MILEAGE_STATUS.pending })
  assert.equal(waiting.state, 'WAITING_FOR_ADDRESSES')

  const failed = transportation({ quoteMileageStatus: MILEAGE_STATUS.routingFailed })
  assert.equal(failed.state, 'ROUTING_FAILED')

  //  PREVENTS the owner reading "we are still waiting on the customer" about a
  //  job that is in fact waiting on US.
  assert.notEqual(transportationLabel(waiting, RATE), transportationLabel(failed, RATE))
  assert.match(transportationLabel(waiting, RATE), /awaiting pickup and destination addresses/i)
  assert.match(transportationLabel(failed, RATE), /manual review/i)
  assert.doesNotMatch(transportationLabel(failed, RATE), /awaiting/i)
})

test('complete addresses with no route yet is READY_TO_ROUTE, not "awaiting addresses"', () => {
  const ready = transportation({
    quoteMileageStatus: MILEAGE_STATUS.pending,
    pickupAddressComplete: true,
    destinationAddressComplete: true,
  })
  assert.equal(ready.state, 'READY_TO_ROUTE')

  //  One end only is still waiting.
  assert.equal(
    transportation({
      quoteMileageStatus: MILEAGE_STATUS.pending,
      pickupAddressComplete: true,
      destinationAddressComplete: false,
    }).state,
    'WAITING_FOR_ADDRESSES',
  )
})

test('a routed total must be able to explain itself, or it is a review state', () => {
  const routed = transportation({
    quoteMileageStatus: MILEAGE_STATUS.calculated,
    quoteBillableMiles: 13,
    quoteMileageCents: 13 * RATE,
  })
  assert.equal(routed.state, 'ROUTED')
  assert.equal(routed.billableMiles, 13)
  assert.equal(routed.mileageCents, 3900)
  const label = transportationLabel(routed, RATE)
  assert.match(label, /13 routed miles/)
  assert.match(label, /\$39/)
  assert.match(label, /fuel included/i)

  //  "calculated" with nothing behind it is a claim we cannot support.
  assert.equal(
    transportation({ quoteMileageStatus: MILEAGE_STATUS.calculated, quoteBillableMiles: null, quoteMileageCents: null })
      .state,
    'ROUTING_FAILED',
  )
})

test('labor-only has no route to wait for', () => {
  //  Recognised from the stored job type, the way the pricing layer does it.
  const t = transportation({ jobType: 'loading_only' })
  assert.equal(t.state, 'NOT_APPLICABLE')
  assert.match(transportationLabel(t, RATE), /customer provides transportation/i)
  assert.equal(t.mileageCents, null, 'labor-only never carries routed mileage')

  assert.equal(transportation({ quoteMileageStatus: MILEAGE_STATUS.notApplicable }).state, 'NOT_APPLICABLE')
})

test('an unreadable or absent mileage state says nothing rather than guessing', () => {
  assert.equal(transportation({}).state, 'UNKNOWN_LEGACY')
  assert.equal(transportation({ quoteMileageStatus: 'something-else' }).state, 'UNKNOWN_LEGACY')
})

test('the stored mileage vocabulary is normalised, so casing cannot change the answer', () => {
  //  The rich card used to compare this column RAW while the plain notice
  //  trimmed and lower-cased it, so one lead could produce two contradictory
  //  owner cards.
  for (const v of ['Pending', ' pending', 'PENDING ']) {
    assert.equal(transportation({ quoteMileageStatus: v }).state, 'WAITING_FOR_ADDRESSES', v)
  }
})

test('the published rate is quoted in the house style, not reinvented', () => {
  assert.equal(RATE, 300, '$3 per routed mile')
  const label = transportationLabel(transportation({ quoteMileageStatus: MILEAGE_STATUS.pending }), RATE)
  assert.match(label, /\$3 per routed mile/, 'whole dollars, matching the price book note')
  assert.doesNotMatch(label, /\$3\.00/)
})

// ── LIFECYCLE ───────────────────────────────────────────────────────────

test('a partial capture is visibly not a completed request', () => {
  assert.equal(leadStage({ lifecycle: 'PARTIAL' }), 'CONTACT_CAPTURED')
  assert.equal(leadStage({ lifecycle: 'IN_PROGRESS' }), 'IN_PROGRESS')
  assert.equal(leadStage({ lifecycle: 'SUBMITTED' }), 'COMPLETED')
  assert.equal(leadStage({ lifecycle: 'CONVERTED' }), 'COMPLETED')
  assert.equal(leadStage({ lifecycle: 'ABANDONED' }), 'ABANDONED')
  //  An ordinary CRM lead has no partial lifecycle at all.
  assert.equal(leadStage({}), 'LEAD')

  //  A booking wins over whatever the lifecycle column happens to say.
  assert.equal(leadStage({ lifecycle: 'PARTIAL', convertedBookingId: 'bk_1' }), 'COMPLETED')

  assert.equal(isPartialStage('CONTACT_CAPTURED'), true)
  assert.equal(isPartialStage('IN_PROGRESS'), true)
  assert.equal(isPartialStage('COMPLETED'), false)
})

// ── THE FORM CONTRACT REGISTRY ──────────────────────────────────────────

test('the form contracts are the only thing licensed to claim "we do not ask"', () => {
  //  Every registered surface must be explicit about BOTH questions — a
  //  contract with an undefined answer would silently become a guess.
  for (const [name, c] of Object.entries(FORM_CONTRACTS)) {
    assert.equal(typeof c.presentsMarketingConsent, 'boolean', name)
    assert.equal(typeof c.presentsSelfReportedSource, 'boolean', name)
    if (c.selfReportedSourceStep) {
      assert.ok(c.steps?.includes(c.selfReportedSourceStep), `${name}: the question's step must be in the order`)
    }
    if (c.marketingConsentStep) {
      assert.ok(c.steps?.includes(c.marketingConsentStep), `${name}: the checkbox's step must be in the order`)
    }
  }
  //  An unregistered surface licenses nothing.
  assert.equal(formContract('SOMETHING_NOBODY_REGISTERED'), null)
  assert.equal(formContract(null), null)
})

// ══════════════════════════════════════════════════════════════════════
//  V3 — THE SERVER OWNS THE FORM CONTRACT
//
//  `marketingConsentPrompted` arrives from a PUBLIC endpoint. Without a
//  server-side authority, anyone could POST `marketingConsentPresented: false`
//  while naming BOOKING_FORM and make the owner's card report "Not asked"
//  about a form that demonstrably carries the checkbox — a compliance record a
//  stranger can edit.
// ══════════════════════════════════════════════════════════════════════

test('a crafted payload CANNOT talk a known form out of having asked', () => {
  //  The attack: claim the booking form never showed the box.
  const forged = marketingConsentState({
    emailMarketingConsent: null,
    marketingConsentPrompted: false,          // <- attacker-supplied lie
    marketingConsentSource: 'BOOKING_FORM',   // <- a surface the server KNOWS
  })
  assert.equal(forged, 'NOT_OPTED_IN', 'the registry must beat the client claim')
  assert.doesNotMatch(MARKETING_CONSENT_LABEL[forged], /not asked/i)
})

test('a crafted payload CANNOT talk a form INTO having asked', () => {
  //  The mirror attack, against a surface the server knows has no checkbox.
  const noBoxSurface = Object.entries(FORM_CONTRACTS).find(([, c]) => !c.presentsMarketingConsent)?.[0]
  if (!noBoxSurface) return // no such surface registered today
  const forged = marketingConsentState({
    emailMarketingConsent: null,
    marketingConsentPrompted: true,           // <- attacker-supplied lie
    marketingConsentSource: noBoxSurface,
  })
  assert.equal(forged, 'NOT_ASKED', 'a surface with no checkbox cannot be claimed to have one')
})

test('the customer\'s own ANSWER still outranks everything', () => {
  //  Server authority is about the QUESTION, never about overriding a real
  //  recorded decision.
  assert.equal(
    marketingConsentState({ emailMarketingConsent: true, marketingConsentPrompted: false, marketingConsentSource: 'BOOKING_FORM' }),
    'OPTED_IN',
  )
  assert.equal(
    marketingConsentState({ emailMarketingConsent: false, marketingConsentPrompted: true, marketingConsentSource: 'BOOKING_FORM' }),
    'NOT_OPTED_IN',
  )
})

test('the client flag is trusted ONLY where the server cannot know', () => {
  //  An unregistered / dynamic surface is the one place the client's report is
  //  the only evidence available.
  assert.equal(
    marketingConsentState({ marketingConsentPrompted: false, marketingConsentSource: 'SOME_UNREGISTERED_SURFACE' }),
    'NOT_ASKED',
  )
  assert.equal(
    marketingConsentState({ marketingConsentPrompted: true, marketingConsentSource: 'SOME_UNREGISTERED_SURFACE' }),
    'NOT_OPTED_IN',
  )
  //  And with nothing at all it still refuses to guess.
  assert.equal(marketingConsentState({ marketingConsentSource: 'SOME_UNREGISTERED_SURFACE' }), 'UNKNOWN_LEGACY')
})

test('unchecked is NEVER converted to "not asked", by any route', () => {
  for (const surface of ['BOOKING_FORM', 'QUICK_QUOTE_FORM', 'SOME_UNREGISTERED_SURFACE', undefined]) {
    const s = marketingConsentState({
      emailMarketingConsent: false,
      marketingConsentPrompted: false,
      marketingConsentSource: surface ?? null,
    })
    assert.equal(s, 'NOT_OPTED_IN', `surface ${surface}: an explicit decline must survive`)
  }
})
