import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

/**
 * CROSS-REPO: prices on step 1, and a gate that still means something.
 *
 * The move-size cards now show a starting price before the contact gate. Two
 * things have to stay true for that to be safe:
 *
 *   1. the amounts are DERIVED from the price book, never typed into the
 *      page — a hardcoded "$879" is a number that goes stale in silence;
 *   2. the gate still withholds the detailed breakdown and the emailed copy,
 *      so "email required" is not now a formality.
 *
 * The arithmetic itself is pinned in the API repo's pricing-truck-parity
 * suite, against the price book. These check the page cannot bypass it.
 *
 * Point at the branch under review with WMIWCI_SITE_DIR=/path/to/site.
 */

const SITE_DIR = process.env.WMIWCI_SITE_DIR
  ? path.resolve(process.env.WMIWCI_SITE_DIR)
  : path.resolve(__dirname, '..', '..', '..', '..', 'WMIWCI-SITE')
const PAGE = path.join(SITE_DIR, 'public', 'quote-new.html')

const skipSite = { skip: !existsSync(PAGE) ? 'WMIWCI-SITE checkout not present' : false }
const page = () => readFileSync(PAGE, 'utf8')

function fnBody(src: string, signature: string): string {
  const start = src.indexOf(signature)
  assert.notEqual(start, -1, `function not found: ${signature}`)
  let depth = 0
  let i = src.indexOf('{', start)
  const open = i
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(open, i + 1)
    }
  }
  throw new Error(`unbalanced braces after ${signature}`)
}

/** The card definitions — the one place a price could be typed by hand. */
function sizeTable(src: string): string {
  const start = src.indexOf('var SIZES = [')
  assert.notEqual(start, -1, 'SIZES table not found')
  return src.slice(start, src.indexOf('];', start))
}

// ── The amounts are derived, not typed ───────────────────────────────────

test('no card price is hardcoded in the page', skipSite, () => {
  const table = sizeTable(page())
  // Any of the approved figures appearing in the card definitions would mean
  // the page had stopped asking the price book.
  for (const amount of ['550', '879', '1199', '1,199', '1599', '1,599']) {
    assert.ok(
      !table.includes(amount),
      `the SIZES table must not contain ${amount} — the card price is computed, not written`
    )
  }
})

test('the card price is base + the REQUIRED truck, from the price book', skipSite, () => {
  const body = fnBody(page(), 'function cardPrice(')
  assert.match(body, /P\.PACKAGES\[/, 'the base must come from the price book')
  assert.match(body, /MIN_TRUCK\[/, 'the truck must be the one that size requires')
  assert.match(body, /TRUCK_FEE\[/, 'and its fee must be added')
  assert.match(body, /pkg\.price\.amount \+ fee/, 'total = base + required truck fee')
})

test('a missing price book produces no card price at all', skipSite, () => {
  const body = fnBody(page(), 'function cardPrice(')
  assert.match(
    body,
    /if \(!PRICING_READY\) return null/,
    'no book means no number — never a guess, never $undefined'
  )
})

test('the supporting sentence quotes a derived figure, not a typed one', skipSite, () => {
  const src = page()
  const body = fnBody(src, 'function renderLede(')
  assert.match(body, /money\(lowest\)/, 'the amount must be computed from the book')
  // And the markup must not carry it.
  const lede = src.slice(src.indexOf('id="qqLede"') - 200, src.indexOf('id="qqLede"') + 200)
  assert.ok(!/\$\d/.test(lede), 'the lede element must be empty in the markup')
})

// ── 5+ bedrooms ──────────────────────────────────────────────────────────

test('5+ bedrooms shows a custom plan and no dollar amount', skipSite, () => {
  const body = fnBody(page(), 'function cardPrice(')
  assert.match(body, /pkgKey === '5br'/)
  assert.match(body, /custom: true/)
  assert.match(body, /'Custom move plan'/)
  // The 5br branch returns BEFORE anything reads the price book.
  const fiveBranch = body.slice(body.indexOf("pkgKey === '5br'"), body.indexOf('PRICING_READY'))
  assert.ok(!/money\(|price\.amount/.test(fiveBranch), 'no amount may be computed for 5br')
})

// ── The gate still withholds something real ──────────────────────────────

test('the breakdown is built only when the estimate is revealed', skipSite, () => {
  const src = page()
  // qqBreakBody is populated inside revealEstimate, which only the submit
  // handler calls — so the detailed breakdown cannot exist before capture.
  const reveal = fnBody(src, 'function revealEstimate(')
  assert.match(reveal, /qqBreakBody/, 'the breakdown is rendered here')
  const preGate = fnBody(src, 'function renderPreGate(')
  assert.ok(!preGate.includes('qqBreakBody'), 'and nowhere in the pre-gate view')
})

test('the gate names what it is actually withholding', skipSite, () => {
  const src = page()
  assert.match(src, /Your detailed estimate is ready/)
  assert.match(src, /view the complete breakdown and receive a copy by email/)
  assert.match(src, /View My Detailed Estimate/)
  // It must NOT claim no estimate has been shown — one has, on step 1.
  assert.ok(
    !/We.{0,3}ve worked out your starting estimate\. Enter your details below to see it/.test(src),
    'that sentence is now false: the customer has already seen the starting price'
  )
  // Spanish keeps pace.
  assert.match(src, /Su estimado detallado est/)
  assert.match(src, /Ver Mi Estimado Detallado/)
})

test('contact details are still required before that reveal', skipSite, () => {
  const src = page()
  const submit = fnBody(src, "$('qqForm').addEventListener('submit'")
  assert.match(submit, /if \(!validateContact\(\)\) return/, 'validation gates the submit')
  const validate = fnBody(src, 'function validateContact(')
  for (const field of ['qqFirst', 'qqLast', 'qqEmail', 'qqPhone']) {
    assert.ok(validate.includes(field), `${field} must still be required`)
  }
  assert.match(validate, /EMAIL_RE\.test/, 'and the email must still be checked')
})

// ── The pre-gate summary must stay short ─────────────────────────────────

test('the pre-gate summary is four single-line facts, not four paragraphs', skipSite, () => {
  const src = page()
  const start = src.indexOf('<div class="qq-ready" id="qqReady">')
  const end = src.indexOf('<div class="qq-row two">', start)
  const panel = src.slice(start, end)

  const rows = (panel.match(/class="qq-ready-row"/g) ?? []).length
  assert.equal(rows, 4, 'exactly the four facts the owner listed')

  // The long explanatory paragraphs are what pushed the first contact field a
  // full viewport below the fold on a phone. Their absence is the guard.
  assert.ok(
    !panel.includes('qq-ready-note'),
    'no explanatory paragraphs may return to this panel'
  )

  for (const fact of [
    'Calculation complete',
    'Assigned truck',
    'Crew and equipment included',
    'Transportation confirmed after address review',
  ]) {
    assert.ok(panel.includes(fact), `missing: ${fact}`)
  }
})

test('the full transportation sentence still appears where the money is', skipSite, () => {
  // Shortening the summary must not lose the commitment — it moves to the
  // breakdown and the estimate card, where the number actually is.
  const src = page()
  assert.match(
    src,
    /Transportation will be confirmed after we review the exact pickup and destination addresses\. Fuel is included\./
  )
  assert.match(src, /Starting estimate before final transportation\./)
  assert.match(
    src,
    /Starting prices include the required truck\. Final transportation is confirmed/
  )
})
