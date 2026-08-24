// ════════════════════════════════════════════════════════════════════════
//  quote-page-browser.test.ts — the quick quote page, RUN, in a real DOM.
//
//  WHY THIS EXISTS. Every other guard in this repo proves the SERVER refuses a
//  retired package. None of them proved what the CUSTOMER sees. Those are
//  different failures: on 2026-08-22 the server was the thing that said $379,
//  but after it was fixed the page still called `unlock()` on every outcome —
//  so a visitor on a cached price book would have been shown $379 out of their
//  OWN stale copy, from a request the server had just refused.
//
//  So this file loads public/quote.html into jsdom, executes its real inline
//  JavaScript against the real generated price book, drives the real form, and
//  asserts on rendered text. No source-code regexes: if the page can put a
//  retired price on screen, these fail.
//
//  OFFLINE AND ISOLATED. `fetch` is stubbed, so nothing leaves the machine —
//  no API call, no Discord message, no email, no database.
// ════════════════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { JSDOM, VirtualConsole, ResourceLoader } from 'jsdom'
import { PACKAGES, LEGACY_PACKAGE_KEYS, PRICE_BOOK_VERSION } from '../pricing-config'
import { SITE_DIR, SKIP_WITHOUT_SITE, siteFile } from './site-dir'

const PAGE = siteFile('public/quote.html')
const MIRROR = siteFile('public/js/pricing-config.js')

const skip = existsSync(PAGE) && existsSync(MIRROR) ? false : 'WMIWCI-SITE not available'

/** The response the API gives a browser holding a withdrawn package. */
const PRICING_EXPIRED = {
  status: 409,
  body: { ok: false, captured: false, error: 'pricing_expired', fields: ['moveSize'], priceBookVersion: PRICE_BOOK_VERSION },
}

type Harness = {
  dom: JSDOM
  doc: Document
  win: any
  /** Every event name passed to the page's `track()`. */
  tracked: string[]
  events: Array<{ name: string; params?: Record<string, unknown> }>
  /** Bodies POSTed to the capture endpoint. */
  posted: any[]
  /** Number of times the page asked for a fresh pricing asset. */
  assetRefetches: number
  text(): string
}

/**
 * Load the real page and let jsdom fetch and execute its real scripts.
 *
 * The price book is served from disk by a ResourceLoader — the same way a
 * browser pulls `<script src="js/pricing-config.js?v=N">` — so the bytes under
 * test are exactly what the generator produced, and the page's own
 * refresh-the-asset path exercises a genuine script load rather than a stub.
 * Every other asset (site-copy.js, analytics) resolves to empty: none of them
 * price anything, and 404s would only add noise.
 */
async function loadPage(
  fetchImpl: (url: string, init?: any) => Promise<any>,
  /** Rewrite the mirror before serving it — used to reproduce an OLDER cached
   *  price book, which is the state a genuinely stale client is actually in. */
  mirrorTransform?: (js: string) => string,
): Promise<Harness> {
  const html = readFileSync(PAGE, 'utf8')
  const mirrorBytes = mirrorTransform
    ? Buffer.from(mirrorTransform(readFileSync(MIRROR, 'utf8')), 'utf8')
    : readFileSync(MIRROR)
  let assetRefetches = 0
  let firstLoadSeen = false

  /** jsdom may cancel an in-flight resource, so its loader returns an
   *  AbortablePromise. Reading from memory cannot be cancelled, so `abort` is
   *  a genuine no-op rather than a cast that hides the contract. */
  const served = (buf: Buffer) => {
    const p = Promise.resolve(buf) as Promise<Buffer> & { abort(): void }
    p.abort = () => {}
    return p
  }

  class LocalAssets extends ResourceLoader {
    fetch(url: string) {
      if (/\/js\/pricing-config\.js/.test(url)) {
        // The page's initial <script> tag is the first hit; anything after it
        // is the recovery path re-fetching the book.
        if (firstLoadSeen) assetRefetches++
        firstLoadSeen = true
        return served(mirrorBytes)
      }
      return served(Buffer.from(''))
    }
  }

  const virtualConsole = new VirtualConsole() // swallow page console noise
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://moveitclearit.com/quote',
    virtualConsole,
    resources: new LocalAssets(),
    beforeParse(win: any) {
      win.fetch = (url: string, init?: any) => fetchImpl(String(url), init)
      win.__tracked = []
      win.__trackedEvents = []
    },
  })

  const win = dom.window as any
  // Let the price-book script load and the page build its cards.
  for (let i = 0; i < 20 && !win.WMIC_PRICING; i++) await new Promise((r) => setTimeout(r, 10))
  await new Promise((r) => setTimeout(r, 10))

  // ── WRAP track() AFTER PARSE, NOT BEFORE ────────────────────────────────
  //  quote.html assigns `window.track` itself (line ~27), so a stub installed
  //  in beforeParse is overwritten the moment the page parses. Recording it
  //  there silently captured NOTHING — which would have made every
  //  "no conversion fired" assertion below pass for the wrong reason. Wrapping
  //  the page's own function afterwards is what actually observes the calls.
  const pageTrack = win.track
  win.track = (name: string, params?: unknown) => {
    win.__tracked.push(name)
    win.__trackedEvents.push({ name, params: params as Record<string, unknown> | undefined })
    if (typeof pageTrack === 'function') { try { pageTrack(name, params) } catch { /* GA absent */ } }
  }

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
    posted: (fetchImpl as any).__posted ?? [],
    get assetRefetches() { return assetRefetches },
    text: () => win.document.body.textContent ?? '',
  }
}

