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

test('booking form: the contact step shows the email NOTICE and an unticked opt-out box — no opt-in checkbox', { skip }, async () => {
  //  EMAIL CONSENT RELEASE 2026-09-16: the opt-in checkbox is gone. If this
  //  ever stops being true, the FORM_CONTRACTS entry below must change with it.
  const h = await load(FORM, /\/api\/leads\/partial/)
  assert.equal(h.doc.getElementById('emailOptIn'), null, 'no opt-in checkbox remains')
  const notice = h.doc.getElementById('emailNoticeBlock')
  assert.ok(notice, 'the booking form must show the email notice')
  assert.equal(notice!.closest('.card')?.id, 'card1', 'on the step that creates the lead')
  assert.equal(notice!.getAttribute('data-notice-version'), 'booking-2026-09-16-r2')
  const optOut = h.doc.getElementById('emailOptOut') as HTMLInputElement | null
  assert.ok(optOut, 'the opt-out box is on the same step')
  assert.equal(optOut!.checked, false, 'and it renders unticked')
})

test('booking form: a background capture sends the opt-out state and typed flag — never a consent claim or a notice', { skip }, async () => {
  const h = await load(FORM, /\/api\/leads\/partial/)
  await triggerBookingCapture(h)

  assert.ok(h.posted.length > 0, 'entering an email must capture a partial lead')
  const body = lastPost(h)
  //  A blur is not the Continue click: it may save the lead, but it can never
  //  carry the notice (so it can never start marketing) and never claims consent.
  assert.equal(body.marketingNotice, undefined, 'only the Continue click carries the notice')
  assert.equal('marketingConsent' in body, false, 'no checkbox, so no consent claim')
  assert.equal(body.emailMarketingOptOut, false, 'the unticked opt-out box is sent explicitly')
  assert.equal(typeof body.emailUserTyped, 'boolean', 'and whether the address was typed on this page load')
})

