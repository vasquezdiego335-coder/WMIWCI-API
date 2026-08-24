// ════════════════════════════════════════════════════════════════════════
//  quote-page-states.test.ts — the quote page's no-estimate state machine,
//  and what happens when a customer changes their mind.
//
//  TWO DEFECTS, both of which told the customer something untrue.
//
//  A · ONE BRANCH SERVED THREE DIFFERENT SITUATIONS:
//
//        if (!outcome.estimate && (outcome.manualReview || selected()))
//
//      `selected()` is truthy for EVERY valid submission — you cannot submit
//      without picking a size — so the condition reduced to `!outcome.estimate`.
//      A timeout, an unreachable API, a 502 from a proxy and a genuine 5BR
//      hand-quote all landed in the same branch, and every one of them told
//      the customer "We have your request. This move is quoted by hand."
//      Nobody had the request. The page then sat there offering no way to try
//      again, with the button still reading "Saving your quote…".
//
//      Three states are now distinct: refused (pricing_expired), genuinely
//      hand-quoted, and failed. Only the first two are ever described as
//      received, and only when `captured === true`.
//
//  B · "ALLOWED TO CONTINUE" WAS THE SAME FLAG AS "PRICES ARE VISIBLE".
//      A captured hand-quote had to be stranded on stage 1 to keep the $1,799
//      hidden. setStage('manual') now grants stage 2 without adding the CSS
//      class that reveals prices.
//
//  C · CHANGING THE MOVE SIZE KEPT THE OLD SERVER PRICE. A customer quoted
//      1BR at $550 who switched to 2BR kept `serverTotal = 550`; render()
//      prefers the server figure, so the 2BR card showed $550 while the button
//      still said "Continue to Booking".
//
//  These drive the REAL page in a real DOM against REAL route responses.
//  Offline: fetch is stubbed, nothing is posted anywhere.
// ════════════════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { JSDOM, VirtualConsole, ResourceLoader } from 'jsdom'
import { PRICE_BOOK_VERSION } from '../pricing-config'
import { SKIP_WITHOUT_SITE, siteFile } from './site-dir'

const PAGE = siteFile('public/quote.html')
const MIRROR = siteFile('public/js/pricing-config.js')
const skip = SKIP_WITHOUT_SITE || (existsSync(PAGE) && existsSync(MIRROR) ? false : 'WMIWCI-SITE not available')

type Harness = {
  dom: JSDOM
  doc: Document
  win: any
  tracked: string[]
  events: Array<{ name: string; params?: Record<string, unknown> }>
  status(): string
  priceText(): string
  buttonLabel(): string
  revealed(): boolean
  continuable(): boolean
  bodyText(): string
  panelText(): string
  posted(): any[]
}

/** Queue of responses; each submission consumes the next one. */
function queuedFetch(responses: Array<{ status: number; body: unknown } | 'network-error'>) {
  const posted: any[] = []
  let i = 0
  const impl: any = async (url: string, init?: any) => {
    if (url.includes('/api/leads/quote-capture')) {
      try { posted.push(JSON.parse(init.body)) } catch { posted.push(null) }
      const r = responses[Math.min(i, responses.length - 1)]
      i++
      if (r === 'network-error') throw new Error('network down')
      return { ok: r.status < 400, status: r.status, json: async () => r.body }
    }
    return { ok: true, status: 200, json: async () => ({}) }
  }
  impl.__posted = posted
  return impl
}