/** A stub fetch that answers the capture endpoint with `resp` and records bodies. */
function stubFetch(resp: { status: number; body: unknown }) {
  const posted: any[] = []
  const impl: any = async (url: string, init?: any) => {
    if (url.includes('/api/leads/quote-capture')) {
      try { posted.push(JSON.parse(init.body)) } catch { posted.push(null) }
      return { ok: resp.status < 400, status: resp.status, json: async () => resp.body }
    }
    // The service-area probe. Answer "unknown" so no travel copy is asserted on.
    return { ok: true, status: 200, json: async () => ({}) }
  }
  impl.__posted = posted
  return impl
}

/** Fill the gate and submit, then let the page's promise chain settle. */
async function submitWith(h: Harness, sizeKey: string): Promise<void> {
  const d = h.doc
  const radio = d.querySelector(`input[name="qSize"][value="${sizeKey}"]`) as HTMLInputElement | null
  if (radio) {
    radio.checked = true
    d.getElementById('qSizes')!.dispatchEvent(new h.win.Event('change', { bubbles: true }))
  }
  const set = (id: string, v: string) => {
    const el = d.getElementById(id) as HTMLInputElement
    if (el) el.value = v
  }
  set('qFirstName', 'Test'); set('qLastName', 'Fixture')
  set('qPhone', '8625550000'); set('qEmail', 'fixture@example.com')
  set('qPuZip', '08817'); set('qDoZip', '07030')
  // The page requires a move date today-or-later, inside its 540-day horizon.
  // Computed from the real clock so the fixture never expires.
  const soon = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10)
  set('qDate', soon)
  const consent = d.getElementById('qConsent') as HTMLInputElement | null
  if (consent) consent.checked = true

  const form = d.getElementById('quoteForm') as HTMLFormElement
  form.dispatchEvent(new h.win.Event('submit', { bubbles: true, cancelable: true }))
  // Let the stubbed promise chain and the asset-refresh timeout resolve.
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
}

// ══════════════════════════════════════════════════════════════════════
//  1. NO RETIRED PACKAGE IS EVER OFFERED
// ══════════════════════════════════════════════════════════════════════
test('browser: the page renders no Studio option and no retired price', { skip }, async () => {
  const h = await loadPage(stubFetch(PRICING_EXPIRED))
  const values = Array.from(h.doc.querySelectorAll('input[name="qSize"]')).map(
    (el) => (el as HTMLInputElement).value,
  )

  assert.ok(values.length >= 5, 'the size cards must actually render')
  for (const retired of LEGACY_PACKAGE_KEYS) {
    assert.ok(!values.includes(retired), `${retired} is selectable on the live page`)
  }
  const rendered = h.doc.getElementById('qSizes')!.textContent ?? ''
  assert.ok(!/studio/i.test(rendered), 'a Studio label is rendered in the size list')
  for (const amount of ['379', '439', '549', '649']) {
    assert.ok(!rendered.includes(amount), `a retired price ($${amount}) is rendered in the size list`)
  }
  h.dom.window.close()
})

