import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildPartialLeadCreate,
  buildPartialLeadUpdate,
  type ExistingPartialLead,
  type PartialLeadInput,
} from '../leads'

/**
 * SITE ACCESS FROM THE QUICK QUOTE (step 4).
 *
 * The page asked three questions — stairs at pickup, stairs at destination,
 * large or heavy items — and then threw the answers away. They were never in
 * the request schema, so zod stripped them silently; nothing downstream ever
 * saw them. These tests pin the behaviour that replaced that.
 */

const NOW = new Date('2026-08-04T12:00:00.000Z')

const existing = (over: Partial<ExistingPartialLead> = {}): ExistingPartialLead => ({
  id: 'lead_1',
  status: 'NEW' as ExistingPartialLead['status'],
  quoteConfirmationQueuedAt: null,
  name: 'Maria Delgado',
  phone: '9735551234',
  email: 'maria@example.com',
  bookingSessionId: 'sess-1',
  lifecycle: null,
  emailMarketingConsent: null,
  formStep: 'quote',
  estimatedValue: 87900,
  utmSource: null,
  utmCampaign: null,
  landingPage: null,
  referrer: null,
  promoCode: null,
  notes: null,
  ...over,
})

const input = (over: Partial<PartialLeadInput> = {}): PartialLeadInput => ({
  email: 'maria@example.com',
  firstName: 'Maria',
  lastName: 'Delgado',
  phone: '9735551234',
  bookingSessionId: 'sess-1',
  formStep: 'quote',
  ...over,
})

test('create: the access line is stored on the lead', () => {
  const row = buildPartialLeadCreate(
    input({ accessDetails: 'From the quick quote — Stairs at pickup: yes; Large or heavy items: yes.' }),
    NOW
  )
  assert.equal(row.notes, 'From the quick quote — Stairs at pickup: yes; Large or heavy items: yes.')
})

test('create: no answers means no note, not an empty string', () => {
  assert.equal(buildPartialLeadCreate(input(), NOW).notes, null)
  assert.equal(buildPartialLeadCreate(input({ accessDetails: '   ' }), NOW).notes, null)
})

test('update: fills notes when the lead has none', () => {
  const patch = buildPartialLeadUpdate(
    existing({ notes: null }),
    input({ accessDetails: 'From the quick quote — Stairs at destination: no.' }),
    NOW,
    'session'
  )
  assert.equal(patch.notes, 'From the quick quote — Stairs at destination: no.')
})

test('update: NEVER overwrites a note a human already wrote', () => {
  // The owner's own words are not recoverable; a lost correction is. This is
  // the deliberate trade documented on PartialLeadInput.accessDetails.
  const patch = buildPartialLeadUpdate(
    existing({ notes: 'Called her — wants the crew before 9am. Gate code 4412.' }),
    input({ accessDetails: 'From the quick quote — Stairs at pickup: no.' }),
    NOW,
    'session'
  )
  assert.equal(patch.notes, 'Called her — wants the crew before 9am. Gate code 4412.')
})

test('update: a capture with no access answers does not blank an existing note', () => {
  const patch = buildPartialLeadUpdate(
    existing({ notes: 'Second-floor walk-up, no elevator.' }),
    input(),
    NOW,
    'session'
  )
  assert.equal(patch.notes, 'Second-floor walk-up, no elevator.')
})

test('update: an email-only match is treated the same way — fill blanks only', () => {
  const filled = buildPartialLeadUpdate(
    existing({ notes: null }),
    input({ accessDetails: 'From the quick quote — Large or heavy items: yes.' }),
    NOW,
    'email'
  )
  assert.equal(filled.notes, 'From the quick quote — Large or heavy items: yes.')

  const preserved = buildPartialLeadUpdate(
    existing({ notes: 'Owner note.' }),
    input({ accessDetails: 'From the quick quote — Large or heavy items: yes.' }),
    NOW,
    'email'
  )
  assert.equal(preserved.notes, 'Owner note.')
})
