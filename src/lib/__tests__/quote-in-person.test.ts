import { test } from 'node:test'
import assert from 'node:assert/strict'
import { composeAccessDetails } from '../quote-access-details'
import { buildLeadCard } from '../booking-display'
import { isInPersonRequest, IN_PERSON_ALERT_LABEL, formatLeadAlert } from '../lead-alert'
import { renderTemplate } from '../email-render'

/**
 * IN-PERSON ESTIMATE REQUESTS.
 *
 * Some moves are cheaper to price after seeing them. When a customer asks for
 * a visit, the promise is that NO automatic number is produced — not that one
 * is produced and hidden. These tests pin that promise at every surface it
 * could leak from: the stored lead, the owner's card, and the confirmation
 * email.
 *
 * They also cover the two answers that used to be impossible to give
 * honestly: "not sure", and "my date is flexible".
 */

const IN_PERSON_STEP = 'quote_in_person'

/** renderTemplate can answer with an error object. Narrowing it here means a
 *  render failure fails loudly with its reason instead of surfacing as a
 *  confusing assertion about missing copy. */
async function render(payload: Record<string, unknown>): Promise<string> {
  const out = await renderTemplate('quote-request-received', payload)
  if ('error' in out) assert.fail(`template failed to render: ${out.error}`)
  return out.html + out.text
}

// ── The mode marker ───────────────────────────────────────────────────────

test('the in-person marker is recognised, and nothing else is', () => {
  assert.equal(isInPersonRequest(IN_PERSON_STEP), true)
  assert.equal(isInPersonRequest('QUOTE_IN_PERSON'), true, 'case must not matter')
  assert.equal(isInPersonRequest('  quote_in_person  '), true, 'padding must not matter')
  assert.equal(isInPersonRequest('quote'), false)
  assert.equal(isInPersonRequest('card1'), false)
  assert.equal(isInPersonRequest(null), false)
  assert.equal(isInPersonRequest(undefined), false)
})

// ── What gets written to the lead ─────────────────────────────────────────

test('an in-person request is LABELLED first in the stored notes', () => {
  const notes = composeAccessDetails({
    quoteMode: 'in_person',
    pickupAddress: '12 Elm St, West Orange NJ',
    preferredDay: 'Saturday',
    preferredTime: 'Morning',
    visitNotes: 'Gate code is 4412',
  })
  assert.ok(notes)
  assert.ok(
    notes!.startsWith('In-Person Estimate Requested'),
    'whoever opens the lead must see what kind of request this is before anything else'
  )
  assert.match(notes!, /12 Elm St/)
  assert.match(notes!, /Preferred day: Saturday/)
  assert.match(notes!, /Preferred time: Morning/)
  assert.match(notes!, /Notes: Gate code is 4412/)
})

test('an ordinary quote is NOT labelled as an in-person request', () => {
  const notes = composeAccessDetails({ stairsPickup: 'yes' })
  assert.ok(notes)
  assert.ok(!notes!.includes('In-Person'), 'the label must not leak onto instant quotes')
})

test('"not sure" survives as a real answer, not as a "no"', () => {
  const notes = composeAccessDetails({
    stairsPickup: 'not_sure',
    stairsDestination: 'no',
    heavyItems: 'not_sure',
  })
  assert.ok(notes)
  // The crew reads this. "not sure" and "no" are different jobs.
  assert.match(notes!, /Stairs at pickup: not sure/)
  assert.match(notes!, /Stairs at destination: no/)
  assert.match(notes!, /Large or heavy items: not sure/)
  assert.ok(
    !/Stairs at pickup: no\b/.test(notes!),
    'an unknown must never be recorded as a confident "no"'
  )
})

test('a flexible date is recorded alongside the date, not instead of it', () => {
  const notes = composeAccessDetails({ dateFlexible: true, stairsPickup: 'no' })
  assert.ok(notes)
  assert.match(notes!, /Moving date is flexible/)

  const rigid = composeAccessDetails({ dateFlexible: false, stairsPickup: 'no' })
  assert.ok(rigid)
  assert.ok(!rigid!.includes('flexible'), 'silence is not a claim of flexibility')
})