test('browser: the cheapest offered package is 1 Bedroom at $550', { skip }, async () => {
  const h = await loadPage(stubFetch(PRICING_EXPIRED))
  const labels = Array.from(h.doc.querySelectorAll('#qSizes label'))
  const first = labels[0]
  assert.equal((first.querySelector('input') as HTMLInputElement).value, '1br',
    'the first, cheapest card must be 1 Bedroom')
  assert.match(first.textContent ?? '', /\$550/, 'and it must show the published $550')
  assert.equal(PACKAGES['1br'].price.amount, 550)
  h.dom.window.close()
})

// ══════════════════════════════════════════════════════════════════════
//  2. A STALE CLIENT NEVER SEES THE RETIRED PRICE   ← the blocker
// ══════════════════════════════════════════════════════════════════════
test('browser: a pricing_expired reply reveals NOTHING — $379 never reaches the screen', { skip }, async () => {
  const h = await loadPage(stubFetch(PRICING_EXPIRED))

  // Simulate the cached bundle: inject the retired option the way a stale
  // price book would have rendered it, and select it.
  const sizes = h.doc.getElementById('qSizes')!
  const stale = h.doc.createElement('label')
  stale.className = 'q-size'
  stale.innerHTML =
    '<input type="radio" name="qSize" value="little-studio">' +
    '<span><b>Small Studio</b><em class="q-size-price">$379</em></span>'
  sizes.insertBefore(stale, sizes.firstChild)

  await submitWith(h, 'little-studio')

  const body = h.doc.body
  // THE ASSERTION THAT MATTERS: the price panel is still locked, so no figure
  // — stale or otherwise — has been revealed.
  assert.ok(!(h.doc.getElementById('quoteForm') as HTMLElement).classList.contains('q-unlocked'),
    'the estimate was unlocked despite the server refusing to price it')

  const priceNum = h.doc.getElementById('qPriceNum')?.textContent ?? ''
  assert.ok(!priceNum.includes('379'), `the retired price was rendered: "${priceNum}"`)
  assert.ok(!/\$\s?379\b/.test(body.textContent ?? ''), '$379 appears somewhere on the page')

  // The retired selection is released, and the shared booking draft with it.
  assert.equal(h.doc.querySelector('input[name="qSize"]:checked'), null,
    'the refused selection is still checked')
  const draft = JSON.parse(h.win.localStorage.getItem('wmiwci_booking_v2') || '{}')
  assert.equal(draft.serviceType, undefined,
    'the retired package is still in the draft the booking form reads')

  // No conversion may fire for a lead that was never created.
  assert.ok(!h.tracked.includes('generate_lead'), 'a conversion fired on a refused quote')
  assert.ok(!h.tracked.includes('quote_lead_captured'), 'a capture event fired on a refused quote')
  assert.ok(h.tracked.includes('quote_price_book_expired'), 'the refusal should be recorded')

  // The customer is told what happened and what to do.
  const status = h.doc.getElementById('qStatus')?.textContent ?? ''
  assert.match(status, /no longer available/i, 'the customer must be told the option expired')
  assert.match(status, /1 Bedroom/i, 'and pointed at the current smallest package')

  // The pricing asset was refreshed — exactly once, so there is no loop.
  assert.equal(h.assetRefetches, 1, 'the price book must be refreshed once and only once')
  h.dom.window.close()
})

test('browser: a second refusal does not re-fetch the asset again (no loop)', { skip }, async () => {
  const h = await loadPage(stubFetch(PRICING_EXPIRED))
  await submitWith(h, '1br')
  await submitWith(h, '1br')
  assert.ok(h.assetRefetches <= 1, `the asset was re-fetched ${h.assetRefetches} times — that is a loop`)
  h.dom.window.close()
})