test('booking form: ticking the opt-out box is sent on the next capture', { skip }, async () => {
  const h = await load(FORM, /\/api\/leads\/partial/)
  const box = h.doc.getElementById('emailOptOut') as HTMLInputElement
  box.checked = true
  box.dispatchEvent(new h.win.Event('change', { bubbles: true }))
  await triggerBookingCapture(h)

  const body = lastPost(h)
  assert.equal(body.emailMarketingOptOut, true, 'an opt-out is honoured on ANY capture, not only Continue')
  assert.equal('marketingConsent' in body, false)
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

test('quick quote: the email notice and an unticked opt-out box, no opt-in checkbox', { skip }, async () => {
  if (!existsSync(QUOTE)) return
  const h = await load(QUOTE, /\/api\/leads\/quote-capture/)
  assert.equal(h.doc.getElementById('qOptIn'), null, 'no opt-in checkbox remains')
  const notice = h.doc.getElementById('qEmailNoticeBlock')
  assert.ok(notice, 'quote.html must show the email notice')
  assert.equal(notice!.getAttribute('data-notice-version'), 'quote-2026-09-16-r2')
  const optOut = h.doc.getElementById('qEmailOptOut') as HTMLInputElement | null
  assert.ok(optOut && optOut.checked === false, 'with an unticked opt-out box')
  //  Read the payload rule off the page rather than driving its multi-step flow.
  const src = readFileSync(QUOTE, 'utf8')
  assert.match(src, /marketingNotice/, 'the submit carries the notice it showed')
  assert.match(src, /emailMarketingOptOut/, 'and the opt-out box state')
  assert.doesNotMatch(src, /marketingConsent\s*:/, 'and never a consent claim')
})

test('contact form: the email notice and an unticked opt-out box, no opt-in checkbox', { skip }, async () => {
  if (!existsSync(CONTACT)) return
  const src = readFileSync(CONTACT, 'utf8')
  assert.doesNotMatch(src, /id="msg-optin"/, 'no opt-in checkbox remains')
  assert.match(src, /id="msg-notice-block"[^>]*data-notice-version="contact-2026-09-16-r2"/, 'contact.html shows the email notice')
  assert.match(src, /<input type="checkbox" id="msg-optout"(?![^>]*\bchecked\b)[^>]*>/, 'with an unticked opt-out box')
  assert.match(src, /marketingNotice/, 'the submit carries the notice it showed')
  assert.match(src, /emailMarketingOptOut/, 'and the opt-out box state')
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

  //  presentsMarketingConsent = the page ADDRESSES marketing email (the old
  //  checkbox, or the notice that replaced it) — see FORM_CONTRACTS.
  assert.equal(
    contract.presentsMarketingConsent,
    !!h.doc.getElementById('emailOptIn') || !!h.doc.getElementById('emailNoticeBlock'),
    'the registry must agree with the markup about the marketing question',
  )
  assert.equal(
    contract.presentsMarketingNotice === true,
    !!h.doc.getElementById('emailNoticeBlock'),
    'the registry must agree with the markup about the email notice',
  )
  assert.equal(contract.marketingNoticeStep, h.doc.getElementById('emailNoticeBlock')?.closest('.card')?.id)
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
    'no checkbox step is claimed now that the checkbox is gone',
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

// ══════════════════════════════════════════════════════════════════════
//  V3 — THE BROWSER PAYLOAD CONTRACT
//
//  The V2 pass claimed an abandoned booking-form lead could gain ZIPs and an
//  individual scan id. That claim was INVALID: the V2 staging harness supplied
//  `pickupZip`, `destinationZip` and `attributionId` BY HAND. The real page
//  never sent them on the partial capture — `attribution()` returned no aid,
//  `collect()` carried no zips, and `attributionId` was added only to the
//  final /api/bookings payload.
//
//  So V2 proved: hand-built request -> API -> PostgreSQL.
//  It did NOT prove: real booking-form.html -> API -> PostgreSQL.
//
//  These tests read the UNMODIFIED body the real page puts on the wire.
//  Nothing is injected after it leaves the browser.
// ══════════════════════════════════════════════════════════════════════

/** Load the form on a URL carrying a real door-hanger scan, as a scanner sees it. */
async function loadScanned(aid: string, extra = ''): Promise<Harness> {
  const html = readFileSync(FORM, 'utf8')
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
    url: `https://moveitclearit.com/booking-form.html?aid=${aid}&src=door_hanger_5000_batch${extra}`,
    virtualConsole: new VirtualConsole(),
    resources: new LocalAssets(),
    beforeParse(win: any) {
      const record = (url: unknown, body: unknown) => {
        if (/\/api\/leads\/partial/.test(String(url)) && typeof body === 'string') {
          try { posted.push(JSON.parse(body)) } catch { /* not ours */ }
        }
      }
      win.fetch = async (url: string, init?: any) => {
        record(url, init?.body)
        return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '{}' }
      }
      win.navigator.sendBeacon = (url: string, blob: any) => {
        //  JSDOM's Blob exposes no `_text`; read it properly or every
        //  exit-beacon body (which is how card-4 enrichment leaves the page)
        //  is silently dropped and the test proves nothing.
        if (blob && typeof blob.text === 'function') blob.text().then((t: string) => record(url, t)).catch(() => {})
        else record(url, blob?._text)
        return true
      }
    },
  })
  const win = dom.window as any
  await new Promise((r) => setTimeout(r, 40))
  return { doc: win.document, win, posted }
}

const AID = 'ab12cd34ef56ab78cd90ef12ab34cd56'

test('V3: the CONTACT-step capture carries the individual scan id', { skip }, async () => {
  //  The aid exists from the moment the page loads — it does not depend on
  //  reaching card 4. A lead abandoned at the contact step is exactly the lead
  //  the door-hanger campaign most needs to attribute.
  const h = await loadScanned(AID)
  await triggerBookingCapture(h)
  const body = lastPost(h)
  assert.equal(body.attributionId, AID, 'the scan id must be on the FIRST partial capture')
})

test('V3: a malformed scan id is omitted, and never costs the lead', { skip }, async () => {
  const h = await loadScanned('not-hex-at-all')
  await triggerBookingCapture(h)
  const body = lastPost(h)
  assert.equal(body.attributionId, undefined, 'a mangled id is dropped, not sent')
  assert.equal(body.email, 'test.customer@example.com', 'and the lead is still captured')
})

test('V3: the card-4 capture carries the REAL address evidence', { skip }, async () => {
  const h = await loadScanned(AID)
  await triggerBookingCapture(h)

  //  Fill the REAL inputs the form actually has — addressFrom / pu_zip /
  //  addressTo / do_zip — not invented field ids.
  const set = (id: string, v: string) => {
    const el = h.doc.getElementById(id) as HTMLInputElement | null
    assert.ok(el, `the form must have #${id}`)
    el!.value = v
    el!.dispatchEvent(new h.win.Event('input', { bubbles: true }))
    el!.dispatchEvent(new h.win.Event('change', { bubbles: true }))
  }
  set('addressFrom', '12 Example Street, West Orange')
  set('pu_zip', '07052')
  set('addressTo', '9 Sample Avenue, Hoboken')
  set('do_zip', '07030')
  const found = h.doc.getElementById('foundUs') as HTMLSelectElement
  found.value = found.options[found.options.length - 1]?.value || 'Other'
  found.dispatchEvent(new h.win.Event('change', { bubbles: true }))

  //  Trigger the page's OWN exit capture, which is how a visitor who fills the
  //  address step and then leaves actually reaches the API. Note the form's
  //  step tracker does not advance under JSDOM (navigation is validation-gated
  //  and the earlier required fields are empty), so this asserts the EVIDENCE
  //  the page sends, not the step label.
  //  A visitor who fills the address step then moves on triggers the form's
  //  own nav capture; one who closes the tab triggers the exit beacon. Fire
  //  both, because a real abandonment can be either.
  const cont = h.doc.querySelector('.btn-continue') as HTMLElement | null
  if (cont) cont.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }))
  for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 5))
  h.win.dispatchEvent(new h.win.Event('pagehide'))
  for (let i = 0; i < 60; i++) await new Promise((r) => setTimeout(r, 5))

  //  Assert against the LAST body that actually carried address evidence —
  //  the beacon and the nav capture are both legitimate carriers.
  const withAddr = h.posted.filter((b: any) => b && b.pickupZip)
  assert.ok(withAddr.length > 0, 'the page must send the address evidence on SOME real capture')

  const body = withAddr[withAddr.length - 1]
  assert.equal(body.pickupZip, '07052', 'the pickup ZIP must reach the API')
  assert.equal(body.destinationZip, '07030', 'and the destination ZIP')
  assert.equal(body.pickupAddressPresent, true, 'the server needs proof the pickup end is filled')
  assert.equal(body.destinationAddressPresent, true, 'and the destination end')
  assert.ok(body.foundUs, 'and the customer-reported source once answered')
})

test('V3: address evidence is ABSENT at the contact step, never guessed', { skip }, async () => {
  const h = await loadScanned(AID)
  await triggerBookingCapture(h)
  const body = lastPost(h)
  assert.equal(body.pickupZip, undefined, 'nothing may be claimed before the step is reached')
  assert.equal(body.destinationZip, undefined)
  assert.equal(body.pickupAddressPresent, undefined)
  assert.equal(body.destinationAddressPresent, undefined)
})

test('V3: the dedupe signature does not suppress newly available evidence', { skip }, async () => {
  //  The signature decides whether a re-send happens at all. If it ignores the
  //  address fields, a card-4 enrichment looks like a duplicate of the contact
  //  step and is never sent — the fix would be invisible in production.
  const src = readFileSync(FORM, 'utf8')
  const sig = /var sig = \[([\s\S]{0,2000}?)\]\.join/.exec(src)?.[1] ?? ''
  assert.ok(sig.length > 0, 'the dedupe signature must be findable')
  for (const field of ['pickupZip', 'destinationZip', 'attributionId']) {
    assert.match(sig, new RegExp(field), `${field} must be part of the re-send signature`)
  }
})
