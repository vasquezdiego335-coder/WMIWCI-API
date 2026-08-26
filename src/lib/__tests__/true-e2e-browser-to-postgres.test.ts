// ════════════════════════════════════════════════════════════════════════
//  true-e2e-browser-to-postgres.test.ts
//
//  THE ONE THING V2 DID NOT PROVE.
//
//  V2 reported a "staging end-to-end" run and concluded that an abandoned
//  booking-form lead could gain ZIPs and an individual scan id. It could not:
//  the V2 harness BUILT the request by hand and supplied pickupZip,
//  destinationZip and attributionId itself. The real page sent none of them on
//  a partial capture. So V2 proved
//
//      hand-built request -> API -> PostgreSQL
//
//  and reported it as
//
//      real booking-form.html -> API -> PostgreSQL.
//
//  This test closes that gap and refuses to reopen it. The ONLY input to the
//  API is the JSON the real page put on the wire, captured verbatim from the
//  page's own fetch/sendBeacon call and passed through UNCHANGED. There is no
//  place in this file where a field can be added to the request after it
//  leaves the browser — `freeze()` below makes that a runtime error, not a
//  convention.
//
//  REAL at every hop: real HTML, real page JavaScript in a real DOM, real Zod
//  schema, real route handler, real capturePartialLead, real Prisma client,
//  real PostgreSQL. Synthetic data only.
// ════════════════════════════════════════════════════════════════════════
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { JSDOM, VirtualConsole, ResourceLoader } from 'jsdom'
import { PrismaClient } from '@prisma/client'
import { SKIP_WITHOUT_SITE, siteFile } from './site-dir'
import { formatLeadAlert, toLeadAlertInput } from '../lead-alert'

const FORM = siteFile('public/booking-form.html')
const MIRROR = siteFile('public/js/pricing-config.js')
const skip =
  SKIP_WITHOUT_SITE ||
  (!process.env.DATABASE_URL ? 'set DATABASE_URL to a disposable PostgreSQL' : false) ||
  (existsSync(FORM) ? false : 'WMIWCI-SITE not available')

const AID = 'ab12cd34ef56ab78cd90ef12ab34cd56'
const EMAIL = 'test.customer@example.com'

let prisma: PrismaClient
let POST: (req: Request) => Promise<Response>

before(async () => {
  if (skip) return
  process.env.PARTIAL_BOOKING_EMAIL_CAPTURE_ENABLED = 'true'
  prisma = new PrismaClient()
  await prisma.$connect()
  ;({ POST } = (await import('../../../app/api/leads/partial/route')) as never)
})
after(async () => {
  if (skip) return
  await prisma.$disconnect()
  //  The outbox wiring opens the real discord queue; close it or the test
  //  process never exits.
  try {
    const { discordQueue } = await import('../queues')
    await (discordQueue as unknown as { close: () => Promise<void> }).close()
  } catch { /* queue was never opened */ }
})
beforeEach(async () => {
  if (skip) return
  //  SCOPED — parallel suites share this database.
  const mine = await prisma.lead.findMany({ where: { email: EMAIL }, select: { id: true } })
  if (mine.length) await prisma.leadNotification.deleteMany({ where: { leadId: { in: mine.map((m) => m.id) } } })
  await prisma.lead.deleteMany({ where: { email: EMAIL } })
})

/**
 * Deep-freeze the captured body.
 *
 * This is the guarantee of the whole file: once a payload has left the page it
 * is immutable, so no later line can quietly add the very fields whose absence
 * was the bug. An attempt to do so throws rather than passing silently.
 */
function freeze<T>(o: T): T {
  if (o && typeof o === 'object') Object.values(o as object).forEach(freeze)
  return Object.freeze(o)
}

type Browser = { doc: Document; win: any; bodies: any[] }

/** The real page, on a URL that carries a real door-hanger scan. */
async function openScannedForm(): Promise<Browser> {
  const html = readFileSync(FORM, 'utf8')
  const mirror = existsSync(MIRROR) ? readFileSync(MIRROR) : Buffer.from('')
  const bodies: any[] = []
  const served = (b: Buffer) => {
    const p = Promise.resolve(b) as Promise<Buffer> & { abort(): void }
    p.abort = () => {}
    return p
  }
  class LocalAssets extends ResourceLoader {
    fetch(url: string) {
      return served(/\/js\/pricing-config\.js/.test(url) ? mirror : Buffer.from(''))
    }
  }
  const record = (url: unknown, body: unknown) => {
    if (/\/api\/leads\/partial/.test(String(url)) && typeof body === 'string') {
      try { bodies.push(freeze(JSON.parse(body))) } catch { /* not our payload */ }
    }
  }
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: `https://moveitclearit.com/booking-form.html?aid=${AID}&src=door_hanger_5000_batch`,
    virtualConsole: new VirtualConsole(),
    resources: new LocalAssets(),
    beforeParse(win: any) {
      win.fetch = async (url: string, init?: any) => {
        record(url, init?.body)
        return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '{}' }
      }
      win.navigator.sendBeacon = (url: string, blob: any) => {
        //  JSDOM's Blob has no `_text`; read it properly or every exit-beacon
        //  body — which is how card-4 enrichment leaves the page — is dropped.
        if (blob && typeof blob.text === 'function') blob.text().then((t: string) => record(url, t)).catch(() => {})
        else record(url, blob?._text)
        return true
      }
    },
  })
  const win = dom.window as any
  await new Promise((r) => setTimeout(r, 60))
  return { doc: win.document, win, bodies }
}

