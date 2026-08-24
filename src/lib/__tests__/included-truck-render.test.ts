// ════════════════════════════════════════════════════════════════════════
//  included-truck-render.test.ts — the booking form's two disclosure panels
//  must render without throwing.
//
//  WHY. Both panels read COPY keys that existed in NEITHER repository:
//
//    renderIncludedTruck()  ->  PRICING.COPY.full_service_mileage_short.en
//    renderRoute()          ->  PRICING.COPY.labor_only_between_addresses.en
//
//  `.en` on undefined threw one line before `box.innerHTML = html`, so the
//  whole panel — package, included truck, upgrade note, disclosure — vanished.
//  Every call site wraps these in try{}catch{}, so both failed INVISIBLY.
//  Nothing compared the page's COPY references against the generated mirror,
//  so nothing noticed. That is the same shape as the original $379 defect: a
//  read of a property that does not exist, failing open and silent.
//
//  The fix points each at the APPROVED canonical field rather than restating
//  the sentence in COPY — the disclosure cannot drift from the published rate
//  if there is only one copy of it:
//
//    TRANSPORTATION_MILEAGE.note / .note_es
//    LABOR_ONLY.timing.betweenAddressesNote / _es
//
//  These tests drive the real page in a real DOM and assert the rendered text
//  IS that canonical string. A future edit that reintroduces a duplicate, or
//  reaches for an undefined key again, fails here.
//
//  Offline: nothing is posted, every asset is served from the SITE checkout.
// ════════════════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { JSDOM, VirtualConsole, ResourceLoader } from 'jsdom'
import { SKIP_WITHOUT_SITE, siteFile } from './site-dir'

const FORM = siteFile('public/booking-form.html')
const MIRROR = siteFile('public/js/pricing-config.js')
const skip = SKIP_WITHOUT_SITE || (existsSync(FORM) && existsSync(MIRROR) ? false : 'WMIWCI-SITE not available')

type Harness = { dom: JSDOM; win: any; doc: Document; errors: string[] }

async function loadForm(): Promise<Harness> {
  const served = (buf: Buffer) => {
    const p = Promise.resolve(buf) as Promise<Buffer> & { abort(): void }
    p.abort = () => {}
    return p
  }
  // Serve the page's REAL sibling scripts off disk. Stubbing them with empty
  // bytes leaves the i18n dictionary undefined, which throws inside the page's
  // own boot code and masks whatever we are trying to observe.
  class LocalAssets extends ResourceLoader {
    fetch(url: string) {
      const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0]
      const onDisk = siteFile('public' + path)
      if (path.endsWith('.js') && onDisk && existsSync(onDisk)) return served(readFileSync(onDisk))
      return served(Buffer.from(''))
    }
  }
  const errors: string[] = []
  const vc = new VirtualConsole()
  vc.on('jsdomError', (e: Error) => errors.push(e.message))

  const dom = new JSDOM(readFileSync(FORM, 'utf8'), {
    runScripts: 'dangerously',
    url: 'https://moveitclearit.com/booking-form.html',
    virtualConsole: vc,
    resources: new LocalAssets(),
    beforeParse(win: any) {
      win.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })
      win.navigator.sendBeacon = () => true
      // jsdom implements neither. Absent, the page's boot code throws before
      // it ever reaches the code under test.
      win.matchMedia = (q: string) => ({
        matches: false,
        media: q,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      })
      win.scrollTo = () => {}
    },
  })
  const win = dom.window as any
  for (let i = 0; i < 30 && !win.WMIC_PRICING; i++) await new Promise((r) => setTimeout(r, 10))
  await new Promise((r) => setTimeout(r, 20))
  return { dom, win, doc: win.document as Document, errors }
}

function check(h: Harness, id: string): HTMLInputElement {
  const el = h.doc.getElementById(id) as HTMLInputElement | null
  assert.ok(el, `#${id} must exist on the form`)
  el.checked = true
  el.dispatchEvent(new h.win.Event('change', { bubbles: true }))
  return el
}

