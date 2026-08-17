// ════════════════════════════════════════════════════════════════════════════
//  cancelled-booking-truth.test.ts — ITEM C2 / RELEASE BLOCKER B2
//
//  THE DEFECT, in the finding's own words: "a failed hold release still tells
//  the customer *the authorization on your card was released in full — you were
//  not charged*, and cancelling a CAPTURED booking shows *nothing is owed* and
//  *your card was never charged* next to a receipt link. In a dispute, the
//  customer's evidence is our own page."
//
//  Two mechanisms, both reproduced below before they are shown fixed:
//
//   1. THE PORTAL ASKED THE WRONG QUESTION FIRST. app/my-booking/[token]/page.tsx
//      read `status === 'cancelled' ? 'released' : captured ? 'captured' : …`, so
//      `captured` was never consulted for a cancelled booking. Six strings hung
//      off that answer, and `captured` itself was half `booking.depositPaid` —
//      a flag the approval CLAIM sets before Stripe is called.
//
//   2. THE DECLINE NEVER RECORDED WHAT HAPPENED, AND COULD NOT BE RETRIED.
//      `declineBooking` cancels first and releases after, inside a try/catch
//      that only warned; the email, the Discord card and the audit row all
//      asserted a release nobody had confirmed, and re-clicking Deny returned
//      `already_cancelled` BEFORE the release block, so the only repair the
//      owner had did nothing.
//
//  WHAT IS ACTUALLY EXERCISED — no paraphrases:
//   • `paymentView` / `isCharged` / `canShowReceipt` are IMPORTED from the
//     shipped app/my-booking/[token]/payment-view.ts;
//   • `heroConfig`, `nextSteps` and `trackerSteps` are LIFTED OUT OF page.tsx
//     with the TypeScript parser, transpiled and CALLED — a Next.js page may
//     only export its default component, so this is the only way to run the
//     real string builders. Comments are stripped before the lift, so no
//     assertion here can be satisfied by prose;
//   • `deniedCard` is lifted the same way out of the Discord route (its own
//     shipped comment names this file);
//   • `declineBooking` is the SHIPPED service, driven through `ApprovalDeps`;
//   • the declined EMAIL is the shipped React template through
//     @react-email/render;
//   • the audit row the shipped `recordDecline` is handed is fed BACK to the
//     shipped `provenHoldRelease`, which is what the portal reads — so the
//     writer and the reader are proven to speak the same vocabulary.
//
//  MUTATION-TESTED: every checker is first pointed at the PRE-FIX behaviour
//  (the status-first ternary, the unconditional email copy, the hardcoded card)
//  and shown to REPORT the defect. A checker that cannot fail proves nothing.
//
//  Offline: no database, no Stripe, no Redis, no network.
//    npx tsx --test src/lib/__tests__/cancelled-booking-truth.test.ts
// ════════════════════════════════════════════════════════════════════════════

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

import {
  paymentView,
  isCharged,
  isRefunded,
  canShowReceipt,
  type PaymentStatus,
  type PaymentView,
} from '../../../app/my-booking/[token]/payment-view'
import {
  depositEvidenceFrom,
  UNKNOWN_DEPOSIT_EVIDENCE,
  type DepositEvidence,
} from '../deposit-evidence'
import { provenHoldRelease, type AuditEvidenceRow, type ProofPayment } from '../../outbox/domain/captured-amount'
import {
  declineBooking,
  type ApprovableBooking,
  type ApprovalDeps,
  type ApprovalStore,
  type CapturedIntent,
  type DeclineCommitArgs,
  type HoldReleaseOutcome,
} from '../booking-approval'

/* eslint-disable @typescript-eslint/no-explicit-any */

const ROOT = join(__dirname, '..', '..', '..')
const PORTAL = join(ROOT, 'app', 'my-booking', '[token]', 'page.tsx')
const DISCORD_ROUTE = join(ROOT, 'app', 'api', 'discord', 'interactions', 'route.ts')

const PI = 'pi_c2'
/** The odd column value the contract names. Stripe never reports 12345, so any
 *  $123.45 in a customer-facing string came from `Booking.depositAmount`. */
const ODD_DEPOSIT_AMOUNT = 12345
const ODD_DOLLARS = '123.45'
const REAL_CAPTURE_CENTS = 4900

// ── Lifting a shipped declaration out of a file that cannot be imported ──────

/** Source with every comment removed, so a claim can never be satisfied by a
 *  comment (the same treatment discord-card-truth gives the Discord route). */
function codeOf(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\r\n?/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n')
}

/**
 * The exact text of a top-level `function NAME(...) {...}` declaration.
 *
 * Parsed with the TypeScript compiler rather than brace-matched by hand:
 * `nextSteps` and `trackerSteps` return OBJECT TYPE LITERALS, so the first `{`
 * after the parameter list belongs to the return type and a hand-rolled matcher
 * silently lifts half a function.
 */
