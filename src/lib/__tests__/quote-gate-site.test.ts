// ════════════════════════════════════════════════════════════════════════
//  THE BROWSER GATE (owner spec 2026-08-03) — asserted against WMIWCI-SITE.
//
//  There is no browser test runner in either repo, so the site contract is
//  asserted against SOURCE TEXT from here, exactly as booking-access-review
//  .test.ts does. These assertions are deliberately BRITTLE — pinned to the
//  implementation — so that removing the gate, or quietly re-optionalising a
//  field, fails loudly instead of silently reopening the leak.
//
//  Every test is skipped cleanly when the sibling checkout is absent.
// ════════════════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const SITE_ROOT = path.resolve(__dirname, '..', '..', '..', '..', 'WMIWCI-SITE', 'public')
const hasSite = existsSync(path.join(SITE_ROOT, 'quote.html'))
const site = (f: string) => readFileSync(path.join(SITE_ROOT, f), 'utf8')
const skipSite = { skip: hasSite ? false : 'WMIWCI-SITE checkout not present' }

/** Strip comment lines so a regex can never be satisfied by a comment that
 *  merely NAMES the thing it forbids. */
const code = (text: string) =>
  text
    .split('\n')
    .filter((l) => {
      const t = l.trim()
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    })
    .join('\n')

// ── 1. The gate itself ──────────────────────────────────────────────────

test('the quick quote requires first name, last name, phone AND email', skipSite, () => {
  const src = site('quote.html')
  for (const id of ['qFirstName', 'qLastName', 'qPhone', 'qEmail']) {
    assert.ok(new RegExp(`id="${id}"[^>]*required`).test(src), `${id} must be a required input`)
    assert.ok(new RegExp(`\\['${id}',`).test(src), `${id} must be in the CHECKS validation table`)
  }
})

test('the email field is no longer optional', skipSite, () => {
  const src = site('quote.html')
  const at = src.indexOf('id="qEmail"')
  const field = src.slice(at, at + 400)
  assert.ok(/required/.test(field), 'email is now the address the confirmation goes to')
  const label = src.slice(Math.max(0, at - 400), at)
  assert.ok(!/q-optional/.test(label), 'the "optional" chip must be gone from the email label')
})

test('the estimate is HIDDEN until the gate opens', skipSite, () => {
  const src = site('quote.html')
  assert.ok(/\.q-price \{ display: none; \}/.test(src), 'the price panel must start hidden')
  assert.ok(/\.q-unlocked \.q-price \{ display: block; \}/.test(src), 'and be revealed only by .q-unlocked')
  assert.ok(/\.q-size-price \{ display: none; \}/.test(src), 'the per-size price must start hidden too')
  assert.ok(/\.q-unlocked \.q-size-price \{ display: block; \}/.test(src))
})

test('the gate EXPLAINS itself — a price that silently refuses to appear reads as a bug', skipSite, () => {
  assert.ok(
    /Enter your contact information to view your preliminary estimate and save your quote/.test(site('quote.html')),
    'the owner-specified explanation must be on the page'
  )
})

test('the page no longer promises a price without contact details', skipSite, () => {
  // HTML comments are stripped first: the file DOCUMENTS the retired promise
  // (so it is put back if the gate is ever removed), and a comment naming it
  // must not read as the page still making it.
  const src = site('quote.html').replace(/<!--[\s\S]*?-->/g, '')
  assert.ok(!/no email required/i.test(src), 'the meta description promised the opposite of what the page now does')
  assert.ok(!/real price before you give us anything/i.test(src), 'the old subtitle contradicted the gate')
})

// ── 2. Consent ──────────────────────────────────────────────────────────

test('marketing consent stays separate, optional and NEVER pre-checked', skipSite, () => {
  const src = site('quote.html')
  const el = src.match(/<input[^>]*id="qOptIn"[^>]*>/)
  assert.ok(el, 'the consent checkbox must still exist')
  assert.ok(/type="checkbox"/.test(el![0]))
  assert.ok(!/\bchecked\b/.test(el![0]), 'a pre-ticked consent box is not consent')
  assert.ok(!/id="qOptIn"[^>]*required/.test(src), 'consent must never gate the estimate')
  assert.ok(/dataset\.touched/.test(src), 'the tri-state touched flag must remain')
})

test('the draft never restores marketing consent', skipSite, () => {
  const src = site('quote.html')
  const save = src.slice(src.indexOf('function saveDraft'), src.indexOf('function restoreDraft'))
  assert.ok(!/qOptIn/.test(save), 'writing consent to the draft would pre-tick it on a later page')
})

// ── 3. One person, one lead ─────────────────────────────────────────────