// ── FULL SERVICE ────────────────────────────────────────────────────────
// 1BR and 2BR are the only packages with BOTH an included truck and an
// upgrade path, which is the combination that reached the broken line.
for (const pkg of ['1br', '2br']) {
  test(`booking form: ${pkg} renders the included-truck panel without throwing`, { skip }, async () => {
    const h = await loadForm()
    check(h, `svc_${pkg}`)
    await new Promise((r) => setTimeout(r, 30))

    assert.deepEqual(h.errors, [], `selecting ${pkg} must not raise: ${h.errors.join('; ')}`)

    const box = h.doc.getElementById('fsTruckBox')
    assert.ok(box, 'the included-truck panel must exist')
    const text = (box as HTMLElement).textContent || ''

    assert.match(text, /Included truck/i, `${pkg} must render the included-truck line, got: ${text.slice(0, 140)}`)
    assert.doesNotMatch(text, /undefined|NaN|\[object/i, `${pkg} panel must not leak a broken value: ${text.slice(0, 160)}`)

    // The disclosure is the canonical string, not a restatement of it.
    const canonical = h.win.WMIC_PRICING.TRANSPORTATION_MILEAGE.note as string
    assert.ok(canonical && canonical.length > 40, 'the canonical mileage note must be present in the mirror')
    assert.ok(
      text.includes(canonical),
      `${pkg} must render TRANSPORTATION_MILEAGE.note verbatim.\n  expected: ${canonical.slice(0, 90)}…\n  rendered: ${text.slice(0, 200)}`,
    )
    h.dom.window.close()
  })
}

test('booking form: the upgrade line is priced from the flat amount, not a charge object', { skip }, async () => {
  // A separate earlier fault in the SAME function: it read `up.charge.amount`,
  // but truckUpgradeForPackage() returns a flat shape with no `charge`.
  const h = await loadForm()
  const up = h.win.WMIC_PRICING?.truckUpgradeForPackage?.('1br')
  assert.ok(up, 'truckUpgradeForPackage must be callable from the mirror')
  assert.equal(typeof up.amount, 'number', 'the upgrade exposes a flat numeric amount')
  assert.equal((up as any).charge, undefined, 'there is no nested charge object to read through')
  h.dom.window.close()
})

// ── LABOR ONLY ──────────────────────────────────────────────────────────
test('booking form: labor-only "loading and unloading" renders the between-addresses disclosure', { skip }, async () => {
  // The labor-only twin of the bug above, in renderRoute(). Only
  // `loading_and_unloading` sets twoAddresses, so it is the only service that
  // reaches the line at all.
  const h = await loadForm()
  check(h, 'svctype_labor')
  await new Promise((r) => setTimeout(r, 20))

  const radio = h.doc.querySelector('input[name="laborService"][value="loading_and_unloading"]') as HTMLInputElement | null
  assert.ok(radio, 'the loading-and-unloading option must exist')
  radio.checked = true
  radio.dispatchEvent(new h.win.Event('change', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 20))

  // Drive the render directly: it is what the page calls on every route
  // change, and calling it here removes any dependency on address geocoding.
  assert.equal(typeof h.win.renderRoute, 'function', 'renderRoute must be reachable')
  assert.equal(h.win.isLaborOnly(), true, 'the form must be in labor-only mode')
  assert.equal(h.win.selectedLaborService(), 'loading_and_unloading', 'the two-address service must be selected')
  h.win.renderRoute(null)

  assert.deepEqual(h.errors, [], `labor-only render must not raise: ${h.errors.join('; ')}`)

  const box = h.doc.getElementById('routeBox')
  assert.ok(box, 'the route panel must exist')
  assert.equal((box as HTMLElement).hidden, false, 'a two-address labor job must SHOW the disclosure')

  const text = (box as HTMLElement).textContent || ''
  const canonical = h.win.WMIC_PRICING.LABOR_ONLY.timing.betweenAddressesNote as string
  assert.ok(canonical && canonical.length > 40, 'the canonical between-addresses note must be present in the mirror')
  assert.ok(
    text.includes(canonical),
    `must render LABOR_ONLY.timing.betweenAddressesNote verbatim.\n  expected: ${canonical.slice(0, 90)}…\n  rendered: ${text.slice(0, 200)}`,
  )
  assert.doesNotMatch(text, /undefined|\[object/i, `disclosure must not leak a broken value: ${text.slice(0, 160)}`)
  h.dom.window.close()
})

test('booking form: a ONE-address labor service shows no between-addresses disclosure', { skip }, async () => {
  // The negative half. `loading_only` has twoAddresses:false, so claiming
  // travel time between addresses would be telling the customer about a
  // charge their job cannot incur.
  const h = await loadForm()
  check(h, 'svctype_labor')
  await new Promise((r) => setTimeout(r, 20))

  const radio = h.doc.querySelector('input[name="laborService"][value="loading_only"]') as HTMLInputElement | null
  assert.ok(radio, 'the loading-only option must exist')
  radio.checked = true
  radio.dispatchEvent(new h.win.Event('change', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 20))

  h.win.renderRoute(null)
  assert.deepEqual(h.errors, [], `labor-only render must not raise: ${h.errors.join('; ')}`)

  const box = h.doc.getElementById('routeBox')
  assert.equal((box as HTMLElement).hidden, true, 'a single-address labor job must HIDE the disclosure')
  h.dom.window.close()
})

test('booking form: no page references a COPY key the mirror does not define', { skip }, async () => {
  // The generalisation. Both bugs were a read of a COPY key that exists
  // nowhere; this fails the moment another one appears on any page.
  const mirror = readFileSync(MIRROR, 'utf8')
  const copyAt = mirror.indexOf('"COPY"')
  assert.ok(copyAt > 0, 'the mirror must expose a COPY block')
  const defined = new Set<string>()
  const keyRe = /"(\w+)":\s*\{\s*"en"/g
  const block = mirror.slice(copyAt, copyAt + 8000)
  for (let m = keyRe.exec(block); m; m = keyRe.exec(block)) defined.add(m[1])
  assert.ok(defined.size > 0, 'the COPY block must define at least one key')

  // COMMENTS ARE PROSE, NOT CODE. This test first failed on the comment that
  // documents the very bug it guards — "this read PRICING.COPY.
  // full_service_mileage_short, a key that exists in NEITHER repository". A
  // guard that cannot tell an explanation from a reference punishes writing the
  // explanation down, so the scan strips comments first. Line comments are only
  // stripped at the start of a line, so a `https://` inside a string survives.
  const stripComments = (src: string): string =>
    src
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ 	]*\/\/.*$/gm, '')

  const pages = ['public/booking-form.html', 'public/quote.html', 'public/pricing.html', 'public/services.html']
  const undefinedRefs: string[] = []
  for (const rel of pages) {
    const file = siteFile(rel)
    if (!file || !existsSync(file)) continue
    const html = stripComments(readFileSync(file, 'utf8'))
    const refRe = /PRICING\.COPY\.(\w+)/g
    for (let m = refRe.exec(html); m; m = refRe.exec(html)) {
      if (!defined.has(m[1])) undefinedRefs.push(`${rel} -> PRICING.COPY.${m[1]}`)
    }
  }
  assert.deepEqual(undefinedRefs, [], 'these pages read COPY keys the mirror does not define:\n  ' + undefinedRefs.join('\n  '))
})
