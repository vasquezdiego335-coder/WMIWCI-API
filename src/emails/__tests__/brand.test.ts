import { test } from 'node:test'
import assert from 'node:assert/strict'
import { render } from '@react-email/render'
import * as React from 'react'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import PreApproval from '../pre-approval'
import FinalConfirmation from '../final-confirmation'
import BookingDeclined from '../booking-declined'
import BookingCancellation from '../booking-cancellation'
import BookingUpdated from '../booking-updated'
import JobReminder from '../job-reminder'
import JobCompletion from '../job-completion'
import PaymentReceipt from '../payment-receipt'
import AbandonedCheckout from '../abandoned-checkout'
import Referral from '../referral'
import ReviewRequest from '../review-request'
import PaymentFailed from '../payment-failed'
import InformationRequired from '../information-required'
import OperationalAlert from '../operational-alert'
import FinalInvoice from '../final-invoice'
import ReferralReward from '../referral-reward'
import QuoteFollowup from '../quote-followup'
import { C } from '../_ui'
import { assertEmailPayload } from '../validation'

// ════════════════════════════════════════════════════════════════════════
//  BRAND + CONTENT-SAFETY LOCK (gap audit 2026-07-17, G5).
//  ---------------------------------------------------------------------
//  The gap audit found NO palette test, NO emoji test, and NO guard against
//  hard-coded prices or unsupported service claims — so off-palette greens and
//  a raw gift emoji shipped unnoticed. This file locks all of it.
//
//  It reads the SOURCE files (not just rendered output) for the emoji + claim
//  checks, because a decorative emoji can hide inside an attribute or a preview
//  string that rendering would not surface as text.
// ════════════════════════════════════════════════════════════════════════

const URL = 'https://moveitclearit.com/my-booking/TOKEN'
const common = { customerName: 'Diego', displayId: 'WMIC-1017', locale: 'en' as const, portalUrl: URL }

const all: Array<[string, React.ReactElement]> = [
  ['pre-approval', React.createElement(PreApproval, { ...common, amountHold: '1' })],
  ['final-confirmation', React.createElement(FinalConfirmation, { ...common, amountPaid: '1', date: '2026-08-01T15:00:00Z', timeLabel: '8–10 AM' })],
  ['booking-declined', React.createElement(BookingDeclined, { ...common, amountHold: '1' })],
  ['booking-cancellation', React.createElement(BookingCancellation, { ...common, refundStatus: 'partial', amountCharged: '49', nonRefundable: '20', refundedAmount: '29' })],
  ['booking-updated', React.createElement(BookingUpdated, { ...common, amountHold: '1', changedLabel: 'the date' })],
  ['job-reminder', React.createElement(JobReminder, { ...common, stage: '72_hours' })],
  ['job-completion', React.createElement(JobCompletion, { ...common })],
  ['payment-receipt', React.createElement(PaymentReceipt, { ...common, amountPaid: '1.00', captured: true })],
  ['abandoned-checkout', React.createElement(AbandonedCheckout, { ...common, amountHold: '1' })],
  ['abandoned-checkout-2', React.createElement(AbandonedCheckout, { ...common, amountHold: '1', stage: 2 })],
  ['abandoned-checkout-3', React.createElement(AbandonedCheckout, { ...common, amountHold: '1', stage: 3 })],
  ['referral', React.createElement(Referral, { ...common })],
  ['review-request', React.createElement(ReviewRequest, { ...common, googleReviewUrl: URL })],
  ['payment-failed', React.createElement(PaymentFailed, { ...common, updatePaymentUrl: URL })],
  ['information-required', React.createElement(InformationRequired, { ...common, missing: ['Exact pickup address'] })],
  ['operational-alert', React.createElement(OperationalAlert, { ...common, alertType: 'reschedule', message: 'Delay.', newDate: '2026-08-02T15:00:00Z' })],
  ['final-invoice', React.createElement(FinalInvoice, { ...common, grandTotal: '480', amountPaid: '1', balanceDue: '479', payUrl: URL })],
  ['referral-reward', React.createElement(ReferralReward, { ...common, redeemUrl: URL })],
  ['quote-followup-1', React.createElement(QuoteFollowup, { ...common, bookingUrl: URL, stage: 1 })],
  ['quote-followup-2', React.createElement(QuoteFollowup, { ...common, bookingUrl: URL, stage: 2 })],
  ['quote-followup-final', React.createElement(QuoteFollowup, { ...common, bookingUrl: URL, stage: 3 })],
]