async function loadPage(fetchImpl: any): Promise<Harness> {
  const mirrorBytes = readFileSync(MIRROR)
  const served = (buf: Buffer) => {
    const p = Promise.resolve(buf) as Promise<Buffer> & { abort(): void }
    p.abort = () => {}
    return p
  }
  class LocalAssets extends ResourceLoader {
    fetch(url: string) {
      return served(/\/js\/pricing-config\.js/.test(url) ? mirrorBytes : Buffer.from(''))
    }
  }
  const dom = new JSDOM(readFileSync(PAGE, 'utf8'), {
    runScripts: 'dangerously',
    url: 'https://moveitclearit.com/quote',
    virtualConsole: new VirtualConsole(),
    resources: new LocalAssets(),
    beforeParse(win: any) {
      win.fetch = (url: string, init?: any) => fetchImpl(String(url), init)
      win.__tracked = []
      win.__trackedEvents = []
    },
  })
  const win = dom.window as any
  for (let i = 0; i < 20 && !win.WMIC_PRICING; i++) await new Promise((r) => setTimeout(r, 10))
  await new Promise((r) => setTimeout(r, 10))

  // Wrap AFTER parse — quote.html assigns window.track itself, so a stub
  // installed in beforeParse is overwritten and records nothing.
  const pageTrack = win.track
  win.track = (name: string, params?: unknown) => {
    win.__tracked.push(name)
    win.__trackedEvents.push({ name, params: params as Record<string, unknown> | undefined })
    if (typeof pageTrack === 'function') { try { pageTrack(name, params) } catch { /* GA absent */ } }
  }

  const el = (id: string) => win.document.getElementById(id) as HTMLElement | null
  return {
    dom,
    doc: win.document,
    win,
    get tracked() { return win.__tracked as string[] },
    /* NAMES ARE NOT ENOUGH. "generate_lead fired" is true both when the event
       carries the server's total and when it carries the browser's own figure,
       and those are opposite outcomes. The parameter objects are recorded so a
       test can assert on what was actually reported. */
    get events() { return win.__trackedEvents as Array<{ name: string; params?: Record<string, unknown> }> },
    status: () => el('qStatus')?.textContent ?? '',
    priceText: () => el('qPriceNum')?.textContent ?? '',
    buttonLabel: () => el('qSubmit')?.textContent ?? '',
    revealed: () => !!win.document.getElementById('quoteForm')?.classList.contains('q-unlocked'),
    continuable: () => /Continue to Booking|Continuar a la Reserva/.test(el('qSubmit')?.textContent ?? ''),
    bodyText: () => win.document.body.textContent ?? '',
    /* THE ESTIMATE PANEL ONLY. The size CARDS also carry each package's
       published price, which is legitimate — it is the list the customer is
       choosing from — and CSS hides it until .q-unlocked. Asserting over the
       whole body therefore catches the card list and proves nothing about what
       the page is QUOTING. The panel is where a quoted figure appears. */
    panelText: () => el('qPrice')?.textContent ?? '',
    posted: () => (fetchImpl.__posted ?? []) as any[],
  }
}

async function submit(h: Harness, sizeKey: string): Promise<void> {
  const d = h.doc
  const radio = d.querySelector(`input[name="qSize"][value="${sizeKey}"]`) as HTMLInputElement | null
  assert.ok(radio, `the ${sizeKey} card must exist`)
  radio.checked = true
  d.getElementById('qSizes')!.dispatchEvent(new h.win.Event('change', { bubbles: true }))

  const set = (id: string, v: string) => {
    const e = d.getElementById(id) as HTMLInputElement
    if (e) e.value = v
  }
  set('qFirstName', 'Test'); set('qLastName', 'Fixture')
  set('qPhone', '8625550000'); set('qEmail', 'fixture@example.com')
  set('qPuZip', '08817'); set('qDoZip', '07030')
  set('qDate', new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10))
  const consent = d.getElementById('qConsent') as HTMLInputElement | null
  if (consent) consent.checked = true

  ;(d.getElementById('quoteForm') as HTMLFormElement).dispatchEvent(
    new h.win.Event('submit', { bubbles: true, cancelable: true }),
  )
  for (let i = 0; i < 15; i++) await new Promise((r) => setTimeout(r, 0))
}

/** Change the selection the way a customer does, without resubmitting. */
async function reselect(h: Harness, sizeKey: string): Promise<void> {
  const radio = h.doc.querySelector(`input[name="qSize"][value="${sizeKey}"]`) as HTMLInputElement | null
  assert.ok(radio, `the ${sizeKey} card must exist`)
  radio.checked = true
  h.doc.getElementById('qSizes')!.dispatchEvent(new h.win.Event('change', { bubbles: true }))
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
}

const RECEIVED = /We have your request|Recibimos su solicitud/

const priced = (total: number, extra: Record<string, unknown> = {}) => ({
  status: 200,
  body: {
    ok: true, captured: true, emailStatus: 'queued', notificationStatus: 'queued',
    priceBookVersion: PRICE_BOOK_VERSION, manualReview: false, reviewReasons: [],
    estimate: {
      totalDollars: total, baseDollars: total, isStarting: false, packageLabel: 'x',
      truckSize: '15ft', truckMinimum: '15ft', truckUpgrade: 0, truckCorrected: false,
      includedTruck: '15ft', mileageStatus: 'pending', priceBookVersion: PRICE_BOOK_VERSION,
      requiresReview: false, reviewReasons: [],
    },
    ...extra,
  },
})

