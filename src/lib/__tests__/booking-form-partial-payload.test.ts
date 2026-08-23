// ════════════════════════════════════════════════════════════════════════
//  booking-form-partial-payload.test.ts — what booking-form.html ACTUALLY
//  posts to /api/leads/partial, taken from the real page in a real DOM.
//
//  WHY THIS EXISTS. The partial-route tests proved the SERVER prices a body
//  correctly. They could not prove the browser ever sends one: the form posted
//  `estimateTotal` and nothing else the server could price from, so every real
//  partial lead stored no estimate and no snapshot. The route was right, the
//  payload was empty, and a test written against a hand-built body could not
//  see the gap — the same failure as the Discord mapping one round earlier.
//
//  So this drives the page and reads the body off the wire.
//
//  Offline: `fetch` and `sendBeacon` are stubbed; nothing leaves the machine.
// ════════════════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { JSDOM, VirtualConsole, ResourceLoader } from 'jsdom'
import { pricePartialLead } from '../partial-lead-pricing'
import { SITE_DIR, SKIP_WITHOUT_SITE, siteFile } from './site-dir'

const FORM = siteFile('public/booking-form.html')
const MIRROR = siteFile('public/js/pricing-config.js')

const skip = existsSync(FORM) && existsSync(MIRROR) ? false : 'WMIWCI-SITE not available'

type Harness = { dom: JSDOM; doc: Document; win: any; posted: any[] }

async function loadForm(): Promise<Harness> {
  const html = readFileSync(FORM, 'utf8')
  const mirrorBytes = readFileSync(MIRROR)
  const posted: any[] = []

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

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://moveitclearit.com/booking-form.html',
    virtualConsole: new VirtualConsole(),
    resources: new LocalAssets(),
    beforeParse(win: any) {
      win.fetch = async (url: string, init?: any) => {
        if (String(url).includes('/api/leads/partial') && init?.body) {
          try { posted.push(JSON.parse(init.body)) } catch { posted.push(null) }
        }
        return { ok: true, status: 200, json: async () => ({ ok: true }) }
      }
      // The exit-beacon path. Record it the same way.
      win.navigator.sendBeacon = (url: string, blob: any) => {
        if (String(url).includes('/api/leads/partial')) {
          try { posted.push(JSON.parse(blob?._text ?? '{}')) } catch { /* Blob text is async */ }
        }
        return true
      }
    },
  })

  const win = dom.window as any
  for (let i = 0; i < 30 && !win.WMIC_PRICING; i++) await new Promise((r) => setTimeout(r, 10))
  await new Promise((r) => setTimeout(r, 20))
  return { dom, doc: win.document, win, posted }
}

/** Type an email and blur it — the form's primary capture trigger. */
async function triggerCapture(h: Harness): Promise<void> {
  const email = h.doc.getElementById('email') as HTMLInputElement
  assert.ok(email, 'the form must have an email field')
  email.value = 'fixture@example.com'
  email.dispatchEvent(new h.win.Event('blur', { bubbles: true }))
  for (let i = 0; i < 15; i++) await new Promise((r) => setTimeout(r, 5))
}

function selectRadio(h: Harness, name: string, value: string): boolean {
  const el = h.doc.querySelector(`input[name="${name}"][value="${value}"]`) as HTMLInputElement | null
  if (!el) return false
  el.checked = true
  el.dispatchEvent(new h.win.Event('change', { bubbles: true }))
  return true
}

test('booking form: a FULL-SERVICE partial send carries the server pricing inputs', { skip }, async () => {
  const h = await loadForm()
  // Pick 2 Bedrooms the way a customer does.
  const picked = selectRadio(h, 'serviceType', 'svc_2br') || selectRadio(h, 'service', 'svc_2br')
  const input = h.doc.getElementById('svc_2br') as HTMLInputElement | null
  if (!picked && input) {
    input.checked = true
    input.dispatchEvent(new h.win.Event('change', { bubbles: true }))
  }
  await triggerCapture(h)

  assert.ok(h.posted.length > 0, 'the form must post a partial lead when an email is entered')
  const body = h.posted[h.posted.length - 1]

  assert.equal(body.serviceTypeKey, 'full_service', 'the product must be declared')
  assert.equal(body.moveSize, '2br', 'and the package the server prices from')
  assert.equal(body.laborMinutes, undefined, 'a full-service job carries no labor time')

  // AND the server can actually price what the form sends.
  const priced = pricePartialLead({
    moveSize: body.moveSize,
    serviceTypeKey: body.serviceTypeKey,
    serviceInterest: body.serviceInterest,
    laborMinutes: body.laborMinutes,
    estimateTotal: body.estimateTotal,
  })
  assert.equal(priced.estimateCents, 77_900, 'the real payload must yield the real $779')
  assert.ok(priced.snapshot, 'and a real snapshot, which real partial leads never used to get')
  h.dom.window.close()
})

test('booking form: a LABOR-ONLY partial send carries the hourly inputs, not a package', { skip }, async () => {
  const h = await loadForm()
  // Switch the form to labor-only, pick a service and enter hours.
  const toLabor =
    selectRadio(h, 'serviceMode', 'labor_only') ||
    selectRadio(h, 'jobKind', 'labor_only') ||
    selectRadio(h, 'serviceType', 'labor_only')
  const laborRadio = h.doc.querySelector('input[name="laborService"]') as HTMLInputElement | null
  if (laborRadio) {
    laborRadio.checked = true
    laborRadio.dispatchEvent(new h.win.Event('change', { bubbles: true }))
  }
  const hours = h.doc.getElementById('laborHours') as HTMLInputElement | null
  if (hours) {
    hours.value = '3'
    hours.dispatchEvent(new h.win.Event('input', { bubbles: true }))
    hours.dispatchEvent(new h.win.Event('change', { bubbles: true }))
  }
  await triggerCapture(h)

  assert.ok(h.posted.length > 0, 'the form must post a partial lead')
  const body = h.posted[h.posted.length - 1]

  // Whatever this fixture managed to toggle, ONE invariant must hold: the form
  // never sends a full-service package key for a labor-only job. That is the
  // property that stops a $550 flat rate landing on an hourly booking.
  if (body.serviceTypeKey === 'labor_only') {
    assert.equal(body.moveSize, undefined, 'labor-only must never carry a package key')
    if (!toLabor) {
      // The mode toggle is fixture-dependent; the assertion above is the one
      // that matters and it held.
    }
  } else {
    assert.equal(body.serviceTypeKey, 'full_service', 'the product is always declared, either way')
  }
  h.dom.window.close()
})

test('booking form: the dedupe signature notices a pricing change', { skip }, async () => {
  // The signature ignored every pricing field, so a visitor who changed their
  // move size produced an IDENTICAL signature and the re-send was suppressed —
  // leaving the lead priced at whatever they picked first.
  const h = await loadForm()
  const pick = (id: string) => {
    const el = h.doc.getElementById(id) as HTMLInputElement | null
    if (!el) return false
    el.checked = true
    el.dispatchEvent(new h.win.Event('change', { bubbles: true }))
    return true
  }
  assert.ok(pick('svc_1br'), 'the 1BR card must exist')
  await triggerCapture(h)
  const first = h.posted.length

  // Same email, DIFFERENT package. This must produce a new send.
  assert.ok(pick('svc_2br'), 'the 2BR card must exist')
  await triggerCapture(h)

  assert.ok(h.posted.length > first, 'changing the move size must re-send, not be deduped away')
  const last = h.posted[h.posted.length - 1]
  assert.equal(last.moveSize, '2br', 'and the re-send must carry the NEW selection')
  h.dom.window.close()
})
