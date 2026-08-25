// ════════════════════════════════════════════════════════════════════════
//  lead-consent-site-contract.test.ts — what the REAL forms send, from the
//  real pages, in a real DOM.
//
//  WHY THIS EXISTS. The server side of the marketing-consent rule was already
//  correct: consent.decideConsent() rule 4 records `false` as "presented and
//  declined" and refuses to let it revoke an earlier opt-in. It was NEVER
//  REACHED, because every capture surface gated on `dataset.touched` — a
//  CLICK — so a checkbox that was displayed and left alone sent nothing, the
//  column stayed null, and the owner's card said "Marketing: not asked" about
//  a customer who had been asked.
//
//  A server-side test could not see that: the server behaved perfectly on the
//  input it never received. The only way to prove it is to drive the page.
//
//  It also pins the FORM CONTRACT registry in lead-state.ts against the real
//  markup — that registry is the ONLY thing licensed to claim a surface does
//  not ask a question, so a checkbox removed from the HTML must not be able to
//  leave a stale "we ask this" claim behind in the API.
//
//  Offline: fetch and sendBeacon are stubbed; nothing leaves the machine.
//  All data is SYNTHETIC.
// ════════════════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { JSDOM, VirtualConsole, ResourceLoader } from 'jsdom'
import { FORM_CONTRACTS } from '../lead-state'
import { SKIP_WITHOUT_SITE, siteFile } from './site-dir'

const FORM = siteFile('public/booking-form.html')
const QUOTE = siteFile('public/quote.html')
const CONTACT = siteFile('public/contact.html')
const MIRROR = siteFile('public/js/pricing-config.js')

const skip = SKIP_WITHOUT_SITE || (existsSync(FORM) && existsSync(MIRROR) ? false : 'WMIWCI-SITE not available')

type Harness = { doc: Document; win: any; posted: any[] }

/** Load a page with its scripts running, recording every lead POST. */
async function load(path: string, endpoint: RegExp): Promise<Harness> {
  const html = readFileSync(path, 'utf8')
  const mirror = existsSync(MIRROR) ? readFileSync(MIRROR) : Buffer.from('')
  const posted: any[] = []

  const served = (buf: Buffer) => {
    const p = Promise.resolve(buf) as Promise<Buffer> & { abort(): void }
    p.abort = () => {}
    return p
  }
  class LocalAssets extends ResourceLoader {
    fetch(url: string) {
      return served(/\/js\/pricing-config\.js/.test(url) ? mirror : Buffer.from(''))
    }
  }

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://moveitclearit.com/',
    virtualConsole: new VirtualConsole(),
    resources: new LocalAssets(),
    beforeParse(win: any) {
      const record = (url: unknown, body: unknown) => {
        if (endpoint.test(String(url)) && typeof body === 'string') {
          try { posted.push(JSON.parse(body)) } catch { /* not our payload */ }
        }
      }
      win.fetch = async (url: string, init?: any) => {
        record(url, init?.body)
        return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '{}' }
      }
      win.navigator.sendBeacon = (url: string, blob: any) => {
        record(url, blob?._text)
        return true
      }
    },
  })

  const win = dom.window as any
  await new Promise((r) => setTimeout(r, 40))
  return { doc: win.document, win, posted }
}

const lastPost = (h: Harness) => h.posted[h.posted.length - 1]

/** Type a valid email and blur — the booking form's primary capture trigger. */
async function triggerBookingCapture(h: Harness): Promise<void> {
  const email = h.doc.getElementById('email') as HTMLInputElement
  assert.ok(email, 'the booking form must have an email field')
  email.value = 'test.customer@example.com'
  email.dispatchEvent(new h.win.Event('blur', { bubbles: true }))
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5))
}

// ══════════════════════════════════════════════════════════════════════
//  BOOKING FORM — the surface that produced the incident
// ══════════════════════════════════════════════════════════════════════

test('booking form: the marketing checkbox IS on the contact step', { skip }, async () => {
  //  This is the whole reason "not asked" was a lie. If this ever stops being
  //  true, the FORM_CONTRACTS entry below is wrong and must change with it.
  const h = await load(FORM, /\/api\/leads\/partial/)
  const box = h.doc.getElementById('emailOptIn')
  assert.ok(box, 'the booking form must present a marketing checkbox')
  const card = box!.closest('.card')
  assert.equal(card?.id, 'card1', 'and it must be on the step that creates the lead')
  assert.equal((box as HTMLInputElement).checked, false, 'it renders unchecked, so silence is a decline')
})

test('THE FIX: a displayed, unchecked box sends FALSE — not nothing', { skip }, async () => {
  const h = await load(FORM, /\/api\/leads\/partial/)
  await triggerBookingCapture(h)

  assert.ok(h.posted.length > 0, 'entering an email must capture a partial lead')
  const body = lastPost(h)

  //  THE REGRESSION THIS PINS. Before the fix this key was absent, the column
  //  stayed null, and the owner card read "Marketing: not asked".
  assert.equal(body.marketingConsent, false, 'an unchecked box that was SHOWN is a decline')
  assert.equal(body.marketingConsentPresented, true, 'and the form says it asked')
  assert.ok('marketingConsent' in body, 'the key must be present, not dropped by JSON.stringify')
})

test('booking form: ticking the box still sends true', { skip }, async () => {
  const h = await load(FORM, /\/api\/leads\/partial/)
  const box = h.doc.getElementById('emailOptIn') as HTMLInputElement
  box.checked = true
  box.dispatchEvent(new h.win.Event('change', { bubbles: true }))
  await triggerBookingCapture(h)

  const body = lastPost(h)
  assert.equal(body.marketingConsent, true)
  assert.equal(body.marketingConsentPresented, true)
  //  The disclosure version travels with it, or the consent proves nothing later.
  assert.ok(body.consentVersion, 'a consent record needs the wording that was shown')
})

