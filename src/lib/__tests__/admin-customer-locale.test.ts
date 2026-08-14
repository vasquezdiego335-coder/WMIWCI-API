// ════════════════════════════════════════════════════════════════════════════
//  admin-customer-locale.test.ts — R2-7.1: booking a repeat customer must not
//  silently change the language their emails are written in.
//
//  THE DEFECT: `AdminBookingSchema` defaulted `customer.locale` to 'en', so
//  EVERY submission arrived looking as though the owner had chosen English —
//  including the one place the owner never sees the field at all, the lead
//  prefill (`/admin/book?leadId=`), which carried no locale. Converting a
//  Spanish-speaking repeat customer's lead therefore wrote locale = 'en' over
//  their stored 'es', and every lifecycle email after that went out in a
//  language they did not ask for. `resolveCustomerMutation` was working
//  correctly the whole time — it writes a supplied value — so a test that hands
//  it `{ locale: undefined }` proves nothing. The defect lived in what "supplied"
//  meant, which is decided by the SCHEMA.
//
//  These tests therefore start from a RAW POST BODY and go through
//  AdminBookingSchema, the way the route does. With the round-1 default in
//  place they fail.
//
//  Offline: no DB, no network. Run:
//    npx tsx --test src/lib/__tests__/admin-customer-locale.test.ts
// ════════════════════════════════════════════════════════════════════════════

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  AdminBookingSchema,
  resolveCustomerMutation,
  type AdminBookingInput,
  type CustomerContact,
} from '../admin-booking'

const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

/** A repeat customer whose emails go out in Spanish. */
const MARISOL: CustomerContact = {
  id: 'cust_marisol',
  name: 'Marisol Reyes',
  email: 'marisol@example.com',
  phone: '973-555-0143',
  locale: 'es',
}

/** The raw body the Book Move form POSTs. `customer` is spread in verbatim so
 *  a test can omit the locale key entirely — which is exactly what the form
 *  now sends when the owner never touches the language select. */
function parseBody(customer: Record<string, unknown>): AdminBookingInput {
  const res = AdminBookingSchema.safeParse({
    customer,
    move: {
      serviceType: '2br',
      moveDate: FUTURE,
      originAddress: { street: '12 Main St', city: 'West Orange', zip: '07052' },
      destAddress: { street: '99 Oak Ave', city: 'Montclair', state: 'NJ', zip: '07042' },
    },
    services: { serviceMode: 'full_service' },
    inventory: [],
    pricing: { ownerTotal: 700 },
    deposit: { mode: 'stripe_link' },
  })
  assert.ok(res.success, `payload must be valid: ${!res.success ? JSON.stringify(res.error.flatten()) : ''}`)
  return res.data
}

/** The route's own customer decision, over a parsed body: it loads the picked
 *  row by id and the row that owns the submitted email, then asks the pure
 *  resolver what to write. */
