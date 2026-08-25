// ════════════════════════════════════════════════════════════════════════
//  NEW-LEAD NOTICE (owner request 2026-07-28)
//
//  The wording is the product here. These lock the properties that decide
//  whether the owner can trust the card: consent stated honestly, the alerts
//  channel left alone, and the contact details actually present.
// ════════════════════════════════════════════════════════════════════════

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { consentLine, formatLeadAlert } from '../lead-alert'
import { PACKAGES } from '../pricing-config'

const base = { id: 'lead_1', name: 'Maria Vasquez', phone: '862-640-0625', email: 'maria@example.com' }

test('an opted-in lead is visibly distinct from one that is not', () => {
  const yes = formatLeadAlert({ ...base, emailMarketingConsent: true })
  const no = formatLeadAlert({ ...base, emailMarketingConsent: false })
  assert.match(yes.title, /opted in/i)
  assert.ok(!/opted in/i.test(no.title), 'a non-consenting lead must not read as opted in')
  assert.notEqual(yes.title, no.title)
})

test('the consent states are never flattened — and "not asked" needs proof', () => {
  // The whole point of tri-state. "not asked" and "not opted in" are
  // different facts and the owner is entitled to both.
  assert.match(consentLine(true), /Opted in/i)
  assert.match(consentLine(false), /not opted in/i)

  //  REGRESSION (incident 2026-08-25). A bare `null` used to render "not
  //  asked". That is a claim about US, not about the customer, and it was
  //  false for every booking-form lead: that form shows the checkbox on the
  //  very step that creates the lead, and only reported a value once the box
  //  had been CLICKED. Without provenance the honest answer is that this
  //  record cannot say — so a bare null must not claim we never asked.
  assert.doesNotMatch(consentLine(null), /not asked/i)
  assert.doesNotMatch(consentLine(undefined), /not asked/i)
  assert.match(consentLine(null), /unknown/i)

  //  "Not asked" is now EARNED: the client says the box was absent...
  assert.match(consentLine(null, { marketingConsentPrompted: false }), /not asked/i)
  //  ...and a box that WAS shown, with no opt-in recorded, is a decline.
  assert.match(consentLine(null, { marketingConsentPrompted: true }), /not opted in/i)
  //  A surface known to ask stays unknown rather than borrowing the claim.
  assert.doesNotMatch(consentLine(null, { captureSurface: 'BOOKING_FORM' }), /not asked/i)

  assert.notEqual(consentLine(false), consentLine(null))
  assert.notEqual(consentLine(null, { marketingConsentPrompted: false }), consentLine(null))
})

test('a null consent NEVER claims the person opted in', () => {
  const { title, lines } = formatLeadAlert({ ...base, emailMarketingConsent: null })
  const text = [title, ...lines.map((l) => l.message)].join('\n')
  assert.ok(!/OPTED IN/.test(text), 'never-asked must not be reported as consent')
})

test('the card carries what the owner needs to act', () => {
  const { lines } = formatLeadAlert({
    ...base, emailMarketingConsent: true, source: 'QUICK_QUOTE_FORM', moveSize: '2br',
    originZip: '07001', destinationZip: '07002', estimatedValue: 89900,
    moveDate: new Date('2026-08-14T15:00:00Z'),
  })
  const text = lines.map((l) => l.message).join('\n')
  assert.match(text, /862-640-0625/, 'phone')
  assert.match(text, /maria@example\.com/, 'email')
  // The size must be spelled out USING THE PRICE BOOK'S OWN LABEL. This used to
  // assert the literal "2 bedrooms", which pinned a hand-written second label
  // book that had drifted from PACKAGES ("Little studio" vs "Small Studio").
  // Asserting equality with PACKAGES makes the two impossible to separate.
  assert.match(text, new RegExp(PACKAGES['2br'].label), 'the size must use the price-book label')
  assert.match(text, /07001 → 07002/, 'both ends of the move')
  assert.match(text, /\$899/, 'the estimate')
  assert.match(text, /Quick quote form/, 'the capture surface')
})

test('an unrecognised source is shown raw, not renamed', () => {
  // PREVENTS: a mis-tagged form hiding behind an invented friendly label.
  const { lines } = formatLeadAlert({ ...base, source: 'SOME_NEW_FORM' })
  assert.match(lines.map((l) => l.message).join('\n'), /SOME_NEW_FORM/)
})

test('a lead with almost no detail still produces a usable card', () => {
  const { title, lines } = formatLeadAlert({ id: 'lead_2' })
  assert.match(title, /New lead/)
  assert.ok(lines.length > 0, 'an empty card would be dropped by the sender')
  const text = lines.map((l) => l.message).join('\n')
  //  A card with NOTHING behind it must claim nothing. This used to assert
  //  "not asked" — an affirmative statement about a customer derived from an
  //  empty object — and the same card printed "From: OTHER" beside it.
  assert.match(text, /Marketing email: Unknown/i)
  assert.match(text, /Tracked acquisition: Unknown/i)
  assert.doesNotMatch(text, /not asked/i)
  assert.doesNotMatch(text, /\bOTHER\b/)
})

test('lead notices never target the ops ALERTS channel', () => {
  // PREVENTS: routine sales traffic muting the channel that carries incidents.
  // If the alerts channel gets muted, the critical alerts go with it.
  const src = readFileSync(resolve(__dirname, '../lead-alert.ts'), 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.ok(!/DISCORD_CHANNEL_ALERTS/.test(code), 'leads must not post to the alerts channel')
  assert.match(code, /DISCORD_CHANNEL_LEADS/)
  assert.match(code, /DISCORD_CHANNEL_OPERATIONS/, 'a fallback must exist so this degrades to visible, not silent')
})

test('the notice fires only for NEW leads, never a repeat submission', () => {
  // PREVENTS: a returning visitor re-pinging the owner on every keystroke
  // capture. A repeat submission merges and takes the update path.
  const src = readFileSync(resolve(__dirname, '../leads.ts'), 'utf8')
  assert.match(src, /if \(res\?\.isNew && opts\.notifyOwner !== false\) notifyOwnerOfNewLead/, 'partial capture path')
  assert.match(src, /if \(res\.isNew\) \{[\s\S]{0,400}notifyOwnerOfNewLead/, 'full capture path')
})

test('opting out of the notice takes an EXPLICIT false — every other caller still pings', () => {
  // The quick quote posts its own richer card (quote-capture.ts) and would
  // otherwise double-ping the owner. Anything that simply does not pass the
  // option — the booking form, the homepage estimate, the QR pages — keeps the
  // notice, so a new capture surface cannot go quiet by forgetting a flag.
  const src = readFileSync(resolve(__dirname, '../leads.ts'), 'utf8')
  assert.match(src, /opts: CapturePartialOptions = \{\}/, 'the option defaults to the empty object')
  assert.match(src, /notifyOwner\?: boolean/, 'and the flag is optional')
  assert.ok(
    !/opts\.notifyOwner === true/.test(src),
    'must not require an opt-IN — that would silence every existing caller'
  )
  const route = readFileSync(resolve(__dirname, '../../../app/api/leads/quote-capture/route.ts'), 'utf8')
  assert.match(route, /\{ notifyOwner: false \}/, 'the quick-quote route is the one caller that opts out')
})

test('the notice is fire-and-forget so a Discord outage cannot cost a lead', () => {
  const src = readFileSync(resolve(__dirname, '../leads.ts'), 'utf8')
  assert.match(src, /function notifyOwnerOfNewLead\(leadId: string, context: string\): void/,
    'must return void — an awaited notice could delay or fail the capture')
  assert.match(src, /void \(async \(\) => \{/)
})