function declarationOf(path: string, name: string): string {
  const source = ts.createSourceFile(path, codeOf(path), ts.ScriptTarget.ES2020, true, ts.ScriptKind.TSX)
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) {
      return statement.getText(source)
    }
  }
  assert.fail(`could not find \`function ${name}\` in ${path} — this guard has drifted from the source`)
}

/** Transpile a lifted declaration and hand back the callable function, with its
 *  free bindings injected by name. */
function lift<T>(path: string, name: string, bindings: Record<string, unknown> = {}): T {
  const js = ts.transpileModule(declarationOf(path, name), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React },
  }).outputText
  const names = Object.keys(bindings)
  const factory = new Function(...names, `${js}\nreturn ${name};`)
  return factory(...names.map((n) => bindings[n])) as T
}

// ── The SHIPPED portal string builders ──────────────────────────────────────

type PortalView = {
  status: string
  paymentStatus: PaymentStatus
  paidAmount: string | null
  heldAmount: string | null
  refundedAmount: string | null
  refundAmountUnknown: boolean
  customerFirstName: string
  requestedDate: string | null
  dateConfirmed: boolean
}

type HeroConfig = { eyebrow: string; title: string; lede: (v: PortalView) => string; reviewTitle: string; reviewBody: string; tone: string; showPaidChip: boolean }

const heroConfig = lift<(v: PortalView) => HeroConfig>(PORTAL, 'heroConfig', { isCharged })
const nextSteps = lift<(v: PortalView) => Array<{ t: string; b: string }>>(PORTAL, 'nextSteps', {})
const trackerSteps = lift<(v: PortalView) => Array<{ label: string; state: string }>>(PORTAL, 'trackerSteps', { isCharged })

/** Every customer-facing sentence the portal builds for one view, flattened. */
function portalText(v: PortalView): string {
  const hero = heroConfig(v)
  return [
    hero.eyebrow,
    hero.title,
    hero.lede(v),
    hero.reviewTitle,
    hero.reviewBody,
    ...nextSteps(v).map((s) => `${s.t} ${s.b}`),
    ...trackerSteps(v).map((s) => s.label),
  ].join(' | ')
}

function viewFor(evidence: DepositEvidence, over: Partial<PortalView> = {}): PortalView {
  const status = over.status ?? 'cancelled'
  const pay: PaymentView = paymentView(evidence, {
    cancelled: status === 'cancelled',
    awaitingPayment: status === 'awaiting_payment',
  })
  return {
    status,
    customerFirstName: 'Maria',
    requestedDate: 'Tuesday, September 14, 2027',
    dateConfirmed: false,
    ...pay,
    ...over,
  }
}

// ── The evidence fixtures, built from the columns the shipped writers persist ─

function capturedPayment(over: Partial<ProofPayment> = {}): ProofPayment {
  return {
    id: 'pay_1',
    amount: REAL_CAPTURE_CENTS,
    status: 'COMPLETED',
    isInternalTest: false,
    stripePaymentIntentId: PI,
    stripeChargeId: 'ch_1',
    refundedAmountCents: null,
    createdAt: new Date('2027-01-05T12:00:00.000Z'),
    ...over,
  }
}

/** The audit row `fulfillment.ts` writes for the AUTHORIZATION. */
const authorizedAudit = (cents: number | null): AuditEvidenceRow => ({
  action: 'PAYMENT_RECEIVED',
  details: { authorized: true, amount: cents, paymentIntentId: PI },
})

/** The audit row `recordDecline` writes for the RELEASE. */
const releaseAudit = (stripeResult: string): AuditEvidenceRow => ({
  action: 'BOOKING_STATE_CHANGED',
  details: { event: 'decline_booking', stripeResult, newStatus: 'CANCELLED' },
})

const evidence = (payments: ProofPayment[], audits: AuditEvidenceRow[]): DepositEvidence =>
  depositEvidenceFrom(payments, audits, { stripePaymentIntentId: PI })

// ── The checkers (pointed at the PRE-FIX output first, in section 0) ─────────

/** The four sentences the blocker quotes, in the shapes the portal builds. */
const NOT_CHARGED = /never charged|were not charged|was released in full|hold released/i
const NOTHING_OWED = /Nothing (further )?is owed|Nothing further is owed/i

function falseReleaseClaimIn(text: string): string | null {
  const m = NOT_CHARGED.exec(text)
  return m ? `claimed "${m[0]}"` : null
}
function inventedAmountIn(text: string): string | null {
  if (text.includes(ODD_DOLLARS)) return `printed $${ODD_DOLLARS} — the booking column`
  if (text.includes(String(ODD_DEPOSIT_AMOUNT))) return `printed ${ODD_DEPOSIT_AMOUNT} — the booking column in cents`
  return null
}

// ════════════════════════════════════════════════════════════════════════════
//  0. HARNESS CHECKS — the checkers SEE the original defect.
// ════════════════════════════════════════════════════════════════════════════