/** Hand the browser's OWN body to the real route. Nothing is added here. */
async function deliverToApi(body: unknown): Promise<{ status: number; json: any }> {
  const res = await POST(
    new Request('https://api.example.com/api/leads/partial', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', origin: 'https://moveitclearit.com' },
      //  The captured object, serialised as-is. No spread, no defaults.
      body: JSON.stringify(body),
    }) as never,
  )
  return { status: res.status, json: JSON.parse(await res.text()) }
}

const setField = (b: Browser, id: string, value: string) => {
  const el = b.doc.getElementById(id) as HTMLInputElement | HTMLSelectElement | null
  assert.ok(el, `the real form must have #${id}`)
  ;(el as HTMLInputElement).value = value
  el!.dispatchEvent(new b.win.Event('input', { bubbles: true }))
  el!.dispatchEvent(new b.win.Event('change', { bubbles: true }))
}

test('TRUE E2E: real page -> real API -> real PostgreSQL, contact step then card-4', { skip }, async () => {
  const b = await openScannedForm()

  // ── 0. Pick a service, the way a customer does. Without a priced service
  //       there is no quote snapshot and the card can say nothing about the
  //       drive — which is correct, but it is not the scenario under test.
  const svc = b.doc.getElementById('svc_1br') as HTMLInputElement | null
  assert.ok(svc, 'the real form must offer the 1-Bedroom package')
  svc!.checked = true
  svc!.dispatchEvent(new b.win.Event('change', { bubbles: true }))
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 5))

  // ── 1. CONTACT STEP. Email entered, marketing box left visibly unchecked ──
  setField(b, 'email', EMAIL)
  ;(b.doc.getElementById('email') as HTMLInputElement).dispatchEvent(new b.win.Event('blur', { bubbles: true }))
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 5))

  assert.ok(b.bodies.length > 0, 'the real page must capture a partial lead on the contact step')
  const first = b.bodies[b.bodies.length - 1]
  console.log('\n[BROWSER BODY 1 — contact step]\n' + JSON.stringify(first, null, 2))

  //  Proof the evidence came from the PAGE, before the API ever sees it.
  assert.equal(first.marketingConsent, false, 'a displayed, unchecked box is a decline')
  assert.equal(first.marketingConsentPresented, true)
  assert.equal(first.attributionId, AID, 'the scan id rides the FIRST capture')
  assert.equal(first.foundUsPresented, false, 'the source question is not reached yet')
  assert.equal(first.pickupZip, undefined, 'and no address may be claimed yet')
  assert.equal(first.destinationZip, undefined)

  const r1 = await deliverToApi(first)
  assert.equal(r1.status, 200)
  assert.equal(r1.json.captured, true)
  assert.equal(r1.json.isNew, true)

  const afterFirst = await prisma.lead.findFirst({ where: { email: EMAIL } })
  assert.ok(afterFirst, 'the row must exist in PostgreSQL')
  const leadId = afterFirst!.id
  assert.equal(afterFirst!.emailMarketingConsent, false, 'stored as Not opted in')
  assert.equal(afterFirst!.marketingConsentPrompted, true)
  assert.equal(afterFirst!.attributionId, AID, 'the individual scan is stored')
  assert.equal(afterFirst!.foundUsPrompted, false)
  assert.equal(afterFirst!.pickupAddressComplete, null, 'the address step was never reached')
  assert.equal(afterFirst!.destinationAddressComplete, null)

  //  The owner-facing view model, read back from the stored row.
  const card1 = formatLeadAlert(toLeadAlertInput(afterFirst as never))
  const text1 = [card1.title, ...card1.lines.map((l) => l.message)].join('\n')
  console.log('\n[OWNER CARD 1]\n' + text1)
  assert.match(text1, /Marketing email: Not opted in/)
  assert.match(text1, /Customer-reported source: Not reached yet/)
  assert.match(text1, /awaiting pickup and destination addresses/i)
  assert.match(text1, /Door hanger/, 'the scan is attributed')
  assert.doesNotMatch(text1, /\bOTHER\b/)

  // ── 2. CARD 4. Addresses and the source answer, entered on the real page ──
  setField(b, 'addressFrom', '12 Example Street, West Orange')
  setField(b, 'pu_zip', '07052')
  setField(b, 'pu_state', 'NJ')
  setField(b, 'addressTo', '9 Sample Avenue, Hoboken')
  setField(b, 'do_zip', '07030')
  setField(b, 'do_state', 'NJ')
  const found = b.doc.getElementById('foundUs') as HTMLSelectElement
  found.value = found.options[found.options.length - 1]?.value || 'Other'
  found.dispatchEvent(new b.win.Event('change', { bubbles: true }))

  const cont = b.doc.querySelector('.btn-continue') as HTMLElement | null
  if (cont) cont.dispatchEvent(new b.win.MouseEvent('click', { bubbles: true }))
  for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 5))
  b.win.dispatchEvent(new b.win.Event('pagehide'))
  for (let i = 0; i < 60; i++) await new Promise((r) => setTimeout(r, 5))

  const enriched = b.bodies.filter((x) => x && x.pickupZip)
  assert.ok(enriched.length > 0, 'the real page must send the address evidence')
  const second = enriched[enriched.length - 1]
  console.log('\n[BROWSER BODY 2 — card 4]\n' + JSON.stringify(second, null, 2))

  assert.equal(second.pickupZip, '07052')
  assert.equal(second.destinationZip, '07030')
  assert.equal(second.pickupAddressPresent, true)
  assert.equal(second.destinationAddressPresent, true)
  assert.ok(second.foundUs, 'and the customer-reported answer')
  assert.equal(second.attributionId, AID, 'first-touch attribution still rides along')
  assert.equal(second.bookingSessionId, first.bookingSessionId, 'the SAME session — one lead')

  const r2 = await deliverToApi(second)
  assert.equal(r2.status, 200)
  assert.equal(r2.json.isNew, false, 'this must MERGE, not create a second lead')

  // ── 3. THE SAME ROW, ENRICHED ──────────────────────────────────────────
  const all = await prisma.lead.findMany({ where: { email: EMAIL } })
  assert.equal(all.length, 1, 'one customer, one lead row')
  const afterSecond = all[0]
  assert.equal(afterSecond.id, leadId, 'the SAME row was enriched')
  assert.equal(afterSecond.originZip, '07052', 'the pickup end reached PostgreSQL')
  assert.equal(afterSecond.destinationZip, '07030')
  assert.equal(afterSecond.pickupAddressComplete, true, 'derived server-side from ZIP + state + street flag')
  assert.equal(afterSecond.destinationAddressComplete, true)
  assert.ok(afterSecond.foundUs, 'the customer-reported source is stored')
  assert.equal(afterSecond.foundUsPrompted, true)
  assert.equal(afterSecond.attributionId, AID, 'first-touch attribution was not overwritten')
  assert.equal(afterSecond.emailMarketingConsent, false, 'the decline still stands')
  assert.notEqual(afterSecond.lifecycle, null)

  //  Tracked acquisition and the customer's own answer stayed SEPARATE.
  const card2 = formatLeadAlert(toLeadAlertInput(afterSecond as never))
  const text2 = [card2.title, ...card2.lines.map((l) => l.message)].join('\n')
  console.log('\n[OWNER CARD 2]\n' + text2 + '\n')
  const acq = /Tracked acquisition: (.*)/.exec(text2)?.[1] ?? ''
  const self = /Customer-reported source: (.*)/.exec(text2)?.[1] ?? ''
  assert.match(acq, /Door hanger/)
  assert.notEqual(acq, self, 'our tracking and their answer are two different facts')
  assert.match(text2, /07052 → 07030/, 'the move now has two ends')
  assert.doesNotMatch(text2, /\bOTHER\b/)
})

test('TRUE E2E: repeated real triggers do not fork the lead', { skip }, async () => {
  const b = await openScannedForm()
  setField(b, 'email', EMAIL)
  const el = b.doc.getElementById('email') as HTMLInputElement
  for (let i = 0; i < 5; i++) {
    el.dispatchEvent(new b.win.Event('blur', { bubbles: true }))
    for (let j = 0; j < 12; j++) await new Promise((r) => setTimeout(r, 5))
  }
  assert.ok(b.bodies.length > 0)
  //  Every captured body goes to the API, exactly as the page produced it.
  for (const body of b.bodies) await deliverToApi(body)
  const rows = await prisma.lead.findMany({ where: { email: EMAIL } })
  assert.equal(rows.length, 1, 'five real triggers, one lead')
})
