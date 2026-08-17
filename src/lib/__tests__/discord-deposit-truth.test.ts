// ════════════════════════════════════════════════════════════════════════
//  T4 / R7 — THE SECOND OWNER SURFACE THAT CLAIMED A CAPTURE (2026-08-15)
//  ---------------------------------------------------------------------
//  Round 2 removed `capturedCents ?? booking.depositAmount ?? 4900` from the
//  Approved card (discord-card-truth.test.ts pins that, and it still holds).
//  The `/booking` DETAILS card printed the same untruth by another route:
//
//      `Deposit: ${moneyC(booking.depositAmount)} · Paid: ${yn(booking.depositPaid)}`
//
//  Both halves are columns, not evidence. `depositAmount` is what the booking
//  was SUPPOSED to be charged, and `depositPaid` is written by the approval
//  CLAIM — before any money moves, which is precisely why booking-approval.ts
//  documents it as proving nothing and makes a COMPLETED Payment row on the
//  booking's own intent the only proof. So in the B1 failure state (row
//  CONFIRMED, $49 captured at Stripe, no Payment row) this card told Diego
//  "Deposit: $49.00 · Paid: Yes", and Diego tells the customer.
//
//  HOW THIS IS TESTED. `depositEvidenceLines` is declared at module level in the
//  route with no free bindings, lifted out of the shipped source, transpiled and
//  CALLED — the same technique day-anchor-display and discord-card-truth use,
//  because a Next.js route file may only export handlers. Comments are stripped
//  before the lift, so nothing here can be satisfied by prose.
//
//  MUTATION-TESTED — measured, not assumed. In the shipped route:
//    • drop `p.status === "COMPLETED"`        → tests 4 and 9 red
//    • drop `p.stripePaymentIntentId === intent` → tests 5 and 9 red
//    • put the old `Deposit: … · Paid: …` line back in the Pricing block
//      → test 9 red (1-8 exercise the lifted helper, which still exists; 9 is
//      the guard that the card actually renders it)
// ════════════════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

const ROOT = join(__dirname, '..', '..', '..')
const ROUTE = join(ROOT, 'app', 'api', 'discord', 'interactions', 'route.ts')

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

type Booking = { depositAmount?: number | null; depositPaid?: boolean | null; stripePaymentIntentId?: string | null }
type Pay = { status?: string | null; amount?: number | null; stripePaymentIntentId?: string | null }

function shippedLines(): (b: Booking, p: Pay[]) => string[] {
  const declaration = declarationOf(codeOf(ROUTE), 'function depositEvidenceLines(')
  const js = ts.transpileModule(declaration, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText
  return new Function(`${js}\nreturn depositEvidenceLines;`)()
}

const lines = shippedLines()
const PI = 'pi_deposit_1'
const BOOKING: Booking = { depositAmount: 4900, depositPaid: true, stripePaymentIntentId: PI }
const flat = (out: string[]) => out.join('\n')

test('R7: a COMPLETED payment on the booking\'s own intent IS proof — the amount prints', () => {
  const out = lines(BOOKING, [{ status: 'COMPLETED', amount: 4900, stripePaymentIntentId: PI }])
  assert.match(flat(out), /Deposit captured: \$49\.00/)
  assert.match(flat(out), new RegExp(PI))
})

test('R7: the amount printed is the RECORDED one, never the quoted one', () => {
  // A $1 owner test capture against a booking quoted at $49.
  const out = lines(BOOKING, [{ status: 'COMPLETED', amount: 100, stripePaymentIntentId: PI }])
  assert.match(flat(out), /Deposit captured: \$1\.00/)
  assert.match(flat(out), /Deposit quoted: \$49\.00/, 'the quote is still shown — as the quote')
  assert.ok(!/Deposit captured: \$49\.00/.test(flat(out)))
})

test('R7 REPRODUCTION: the B1 state (depositPaid, no Payment row) must NOT read as paid', () => {
  const out = lines(BOOKING, [])
  const s = flat(out)
  assert.match(s, /Deposit captured: NOT RECORDED/)
  assert.match(s, /Check Stripe/i, 'the owner is told what to do before speaking to the customer')
  assert.ok(!/·\s*Paid: Yes/.test(s), 'the old line is back')
  // The quoted figure may appear, LABELLED as quoted — never as a capture.
  assert.ok(!/captured: \$/i.test(s), `an unproven amount was printed: ${s}`)
})

test('R7: a PENDING payment is not a capture', () => {
  const out = lines(BOOKING, [{ status: 'PENDING', amount: 4900, stripePaymentIntentId: PI }])
  assert.match(flat(out), /Deposit captured: NOT RECORDED/)
})

test('R7: a move-day payment on a DIFFERENT intent can never stand in for the deposit', () => {
  const out = lines(BOOKING, [{ status: 'COMPLETED', amount: 55000, stripePaymentIntentId: 'pi_moveday' }])
  const s = flat(out)
  assert.match(s, /Deposit captured: NOT RECORDED/)
  assert.ok(!/550\.00/.test(s), 'the balance payment leaked into the deposit line')
})

test('R7: an unpaid booking says plainly that nothing is recorded, without alarming', () => {
  const out = lines({ depositAmount: 4900, depositPaid: false, stripePaymentIntentId: PI }, [])
  const s = flat(out)
  assert.match(s, /Deposit captured: no record/)
  assert.ok(!/NOT RECORDED/.test(s), 'a booking that was never approved is not an incident')
})

test('R7: no intent at all cannot be matched, so nothing is claimed', () => {
  const out = lines({ depositAmount: 4900, depositPaid: true, stripePaymentIntentId: null }, [
    { status: 'COMPLETED', amount: 4900, stripePaymentIntentId: null },
  ])
  assert.match(flat(out), /Deposit captured: NOT RECORDED/)
})

test('R7: a missing deposit amount prints a dash, not a default fee', () => {
  const out = lines({ depositAmount: null, depositPaid: false, stripePaymentIntentId: PI }, [])
  assert.match(flat(out), /Deposit quoted: —/)
  assert.ok(!/49/.test(flat(out)), 'the standard fee must never be assumed')
})

test('R7: the details card renders the evidence lines and no longer reads depositPaid for money', () => {
  const code = codeOf(ROUTE)
  assert.ok(
    /\.\.\.depositEvidenceLines\(booking, booking\.payments\)/.test(code),
    'the Pricing block must render the evidence lines',
  )
  assert.ok(
    !/Deposit: \$\{moneyC\(booking\.depositAmount\)\} · Paid: \$\{yn\(booking\.depositPaid\)\}/.test(code),
    'the column-only deposit line is back',
  )
  assert.ok(
    /p\.status === "COMPLETED"/.test(code) && /p\.stripePaymentIntentId === intent/.test(code),
    'proof is a COMPLETED payment on the booking\'s own intent — both halves are required',
  )
})