/** The pre-fix derivation, transcribed from the finding (page.tsx:197-202):
 *      const captured = booking.depositPaid || payments.some(p => p.status === 'COMPLETED')
 *      const paymentStatus = status === 'cancelled' ? 'released' : captured ? 'captured' : … */
function preFixPaymentStatus(booking: { depositPaid: boolean; payments: Array<{ status: string }> }, status: string): PaymentStatus {
  const captured = booking.depositPaid || booking.payments.some((p) => p.status === 'COMPLETED')
  return status === 'cancelled' ? 'released' : captured ? 'captured' : 'awaiting'
}

test('C2 harness check: the PRE-FIX portal called a CAPTURED cancelled booking "released"', () => {
  const status = preFixPaymentStatus({ depositPaid: true, payments: [{ status: 'COMPLETED' }] }, 'cancelled')
  assert.equal(status, 'released', 'the reproduction must reproduce, or nothing below means anything')

  // ...and the SHIPPED strings for that answer are the ones the blocker quotes.
  const text = portalText(viewFor(UNKNOWN_DEPOSIT_EVIDENCE, { paymentStatus: 'released', heldAmount: '$49', paidAmount: null }))
  assert.ok(falseReleaseClaimIn(text), 'the release checker cannot see the copy it exists to catch')
  assert.ok(NOTHING_OWED.test(text), 'the "nothing is owed" checker cannot see it either')
  assert.match(text, /your card was never charged/i)
})

test('C2 harness check: the PRE-FIX portal printed depositAmount as the fee', () => {
  // `bookingFee: (booking.depositAmount ?? 4900) / 100`, rendered into the lede.
  const preFixFee = `$${(ODD_DEPOSIT_AMOUNT / 100).toFixed(2)}`
  assert.ok(inventedAmountIn(`Your booking request and ${preFixFee} booking fee were received.`))
  // And the amount checker does not fire on a proven $49.
  assert.equal(inventedAmountIn('the $49.00 hold on your card has been released'), null)
})

test('C2 harness check: the PRE-FIX declined email asserted the release unconditionally', async () => {
  const React = await import('react')
  const { render } = await import('@react-email/render')
  const { default: BookingDeclined } = await import('../../emails/booking-declined')
  // The pre-fix template had NO conditional: every send got the released block.
  // `holdReleased: true` is that exact copy, and it is still reachable — which
  // is why the check below is about WHICH input produces it.
  const html = await render(React.createElement(BookingDeclined, { locale: 'en', amountHold: '49.00', holdReleased: true }))
  assert.ok(falseReleaseClaimIn(html.replace(/<[^>]+>/g, ' ')), 'the checker cannot see the released copy')
  assert.match(html.replace(/<[^>]+>/g, ' '), /You were not charged/)
})

// ════════════════════════════════════════════════════════════════════════════
//  1. THE PAYMENT STATE — the four combinations the blocker asked for a test on.
// ════════════════════════════════════════════════════════════════════════════

test('C2: cancelled + CAPTURED ⇒ captured, with the LEDGER figure (never depositAmount)', () => {
  const v = paymentView(evidence([capturedPayment()], [authorizedAudit(REAL_CAPTURE_CENTS)]), { cancelled: true, awaitingPayment: false })
  assert.equal(v.paymentStatus, 'captured')
  assert.equal(v.paidAmount, '$49')
  assert.equal(v.heldAmount, null, 'money that was taken is not a hold')
  assert.ok(isCharged(v.paymentStatus))
})

test('C2: cancelled + captured + FULL refund ⇒ refunded', () => {
  const v = paymentView(
    evidence([capturedPayment({ status: 'REFUNDED', refundedAmountCents: REAL_CAPTURE_CENTS })], []),
    { cancelled: true, awaitingPayment: false },
  )
  assert.equal(v.paymentStatus, 'refunded')
  assert.equal(v.refundedAmount, '$49')
  assert.ok(isRefunded(v.paymentStatus))
})

test('C2: cancelled + captured + PARTIAL refund ⇒ partially_refunded, not "refunded"', () => {
  const v = paymentView(
    evidence([capturedPayment({ status: 'PARTIALLY_REFUNDED', refundedAmountCents: 1000 })], []),
    { cancelled: true, awaitingPayment: false },
  )
  assert.equal(v.paymentStatus, 'partially_refunded')
  assert.equal(v.paidAmount, '$49')
  assert.equal(v.refundedAmount, '$10')
})

test('C2: a partial refund of UNKNOWN size states no refund figure', () => {
  const v = paymentView(
    evidence([capturedPayment({ status: 'PARTIALLY_REFUNDED', refundedAmountCents: null })], []),
    { cancelled: true, awaitingPayment: false },
  )
  assert.equal(v.paymentStatus, 'partially_refunded')
  assert.equal(v.refundedAmount, null)
  assert.equal(v.refundAmountUnknown, true)
})