test('no answers at all produces null, not an empty note', () => {
  assert.equal(composeAccessDetails({}), null)
})

// ── The owner's Discord card ──────────────────────────────────────────────

test('the owner card is titled as an in-person request', () => {
  const { embeds } = buildLeadCard({
    leadId: 'l1',
    name: 'Maria Delgado',
    phone: '9735551234',
    email: 'maria@example.com',
    estimateDollars: null,
    formStep: IN_PERSON_STEP,
  })
  assert.match(embeds[0].title ?? '', /In-Person Estimate Requested/)
})

test('the card says the estimate was DECLINED, not that it failed', () => {
  const { embeds } = buildLeadCard({
    leadId: 'l1',
    name: 'Maria Delgado',
    estimateDollars: null,
    formStep: IN_PERSON_STEP,
  })
  const body = JSON.stringify(embeds[0])
  assert.match(body, /In-person estimate requested/i)
  assert.ok(
    !/no estimate yet/i.test(body),
    '"no estimate yet" reads as a system failure; this one was deliberate'
  )
})

test('an ordinary lead keeps its ordinary card', () => {
  const { embeds } = buildLeadCard({
    leadId: 'l1',
    name: 'Maria Delgado',
    estimateDollars: 879,
    formStep: 'quote',
  })
  assert.match(embeds[0].title ?? '', /New quote request/)
  assert.match(JSON.stringify(embeds[0]), /\$879/)
})

test('an in-person card NEVER shows a dollar amount, even if one is passed', () => {
  // Defence in depth: the route already refuses to compute one, but a card
  // that would render a stray number is a card that will eventually render one.
  const { embeds } = buildLeadCard({
    leadId: 'l1',
    name: 'Maria Delgado',
    estimateDollars: 1199, // deliberately wrong: the card must refuse it
    formStep: IN_PERSON_STEP,
  })
  const body = JSON.stringify(embeds[0])
  assert.ok(!/1,199/.test(body), 'a stray number must not reach an in-person card')
  assert.ok(!/\$\d/.test(body), 'no currency may appear on an in-person card')
  assert.match(body, /In-person estimate requested/i)
})

test('the plain alert formatter labels it too', () => {
  const { title, lines } = formatLeadAlert({
    id: 'l1',
    name: 'Maria Delgado',
    formStep: IN_PERSON_STEP,
  })
  assert.match(title, new RegExp(IN_PERSON_ALERT_LABEL))
  assert.ok(lines.some((l) => l.message.includes(IN_PERSON_ALERT_LABEL)))
})

// ── The confirmation email ────────────────────────────────────────────────

test('the in-person email uses the promised confirmation sentence', async () => {
  const body = await render({
    firstName: 'Maria',
    inPerson: true,
    businessPhone: '862-640-0625',
    locale: 'en',
  })
  assert.match(body, /in-person estimate request has been received/i)
  assert.match(body, /local team will contact you to arrange a convenient time/i)
})

test('the in-person email carries NO price, even when one is passed', async () => {
  // The template must not depend on the caller remembering to omit it.
  const body = await render({
    firstName: 'Maria',
    inPerson: true,
    estimatedPrice: '$1,199',
    businessPhone: '862-640-0625',
    locale: 'en',
  })
  assert.ok(!body.includes('1,199'), 'an in-person request was never quoted a number')
  assert.ok(
    !/preliminary estimate is approximately/i.test(body),
    'the estimate paragraph must be absent, not empty'
  )
})

test('the ordinary email still shows the estimate', async () => {
  const body = await render({
    firstName: 'Maria',
    estimatedPrice: '$879',
    businessPhone: '862-640-0625',
    locale: 'en',
  })
assert.match(body, /879/)
})

test('the Spanish in-person email is a real translation, not the English one', async () => {
  const body = await render({
    firstName: 'Maria',
    inPerson: true,
    businessPhone: '862-640-0625',
    locale: 'es',
  })
  assert.match(body, /estimado en persona/i)
  assert.match(body, /equipo local se comunicar/i)
  assert.ok(!/has been received/i.test(body), 'the English sentence must not leak into the Spanish send')
})