function bookAs(customer: Record<string, unknown>, existing: CustomerContact | null) {
  const d = parseBody(customer)
  return {
    parsed: d,
    mutation: resolveCustomerMutation({
      pickedId: d.customer.id,
      existing,
      emailOwner: existing && existing.email === d.customer.email ? existing : null,
      submitted: d.customer,
      fallbackEmail: d.customer.email ?? 'no-email@placeholder.invalid',
    }),
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  The guarantee
// ════════════════════════════════════════════════════════════════════════════

test('R2-7.1: an untouched language field is ABSENT, not a silent "English"', () => {
  // The schema is where the defect lived: a default turned "the owner said
  // nothing" into "the owner said English".
  const d = parseBody({ name: 'Marisol Reyes', email: 'marisol@example.com', phone: '973-555-0143' })
  assert.equal(d.customer.locale, undefined, 'no locale key must survive as undefined, never as a default')

  // An empty string is the same statement, made by an older client.
  const blank = parseBody({ name: 'Marisol Reyes', email: 'marisol@example.com', locale: '' })
  assert.equal(blank.customer.locale, undefined)
})

test('R2-7.1: booking a Spanish-speaking repeat customer never flips them to English', () => {
  // The exact lead-conversion shape: the workspace linked their record by id,
  // the owner confirmed the name/email/phone on the phone, and never opened the
  // language select.
  const { mutation } = bookAs(
    {
      id: MARISOL.id,
      name: 'Marisol Reyes',
      email: 'marisol@example.com',
      phone: '973-555-0143',
    },
    MARISOL,
  )
  assert.equal(mutation.mode, 'use', 'nothing about this customer changed, so nothing is written')
  // 'use' carries no patch at all — belt and braces in case the mode ever
  // changes: whatever is written, it must not include a locale.
  const patch = (mutation as { data?: Record<string, unknown> }).data
  assert.ok(!patch || patch.locale === undefined, 'locale must not be written at all')
})

test('R2-7.1: an unrelated correction on the same booking still leaves the language alone', () => {
  // The owner fixes a typo in the phone number. That is a contact edit, not a
  // language decision — the update must carry the phone and ONLY the phone.
  const { mutation } = bookAs(
    {
      id: MARISOL.id,
      name: 'Marisol Reyes',
      email: 'marisol@example.com',
      phone: '973-555-0199',
    },
    MARISOL,
  )
  assert.equal(mutation.mode, 'update')
  assert.ok(mutation.mode === 'update')
  assert.equal(mutation.data.locale, undefined, 'the language is not part of a phone correction')
  assert.ok(!('locale' in mutation.before), 'nothing to audit about a language nobody touched')
  // Asserted LAST: node's strict deepEqual narrows `mutation.data` to the
  // literal it is compared against, which would hide the checks above.
  assert.deepEqual(mutation.data, { phone: '973-555-0199' }, 'only the field the owner actually changed')
})

// ════════════════════════════════════════════════════════════════════════════
//  What must still work
// ════════════════════════════════════════════════════════════════════════════

test('R2-7.1: the owner CAN still set a language, in either direction', () => {
  // Spanish speaker recorded as English → the owner fixes it.
  const toSpanish = bookAs(
    { id: 'cust_english', name: 'Dana Mover', email: 'dana@example.com', locale: 'es' },
    { id: 'cust_english', name: 'Dana Mover', email: 'dana@example.com', phone: '862-640-0625', locale: 'en' },
  )
  assert.equal(toSpanish.mutation.mode, 'update')
  assert.ok(toSpanish.mutation.mode === 'update')
  assert.equal(toSpanish.mutation.data.locale, 'es')
  assert.equal(toSpanish.mutation.before.locale, 'en', 'the change is auditable')

  // And back again, when the owner explicitly says English.
  const toEnglish = bookAs({ id: MARISOL.id, name: 'Marisol Reyes', email: 'marisol@example.com', locale: 'en' }, MARISOL)
  assert.equal(toEnglish.mutation.mode, 'update')
  assert.ok(toEnglish.mutation.mode === 'update')
  assert.equal(toEnglish.mutation.data.locale, 'en', 'an EXPLICIT English is a real choice and is written')
  assert.equal(toEnglish.mutation.before.locale, 'es')
})

test('R2-7.1: a brand-new customer with no stated language is created English', () => {
  // A create cannot overwrite a preference — there is none yet — so the house
  // default applies, and it applies at CREATE time, not through the schema.
  const fresh = bookAs({ name: 'New Person', email: 'new@example.com', phone: '862-640-0000' }, null)
  assert.equal(fresh.mutation.mode, 'create')
  assert.ok(fresh.mutation.mode === 'create')
  assert.equal(fresh.mutation.data.locale, 'en')

  const spanish = bookAs({ name: 'Nueva Persona', email: 'nueva@example.com', locale: 'es' }, null)
  assert.ok(spanish.mutation.mode === 'create')
  assert.equal(spanish.mutation.data.locale, 'es')
})

test('R2-7.1: locale is still validated — junk is refused, not coerced', () => {
  const bad = AdminBookingSchema.safeParse({
    customer: { name: 'X', email: 'x@example.com', locale: 'fr' },
    move: {
      serviceType: '2br',
      moveDate: FUTURE,
      originAddress: { street: '12 Main St', city: 'West Orange', zip: '07052' },
      destAddress: { street: '99 Oak Ave', city: 'Montclair', state: 'NJ', zip: '07042' },
    },
    services: { serviceMode: 'full_service' },
    inventory: [],
    pricing: { ownerTotal: 700 },
    deposit: { mode: 'stripe_link' },
  })
  assert.equal(bad.success, false, 'an unsupported language must 422, never fall back to English')
})

// ════════════════════════════════════════════════════════════════════════════
//  The two client-side halves of the same guarantee (source guards)
//
//  The schema fix only holds if the browser stops sending a locale it was never
//  given, and the owner only sees the truth if the lead prefill carries the
//  customer's stored language. Neither can be exercised offline — they are a
//  React island and a server component that reads Prisma — so these assert
//  about the SOURCE, with comments stripped first so a sentence describing the
//  code can never stand in for the code.
// ════════════════════════════════════════════════════════════════════════════

const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

test('R2-7.1: the Book Move form only submits a language the owner chose', () => {
  const src = stripComments(
    readFileSync(join(process.cwd(), 'app/(admin)/admin/(dashboard)/book/BookMoveForm.tsx'), 'utf8'),
  )
  // The POST body must send locale conditionally, not unconditionally.
  assert.match(
    src,
    /locale:\s*localeTouched\s*\?/,
    'the submitted locale must depend on the owner having touched the field',
  )
  assert.ok(
    !/\n\s+locale,\s*\n/.test(src),
    'a bare `locale,` in the POST body would send the form default on every booking',
  )
  // Choosing a language must be what marks it touched.
  assert.match(src, /setLocaleTouched\(true\)/, 'the select must record a real choice')
})

test('R2-7.1: the lead prefill carries the linked customer stored language', () => {
  const src = stripComments(readFileSync(join(process.cwd(), 'app/(admin)/admin/(dashboard)/book/page.tsx'), 'utf8'))
  assert.match(src, /locale:\s*true/, 'the customer lookup must select the stored locale')
  assert.match(src, /customerLocale:/, 'and hand it to the form, so the select shows their language')
})