// ── 1. PALETTE ──────────────────────────────────────────────────────────
// Every hex the design system actually sanctions, plus the technical
// exceptions an email cannot avoid.
const APPROVED = new Set(
  [
    ...Object.values(C),
    '#FFFFFF',
    '#FFF',
    '#000000',
    '#000',
    // Dark-mode counterparts + neutral greys used by the shared kit.
    '#111111',
    '#1A1A1A',
  ].map((h) => h.toUpperCase())
)

// A colour hex, NOT an HTML entity. `&#8202;` (hair space) and friends would
// otherwise match as "#8202" — a false positive that hides the real offenders.
const HEX_RE = /(?<![&\w])#[0-9a-fA-F]{3,8}\b/g

test('every rendered template uses ONLY approved palette colours', () => {
  const offenders: string[] = []
  for (const [name, el] of all) {
    const html = render(el)
    for (const hex of html.match(HEX_RE) ?? []) {
      const h = hex.toUpperCase()
      // Ignore 8-digit rgba-hex and anything inside a hosted asset URL.
      if (h.length === 9) continue
      if (!APPROVED.has(h)) offenders.push(`${name}: ${hex}`)
    }
  }
  assert.deepEqual(
    offenders.filter((v, i) => offenders.indexOf(v) === i),
    [],
    'off-palette colours found. Add them to _ui.C deliberately, or fix the template.'
  )
})

test('no decorative green, blue, red or purple sneaks in as a raw named colour', () => {
  // Named CSS colours bypass the hex check entirely — catch the common ones.
  const BANNED = /\b(?:color|background|background-color|border-color)\s*:\s*(green|blue|red|purple|lime|cyan|magenta|teal)\b/i
  for (const [name, el] of all) {
    assert.equal(BANNED.test(render(el)), false, `${name} uses a raw named colour`)
  }
})

// ── 2. NO EMOJI AS A PRODUCTION GRAPHIC ─────────────────────────────────
const EMAIL_DIR = join(__dirname, '..')
const SOURCES = readdirSync(EMAIL_DIR).filter((f) => f.endsWith('.tsx'))

// Pictographic ranges + the HTML-entity spellings of the same characters.
// Text punctuation (– — ' " …) is deliberately NOT matched.
// Surrogate-pair ranges rather than /u escapes — this project's tsconfig target
// predates the `u` flag. \uD83C-\uD83E leads cover U+1F000–U+1FAFF (pictographs);
// ☀-➿ is Misc Symbols + Dingbats; ️ (U+FE0F) is the emoji variation selector.
//
// DELIBERATE, NARROW EXCEPTION — typographic ornaments, not emoji:
//   ✓ U+2713, ✔ U+2714  list-marker check marks (pre-approval)
//   ❮ U+276E, ❯ U+276F  chevron ornaments used in CTAs
//   ★ U+2605, ☆ U+2606  star-rating glyphs (review-request). NOTE: the
//                        EMOJI star is ⭐ U+2B50 and stays banned.
// Unqualified, these have TEXT presentation: they render as glyphs in the
// surrounding font at the surrounding colour, so they inherit the palette
// instead of fighting it. The SAME characters followed by U+FE0F request emoji
// presentation and ARE still caught, as is every pictograph and the gift/
// party/rocket family that this test exists to keep out.
const ORNAMENTS = '✓✔❮❯★☆'

/**
 * Emoji-ish characters in `s`, minus the sanctioned typographic ornaments.
 * A bare ornament is allowed; the same ornament followed by U+FE0F is not
 * (that is an explicit request for colour-emoji presentation), so a 2-char
 * match is always a hit.
 */