test('C2: cancelled + no capture + PROVEN release ⇒ released', () => {
  const v = paymentView(evidence([], [releaseAudit('hold_released'), authorizedAudit(4900)]), { cancelled: true, awaitingPayment: false })
  assert.equal(v.paymentStatus, 'released')
  assert.equal(v.heldAmount, '$49')
  assert.equal(v.paidAmount, null)
})

test('C2 REPRODUCTION: cancelled + no capture + FAILED release ⇒ hold_unresolved, never "released"', () => {
  const v = paymentView(evidence([], [releaseAudit('release_failed: Stripe 503'), authorizedAudit(4900)]), { cancelled: true, awaitingPayment: false })
  assert.equal(v.paymentStatus, 'hold_unresolved')
  assert.notEqual(v.paymentStatus as string, 'released')
})

test('C2 REPRODUCTION: cancelled with NOTHING recorded either way ⇒ hold_unresolved', () => {
  // The state every decline before this item left behind: no release evidence.
  const v = paymentView(evidence([], []), { cancelled: true, awaitingPayment: false })
  assert.equal(v.paymentStatus, 'hold_unresolved')
})

test('C2: a booking that never had an authorization is honestly "released"', () => {
  const v = paymentView(evidence([], [releaseAudit('no_hold')]), { cancelled: true, awaitingPayment: false })
  assert.equal(v.paymentStatus, 'released')
  assert.equal(v.heldAmount, null, 'and no figure, because none was ever authorized')
})

test('C1/C2: an UNREADABLE ledger is not evidence — no money claim at all', () => {
  const v = paymentView(UNKNOWN_DEPOSIT_EVIDENCE, { cancelled: true, awaitingPayment: false })
  assert.equal(v.paymentStatus, 'unknown')
  assert.equal(v.paidAmount, null)
  assert.equal(v.heldAmount, null)
  assert.equal(v.refundedAmount, null)
})

test('C2: depositPaid is not an input at all — the flag cannot promote anything', () => {
  // `depositPaid: true` with an empty ledger is the exact B1 failure state.
  // paymentView never sees the column; it sees evidence, and there is none.
  const v = paymentView(evidence([], []), { cancelled: false, awaitingPayment: false })
  assert.equal(v.paymentStatus, 'received')
  assert.equal(v.paidAmount, null, 'nothing proves a capture, so nothing says one happened')
})

// ════════════════════════════════════════════════════════════════════════════
//  2. THE SHIPPED PORTAL STRINGS — run, not paraphrased.
// ════════════════════════════════════════════════════════════════════════════

test('C2 BLOCKER: a CAPTURED cancelled booking never says "not charged" or "nothing is owed"', () => {
  const v = viewFor(evidence([capturedPayment()], [authorizedAudit(REAL_CAPTURE_CENTS)]))
  assert.equal(v.paymentStatus, 'captured')
  const text = portalText(v)
  assert.equal(falseReleaseClaimIn(text), null, `the portal still claims a release: ${text}`)
  assert.equal(NOTHING_OWED.test(text), false, `the portal still says nothing is owed: ${text}`)
  // ...and it says the thing the cancellation email in the same inbox says.
  assert.match(text, /\$49 deposit was charged/i)
  assert.match(text, /follow up with you about it/i)
})

test('C2 BLOCKER: the receipt link may only appear where money was proven taken', () => {
  assert.equal(canShowReceipt('captured'), true)
  assert.equal(canShowReceipt('refunded'), true)
  assert.equal(canShowReceipt('partially_refunded'), true)
  assert.equal(canShowReceipt('released'), false, 'a receipt under "you were not charged" is the dispute exhibit')
  assert.equal(canShowReceipt('hold_unresolved'), false)
  assert.equal(canShowReceipt('unknown'), false)
  assert.equal(canShowReceipt('received'), false)
  assert.equal(canShowReceipt('awaiting'), false)

  // The page must actually consult it — the link used to be gated on the
  // Receipt row alone.
  const page = codeOf(PORTAL)
  assert.match(page, /v\.receiptUrl && canShowReceipt\(v\.paymentStatus\)/, 'the receipt link is no longer gated on the payment state')
})

test('C2: a FAILED release promises the release, and never asserts it', () => {
  const v = viewFor(evidence([], [releaseAudit('release_failed: Stripe 503'), authorizedAudit(4900)]))
  assert.equal(v.paymentStatus, 'hold_unresolved')
  const text = portalText(v)
  assert.equal(falseReleaseClaimIn(text), null, `the portal still claims the hold was released: ${text}`)
  assert.match(text, /re releasing the \$49 authorization/i)
  assert.match(text, /still (showing as )?pending/i, 'and it tells the customer what to do if it is not gone')
})

test('C2: a PROVEN release keeps the reassurance it has always given', () => {
  const v = viewFor(evidence([], [releaseAudit('hold_released'), authorizedAudit(4900)]))
  const text = portalText(v)
  assert.match(text, /released/i)
  assert.match(text, /you were not charged/i, 'the honest case must not be collateral damage')
  assert.ok(NOTHING_OWED.test(text))
})

