import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

/**
 * CROSS-REPO: the quick-quote page itself.
 *
 * The site has no test runner, so these run from here against the checked-out
 * page. They deliberately assert STRUCTURE that a runtime bug would have to
 * break — which control sends what, what the print stylesheet removes, which
 * defaults exist — rather than "this sentence appears somewhere", because a
 * page can contain every promised string and still behave wrongly.
 *
 * Behaviour itself is verified by driving the real page in a browser; those
 * results are recorded in the PR. These are the invariants that must not
 * silently regress between those runs.
 *
 * Point at the branch under review with WMIWCI_SITE_DIR=/path/to/site.
 */

const SITE_DIR = process.env.WMIWCI_SITE_DIR
  ? path.resolve(process.env.WMIWCI_SITE_DIR)
  : path.resolve(__dirname, '..', '..', '..', '..', 'WMIWCI-SITE')
const PAGE = path.join(SITE_DIR, 'public', 'quote-new.html')

const skipSite = { skip: !existsSync(PAGE) ? 'WMIWCI-SITE checkout not present' : false }
const page = () => readFileSync(PAGE, 'utf8')

/** The body of a named JS function, so an assertion can be scoped to it. */
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

// ── In-person requests are never priced ───────────────────────────────────

test('the in-person submission sends no size, no truck and no total', skipSite, () => {
  const body = fnBody(page(), "$('qqVSend').addEventListener('click'")
  assert.match(body, /quoteMode:\s*'in_person'/, 'the mode is what makes the server skip pricing')

  // The three keys that would let a price be computed or displayed.
  for (const forbidden of ['moveSize:', 'truckSize:', 'estimateTotal:']) {
    assert.ok(
      !body.includes(forbidden),
      `the in-person request must not send ${forbidden} — there is nothing to price`
    )
  }
})

test('the in-person path never reads the price book', skipSite, () => {
  const body = fnBody(page(), 'function showInPerson(')
  assert.ok(!body.includes('quoteState('), 'entering the visit path must not compute a quote')
  assert.ok(!/WMIC_PRICING|PACKAGES/.test(body), 'the visit path must not touch the price book')
})

test('the in-person confirmation is the exact promised sentence', skipSite, () => {
  const src = page()
  assert.match(src, /Your in-person estimate request has been received/)
  assert.match(src, /Our local team will contact you to arrange a convenient time/)
  // And in Spanish, so one language is not silently better served.
  assert.match(src, /Su solicitud de estimado en persona ha sido recibida/)
  assert.match(src, /equipo local se comunicar/)
})

test('the visit is offered beside step 1 AND on the 5+ bedroom path', skipSite, () => {
  const src = page()
  assert.match(src, /id="qqWantVisit"/, 'the offer next to the size question')
  assert.match(src, /id="qqCustomVisit"/, 'the offer on the custom-plan panel')
  assert.match(src, /showInPerson\)/, 'both must reach the same handler')
  // It must NOT be a step: a sixth [data-step] would put it in the progress bar.
  const steps = (src.match(/data-step="\d"/g) ?? []).map((m) => m.replace(/\D/g, ''))
  assert.deepEqual(Array.from(new Set(steps)).sort(), ['1', '2', '3', '4', '5'])
  assert.match(src, /data-view="inperson"/, 'it is a view, not a step')
})

// ── "Not sure" ────────────────────────────────────────────────────────────

test('stairs and heavy items offer three answers and default to none', skipSite, () => {
  const src = page()
  assert.match(src, /optionCard\(id, 'not_sure', 'Not sure', 'No estoy seguro'/)
  assert.ok(
    !/_no'\)\.checked = true/.test(src),
    'nothing may be chosen on the customer’s behalf — that is how a guess became a fact'
  )
  assert.ok(!/If you.{0,3}re not sure, choose No/.test(src), 'the old instruction must be gone')
})

test('an unanswered question is sent as absent, never as "no"', skipSite, () => {
  const body = fnBody(page(), 'function yesNo(')
  assert.match(body, /picked \? picked\.value : undefined/)
  assert.ok(!/:\s*'no'/.test(body), 'returning a default "no" is the same lie in a different place')
})

// ── Flexible date ─────────────────────────────────────────────────────────

test('a flexible date is sent alongside the date, not instead of it', skipSite, () => {
  const src = page()
  const body = fnBody(src, 'function buildBody(')
  assert.match(body, /dateFlexible:/)
  assert.match(body, /moveDate:/, 'the approximate date must still be sent')
  assert.match(src, /id="qqDateFlexible"/)
  // Persisted, so returning to the page does not lose it.
  assert.match(fnBody(src, 'function saveDraft('), /qqDateFlexible/)
  assert.match(fnBody(src, 'function restoreDraft('), /qqDateFlexible/)
})

// ── Print ─────────────────────────────────────────────────────────────────

test('print removes every control and keeps the estimate', skipSite, () => {
  const src = page()
  const block = src.slice(src.indexOf('@media print'))
  // The exact selector LIST, split — a substring match would read
  // ".qq-break summary span" as hiding the whole breakdown.
  const rule = block.slice(0, block.indexOf('{ display: none !important; }'))
  const hidden = rule
    .slice(rule.indexOf('{') + 1) // drop "@media print {"
    .split(',')
    .map((sel) => sel.trim())
    .filter(Boolean)

  // Operating the page is not part of the document it produces.
  for (const gone of ['.qq-bar', '.qq-actions-bar', '.qq-progress', '.qq-actions', '.qq-alt', '.qq-hp', '#qqLang']) {
    assert.ok(hidden.includes(gone), `print must remove ${gone}`)
  }
  // What a printed estimate is FOR must survive — as a WHOLE element. A rule
  // hiding a descendant (the details marker) is not the same thing.
  for (const kept of ['.qq-estimate', '.qq-break', '.qq-next', '.qq-trust', '.qq-card']) {
    assert.ok(!hidden.includes(kept), `${kept} must print`)
  }
  assert.ok(
    hidden.some((sel) => sel.startsWith('.qq-break summary')),
    'the details "+" marker is interface, and should not print'
  )
  assert.match(block, /\.qq-break\[open\] \.qq-break-body \{ display: block/)
})

// ── Labor-only stays out of the full-service number ───────────────────────

test('the labor-only link navigates and nothing else', skipSite, () => {
  const src = page()
  const m = src.match(/<a href="services\.html#svc-labor-only"[^>]*id="qqLaborLink"[^>]*>/)
  assert.ok(m, 'the link must point at the labor-only section of the services page')
  assert.ok(!/onclick/.test(m![0]), 'a plain anchor cannot mutate the estimate')
  assert.ok(
    !src.includes("getElementById('qqLaborLink').addEventListener"),
    'no handler may hang off it'
  )
  // The full-service calculation must not know labor-only exists.
  const quote = fnBody(src, 'function quoteState(')
  assert.ok(!/labor/i.test(quote), 'labor-only pricing must never enter this calculation')
})

// ── The promised copy that carries a commitment ───────────────────────────

test('the total states what it is and is not', skipSite, () => {
  const src = page()
  assert.match(src, /Starting estimate before final transportation\./)
  assert.match(
    src,
    /Transportation will be confirmed after we review the exact pickup and destination addresses\. Fuel is included\./
  )
})

test('booking is offered as a choice, not the only exit', skipSite, () => {
  const src = page()
  assert.match(src, /You can continue booking or speak with us before deciding\./)
  assert.match(src, /call or text us with questions at any point/)
})