// ══════════════════════════════════════════════════════════════════════
//  3. A GOOD QUOTE STILL WORKS, AND SAYS WHAT IT IS
// ══════════════════════════════════════════════════════════════════════
test('browser: a successful 1BR quote reveals exactly $550 and no truck surcharge', { skip }, async () => {
  const ok = {
    status: 200,
    body: {
      ok: true, captured: true, emailStatus: 'queued', notificationStatus: 'queued',
      estimate: {
        totalDollars: 550, baseDollars: 550, isStarting: false, packageLabel: '1 Bedroom',
        truckSize: '10ft', truckMinimum: '10ft', truckUpgrade: 0, truckCorrected: false,
        includedTruck: '10ft', mileageStatus: 'pending', priceBookVersion: PRICE_BOOK_VERSION,
      },
      priceBookVersion: PRICE_BOOK_VERSION,
    },
  }
  const fetchImpl = stubFetch(ok)
  const h = await loadPage(fetchImpl)
  await submitWith(h, '1br')

  assert.ok((h.doc.getElementById('quoteForm') as HTMLElement).classList.contains('q-unlocked'),
    'a good quote must reveal the estimate')
  assert.match(h.doc.getElementById('qPriceNum')?.textContent ?? '', /\$550/)
  assert.ok(!/\$\s?650\b/.test(h.doc.body.textContent ?? ''), 'a truck surcharge was added to a standard 1BR')

  // And the submission carried the price book it was built from.
  const body = (fetchImpl as any).__posted[0]
  assert.equal(body.priceBookVersion, PRICE_BOOK_VERSION,
    'the browser must declare which price book it is running')

  // PROOF THE RECORDER WORKS. Without this, the "no conversion fired"
  // assertions on the refused-quote test would pass even if track() were never
  // observed at all — which is exactly the trap this suite hit once already.
  assert.ok(h.tracked.includes('generate_lead'),
    'a captured lead MUST fire the conversion — otherwise the negative assertions elsewhere prove nothing')
  h.dom.window.close()
})

test('browser: the revealed figure is labelled a subtotal with transportation pending', { skip }, async () => {
  const ok = {
    status: 200,
    body: {
      ok: true, captured: true, emailStatus: 'queued', notificationStatus: 'queued',
      estimate: {
        totalDollars: 779, baseDollars: 779, isStarting: false, packageLabel: '2 Bedrooms',
        truckSize: '15ft', truckMinimum: '15ft', truckUpgrade: 0, truckCorrected: false,
        includedTruck: '15ft', mileageStatus: 'pending', priceBookVersion: PRICE_BOOK_VERSION,
      },
      priceBookVersion: PRICE_BOOK_VERSION,
    },
  }
  const h = await loadPage(stubFetch(ok))
  await submitWith(h, '2br')

  const shown = h.doc.body.textContent ?? ''
  assert.match(h.doc.getElementById('qPriceNum')?.textContent ?? '', /\$779/, '2BR is the published $779')
  assert.ok(!/\$\s?879\b/.test(shown), 'the retired $879 truck surcharge is back on screen')
  assert.match(shown, /package subtotal/i, 'the figure must be called a subtotal, not an estimate')
  assert.match(shown, /transportation pending/i, 'the pending drive must be disclosed')
  assert.match(shown, /\$3 per routed mile/i, 'at the published rate')
  assert.match(shown, /fuel included/i)
  h.dom.window.close()
})

// ══════════════════════════════════════════════════════════════════════
//  4. THE BROWSER AND SERVER PRICE BOOKS ARE THE SAME BOOK
// ══════════════════════════════════════════════════════════════════════
test('browser: the page runs the same price-book version as the server', { skip }, async () => {
  const h = await loadPage(stubFetch(PRICING_EXPIRED))
  assert.equal(h.win.WMIC_PRICING.PRICE_BOOK_VERSION, PRICE_BOOK_VERSION,
    'the generated mirror must carry the server price-book version')
  h.dom.window.close()
})

// ══════════════════════════════════════════════════════════════════════
//  5. A PREVIOUS MIRROR — ONE THAT PREDATES PRICE_BOOK_VERSION ENTIRELY
//
//  This is the state a genuinely stale visitor is in, and the one the last
//  round got wrong: the page sent `priceBookVersion: null`, which the API
//  rejected on SHAPE (422) before it could ever say `pricing_expired`.
// ══════════════════════════════════════════════════════════════════════