test('C2: an UNREADABLE ledger says the booking state and nothing about the card', () => {
  const v = viewFor(UNKNOWN_DEPOSIT_EVIDENCE)
  const text = portalText(v)
  assert.equal(falseReleaseClaimIn(text), null)
  assert.equal(NOTHING_OWED.test(text), false, '"nothing is owed" is still a money statement')
  assert.ok(!/\$\d/.test(text), `an unreadable ledger printed a figure: ${text}`)
  assert.match(text, /can’t show your payment details/i)
})

test('C1: no portal string ever prints Booking.depositAmount', () => {
  // The evidence carries the REAL figures; the odd column is not an input to any
  // of these builders, and there is no `?? 4900` underneath them.
  for (const ev of [
    evidence([capturedPayment()], [authorizedAudit(REAL_CAPTURE_CENTS)]),
    evidence([], [releaseAudit('hold_released'), authorizedAudit(REAL_CAPTURE_CENTS)]),
    UNKNOWN_DEPOSIT_EVIDENCE,
  ]) {
    for (const status of ['cancelled', 'under_review', 'confirmed', 'completed', 'awaiting_payment']) {
      const text = portalText(viewFor(ev, { status }))
      assert.equal(inventedAmountIn(text), null, `${status} leaked the booking column: ${text}`)
    }
  }
  const page = codeOf(PORTAL)
  assert.ok(!/depositAmount/.test(page), 'the portal reached for the booking column again')
  assert.ok(!/\?\?\s*4900/.test(page), 'the house-fee fallback is back')
})

test('C1: a proven $123.45 capture DOES print — the rule is proof, not silence', () => {
  const v = viewFor(evidence([capturedPayment({ amount: ODD_DEPOSIT_AMOUNT })], []))
  assert.equal(v.paidAmount, `$${ODD_DOLLARS}`)
  assert.ok(inventedAmountIn(portalText(v)), 'a LEDGER-proven odd figure is exactly what must be printed')
})

// ════════════════════════════════════════════════════════════════════════════
//  3. THE OWNER'S DENIED CARD — lifted from the shipped route.
// ════════════════════════════════════════════════════════════════════════════

type Card = { embeds: Array<{ description: string; color: number; fields: Array<{ name: string; value: string }> }> }
const deniedCard = lift<(b: any, approver: string, release?: HoldReleaseOutcome | null) => Card>(DISCORD_ROUTE, 'deniedCard', {})
const CARD_BOOKING = { displayId: 'WMIC-1042', customer: { name: 'Maria Lopez' } }
const holdField = (c: Card) => c.embeds[0].fields.find((f) => f.name.includes('Hold'))?.value ?? ''

test('C2: the denied card reports a PROVEN release exactly as before', () => {
  const c = deniedCard(CARD_BOOKING, 'Diego', { released: true, state: 'hold_released', authorizedCents: 4900 })
  assert.match(holdField(c), /Released — not charged/)
  assert.match(c.embeds[0].description, /Authorization released/)
})

test('C2 REPRODUCTION: a FAILED release tells the owner it failed, and how to retry', () => {
  const c = deniedCard(CARD_BOOKING, 'Diego', { released: false, state: 'release_failed', authorizedCents: null, detail: '503' })
  assert.equal(falseReleaseClaimIn(JSON.stringify(c)), null, 'the card still tells the owner the customer was not charged')
  assert.match(holdField(c), /RELEASE FAILED/)
  assert.match(holdField(c), /Press Deny again to retry/)
})

test('C2: ABSENT release evidence is not a released hold', () => {
  for (const release of [null, undefined, { released: false, state: 'unknown', authorizedCents: null } as HoldReleaseOutcome]) {
    const c = deniedCard(CARD_BOOKING, 'Diego', release)
    assert.equal(falseReleaseClaimIn(JSON.stringify(c)), null, `absent evidence rendered a release claim: ${JSON.stringify(c)}`)
    assert.match(holdField(c), /NOT VERIFIED|RELEASE FAILED/)
  }
})

test('C2: the card never invents a figure for the hold', () => {
  const flat = JSON.stringify(deniedCard(CARD_BOOKING, 'Diego', { released: false, state: 'release_failed', authorizedCents: null }))
  assert.ok(!/\$\d/.test(flat), `the denied card printed an unproven amount: ${flat}`)
  const declaration = declarationOf(DISCORD_ROUTE, 'deniedCard')
  assert.ok(!/4900|depositAmount/.test(declaration), 'the card reached for the booking column')
})

test('C2: the handler hands the card the release the service computed', () => {
  const code = codeOf(DISCORD_ROUTE)
  assert.match(code, /deniedCard\(result\.booking, approverName, result\.release\)/, 'the release outcome is discarded again')
})

// ════════════════════════════════════════════════════════════════════════════
//  4. THE SHIPPED DECLINE SERVICE — the failure is recorded, and retryable.
// ════════════════════════════════════════════════════════════════════════════

