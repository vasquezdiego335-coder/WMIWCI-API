// ════════════════════════════════════════════════════════════════════════
//  quote-page-label-and-conversion.test.ts — two defects that both took a
//  true statement one step too far.
//
//  1 · "YOUR FLAT PACKAGE PRICE". The figure shown EXCLUDES routed-mile
//      transportation — the line directly beneath it says so — and the page
//      called it flat anyway. The customer was told the number was final and
//      pending in the same breath. It is a PACKAGE SUBTOTAL, which is the
//      wording the owner's Discord card and the confirmation email already use
//      for the same figure.
//
//      The label lives in `data-en` / `data-es` because setLang() repaints
//      every [data-en][data-es] node from those attributes. A label fixed only
//      in the inline text reverts the moment somebody switches language, so
//      that specific regression gets its own test.
//
//  2 · CAPTURED HAND-QUOTES FIRED NO CONVERSION. The branch skipped
//      fireConversion() reasoning that a job with no quoted amount must not be
//      reported as revenue. True — but it does not follow that the lead should
//      vanish from the conversion data. 5BR and in-person requests are among
//      the most valuable enquiries the business takes, and suppressing the
//      event made the channels that produce large moves look barren.
//
//      The fix reports the lead with NO `value` property, which is the honest
//      record of "real lead, amount not yet known" and a different thing from
//      a lead worth zero.
//
//  These assert on the event PARAMETERS, not just the names: "generate_lead
//  fired" is equally true when the event carries the server's total and when
//  it carries the browser's own figure, and those are opposite outcomes.
//
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

type Ev = { name: string; params?: Record<string, unknown> }
type Harness = {
  dom: JSDOM
  doc: Document
  win: any
  events: Ev[]
  panelText(): string
  labelText(): string
  buttonLabel(): string
  revealed(): boolean
  setLang(lang: 'en' | 'es'): void
}