/** Strip PRICE_BOOK_VERSION and the retirement flags, i.e. the mirror as it
 *  was BEFORE this work: studios present and sellable, no version field. */
const asPreviousMirror = (js: string): string =>
  js
    .replace(/"PRICE_BOOK_VERSION":\s*"[^"]*",\s*/, '')
    .replace(/"legacy":\s*true,\s*/g, '')
    .replace(/"retiredOn":\s*"[^"]*",\s*/g, '')

test('browser: a PREVIOUS mirror omits priceBookVersion rather than sending null', { skip }, async () => {
  const fetchImpl = stubFetch(PRICING_EXPIRED)
  const h = await loadPage(fetchImpl, asPreviousMirror)

  // Sanity: this really is an old book — no version, and the studios are back.
  assert.equal(h.win.WMIC_PRICING.PRICE_BOOK_VERSION, undefined, 'the fixture must actually be a pre-version mirror')

  await submitWith(h, '1br')

  const body = (fetchImpl as any).__posted[0]
  assert.ok(body, 'the submission must reach the API')
  assert.ok(
    !('priceBookVersion' in body),
    `an unknown version must be OMITTED, never sent as null — got ${JSON.stringify(body.priceBookVersion)}`,
  )
  // Belt and braces: null must not appear under ANY spelling.
  assert.ok(
    !Object.values(body).includes(null),
    `no field may be sent as null — the API rejects null on shape: ${JSON.stringify(body)}`,
  )
  h.dom.window.close()
})

test('browser: even a PREVIOUS mirror cannot put a retired tier on the page', { skip }, async () => {
  // A better outcome than expected, and worth pinning. The retirement flags
  // are stripped from this mirror, so the `pkg.legacy` filter is dead exactly
  // as it was during the incident — but the ALLOWLIST still holds: a package
  // must be in PRICED_PACKAGE_KEYS to be offered, and the studios never were.
  //
  // This is what "fails closed" buys. The flag filter protects against a
  // retirement; the allowlist protects against the flag going missing.
  const h = await loadPage(stubFetch(PRICING_EXPIRED), asPreviousMirror)

  const P = h.win.WMIC_PRICING
  assert.equal(P.PACKAGES['little-studio'].legacy, undefined, 'the fixture must really have lost the flag')
  assert.equal(P.PACKAGES['little-studio'].price.amount, 379, 'and must still contain the retired tier')

  const offered = Array.from(h.doc.querySelectorAll('input[name="qSize"]')).map(
    (el) => (el as HTMLInputElement).value,
  )
  for (const retired of LEGACY_PACKAGE_KEYS) {
    assert.ok(!offered.includes(retired), `${retired} was offered from a flag-less mirror`)
  }
  assert.ok(!/\$\s?379\b/.test(h.doc.body.textContent ?? ''), '$379 reached the screen from the stale book')
  h.dom.window.close()
})

test('browser: a CURRENT mirror does send its version', { skip }, async () => {
  // The positive control. Without it, the omission test above would pass even
  // if the page had stopped sending the field altogether.
  const fetchImpl = stubFetch(PRICING_EXPIRED)
  const h = await loadPage(fetchImpl)
  await submitWith(h, '1br')
  const body = (fetchImpl as any).__posted[0]
  assert.equal(body.priceBookVersion, PRICE_BOOK_VERSION, 'a current client must declare its price book')
  h.dom.window.close()
})