type DeclineHarness = {
  deps: ApprovalDeps
  state: {
    booking: ApprovableBooking | null
    releases: string[]
    retrieves: string[]
    declines: DeclineCommitArgs[]
    declinedNotified: Array<{ release: HoldReleaseOutcome }>
    releaseError?: string
    intent?: CapturedIntent | null
    intentError?: string
  }
}

function makeBooking(over: Partial<ApprovableBooking> = {}): ApprovableBooking {
  return {
    id: 'bk_c2',
    status: 'PENDING_APPROVAL',
    stripePaymentIntentId: PI,
    // THE ODD COLUMN. Whatever this booking was supposed to be charged, no
    // message about the customer's card may come from it.
    depositAmount: ODD_DEPOSIT_AMOUNT,
    displayId: 'WMIC-1042',
    customerToken: 'tok_c2',
    itemsDescription: '1 Bedroom move',
    arrivalWindow: null,
    totalEstimate: 599,
    originAddress: '1 A St, Newark NJ',
    destAddress: '2 B St, Newark NJ',
    serviceAreaZone: 'primary',
    travelFee: 0,
    manualReviewRequired: false,
    requestedDate: new Date('2027-09-14T12:00:00.000Z'),
    confirmedDate: null,
    scheduledStart: null,
    scheduledEnd: null,
    estimatedHours: 3,
    customer: { name: 'Maria Lopez', email: 'maria@example.com', phone: '+19735550100', locale: 'en' },
    ...over,
  }
}

function makeDeclineHarness(initial: ApprovableBooking = makeBooking()): DeclineHarness {
  const state: DeclineHarness['state'] = {
    booking: initial,
    releases: [],
    retrieves: [],
    declines: [],
    declinedNotified: [],
  }
  const store: ApprovalStore = {
    async loadBooking() {
      return state.booking ? { ...state.booking } : null
    },
    async claimConfirm() {
      return 0
    },
    async rollbackClaim() {},
    async reloadStatus() {
      return state.booking ? { ...state.booking } : null
    },
    async commitApproval() {},
    async claimCancel() {
      const DENYABLE = ['PENDING_APPROVAL', 'PENDING_PAYMENT', 'DRAFT']
      if (state.booking && DENYABLE.includes(state.booking.status)) {
        state.booking = { ...state.booking, status: 'CANCELLED' }
        return 1
      }
      return 0
    },
    async recordDecline(args) {
      state.declines.push(args)
    },
  }
  const deps: ApprovalDeps = {
    store,
    stripe: {
      async capture(pi) {
        return { id: pi } as CapturedIntent
      },
      async retrieveCharge() {
        return null
      },
      async releaseHold(pi) {
        state.releases.push(pi)
        if (state.releaseError) throw new Error(state.releaseError)
        return { id: pi, status: 'canceled', amount: REAL_CAPTURE_CENTS } as unknown as CapturedIntent
      },
      async retrieveIntent(pi) {
        state.retrieves.push(pi)
        if (state.intentError) throw new Error(state.intentError)
        return state.intent === undefined ? ({ id: pi, status: 'requires_capture', amount: REAL_CAPTURE_CENTS } as unknown as CapturedIntent) : state.intent
      },
    },
    notifier: {
      async sendApproved() {},
      async sendDeclined(_booking, release) {
        state.declinedNotified.push({ release })
      },
    },
    logger: { info() {}, warn() {}, error() {} },
  }
  return { deps, state }
}

const ACTOR = { name: 'Diego', userId: 'u_diego', role: 'OWNER' as const }

test('C2: a decline whose Stripe release SUCCEEDS records hold_released and says so', async () => {
  const h = makeDeclineHarness()
  const res = await declineBooking({ bookingId: 'bk_c2', actor: ACTOR, source: 'admin' }, h.deps)
  assert.equal(res.ok, true)
  assert.equal((res as any).holdReleased, true)
  assert.equal(h.state.declines[0].auditDetails.stripeResult, 'hold_released')
  assert.equal(h.state.declines[0].auditDetails.result, 'success')
  assert.equal(h.state.declinedNotified[0].release.released, true)
  // Stripe's own figure for the authorization travelled out, not the column.
  assert.equal(h.state.declinedNotified[0].release.authorizedCents, REAL_CAPTURE_CENTS)
})

test('C2 REPRODUCTION: a FAILED release is recorded as failed, in both audit fields', async () => {
  const h = makeDeclineHarness()
  h.state.releaseError = 'Stripe API is currently unavailable (503)'
  const res = await declineBooking({ bookingId: 'bk_c2', actor: ACTOR, source: 'admin' }, h.deps)
  assert.equal(res.ok, true)
  assert.equal((res as any).holdReleased, false)
  assert.equal((res as any).release.state, 'release_failed')
  assert.equal(h.state.booking?.status, 'CANCELLED', 'the cancellation still stands — that part was never the bug')

  const details = h.state.declines[0].auditDetails as Record<string, unknown>
  assert.match(String(details.stripeResult), /^release_failed/)
  assert.equal(details.result, 'release_failed', 'the audit used to say result:success beside stripeResult:release_failed')
})