// ══════════════════════════════════════════════════════════════════════
//  A · THE THREE NO-ESTIMATE STATES
// ══════════════════════════════════════════════════════════════════════
test('quote page: a genuine hand-quote is received, shows no price, and CAN continue', { skip }, async () => {
  const h = await loadPage(queuedFetch([{
    status: 200,
    body: {
      ok: true, captured: true, emailStatus: 'queued', notificationStatus: 'queued',
      priceBookVersion: PRICE_BOOK_VERSION, estimate: null, manualReview: true,
      reviewReasons: ['This move may need more than one truck or more than one trip, so it is planned by hand.'],
    },
  }]))
  await submit(h, '5br')

  assert.match(h.status(), RECEIVED, 'a CAPTURED hand-quote genuinely was received')
  assert.equal(h.priceText(), '—', 'a move the server declined to price shows no number')
  assert.equal(h.revealed(), false, 'prices must stay hidden — no .q-unlocked')
  assert.equal(h.continuable(), true, 'but the customer must still be able to reach booking')
  assert.ok(!/1,?799/.test(h.panelText()),
    'the 5BR starting figure must never appear in the estimate panel')
  // And the published card prices stay CSS-hidden, because 'manual' does not
  // add .q-unlocked — which is the whole reason the two flags were split.
  assert.equal(h.revealed(), false, 'the card prices must remain unrevealed')
  // BEHAVIOUR CHANGED 2026-08-24, and the assertion is stronger for it. This
  // used to require that NO conversion fire, on the reasoning that a job with
  // no quoted amount is not revenue. The premise is right; the conclusion was
  // not. A captured hand-quote is a real lead — 5BR and in-person requests are
  // among the largest jobs the business takes — and suppressing the event
  // deleted them from the conversion data entirely.
  //
  // So it fires exactly once and carries NO `value` property. That is the
  // honest record of "a real lead, amount not yet known", which is a different
  // thing from a lead worth zero, and different again from reporting the
  // browser's own figure.
  const leadEvents = h.events.filter((e) => e.name === 'generate_lead')
  assert.equal(leadEvents.length, 1, 'a captured hand-quote is still a lead')
  assert.ok(
    !('value' in (leadEvents[0].params ?? {})),
    `a job with no quoted amount must report no value: ${JSON.stringify(leadEvents[0].params)}`,
  )
  h.dom.window.close()
})

test('quote page: a hand-quote that was NOT captured never claims we have it', { skip }, async () => {
  const h = await loadPage(queuedFetch([{
    status: 503,
    body: {
      ok: false, captured: false, error: 'server_error',
      priceBookVersion: PRICE_BOOK_VERSION, estimate: null, manualReview: true,
      reviewReasons: ['This move may need more than one truck or more than one trip, so it is planned by hand.'],
    },
  }]))
  await submit(h, '5br')

  assert.doesNotMatch(h.status(), RECEIVED, 'nobody has the request — saying so would be false')
  assert.equal(h.priceText(), '—', 'still no number')
  assert.equal(h.revealed(), false)
  assert.equal(h.continuable(), false, 'an unsaved request must not proceed to booking')
  assert.match(h.buttonLabel(), /See my estimate|Ver mi estimado/, 'the button must offer a retry')
  h.dom.window.close()
})

test('quote page: a network failure is a failure, not a hand-quote', { skip }, async () => {
  // THE HEADLINE CASE. `selected()` made this indistinguishable from a 5BR.
  const h = await loadPage(queuedFetch(['network-error']))
  await submit(h, '2br')

  assert.doesNotMatch(h.status(), RECEIVED, 'an outage must never be reported as a received request')
  assert.doesNotMatch(h.status(), /quoted by hand|cotizamos a mano/i,
    'a 2BR has an automatic price — calling it hand-quoted is a fabrication')
  assert.equal(h.revealed(), false, 'no server price means nothing may be revealed')
  assert.ok(!/779/.test(h.panelText()),
    'with no server price, the browser mirror figure must not reach the estimate panel')
  assert.match(h.buttonLabel(), /See my estimate|Ver mi estimado/, 'the button must be usable again')
  assert.equal(h.continuable(), false)
  assert.ok(h.tracked.includes('quote_lead_capture_failed'), 'and it is recorded as a failure')
  h.dom.window.close()
})

test('quote page: a 5xx with no estimate is a failure, not a hand-quote', { skip }, async () => {
  const h = await loadPage(queuedFetch([{ status: 502, body: { ok: false, captured: false, error: 'server_error' } }]))
  await submit(h, '2br')

  assert.doesNotMatch(h.status(), RECEIVED)
  assert.equal(h.revealed(), false)
  assert.match(h.buttonLabel(), /See my estimate|Ver mi estimado/)
  h.dom.window.close()
})

test('quote page: a retry after a failure actually works', { skip }, async () => {
  // The failure path is only honest if the offered next action exists.
  const h = await loadPage(queuedFetch(['network-error', priced(779)]))
  await submit(h, '2br')
  assert.equal(h.revealed(), false, 'first attempt failed')

  ;(h.doc.getElementById('quoteForm') as HTMLFormElement).dispatchEvent(
    new h.win.Event('submit', { bubbles: true, cancelable: true }),
  )
  for (let i = 0; i < 15; i++) await new Promise((r) => setTimeout(r, 0))

  assert.equal(h.revealed(), true, 'the second attempt succeeded and revealed the price')
  assert.equal(h.continuable(), true)
  h.dom.window.close()
})