// ══════════════════════════════════════════════════════════════════════
//  6. DRIVEN BY THE **REAL** ROUTE RESPONSE
//
//  Every browser test above answers with a response this file wrote. That
//  assumes the API produces it — and the assumption was wrong twice: once
//  when the flag short-circuited to a bare 200, and once when an old mirror
//  was 422'd on shape. So these call the ACTUAL handler and feed the browser
//  exactly what it returns, in each state of the capture feature flag.
// ══════════════════════════════════════════════════════════════════════
test('browser: a retired Studio never reveals a price — using the REAL API response', { skip }, async () => {
  const { POST } = (await import('../../../app/api/leads/quote-capture/route')) as unknown as {
    POST: (req: Request) => Promise<Response>
  }

  for (const flag of ['true', 'false', undefined] as const) {
    if (flag === undefined) delete process.env.QUOTE_LEAD_CAPTURE_ENABLED
    else process.env.QUOTE_LEAD_CAPTURE_ENABLED = flag
    const label = `flag=${flag ?? 'UNSET'}`

    // A stub fetch that PROXIES to the real route handler.
    const posted: any[] = []
    const viaRealRoute: any = async (url: string, init?: any) => {
      if (!url.includes('/api/leads/quote-capture')) {
        return { ok: true, status: 200, json: async () => ({}) }
      }
      posted.push(JSON.parse(init.body))
      const res = await POST(
        new Request('https://api.example.com/api/leads/quote-capture', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', origin: 'https://moveitclearit.com' },
          body: init.body,
        }) as never,
      )
      const json = await res.json()
      return { ok: res.status < 400, status: res.status, json: async () => json }
    }
    viaRealRoute.__posted = posted

    // A PREVIOUS mirror: no version field, no retirement flags.
    const h = await loadPage(viaRealRoute, asPreviousMirror)

    // Inject the retired option the way a stale bundle would have rendered it.
    const sizes = h.doc.getElementById('qSizes')!
    const stale = h.doc.createElement('label')
    stale.className = 'q-size'
    stale.innerHTML =
      '<input type="radio" name="qSize" value="little-studio">' +
      '<span><b>Small Studio</b><em class="q-size-price">$379</em></span>'
    sizes.insertBefore(stale, sizes.firstChild)

    await submitWith(h, 'little-studio')

    assert.ok(
      !(h.doc.getElementById('quoteForm') as HTMLElement).classList.contains('q-unlocked'),
      `${label}: the estimate was unlocked despite the real API refusing to price it`,
    )
    assert.ok(!/\$\s?379\b/.test(h.doc.getElementById('qPriceNum')?.textContent ?? ''), `${label}: $379 rendered`)
    assert.ok(!h.tracked.includes('generate_lead'), `${label}: a conversion fired on a refused quote`)
    assert.ok(!h.tracked.includes('quote_lead_captured'), `${label}: a capture event fired`)
    assert.equal(h.doc.querySelector('input[name="qSize"]:checked'), null, `${label}: selection not cleared`)
    assert.match(h.doc.getElementById('qStatus')?.textContent ?? '', /no longer available/i, label)
    h.dom.window.close()
  }
  process.env.QUOTE_LEAD_CAPTURE_ENABLED = 'true'
})

test('browser: a 3BR shows the SERVER review language, from the REAL response', { skip }, async () => {
  // The page must not decide "subject to review" from its own mirror. This
  // drives the real route so the wording comes from the server that computed it.
  process.env.QUOTE_LEAD_CAPTURE_ENABLED = 'false' // priced, not persisted
  const { POST } = (await import('../../../app/api/leads/quote-capture/route')) as unknown as {
    POST: (req: Request) => Promise<Response>
  }
  const viaRealRoute: any = async (url: string, init?: any) => {
    if (!url.includes('/api/leads/quote-capture')) return { ok: true, status: 200, json: async () => ({}) }
    const res = await POST(
      new Request('https://api.example.com/api/leads/quote-capture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', origin: 'https://moveitclearit.com' },
        body: init.body,
      }) as never,
    )
    const json = await res.json()
    return { ok: res.status < 400, status: res.status, json: async () => json }
  }
  viaRealRoute.__posted = []

  const h = await loadPage(viaRealRoute)
  await submitWith(h, '3br')

  const shown = h.doc.body.textContent ?? ''
  assert.match(h.doc.getElementById('qPriceNum')?.textContent ?? '', /\$1,049/, '3BR is the published floor')
  assert.ok(!/\$1,199/.test(shown), 'the retired truck surcharge is back on screen')
  assert.match(shown, /subject to review/i, 'the server said this needs a human; the page must say so')
  assert.match(shown, /inventory|access|truck plan/i, 'and give the reason')
  h.dom.window.close()
  process.env.QUOTE_LEAD_CAPTURE_ENABLED = 'true'
})