test('C2 REPRODUCTION: the customer email is told the release FAILED, and prints no invented figure', async () => {
  const h = makeDeclineHarness()
  h.state.releaseError = 'Stripe API is currently unavailable (503)'
  await declineBooking({ bookingId: 'bk_c2', actor: ACTOR, source: 'admin' }, h.deps)
  assert.equal(h.state.declinedNotified.length, 1)
  const release = h.state.declinedNotified[0].release
  assert.equal(release.released, false)
  assert.equal(release.authorizedCents, null, 'a failed release proves no figure either')

  // The SHIPPED template, driven with exactly what the shipped notifier builds.
  const React = await import('react')
  const { render } = await import('@react-email/render')
  const { default: BookingDeclined } = await import('../../emails/booking-declined')
  const html = await render(
    React.createElement(BookingDeclined, {
      locale: 'en',
      customerName: 'Maria',
      displayId: 'WMIC-1042',
      ...(release.authorizedCents != null ? { amountHold: (release.authorizedCents / 100).toFixed(2) } : {}),
      holdReleased: release.released,
      holdEverExisted: release.state !== 'no_hold',
    }),
  )
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
  assert.equal(falseReleaseClaimIn(text), null, `the declined email still claims the release: ${text}`)
  assert.equal(inventedAmountIn(text), null)
  assert.ok(!/\$\d/.test(text), `the declined email printed an unproven amount: ${text}`)
  assert.match(text, /re releasing the authorization on your card/i)
  assert.match(text, /your booking is cancelled/i)
})

test('C2: the SHIPPED template still ships the released copy when the release is proven', async () => {
  const h = makeDeclineHarness()
  await declineBooking({ bookingId: 'bk_c2', actor: ACTOR, source: 'admin' }, h.deps)
  const release = h.state.declinedNotified[0].release

  const React = await import('react')
  const { render } = await import('@react-email/render')
  const { default: BookingDeclined } = await import('../../emails/booking-declined')
  const html = await render(
    React.createElement(BookingDeclined, {
      locale: 'en',
      amountHold: (release.authorizedCents! / 100).toFixed(2),
      holdReleased: release.released,
      holdEverExisted: true,
    }),
  )
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
  assert.match(text, /Your \$49\.00 hold was released/)
  assert.match(text, /You were not charged/)
  assert.equal(inventedAmountIn(text), null, 'and Stripe’s figure, never the booking column')
})

test('C2: an UNTAUGHT sender (no holdReleased at all) gets the honest variant', async () => {
  const React = await import('react')
  const { render } = await import('@react-email/render')
  const { default: BookingDeclined } = await import('../../emails/booking-declined')
  const html = await render(React.createElement(BookingDeclined, { locale: 'en' }))
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
  assert.equal(falseReleaseClaimIn(text), null, 'undefined must default to claiming nothing, not everything')
})

test('C2 REPRODUCTION: re-declining a booking whose release failed RETRIES the release', async () => {
  const h = makeDeclineHarness()
  h.state.releaseError = 'Stripe API is currently unavailable (503)'
  await declineBooking({ bookingId: 'bk_c2', actor: ACTOR, source: 'admin' }, h.deps)
  assert.equal(h.state.releases.length, 1)
  assert.equal(h.state.declinedNotified.length, 1)

  // Stripe recovers; the owner clicks Deny again — the only repair he has.
  h.state.releaseError = undefined
  const retry = await declineBooking({ bookingId: 'bk_c2', actor: ACTOR, source: 'admin' }, h.deps)

  assert.equal(retry.ok, true)
  assert.equal((retry as any).outcome, 'already_cancelled')
  assert.equal((retry as any).holdReleased, true, 'the retry used to return holdReleased:false without calling Stripe')
  assert.equal(h.state.retrieves.length, 1, 'it reads Stripe before acting')
  assert.equal(h.state.releases.length, 2, 'and it actually released the authorization')
  assert.equal(h.state.declinedNotified.length, 1, 'the customer is NOT emailed a second time')

  // The newest audit row is what the portal will read back.
  const newest = h.state.declines[h.state.declines.length - 1].auditDetails as Record<string, unknown>
  assert.equal(newest.event, 'decline_booking_release_retry')
  assert.equal(newest.stripeResult, 'hold_released')
})

test('C2: the retry does NOT release an authorization Stripe says is already gone', async () => {
  const h = makeDeclineHarness(makeBooking({ status: 'CANCELLED' }))
  h.state.intent = { id: PI, status: 'canceled', amount: REAL_CAPTURE_CENTS } as unknown as CapturedIntent
  const res = await declineBooking({ bookingId: 'bk_c2', actor: ACTOR, source: 'admin' }, h.deps)
  assert.equal((res as any).holdReleased, true)
  assert.equal((res as any).release.state, 'already_released')
  assert.equal(h.state.releases.length, 0, 'nothing to release')
})

