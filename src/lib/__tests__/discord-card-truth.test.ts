// ════════════════════════════════════════════════════════════════════════
//  R7 — THE APPROVED CARD MAY PRINT ONLY WHAT WAS PROVED (2026-08-15)
//  ---------------------------------------------------------------------
//  `confirmedCard` in app/api/discord/interactions/route.ts read
//  `capturedCents ?? booking.depositAmount ?? 4900` under a hardcoded "Deposit
//  captured", so the owner's card announced "💳 Captured $49.00" even when the
//  approval had verified nothing. That is exactly the B1 failure state — booking
//  CONFIRMED, no COMPLETED Payment row, $49 sitting in Stripe unrecorded — and
//  the card told Diego the money was in. He then tells the customer.
//
//  HOW THIS IS TESTED. The card builder cannot be imported: a Next.js route file
//  may only export handlers, and moving the function out would break the R3-1
//  guard in day-anchor-display.test.ts, which reads it from THIS file. So the
//  shipped declaration is lifted out of the source, transpiled, and CALLED —
//  these are behavioural assertions about the real function, not a grep over its
//  text. Comments are stripped before the lift, so no assertion here can be
//  satisfied by prose.
// ════════════════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

const ROOT = join(__dirname, '..', '..', '..')
const ROUTE = join(ROOT, 'app', 'api', 'discord', 'interactions', 'route.ts')

/** Source with every comment removed — the same treatment day-anchor-display
 *  gives it, so a claim can never be satisfied by a comment. */
function codeOf(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\r\n?/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n')
}

/** The whole `function name(...) { ... }` declaration, brace-matched. */
function declarationOf(code: string, declaration: string): string {
  const start = code.indexOf(declaration)
  assert.ok(start > -1, `could not find \`${declaration}\` — this guard has drifted from the source`)
  const open = code.indexOf('{', code.indexOf(')', start))
  let depth = 0
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth++
    else if (code[i] === '}' && --depth === 0) return code.slice(start, i + 1)
  }
  assert.fail(`unbalanced braces after \`${declaration}\``)
}

type Card = {
  embeds: Array<{
    title: string
    description: string
    fields: Array<{ name: string; value: string }>
    footer: { text: string }
  }>
  components: unknown[]
}

/** The SHIPPED confirmedCard, transpiled and callable. Its only free binding is
 *  formatMoveWhen, which is injected. */
function shippedConfirmedCard(): (
  booking: Record<string, unknown>,
  approver: string,
  capturedCents?: number | null,
  receiptUrl?: string | null,
) => Card {
  const declaration = declarationOf(codeOf(ROUTE), 'function confirmedCard(')
  const js = ts.transpileModule(declaration, {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText
  const factory = new Function('formatMoveWhen', `${js}\nreturn confirmedCard;`)
  return factory(() => 'Thursday, July 15, 2027')
}

const card = shippedConfirmedCard()
const BOOKING = { displayId: 'WMIC-1042', customer: { name: 'Sam Rivera' }, requestedDate: null, confirmedDate: null }
const flat = (c: Card) => JSON.stringify(c)
const field = (c: Card, name: string) => c.embeds[0].fields.find((f) => f.name.includes(name))

test('R7: a VERIFIED capture prints the amount that was captured', () => {
  const c = card(BOOKING, 'Diego', 4900, null)
  assert.equal(field(c, 'Captured')?.value, '$49.00')
  assert.match(c.embeds[0].description, /Deposit captured/)
})

test('R7: the amount printed is the one the CALL proved, not the standard fee', () => {
  // A controlled test payment captures $1. The card must say $1.
  const c = card(BOOKING, 'Diego', 100, null)
  assert.equal(field(c, 'Captured')?.value, '$1.00')
  assert.ok(!flat(c).includes('49.00'), 'the $49 fee must never appear when $1 was captured')
})

test('R7 REPRODUCTION: capturedCents null ⇒ no dollar figure and no capture claim', () => {
  // This is the B1 failure state the convergence path returns null for: the row
  // reads CONFIRMED, the Payment row is missing or not COMPLETED.
  const c = card(BOOKING, 'Diego', null, null)
  assert.ok(!/\$\d/.test(flat(c)), `the card printed an unproven amount: ${flat(c)}`)
  assert.ok(!/Deposit captured/.test(flat(c)), 'nothing may assert a capture this call did not verify')
  assert.match(field(c, 'Deposit')?.value ?? '', /Not verified/)
  assert.match(c.embeds[0].description, /did NOT verify/)
})

test('R7 REPRODUCTION: a booking carrying depositAmount 4900 still prints nothing', () => {
  // The deleted fallback was `capturedCents ?? booking.depositAmount ?? 4900`.
  // Both halves are gone: a booking that carries the number cannot lend it to
  // the card, and there is no hardcoded default underneath.
  const c = card({ ...BOOKING, depositAmount: 4900, depositPaid: true }, 'Diego', null, null)
  assert.ok(!flat(c).includes('49.00'), `the booking's own deposit column leaked into the card: ${flat(c)}`)
  assert.ok(!flat(c).includes('4900'))
})

test('R7: undefined is treated exactly like null — unknown is unknown', () => {
  const c = card(BOOKING, 'Diego', undefined, null)
  assert.ok(!/\$\d/.test(flat(c)))
  assert.match(field(c, 'Deposit')?.value ?? '', /Not verified/)
})

test('R7: the source carries no 4900 fallback and never reads depositAmount for the card', () => {
  const declaration = declarationOf(codeOf(ROUTE), 'function confirmedCard(')
  assert.ok(!/4900/.test(declaration), 'the hardcoded cents fallback is back')
  assert.ok(!/depositAmount/.test(declaration), 'the card must not reach for the booking column')
})

test('R7: the call site passes capturedCents through — null is not coerced away', () => {
  const code = codeOf(ROUTE)
  assert.ok(
    /confirmedCard\(result\.booking, approverName, result\.capturedCents,/.test(code),
    'the handler must hand the card the real value, null included',
  )
  assert.ok(
    !/result\.capturedCents \?\? undefined/.test(code),
    'coercing null to undefined would re-create the fallback by another route',
  )
})

test('R7: everything the card DOES prove still renders (identity, date, approver, receipt)', () => {
  const c = card(BOOKING, 'Diego', 4900, 'https://stripe.example/receipt/abc')
  assert.match(c.embeds[0].title, /WMIC-1042/)
  assert.equal(field(c, 'Customer')?.value, 'Sam Rivera')
  assert.equal(field(c, 'Move date')?.value, 'Thursday, July 15, 2027')
  assert.equal(c.embeds[0].footer.text, 'Approved by Diego')
  assert.equal(c.components.length, 1, 'the receipt button survives')
  // ...and an unverified capture still gets no receipt button invented for it.
  assert.equal(card(BOOKING, 'Diego', null, null).components.length, 0)
})