// ══════════════════════════════════════════════════════════════════════
//  7. A MANUAL-REVIEW PACKAGE HAS NO PRICE TO SHOW
//
//  5BR is quoted by hand: the API returns `estimate: null` and
//  `manualReview: true`. The page ignored the top-level review state, fell
//  through to unlock(), and rendered the amount from its OWN mirror — so a
//  customer was shown "$1,799" for a job the server had explicitly declined
//  to price, and the conversion could report that number as revenue.
// ══════════════════════════════════════════════════════════════════════
test('browser: 5BR never displays a price — driven by the REAL route', { skip }, async () => {
  const { POST } = (await import('../../../app/api/leads/quote-capture/route')) as unknown as {
    POST: (req: Request) => Promise<Response>
  }
  process.env.QUOTE_LEAD_CAPTURE_ENABLED = 'false' // priced, not persisted
  const viaRealRoute: any = async (url: string, init?: any) => {
    if (!url.includes('/api/leads/quote-capture')) return { ok: true, status: 200, json: async () => ({}) }
    const res = await POST(
      new Request('https://api.example.com/api/leads/quote-capture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', origin: 'https://moveitclearit.com' },
        body: init.body,
      }) as never,
    )
    const json = await res.json()
    return { ok: res.status < 400, status: res.status, json: async () => json }
  }
  viaRealRoute.__posted = []

  const h = await loadPage(viaRealRoute)
  await submitWith(h, '5br')

  const shown = h.doc.body.textContent ?? ''
  const priceNum = h.doc.getElementById('qPriceNum')?.textContent ?? ''

  // THE DEFECT: the estimate panel presenting the mirror's amount as if it
  // were this customer's quote.
  assert.ok(
    !/1[,.]?799/.test(priceNum),
    `the mirror's own $1,799 was displayed as the estimate for a package the server refused to price: "${priceNum}"`,
  )
  assert.equal(priceNum.trim(), '—', 'an unpriced job shows no figure at all')

  // And the page must NOT be unlocked, which is what keeps the size cards'
  // prices hidden (CSS gates `.q-size-price` behind `.q-unlocked`).
  assert.ok(
    !(h.doc.getElementById('quoteForm') as HTMLElement).classList.contains('q-unlocked'),
    'the page unlocked for a job the server declined to price',
  )

  // NOTE on the size card: it carries "From $1,799", which is the genuinely
  // PUBLISHED starting price for 5 bedrooms — the same figure the pricing page
  // advertises. That is legitimate and is not asserted against; it is also
  // invisible here, because the form never unlocks. What must never happen is
  // presenting it as the customer's own quote, which is what the two
  // assertions above pin.
  assert.match(shown, /by hand|manual|review/i, 'the customer must be told it is quoted by hand')
  // And no conversion may report a number the business never quoted.
  assert.ok(!h.tracked.includes('generate_lead'), 'a conversion fired for an unpriced job')
  h.dom.window.close()
  process.env.QUOTE_LEAD_CAPTURE_ENABLED = 'true'
})

test('browser: an in-person request shows no price either', { skip }, async () => {
  const { POST } = (await import('../../../app/api/leads/quote-capture/route')) as unknown as {
    POST: (req: Request) => Promise<Response>
  }
  process.env.QUOTE_LEAD_CAPTURE_ENABLED = 'false'
  const viaRealRoute: any = async (url: string, init?: any) => {
    if (!url.includes('/api/leads/quote-capture')) return { ok: true, status: 200, json: async () => ({}) }
    // The page has no in-person toggle in this fixture, so ask for it directly:
    // the point is the RESPONSE shape (no estimate + manualReview), which the
    // page must handle whatever produced it.
    const body = { ...JSON.parse(init.body), quoteMode: 'in_person' }
    const res = await POST(
      new Request('https://api.example.com/api/leads/quote-capture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', origin: 'https://moveitclearit.com' },
        body: JSON.stringify(body),
      }) as never,
    )
    const json = await res.json()
    return { ok: res.status < 400, status: res.status, json: async () => json }
  }
  viaRealRoute.__posted = []

  const h = await loadPage(viaRealRoute)
  await submitWith(h, '2br')
  assert.ok(!/\$\s?779/.test(h.doc.getElementById('qPriceNum')?.textContent ?? ''),
    'no automatic number may be shown when the server produced none')
  assert.ok(!h.tracked.includes('generate_lead'))
  h.dom.window.close()
  process.env.QUOTE_LEAD_CAPTURE_ENABLED = 'true'
})