test('the quote form shares the booking form session key so one person is one lead', skipSite, () => {
  assert.ok(/wmiwci_booking_session/.test(site('quote.html')), 'quote.html must use the shared session key')
  assert.ok(/wmiwci_booking_session/.test(site('booking-form.html')))
  assert.ok(/bookingSessionId: sessionId\(\)/.test(site('quote.html')), 'and send it with the lead')
})

// ── 4. The estimate survives a backend failure ──────────────────────────

test('the estimate is shown even when the save fails', skipSite, () => {
  const src = site('quote.html')
  const at = src.indexOf('saveLead(body).then')
  assert.ok(at > 0, 'the save must be awaited so its outcome can be reported')
  const handler = src.slice(at, at + 1200)
  assert.ok(/unlock\(\);/.test(handler), 'unlock() must run regardless of the save outcome')
  assert.ok(
    handler.indexOf('unlock()') < handler.indexOf('if (outcome.captured)'),
    'unlock() must come BEFORE the captured branch, never inside the success arm'
  )
  assert.ok(/SAVE_TIMEOUT_MS/.test(src), 'a slow backend must not hold the estimate hostage')
})

test('each outcome gets its OWN sentence, and none of them says "sent"', skipSite, () => {
  const src = site('quote.html')
  assert.ok(/A copy is on the way to your email/.test(src), 'saved + email queued')
  assert.ok(/We couldn\u2019t email the copy/.test(src), 'saved, email queue unavailable')
  assert.ok(/we couldn\u2019t save your information/.test(src), 'not saved at all')
  // Queueing a job is not delivery. "Sent" is a claim this layer cannot make.
  assert.ok(!/We\u2019ve emailed you a copy/.test(src),
    'the old wording promised delivery the API had not achieved')
})

test('the lead-conversion event fires only AFTER confirmed capture, and only once', skipSite, () => {
  const src = site('quote.html')
  assert.ok(/var conversionFired = false/.test(src), 'a once-only guard must exist')
  assert.ok(/function fireConversion/.test(src))
  const at = src.indexOf('if (outcome.captured)')
  assert.ok(at > 0, 'the captured branch must exist')
  assert.ok(/fireConversion\(/.test(src.slice(at, at + 500)),
    'generate_lead must fire INSIDE the captured branch')
  const submitAt = src.indexOf('var body = buildLeadBody();')
  const beforeSave = src.slice(submitAt, src.indexOf('saveLead(body).then'))
  assert.ok(!/generate_lead/.test(beforeSave),
    'firing it on submit counted failed requests and honeypot hits as conversions')
})

test('a failed capture fires a FAILURE event, not a conversion', skipSite, () => {
  assert.ok(/quote_lead_capture_failed/.test(site('quote.html')))
})

test('the server total overrides a stale browser price book', skipSite, () => {
  const src = site('quote.html')
  assert.ok(/var serverTotal = null/.test(src))
  assert.ok(/serverTotal !== null\) \? serverTotal :/.test(src),
    'render() must prefer the server figure once it has one')
})