test('booking form: the source question is NOT claimed at the contact step', { skip }, async () => {
  const h = await load(FORM, /\/api\/leads\/partial/)
  await triggerBookingCapture(h)
  const body = lastPost(h)

  //  "How did you hear about us?" is on card4. A contact-step capture must say
  //  "not reached", and must not send an answer the customer has not given.
  assert.equal(body.foundUsPresented, false, 'the customer has not reached that step')
  assert.equal(body.foundUs, undefined, 'and no answer may be invented for them')
})

test('booking form: the source question lives AFTER the addresses, as the contract says', { skip }, async () => {
  const h = await load(FORM, /\/api\/leads\/partial/)
  const found = h.doc.getElementById('foundUs')
  assert.ok(found, 'the booking form must ask how they heard about us')
  const card = found!.closest('.card')
  assert.equal(card?.id, 'card4', 'on the Addresses & Access step')

  //  And the addresses really are collected there too, so a contact-step lead
  //  genuinely cannot be routed yet.
  assert.ok(h.doc.getElementById('addressFrom'), 'pickup address is on the same later step')
  assert.ok(h.doc.getElementById('addressTo'), 'destination address is on the same later step')
})

test('booking form: one lead per session — a re-trigger does not fork the lead', { skip }, async () => {
  const h = await load(FORM, /\/api\/leads\/partial/)
  await triggerBookingCapture(h)
  await triggerBookingCapture(h)

  const ids = new Set(h.posted.map((b) => b.bookingSessionId).filter(Boolean))
  assert.equal(ids.size, 1, 'every send must carry the SAME session id, so the server merges')
})

// ══════════════════════════════════════════════════════════════════════
//  THE OTHER SURFACES — same pathology, same fix
// ══════════════════════════════════════════════════════════════════════

test('quick quote: a displayed, unchecked box sends false', { skip }, async () => {
  if (!existsSync(QUOTE)) return
  const h = await load(QUOTE, /\/api\/leads\/quote-capture/)
  const box = h.doc.getElementById('qOptIn')
  assert.ok(box, 'quote.html must present a marketing checkbox')

  //  Read the rule off the page rather than driving its whole multi-step flow:
  //  what matters is that the CLICK gate is gone.
  const src = readFileSync(QUOTE, 'utf8')
  assert.doesNotMatch(
    src,
    /qOptIn'\)[\s\S]{0,200}dataset\.touched/,
    'the quick quote must not require a CLICK before it will record a decline',
  )
  assert.match(src, /marketingConsentPresented/, 'and it must report whether it asked')
})

test('contact form: a displayed, unchecked box sends false', { skip }, async () => {
  if (!existsSync(CONTACT)) return
  const src = readFileSync(CONTACT, 'utf8')
  assert.match(src, /msg-optin/, 'contact.html presents a marketing checkbox')
  assert.doesNotMatch(
    src,
    /msg-optin[\s\S]{0,300}dataset\.touched/,
    'the contact form must not require a CLICK before it will record a decline',
  )
  assert.match(src, /marketingConsentPresented/, 'and it must report whether it asked')
})

test('no lead-producing surface still gates a decline on a CLICK', { skip }, async () => {
  //  A blanket sweep, so a fourth form cannot quietly reintroduce the bug.
  for (const [name, path] of [['booking-form', FORM], ['quote', QUOTE], ['contact', CONTACT]] as const) {
    if (!existsSync(path)) continue
    const src = readFileSync(path, 'utf8')
    assert.doesNotMatch(
      src,
      /dataset\.touched === '1'\s*\)\s*\?\s*false\s*:\s*undefined/,
      `${name} still treats an untouched checkbox as "never asked"`,
    )
  }
})

// ══════════════════════════════════════════════════════════════════════
//  THE FORM CONTRACT REGISTRY vs THE REAL MARKUP
// ══════════════════════════════════════════════════════════════════════

test('FORM_CONTRACTS matches what booking-form.html actually asks', { skip }, async () => {
  const h = await load(FORM, /\/api\/leads\/partial/)
  const contract = FORM_CONTRACTS.BOOKING_FORM
  assert.ok(contract, 'the booking form must have a registered contract')

  assert.equal(
    contract.presentsMarketingConsent,
    !!h.doc.getElementById('emailOptIn'),
    'the registry must agree with the markup about the marketing checkbox',
  )
  assert.equal(
    contract.presentsSelfReportedSource,
    !!h.doc.getElementById('foundUs'),
    'the registry must agree with the markup about the source question',
  )
  assert.equal(
    contract.selfReportedSourceStep,
    h.doc.getElementById('foundUs')?.closest('.card')?.id,
    'and about WHICH step carries it — that is what proves "not reached"',
  )
  assert.equal(
    contract.marketingConsentStep,
    h.doc.getElementById('emailOptIn')?.closest('.card')?.id,
  )

  //  The declared step order must be the real one. It is not positional
  //  (cardsvc is step 1, card1 is step 2), so it cannot be computed.
  const realOrder = Array.from(h.doc.querySelectorAll('.card')).map((c) => c.id).filter(Boolean)
  assert.deepEqual(
    contract.steps,
    realOrder,
    'the contract step order must match the cards on the page, in order',
  )
})

test('FORM_CONTRACTS does not claim the quick quote asks how they heard', { skip }, async () => {
  if (!existsSync(QUOTE)) return
  const src = readFileSync(QUOTE, 'utf8')
  assert.equal(
    FORM_CONTRACTS.QUICK_QUOTE_FORM.presentsSelfReportedSource,
    /id="foundUs"/.test(src),
    'a surface may only be recorded as "does not ask" while that is actually true',
  )
})