function emojiHits(s: string): string[] {
  const broad = /[\uD83C-\uD83E][\uDC00-\uDFFF]|[☀-➿]️?/g
  return (s.match(broad) ?? []).filter((m) => !(m.length === 1 && ORNAMENTS.indexOf(m) >= 0))
}

// Pictographic entity spellings, e.g. `&#127873;` (🎁 — the exact bug that
// shipped as the referral hero). The four ornament code points above
// (✓ 10003, ✔ 10004, ❮ 10094, ❯ 10095, ★ 9733, ☆ 9734) are excluded likewise.
const ORNAMENT_ENTITIES = new Set(['10003', '10004', '10094', '10095', '9733', '9734'])
const ENTITY_RE = /&#(\d{4,6});/g

test('no template renders a raw emoji as a graphic', () => {
  for (const [name, el] of all) {
    // Strip comments — explanatory prose about the old emoji is allowed.
    const visible = render(el).replace(/<!--[\s\S]*?-->/g, '')
    assert.deepEqual(emojiHits(visible), [], `${name} renders emoji character(s)`)
  }
})

test('no template SOURCE hard-codes a pictographic HTML entity', () => {
  // This is the exact shape of the bug that shipped: `&#127873;` (🎁) as the
  // referral hero. Comments are stripped so the explanation of the fix survives.
  for (const file of SOURCES) {
    const src = readFileSync(join(EMAIL_DIR, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')

    const offenders: string[] = []
    let m: RegExpExecArray | null
    ENTITY_RE.lastIndex = 0
    while ((m = ENTITY_RE.exec(src))) {
      const code = Number(m[1])
      if (ORNAMENT_ENTITIES.has(m[1])) continue
      // Below U+2600 is punctuation/spacing (– — … hair spaces): not emoji.
      if (code < 0x2600) continue
      offenders.push(m[0])
    }
    assert.deepEqual(offenders, [], `${file} hard-codes a pictographic entity`)
  }
})

// ── 3. CONTENT SAFETY ───────────────────────────────────────────────────

test('the retired slogan never appears', () => {
  for (const [name, el] of all) {
    assert.equal(/We Move It\.?\s*We Clear It/i.test(render(el)), false, `${name} carries the retired slogan`)
  }
})

test('no template hard-codes the deposit amount', () => {
  // Amounts must come from the payload via money(); a baked-in "$49" goes stale
  // the moment pricing changes.
  //
  // Every money-bearing template is re-rendered here with DISTINCTIVE amounts,
  // so a "$49" in the output can only have come from the source. (Rendering with
  // a 49-valued fixture would make this test unable to tell the two apart —
  // which is exactly how it first reported a false positive.)
  const moneyed: Array<[string, React.ReactElement]> = [
    ['pre-approval', React.createElement(PreApproval, { ...common, amountHold: '77' })],
    ['final-confirmation', React.createElement(FinalConfirmation, { ...common, amountPaid: '77', date: '2026-08-01T15:00:00Z', timeLabel: '8–10 AM' })],
    ['booking-declined', React.createElement(BookingDeclined, { ...common, amountHold: '77' })],
    ['booking-cancellation', React.createElement(BookingCancellation, { ...common, refundStatus: 'partial', amountCharged: '77', nonRefundable: '20', refundedAmount: '57' })],
    ['booking-updated', React.createElement(BookingUpdated, { ...common, amountHold: '77', changedLabel: 'the date' })],
    ['payment-receipt', React.createElement(PaymentReceipt, { ...common, amountPaid: '77.00', captured: true })],
    ['abandoned-checkout', React.createElement(AbandonedCheckout, { ...common, amountHold: '77' })],
    ['final-invoice', React.createElement(FinalInvoice, { ...common, grandTotal: '480', amountPaid: '77', balanceDue: '403', payUrl: URL })],
  ]
  for (const [name, el] of moneyed) {
    assert.equal(/\$49\b/.test(render(el)), false, `${name} hard-codes $49`)
  }
})

test('no template claims a service Move It Clear It does not provide', () => {
  // Labor-only. Claiming transport, packing, licensing or insurance is both
  // untrue and a liability. Negated forms ("we don't drive the truck") are fine,
  // so match only affirmative claim shapes.
  const BANNED: Array<[RegExp, string]> = [
    [/\bfully licensed and insured\b/i, 'licensed-and-insured claim'],
    [/\bwe (?:will )?(?:drive|transport) (?:your|the) (?:truck|belongings|stuff)\b/i, 'transport claim'],
    [/\bwe (?:will )?pack (?:your|everything)\b/i, 'packing claim'],
    [/\bfull-?service (?:moving|movers)\b/i, 'full-service claim'],
    [/\bjunk removal included\b/i, 'junk-removal claim'],
  ]
  for (const [name, el] of all) {
    const html = render(el)
    for (const [re, label] of BANNED) {
      assert.equal(re.test(html), false, `${name} makes an unsupported ${label}`)
    }
  }
})

test('no template invents scarcity or a countdown', () => {
  // We do not check live availability at send time, so any of these would be
  // fabricated. This is what the abandoned-checkout stage-1 rewrite removed.
  const BANNED: Array<[RegExp, string]> = [
    [/\bexpires? in \d+\b/i, 'countdown'],
    [/\bonly \d+ (?:slots?|spots?) (?:left|remaining)\b/i, 'slot scarcity'],
    [/\bbefore someone else (?:takes|books)\b/i, 'someone-else scarcity'],
    [/\blast chance\b/i, 'last-chance urgency'],
    [/\bact now\b/i, 'act-now urgency'],
  ]
  for (const [name, el] of all) {
    const html = render(el)
    for (const [re, label] of BANNED) {
      assert.equal(re.test(html), false, `${name} uses ${label}`)
    }
  }
})

test('a promotional template with no unsubscribe URL omits the link, never href="#"', () => {
  // The footer must DROP the unsubscribe row rather than render a dead link.
  // (Whether the message may send at all without one is a separate policy
  // question, enforced by the send guard — see the next test.)
  const promotional = all.filter(([n]) =>
    /^(abandoned-checkout|referral|review-request|quote-followup)/.test(n)
  )
  assert.ok(promotional.length >= 6, 'expected the promotional set to be covered')
  for (const [name, el] of promotional) {
    const footer = render(el).split('Unsubscribe')[1] ?? ''
    assert.equal(/href="#"/.test(footer), false, `${name} ships a dead unsubscribe link`)
  }
})

test('a missing PRIMARY CTA link blocks the send instead of rendering href="#"', () => {
  // THE REAL GUARANTEE. Every template defaults its URL props to '#', so an
  // absent link used to render a dead button and ship. REQUIRED_FIELDS now lists
  // each template's primary CTA, so assertEmailPayload refuses the send.
  const cases: Array<[string, string]> = [
    ['abandoned-checkout', 'checkoutUrl'],
    ['abandoned-checkout-2', 'checkoutUrl'],
    ['abandoned-checkout-3', 'checkoutUrl'],
    ['quote-followup-1', 'bookingUrl'],
    ['quote-followup-2', 'bookingUrl'],
    ['quote-followup-final', 'bookingUrl'],
    ['referral', 'referralUrl'],
    ['job-completion', 'portalUrl'],
    ['booking-cancellation', 'portalUrl'],
    ['booking-updated', 'portalUrl'],
    ['operational-alert', 'portalUrl'],
    ['review-request', 'googleReviewUrl'],
    ['payment-failed', 'updatePaymentUrl'],
    ['referral-reward', 'redeemUrl'],
  ]
  for (const [template, field] of cases) {
    // Missing entirely → blocked.
    assert.throws(
      () => assertEmailPayload(template, { customerName: 'Diego', changes: ['date'] }),
      (err: Error) => err.name === 'EmailValidationError' && err.message.includes(field),
      `${template}: a missing ${field} must block the send`
    )
    // Present but a placeholder → also blocked.
    assert.throws(
      () => assertEmailPayload(template, { customerName: 'Diego', changes: ['date'], [field]: '#' }),
      (err: Error) => err.name === 'EmailValidationError',
      `${template}: a '#' ${field} must block the send`
    )
  }
})

// ── 4. THE INLINE-HTML PATH ─────────────────────────────────────────────
// `repeat-reminder` is the one follow-up still built as an inline HTML string
// in src/lib/followups.ts rather than with the _ui kit, so the render-based
// palette test above cannot see it. That is exactly how a BLUE CTA (#1f6feb)
// shipped in a four-colour brand. Lock the source directly.
test('the inline-HTML follow-up uses no off-palette colour literals', () => {
  const src = readFileSync(join(EMAIL_DIR, '..', 'lib', 'followups.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

  const offenders: string[] = []
  HEX_RE.lastIndex = 0
  for (const hex of src.match(HEX_RE) ?? []) {
    if (!APPROVED.has(hex.toUpperCase())) offenders.push(hex)
  }
  assert.deepEqual(
    offenders.filter((v, i) => offenders.indexOf(v) === i),
    [],
    'followups.ts hard-codes an off-palette colour — use the C tokens'
  )
})

// ── 5. UNSUPPORTED CLAIMS (finding EMAIL-P1-14) ─────────────────────────
// Semantic claim FAMILIES, not exact strings, so a reworded version of the same
// untrue promise still fails. Each family was a real claim that shipped.
test('no template advertises junk removal or cleanout while that service is off', () => {
  // Not enabled, not operationally available. Advertising it is an offer we
  // cannot fulfil. Shipped in referral.tsx ("your next move or cleanout") and
  // the repeat-reminder ("need furniture or junk cleared out").
  const BANNED = [/cleanout/i, /clean[- ]?out/i, /junk removal/i, /junk cleared/i, /limpieza/i, /basura/i]
  for (const [name, el] of all) {
    const html = render(el)
    for (const re of BANNED) {
      assert.equal(re.test(html), false, `${name} advertises a disabled service (${re})`)
    }
  }
})

test('no template claims flat-rate pricing or an absence of extra fees', () => {
  // Stairs, travel, truck add-on and access fees can all apply, so
  // "transparent flat-rate pricing — no hidden fees" was untrue.
  const BANNED = [/no hidden fees/i, /flat[- ]rate pricing/i, /sin cargos ocultos/i, /precio fijo y transparente/i]
  for (const [name, el] of all) {
    const html = render(el)
    for (const re of BANNED) assert.equal(re.test(html), false, `${name} makes a pricing claim (${re})`)
  }
})

test('no template hard-codes a completed-move count', () => {
  // "50+ completed moves across New Jersey" had no source and no counting rule.
  const BANNED = [/\d+\+?\s*(completed\s*)?moves/i, /\d+\+?\s*mudanzas/i]
  for (const [name, el] of all) {
    const html = render(el)
    for (const re of BANNED) assert.equal(re.test(html), false, `${name} claims a move count (${re})`)
  }
})

test('no template claims equipment, transport, packing, licensing or insurance', () => {
  const BANNED = [
    /equipment included/i,
    /equipo de mudanza incluido/i,
    /licensed and insured/i,
    /fully insured/i,
    /we (?:will )?(?:drive|transport)/i,
  ]
  for (const [name, el] of all) {
    const html = render(el)
    for (const re of BANNED) assert.equal(re.test(html), false, `${name} claims an unverified capability (${re})`)
  }
})

test('no template claims the deposit reserves capacity', () => {
  // The hold does not reserve a slot — the booking still needs owner approval.
  const BANNED = [/secures your slot/i, /reserves your slot/i, /asegura tu lugar/i, /your slot is (?:held|reserved)/i]
  for (const [name, el] of all) {
    const html = render(el)
    for (const re of BANNED) assert.equal(re.test(html), false, `${name} claims a reserved slot (${re})`)
  }
})