test('a non-JSON response cannot break the page', skipSite, () => {
  const src = site('quote.html')
  assert.ok(/r\.json\(\)\.catch\(/.test(src), 'an HTML error page from a proxy must not throw')
  assert.ok(/UNKNOWN_OUTCOME/.test(src), 'and must resolve to a known-unknown outcome')
})

test('the submit button is re-enabled on every path', skipSite, () => {
  const src = site('quote.html')
  const at = src.indexOf('saveLead(body).then')
  assert.ok(/btn\.disabled = false/.test(src.slice(at, at + 700)),
    'a customer must never be left with a dead control after an error')
})

test('the quote page uses its OWN endpoint, never the shared /api/leads alias', skipSite, () => {
  const src = site('quote.html')
  assert.ok(/\/api\/leads\/quote-capture/.test(src), 'it must call the dedicated capture route')
  assert.ok(!/fetch\(API_BASE \+ '\/api\/leads'/.test(src),
    '/api/leads is a thin alias over /api/leads/partial serving five other capture surfaces; ' +
    'this page needs stricter rules than that shared contract can carry')
})

// ── 5. Submission hygiene + accessibility ───────────────────────────────

test('double submission is prevented', skipSite, () => {
  const src = site('quote.html')
  assert.ok(/if \(submitting\) return;/.test(src))
  assert.ok(/btn\.disabled = true;/.test(src))
})

test('the busy state is announced, not just spun', skipSite, () => {
  const src = site('quote.html')
  assert.ok(/aria-busy/.test(src), 'the button must expose a busy state')
  assert.ok(/id="qStatus"[^>]*role="status"/.test(src), 'and a live region must carry the words')
})

test('the honeypot survives', skipSite, () => {
  assert.ok(/id="qCompany"/.test(site('quote.html')))
})

// ── 6. Back-navigation ──────────────────────────────────────────────────

test('answers survive navigating away and back', skipSite, () => {
  const src = site('quote.html')
  assert.ok(/function restoreDraft/.test(src))
  assert.ok(/wmiwci_booking_v2/.test(src), 'it must reuse the existing shared draft key, not a new store')
  assert.ok(/pagehide/.test(src), 'a Back tap with a focused field must still save')
})

// ── 7. Attribution ──────────────────────────────────────────────────────

test('THE ATTRIBUTION BUG is fixed — booking-form must call the function that exists', skipSite, () => {
  const booking = site('booking-form.html')
  assert.ok(/window\.WMIC_attribution\s*=/.test(site('js/site-copy.js')), 'site-copy.js defines WMIC_attribution')
  assert.ok(
    !/window\.wmicAttribution\s*(\?|\()/.test(code(booking)),
    'booking-form.html called window.wmicAttribution, defined nowhere — every cloaked-link lead lost its attribution'
  )
  assert.ok(/window\.WMIC_attribution/.test(booking), 'it must call the real name')
})

test('ad click ids are captured and forwarded', skipSite, () => {
  const copy = site('js/site-copy.js')
  assert.ok(/gclid/.test(copy) && /fbclid/.test(copy), 'the attribution store must carry the click ids')
  for (const f of ['quote.html', 'booking-form.html']) {
    assert.ok(/gclid/.test(site(f)), `${f} must send gclid`)
    assert.ok(/fbclid/.test(site(f)), `${f} must send fbclid`)
  }
})

test('the quote hand-off reads the attribution STORE, not only the query string', skipSite, () => {
  const src = site('quote.html')
  const at = src.indexOf("['utm_source', 'utm_medium', 'utm_campaign']")
  assert.ok(at > 0, 'the utm forwarding loop must still exist')
  const loop = src.slice(at, at + 260)
  assert.ok(/attr\[k\]/.test(loop), 'cloaking strips utm_* from the URL, so the store must be read first')
})

// ── 8. Contact preference on both public forms ──────────────────────────

test('the contact-preference controls exist on BOTH public forms and are optional', skipSite, () => {
  for (const f of ['quote.html', 'booking-form.html']) {
    const src = site(f)
    assert.ok(/contactPreference|qContactPref/i.test(src), `${f} must offer a contact preference`)
    assert.ok(/bestTimeToCall|qBestTime/i.test(src), `${f} must offer a best time to call`)
  }
  const quote = site('quote.html')
  for (const value of ['call_asap', 'text', 'email', 'customer_will_contact']) {
    assert.ok(new RegExp(`value="${value}"`).test(quote), `the ${value} option must exist`)
  }
  assert.ok(!/id="qContactPref"[^>]*required/.test(quote), 'the preference must never be required')
  assert.ok(!/id="qBestTime"[^>]*required/.test(quote), 'best time must never be required')
})

test('the booking form still requires exactly the four contact fields — no more, no less', skipSite, () => {
  const src = site('booking-form.html')
  const at = src.indexOf('card1:')
  assert.ok(at > 0, 'the card1 validator must still exist')
  // The validator array is one entry per line; 600 chars covers all four
  // without spilling into card2.
  const validators = src.slice(at, src.indexOf('card2:', at))
  assert.ok(validators.length > 0 && validators.length < 1500, 'the slice must cover card1 only')
  assert.ok(/firstName/.test(validators) && /lastName/.test(validators))
  assert.ok(/phone/.test(validators) && /email/.test(validators))
  assert.ok(
    !/contactPreference/.test(validators) && !/bestTimeToCall/.test(validators),
    'the new optional fields must never enter a required-field validator'
  )
})

// ── 9. The stale pricing-page starter ───────────────────────────────────

test('the pricing-page estimate starter speaks the CURRENT vocabulary', skipSite, () => {
  const pricing = site('pricing.html')
  assert.ok(
    /value="full_service"/.test(pricing) && /value="labor_only"/.test(pricing),
    'estimate-starter.js expects full_service | labor_only | not-sure'
  )
  assert.ok(!/value="need-help"/.test(pricing), 'the retired truck-question values must be gone')
})

// ── 10. Mobile + reduced motion ─────────────────────────────────────────

test('mobile: the new fields reuse the existing responsive grid', skipSite, () => {
  const src = site('quote.html')
  assert.ok(
    /@media \(max-width: 560px\)[\s\S]{0,400}\.q-row\s*\{\s*grid-template-columns: 1fr;/.test(src),
    'the two-column rows must still collapse on a phone'
  )
  assert.ok(/\.q-field select/.test(src), 'the select must be styled like the inputs, not left native')
})

test('reduced motion is respected by the new spinner', skipSite, () => {
  const src = site('quote.html')
  const block = src.slice(src.indexOf('@media (prefers-reduced-motion'))
  assert.ok(/\.q-spin \{ animation: none; \}/.test(block))
})
