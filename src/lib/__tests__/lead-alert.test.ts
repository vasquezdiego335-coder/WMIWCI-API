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

const base = { id: 'lead_1', name: 'Maria Vasquez', phone: '862-640-0625', email: 'maria@example.com' }

test('an opted-in lead is visibly distinct from one that is not', () => {
  const yes = formatLeadAlert({ ...base, emailMarketingConsent: true })
  const no = formatLeadAlert({ ...base, emailMarketingConsent: false })
  assert.match(yes.title, /opted in/i)
  assert.ok(!/opted in/i.test(no.title), 'a non-consenting lead must not read as opted in')
  assert.notEqual(yes.title, no.title)
})

test('the three consent states are never flattened', () => {
  // The whole point of tri-state. "not asked" and "not opted in" are
  // different facts and the owner is entitled to both.
  assert.match(consentLine(true), /OPTED IN/)
  assert.match(consentLine(false), /not opted in/)
  assert.match(consentLine(null), /not asked/)
  assert.match(consentLine(undefined), /not asked/)
  assert.notEqual(consentLine(false), consentLine(null))
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
  assert.match(text, /2 bedrooms/, 'the size key must be spelled out')
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
  assert.match(lines.map((l) => l.message).join('\n'), /not asked/)
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
  assert.match(src, /if \(res\?\.isNew\) notifyOwnerOfNewLead/, 'partial capture path')
  assert.match(src, /if \(res\.isNew\) \{[\s\S]{0,400}notifyOwnerOfNewLead/, 'full capture path')
})

test('the notice is fire-and-forget so a Discord outage cannot cost a lead', () => {
  const src = readFileSync(resolve(__dirname, '../leads.ts'), 'utf8')
  assert.match(src, /function notifyOwnerOfNewLead\(leadId: string, context: string\): void/,
    'must return void — an awaited notice could delay or fail the capture')
  assert.match(src, /void \(async \(\) => \{/)
})