test('quote page: pricing_expired clears the selection and restores the gate button', { skip }, async () => {
  const h = await loadPage(queuedFetch([{
    status: 409,
    body: { ok: false, captured: false, error: 'pricing_expired', fields: ['moveSize'], priceBookVersion: PRICE_BOOK_VERSION },
  }]))
  await submit(h, '2br')

  assert.doesNotMatch(h.status(), RECEIVED, 'a refused package was not received')
  assert.equal(h.revealed(), false, 'no price is revealed')
  assert.equal(h.continuable(), false, 'and booking cannot proceed')
  assert.match(h.buttonLabel(), /See my estimate|Ver mi estimado/, 'the button returns to stage 1')
  const stillChecked = h.doc.querySelector('input[name="qSize"]:checked')
  assert.equal(stillChecked, null, 'the refused selection is cleared')
  h.dom.window.close()
})

test('quote page: a priced-but-unsaved 503 shows the SERVER price and says it was not saved', { skip }, async () => {
  const h = await loadPage(queuedFetch([{
    status: 503,
    body: {
      ok: false, captured: false, error: 'server_error', priceBookVersion: PRICE_BOOK_VERSION,
      manualReview: false, reviewReasons: [],
      estimate: {
        totalDollars: 779, baseDollars: 779, isStarting: false, packageLabel: '2 Bedrooms',
        truckSize: '15ft', truckMinimum: '15ft', truckUpgrade: 0, truckCorrected: false,
        includedTruck: '15ft', mileageStatus: 'pending', priceBookVersion: PRICE_BOOK_VERSION,
        requiresReview: false, reviewReasons: [],
      },
    },
  }]))
  await submit(h, '2br')

  assert.equal(h.revealed(), true, 'the server DID price it, so the number is honest to show')
  assert.match(h.priceText(), /779/, 'and it is the server figure')
  assert.doesNotMatch(h.status(), RECEIVED, 'but we do not have their information')
  assert.match(h.status(), /couldn|no pudimos/i, 'the save failure is stated')
  assert.ok(!h.tracked.includes('generate_lead'), 'a failed capture is not a conversion')
  h.dom.window.close()
})

// ══════════════════════════════════════════════════════════════════════
//  C · RE-SELECTION INVALIDATES THE QUOTE
// ══════════════════════════════════════════════════════════════════════
test('quote page: 1BR $550 cannot be carried forward onto 2BR', { skip }, async () => {
  const h = await loadPage(queuedFetch([priced(550)]))
  await submit(h, '1br')
  assert.equal(h.revealed(), true, 'the 1BR quote succeeded')
  assert.match(h.priceText(), /550/, 'and $550 is on screen')

  await reselect(h, '2br')

  assert.ok(!h.priceText().includes('550'), 'the 1BR price must not survive the change')
  assert.equal(h.revealed(), false, 'the quote is relocked until the server prices the new size')
  assert.equal(h.continuable(), false, 'Continue to Booking must not bypass re-pricing')
  assert.match(h.buttonLabel(), /See my estimate|Ver mi estimado/, 'the button returns to stage 1')
  assert.equal(h.win.__serverTotalProbe?.(), undefined, 'no server state is exposed for reuse')
  h.dom.window.close()
})

test('quote page: after re-selecting, a NEW submission is required and it re-prices', { skip }, async () => {
  const h = await loadPage(queuedFetch([priced(550), priced(779)]))
  await submit(h, '1br')
  await reselect(h, '2br')
  await submit(h, '2br')

  assert.equal(h.revealed(), true)
  assert.match(h.priceText(), /779/, 'the NEW package price is shown')
  assert.ok(!h.priceText().includes('550'), 'and the old one is gone')

  const sizes = h.posted().filter(Boolean).map((b: any) => b.moveSize)
  assert.ok(sizes.includes('2br'), 'the second submission declared the new package')
  h.dom.window.close()
})

test('quote page: re-selecting after a HAND-QUOTE also relocks', { skip }, async () => {
  const h = await loadPage(queuedFetch([{
    status: 200,
    body: {
      ok: true, captured: true, emailStatus: 'queued', notificationStatus: 'queued',
      priceBookVersion: PRICE_BOOK_VERSION, estimate: null, manualReview: true,
      reviewReasons: ['Planned by hand.'],
    },
  }]))
  await submit(h, '5br')
  assert.equal(h.continuable(), true, 'a captured hand-quote may continue')

  await reselect(h, '2br')
  assert.equal(h.continuable(), false, 'changing size withdraws that permission')
  assert.equal(h.revealed(), false)
  assert.match(h.buttonLabel(), /See my estimate|Ver mi estimado/)
  h.dom.window.close()
})