function stubFetch(responses: Array<{ status: number; body: unknown } | 'network-error'>) {
  let i = 0
  const impl: any = async (url: string, init?: any) => {
    if (String(url).includes('/api/leads/quote-capture')) {
      const r = responses[Math.min(i, responses.length - 1)]
      i++
      if (r === 'network-error') throw new Error('network down')
      return { ok: r.status < 400, status: r.status, json: async () => r.body }
    }
    return { ok: true, status: 200, json: async () => ({}) }
  }
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
      win.__events = []
    },
  })
  const win = dom.window as any
  for (let i = 0; i < 20 && !win.WMIC_PRICING; i++) await new Promise((r) => setTimeout(r, 10))
  await new Promise((r) => setTimeout(r, 10))

  // Wrap AFTER parse — quote.html assigns window.track itself, so a stub
  // installed in beforeParse is overwritten and records nothing.
  const pageTrack = win.track
  win.track = (name: string, params?: Record<string, unknown>) => {
    win.__events.push({ name, params })
    if (typeof pageTrack === 'function') { try { pageTrack(name, params) } catch { /* GA absent */ } }
  }

  const el = (id: string) => win.document.getElementById(id) as HTMLElement | null
  return {
    dom,
    doc: win.document,
    win,
    get events() { return win.__events as Ev[] },
    panelText: () => el('qPrice')?.textContent ?? '',
    labelText: () => win.document.querySelector('.q-price-lab')?.textContent ?? '',
    buttonLabel: () => el('qSubmit')?.textContent ?? '',
    revealed: () => !!win.document.getElementById('quoteForm')?.classList.contains('q-unlocked'),
    /* Click the real language control. setLang() is scoped inside the page's
       IIFE and is not reachable from the test, and reaching for it would in
       any case test a function rather than the button a customer presses. */
    setLang: (lang: 'en' | 'es') => {
      const btn = win.document.querySelector(`#qLang button[data-lang="${lang}"]`) as HTMLButtonElement | null
      if (!btn) throw new Error(`no language button for ${lang}`)
      btn.dispatchEvent(new win.Event('click', { bubbles: true }))
    },
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

const pricedBody = (total: number) => ({
  status: 200,
  body: {
    ok: true, captured: true, emailStatus: 'queued', notificationStatus: 'queued',
    priceBookVersion: PRICE_BOOK_VERSION, manualReview: false, reviewReasons: [],
    estimate: {
      totalDollars: total, baseDollars: total, isStarting: false, packageLabel: '2 Bedrooms',
      truckSize: '15ft', truckMinimum: '15ft', truckUpgrade: 0, truckCorrected: false,
      includedTruck: '15ft', mileageStatus: 'pending', priceBookVersion: PRICE_BOOK_VERSION,
      requiresReview: false, reviewReasons: [],
    },
  },
})

const manualCaptured = {
  status: 200,
  body: {
    ok: true, captured: true, emailStatus: 'queued', notificationStatus: 'queued',
    priceBookVersion: PRICE_BOOK_VERSION, estimate: null, manualReview: true,
    reviewReasons: ['This move may need more than one truck or more than one trip, so it is planned by hand.'],
  },
}

const manualNotCaptured = {
  status: 503,
  body: {
    ok: false, captured: false, error: 'server_error',
    priceBookVersion: PRICE_BOOK_VERSION, estimate: null, manualReview: true,
    reviewReasons: ['Planned by hand.'],
  },
}

const only = (h: Harness, name: string): Ev[] => h.events.filter((e) => e.name === name)

// ══════════════════════════════════════════════════════════════════════
//  FIX 1 · THE LABEL
// ══════════════════════════════════════════════════════════════════════
test('label: the revealed automatic amount is a Package subtotal', { skip }, async () => {
  const h = await loadPage(stubFetch([pricedBody(779)]))
  await submit(h, '2br')
  assert.equal(h.revealed(), true, 'the server priced it, so it is revealed')
  assert.equal(h.labelText().trim(), 'Package subtotal')
  assert.match(h.panelText(), /779/)
  h.dom.window.close()
})

test('label: Spanish reads Subtotal del paquete', { skip }, async () => {
  const h = await loadPage(stubFetch([pricedBody(779)]))
  h.setLang('es')
  await submit(h, '2br')
  assert.equal(h.labelText().trim(), 'Subtotal del paquete')
  h.dom.window.close()
})

test('label: switching language cannot restore the old wording', { skip }, async () => {
  // setLang() repaints from data-en/data-es, so a label fixed only in the
  // inline text reverts on the first language toggle. This is that regression.
  const h = await loadPage(stubFetch([pricedBody(779)]))
  await submit(h, '2br')
  for (const lang of ['es', 'en', 'es', 'en'] as const) {
    h.setLang(lang)
    assert.doesNotMatch(h.labelText(), /flat package price|precio fijo del paquete/i,
      `the old label came back after switching to ${lang}: "${h.labelText()}"`)
  }
  assert.equal(h.labelText().trim(), 'Package subtotal')
  h.dom.window.close()
})

test('label: neither old phrase appears anywhere in the quote panel', { skip }, async () => {
  const h = await loadPage(stubFetch([pricedBody(779)]))
  await submit(h, '2br')
  assert.doesNotMatch(h.panelText(), /flat package price/i)
  assert.doesNotMatch(h.panelText(), /precio fijo del paquete/i)
  h.dom.window.close()
})

test('label: transportation is still disclosed as pending at $3 per routed mile', { skip }, async () => {
  // The label is only honest because this line is present. If the disclosure
  // ever disappears, "subtotal" stops meaning anything.
  const h = await loadPage(stubFetch([pricedBody(779)]))
  await submit(h, '2br')
  const text = h.panelText()
  assert.match(text, /\$3 per routed mile/i, `the mileage rate must be stated: ${text.slice(0, 200)}`)
  assert.match(text, /fuel included/i)
  assert.match(text, /pending/i)
  h.dom.window.close()
})

test('label: the source markup carries the new wording in BOTH languages', { skip }, () => {
  const html = readFileSync(PAGE, 'utf8')
  assert.match(html, /data-en="Package subtotal"/)
  assert.match(html, /data-es="Subtotal del paquete"/)
  assert.doesNotMatch(html, /Your flat package price/)
  assert.doesNotMatch(html, /Su precio fijo del paquete/)
})

// ══════════════════════════════════════════════════════════════════════
//  FIX 2 · CONVERSIONS
// ══════════════════════════════════════════════════════════════════════
test('conversion: a captured AUTOMATIC quote fires once, with the SERVER value', { skip }, async () => {
  const h = await loadPage(stubFetch([pricedBody(779)]))
  await submit(h, '2br')

  const lead = only(h, 'generate_lead')
  const captured = only(h, 'quote_lead_captured')
  assert.equal(lead.length, 1, 'generate_lead exactly once')
  assert.equal(captured.length, 1, 'quote_lead_captured exactly once')
  assert.equal(lead[0].params?.value, 779, 'the value is the SERVER total')
  assert.equal(captured[0].params?.value, 779)
  assert.equal(lead[0].params?.currency, 'USD')
  h.dom.window.close()
})

test('conversion: a captured MANUAL request fires once, with NO value property', { skip }, async () => {
  // The defect: this branch fired nothing at all, so 5BR and in-person
  // enquiries — the largest jobs — were invisible in the conversion data.
  const h = await loadPage(stubFetch([manualCaptured]))
  await submit(h, '5br')

  const lead = only(h, 'generate_lead')
  const captured = only(h, 'quote_lead_captured')
  assert.equal(lead.length, 1, 'a captured hand-quote is still a lead')
  assert.equal(captured.length, 1)
  assert.ok(!('value' in (lead[0].params ?? {})), `generate_lead must carry no value: ${JSON.stringify(lead[0].params)}`)
  assert.ok(!('value' in (captured[0].params ?? {})), 'quote_lead_captured must carry no value either')
  h.dom.window.close()
})

test('conversion: the manual event never reports the browser figure', { skip }, async () => {
  // body.estimateTotal is the BROWSER's number. It is exactly the value that
  // must not travel, and it is the one a well-meaning "fallback" would pick.
  const h = await loadPage(stubFetch([manualCaptured]))
  await submit(h, '5br')
  for (const e of h.events) {
    const v = e.params?.value
    assert.ok(v === undefined, `${e.name} carried a value it should not have: ${JSON.stringify(e.params)}`)
    assert.doesNotMatch(JSON.stringify(e.params ?? {}), /1799|1,799/, `${e.name} leaked the 5BR published figure`)
  }
  h.dom.window.close()
})

test('conversion: an UNCAPTURED manual request fires no conversion', { skip }, async () => {
  const h = await loadPage(stubFetch([manualNotCaptured]))
  await submit(h, '5br')
  assert.equal(only(h, 'generate_lead').length, 0, 'nobody has the request; it is not a conversion')
  assert.equal(only(h, 'quote_lead_captured').length, 0)
  h.dom.window.close()
})

for (const [label, response] of [
  ['a network failure', 'network-error' as const],
  ['a 5xx', { status: 502, body: { ok: false, captured: false, error: 'server_error' } }],
  ['a refused retired package', {
    status: 409,
    body: { ok: false, captured: false, error: 'pricing_expired', fields: ['moveSize'], priceBookVersion: PRICE_BOOK_VERSION },
  }],
] as const) {
  test(`conversion: ${label} fires no conversion`, { skip }, async () => {
    const h = await loadPage(stubFetch([response as never]))
    await submit(h, '2br')
    assert.equal(only(h, 'generate_lead').length, 0)
    assert.equal(only(h, 'quote_lead_captured').length, 0)
    h.dom.window.close()
  })
}

test('conversion: the honeypot fires no conversion and does not submit', { skip }, async () => {
  const h = await loadPage(stubFetch([pricedBody(779)]))
  const trap = h.doc.getElementById('qCompany') as HTMLInputElement
  assert.ok(trap, 'the honeypot field must exist')
  trap.value = 'spam co'
  await submit(h, '2br')
  assert.equal(only(h, 'generate_lead').length, 0)
  h.dom.window.close()
})

test('conversion: stage-two Continue does not fire a second conversion', { skip }, async () => {
  const h = await loadPage(stubFetch([pricedBody(779)]))
  await submit(h, '2br')
  assert.equal(only(h, 'generate_lead').length, 1)

  // Stage two: the same button now means "continue". Navigation is stubbed so
  // the click is observable without leaving the page.
  h.win.goToBooking = () => {}
  const form = h.doc.getElementById('quoteForm') as HTMLFormElement
  form.dispatchEvent(new h.win.Event('submit', { bubbles: true, cancelable: true }))
  form.dispatchEvent(new h.win.Event('submit', { bubbles: true, cancelable: true }))
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))

  assert.equal(only(h, 'generate_lead').length, 1, 'Continue must not re-report the lead')
  assert.equal(only(h, 'quote_lead_captured').length, 1)
  h.dom.window.close()
})

test('conversion: a retry after a failure fires exactly one conversion', { skip }, async () => {
  const h = await loadPage(stubFetch(['network-error', pricedBody(779)]))
  await submit(h, '2br')
  assert.equal(only(h, 'generate_lead').length, 0, 'the failed attempt reports nothing')

  ;(h.doc.getElementById('quoteForm') as HTMLFormElement).dispatchEvent(
    new h.win.Event('submit', { bubbles: true, cancelable: true }),
  )
  for (let i = 0; i < 15; i++) await new Promise((r) => setTimeout(r, 0))

  assert.equal(only(h, 'generate_lead').length, 1, 'the successful retry reports once')
  assert.equal(only(h, 'generate_lead')[0].params?.value, 779)
  h.dom.window.close()
})