test('C2: the retry REFUSES to call a capture a release, and claims nothing', async () => {
  const h = makeDeclineHarness(makeBooking({ status: 'CANCELLED' }))
  h.state.intent = { id: PI, status: 'succeeded', amount_received: REAL_CAPTURE_CENTS, amount: REAL_CAPTURE_CENTS } as unknown as CapturedIntent
  const res = await declineBooking({ bookingId: 'bk_c2', actor: ACTOR, source: 'admin' }, h.deps)
  assert.equal((res as any).holdReleased, false)
  assert.equal((res as any).release.state, 'captured')
  assert.equal(h.state.releases.length, 0, 'releasing captured money is not the repair')
  // ...and the owner card for that answer claims nothing about the customer.
  assert.equal(falseReleaseClaimIn(JSON.stringify(deniedCard(CARD_BOOKING, 'Diego', (res as any).release))), null)
})

test('C2: a Stripe read that FAILS reports unknown — never "so we assumed"', async () => {
  const h = makeDeclineHarness(makeBooking({ status: 'CANCELLED' }))
  h.state.intentError = 'Neon connection reset'
  const res = await declineBooking({ bookingId: 'bk_c2', actor: ACTOR, source: 'admin' }, h.deps)
  assert.equal((res as any).holdReleased, false)
  assert.equal((res as any).release.state, 'unknown')
  assert.equal(h.state.releases.length, 0)
  assert.equal(h.state.declinedNotified.length, 0)
})

test('C2: nothing in the decline path ever emails or cards the booking column', async () => {
  const h = makeDeclineHarness()
  h.state.releaseError = 'boom'
  const res = await declineBooking({ bookingId: 'bk_c2', actor: ACTOR, source: 'admin' }, h.deps)
  const everything = JSON.stringify([
    h.state.declines,
    h.state.declinedNotified,
    deniedCard(CARD_BOOKING, 'Diego', (res as any).release),
  ])
  assert.equal(inventedAmountIn(everything), null, `the odd deposit column escaped: ${everything}`)
})

// ════════════════════════════════════════════════════════════════════════════
//  5. WRITER → READER: the audit the decline writes is the evidence the portal
//     reads. These are two different modules; if their vocabulary ever drifts,
//     the portal silently answers "unknown" for every booking.
// ════════════════════════════════════════════════════════════════════════════

async function auditRowsFrom(h: DeclineHarness): Promise<AuditEvidenceRow[]> {
  // Newest first, exactly as readDepositEvidence orders them.
  return [...h.state.declines].reverse().map((d) => ({ action: 'BOOKING_STATE_CHANGED', details: d.auditDetails }))
}

test('C2 LOOP: a successful decline is read back as `released`', async () => {
  const h = makeDeclineHarness()
  await declineBooking({ bookingId: 'bk_c2', actor: ACTOR, source: 'admin' }, h.deps)
  assert.equal(provenHoldRelease(await auditRowsFrom(h)), 'released')
})

test('C2 LOOP: a failed decline is read back as `release_failed` ⇒ hold_unresolved', async () => {
  const h = makeDeclineHarness()
  h.state.releaseError = 'Stripe API is currently unavailable (503)'
  await declineBooking({ bookingId: 'bk_c2', actor: ACTOR, source: 'admin' }, h.deps)
  const rows = await auditRowsFrom(h)
  assert.equal(provenHoldRelease(rows), 'release_failed')
  assert.equal(paymentView(depositEvidenceFrom([], rows, { stripePaymentIntentId: PI }), { cancelled: true, awaitingPayment: false }).paymentStatus, 'hold_unresolved')
})

test('C2 LOOP: a RETRY that succeeds overwrites the earlier failure for the customer', async () => {
  const h = makeDeclineHarness()
  h.state.releaseError = 'Stripe API is currently unavailable (503)'
  await declineBooking({ bookingId: 'bk_c2', actor: ACTOR, source: 'admin' }, h.deps)
  h.state.releaseError = undefined
  await declineBooking({ bookingId: 'bk_c2', actor: ACTOR, source: 'admin' }, h.deps)

  const rows = await auditRowsFrom(h)
  assert.equal(provenHoldRelease(rows), 'released', 'newest evidence must win, or a fixed hold stays "unresolved" forever')
  const v = viewFor(depositEvidenceFrom([], rows, { stripePaymentIntentId: PI }))
  assert.equal(v.paymentStatus, 'released')
  assert.match(portalText(v), /you were not charged/i, 'and only now may the page say it')
})

test('C2 LOOP: a decline on a booking with no intent reads back as `no_hold`', async () => {
  const h = makeDeclineHarness(makeBooking({ stripePaymentIntentId: null }))
  const res = await declineBooking({ bookingId: 'bk_c2', actor: ACTOR, source: 'admin' }, h.deps)
  assert.equal((res as any).release.state, 'no_hold')
  assert.equal(provenHoldRelease(await auditRowsFrom(h)), 'no_hold')
  assert.equal(h.state.releases.length, 0)
})
