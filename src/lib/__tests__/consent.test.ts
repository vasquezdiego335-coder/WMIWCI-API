import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  CONSENT_SOURCES,
  CONSENT_VERSION,
  decideConsent,
  isMarketable,
  normaliseConsentSource,
  type ExistingConsent,
  type IncomingConsent,
} from '../consent'
import { mapLeadSource } from '../leads'

// ════════════════════════════════════════════════════════════════════════
//  MARKETING CONSENT RULES (owner spec 2026-07-28)
//
//  Consent is the one thing here that cannot be reconstructed if it is lost or
//  mis-recorded. Every test below names the real-world mistake it prevents.
// ════════════════════════════════════════════════════════════════════════

const NOW = new Date('2026-07-28T12:00:00Z')
const decide = (existing: ExistingConsent, incoming: IncomingConsent) => decideConsent(existing, incoming, NOW)

const NEVER_ASKED: ExistingConsent = { consent: null }
const DECLINED: ExistingConsent = { consent: false, consentAt: new Date('2026-06-01T00:00:00Z'), consentSource: 'BOOKING_FORM', consentVersion: '2026-07-v1' }
const OPTED_IN: ExistingConsent = { consent: true, consentAt: new Date('2026-06-01T00:00:00Z'), consentSource: 'BOOKING_FORM', consentVersion: '2026-07-v1' }

// ── The single most important rule ──────────────────────────────────────

test('a form with NO consent field changes nothing', () => {
  // PREVENTS: a returning customer booking on a form without a checkbox
  // silently gaining — or losing — marketing permission.
  for (const existing of [NEVER_ASKED, DECLINED, OPTED_IN]) {
    const d = decide(existing, { consent: undefined, source: 'BOOKING_FORM' })
    assert.deepEqual(d.changes, {}, 'silence must write nothing')
    assert.equal(d.granted, false)
  }
})

test('null consent is NEVER inferred as false', () => {
  // PREVENTS: destroying the difference between "we asked and they said no"
  // and "we never asked". The six pre-checkbox customers depend on this.
  const d = decide(NEVER_ASKED, { consent: undefined })
  assert.equal(d.changes.emailMarketingConsent, undefined)
})

test('consent is never inferred from a booking, a quote or an email address', () => {
  // The ONLY input that can create permission is consent === true.
  const d = decide(NEVER_ASKED, { source: 'BOOKING_FORM', version: CONSENT_VERSION })
  assert.equal(d.granted, false)
  assert.deepEqual(d.changes, {})
})

// ── Grant ───────────────────────────────────────────────────────────────

test('an explicit opt-in records consent WITH its evidence', () => {
  const d = decide(NEVER_ASKED, { consent: true, source: 'BOOKING_FORM', version: CONSENT_VERSION })
  assert.equal(d.granted, true)
  assert.equal(d.changes.emailMarketingConsent, true)
  assert.equal(d.changes.marketingConsentSource, 'BOOKING_FORM')
  assert.equal(d.changes.marketingConsentVersion, CONSENT_VERSION)
  assert.deepEqual(d.changes.marketingConsentAt, NOW)
})

test('a previous explicit DECLINE can become true with a real opt-in', () => {
  const d = decide(DECLINED, { consent: true, source: 'QUICK_QUOTE_FORM' })
  assert.equal(d.granted, true)
  assert.equal(d.changes.emailMarketingConsent, true)
  assert.equal(d.changes.marketingConsentSource, 'QUICK_QUOTE_FORM')
})

test('re-consenting does NOT reset the original timestamp', () => {
  // PREVENTS: losing "consented since June", which is the fact that matters
  // when somebody asks how long we have been permitted to mail them.
  const d = decide(OPTED_IN, { consent: true, source: 'HOMEPAGE_ESTIMATE' })
  assert.deepEqual(d.changes, {}, 'an existing opt-in is preserved untouched')
})

// ── Decline ─────────────────────────────────────────────────────────────

test('an unchecked box is recorded as an explicit decline, not as "never asked"', () => {
  const d = decide(NEVER_ASKED, { consent: false, source: 'QUICK_QUOTE_FORM' })
  assert.equal(d.changes.emailMarketingConsent, false)
  assert.equal(d.changes.marketingConsentSource, 'QUICK_QUOTE_FORM')
})

test('an unchecked box NEVER revokes an earlier explicit opt-in', () => {
  // PREVENTS: someone who opted in during booking losing it because they later
  // filled a quote form and did not re-tick the box. Opting out is what the
  // unsubscribe link is for; a half-filled form is not an unsubscribe.
  const d = decide(OPTED_IN, { consent: false, source: 'QUICK_QUOTE_FORM' })
  assert.deepEqual(d.changes, {})
  assert.match(d.reason, /not an unsubscribe/i)
})

test('only a genuine withdrawal page may revoke consent', () => {
  const d = decide(OPTED_IN, { consent: false, isWithdrawal: true, source: 'ADMIN_MANUAL' })
  assert.equal(d.changes.emailMarketingConsent, false)
  assert.equal(d.granted, false)
})

// ── Suppression ─────────────────────────────────────────────────────────

test('SUPPRESSION overrides an explicit opt-in submitted on the same request', () => {
  // PREVENTS: someone who unsubscribed or complained being re-subscribed by a
  // later form. This is the rule that protects the sending domain.
  const d = decide(NEVER_ASKED, { consent: true, source: 'BOOKING_FORM', isSuppressed: true })
  assert.deepEqual(d.changes, {})
  assert.equal(d.granted, false)
  assert.match(d.reason, /suppress/i)
})

test('suppression is checked FIRST, before withdrawal or grant', () => {
  const d = decide(OPTED_IN, { consent: true, isSuppressed: true, isWithdrawal: true })
  assert.deepEqual(d.changes, {}, 'nothing is written for a suppressed address')
})

// ── Marketability ───────────────────────────────────────────────────────

test('only an explicit opt-in with a clean record is marketable', () => {
  assert.equal(isMarketable({ email: 'a@b.com', consent: true }).marketable, true)
})

test('every disqualifying condition excludes a contact', () => {
  const base = { email: 'a@b.com', consent: true }
  assert.equal(isMarketable({ ...base, suppressed: true }).marketable, false)
  assert.equal(isMarketable({ ...base, unsubscribed: true }).marketable, false)
  assert.equal(isMarketable({ ...base, hardBounced: true }).marketable, false)
  assert.equal(isMarketable({ ...base, complained: true }).marketable, false)
  assert.equal(isMarketable({ email: 'a@b.com', consent: false }).marketable, false)
  assert.equal(isMarketable({ email: 'a@b.com', consent: null }).marketable, false)
  assert.equal(isMarketable({ email: null, consent: true }).marketable, false)
})

test('a null-consent contact is excluded with an honest reason', () => {
  const r = isMarketable({ email: 'a@b.com', consent: null })
  assert.match(r.reason, /absence of a decision is not consent/i)
})

// ── Source vocabulary ───────────────────────────────────────────────────

test('the legacy booking_step_1 string maps to BOOKING_FORM', () => {
  assert.equal(normaliseConsentSource('booking_step_1'), 'BOOKING_FORM')
})

test('unknown source strings are rejected rather than stored raw', () => {
  // PREVENTS: the uncontrolled-vocabulary problem that filled the lead table
  // with `OTHER` and made attribution unanswerable.
  assert.equal(normaliseConsentSource('some-random-thing'), null)
  assert.equal(normaliseConsentSource(''), null)
  assert.equal(normaliseConsentSource(null), null)
})

test('every controlled source round-trips', () => {
  for (const s of CONSENT_SOURCES) assert.equal(normaliseConsentSource(s), s)
})

test('the disclosure version is a single centralised constant', () => {
  assert.match(CONSENT_VERSION, /^\d{4}-\d{2}-v\d+$/)
  const dir = resolve(__dirname, '../..')
  // It must not be duplicated as a literal anywhere else.
  for (const f of ['lib/leads.ts', '../app/api/bookings/route.ts']) {
    const src = readFileSync(resolve(dir, f), 'utf8')
    assert.ok(!src.includes(`'${CONSENT_VERSION}'`), `${f} must import CONSENT_VERSION, not hardcode it`)
  }
})

// ── Wiring ──────────────────────────────────────────────────────────────

/** Source assertions run on CODE — a comment explaining what was removed is
 *  not the thing itself, and matching it produces a false failure. */
const stripComments = (src: string): string =>
  src
    .split('\n')
    .filter((l) => {
      const t = l.trim()
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    })
    .join('\n')

test('the booking route sends the controlled source and the version', () => {
  const src = readFileSync(resolve(__dirname, '../../../app/api/bookings/route.ts'), 'utf8')
  assert.ok(/consentSource: 'BOOKING_FORM'/.test(src), 'must use the controlled value')
  assert.ok(/consentVersion: CONSENT_VERSION/.test(src), 'must record what the visitor was shown')
  assert.ok(!/booking_step_1/.test(stripComments(src)), 'the ad-hoc string must be gone from the code')
})

test('customer consent writes carry source and version, not just the boolean', () => {
  const src = readFileSync(resolve(__dirname, '../leads.ts'), 'utf8')
  const fn = src.slice(src.indexOf('export async function markLeadConverted'))
  assert.ok(/customerDecision/.test(fn), 'the customer write must go through the consent engine')
  assert.ok(/decideConsent\(/.test(fn), 'rules must not be reimplemented inline')
  // The old bare write must be gone.
  assert.ok(!/data: \{ emailMarketingConsent: effectiveConsent, marketingConsentAt: now \}/.test(fn))
})

test('a suppressed address is checked before any consent write', () => {
  const src = readFileSync(resolve(__dirname, '../leads.ts'), 'utf8')
  const fn = src.slice(src.indexOf('export async function markLeadConverted'))
  assert.ok(/emailSuppression\.findUnique/.test(fn), 'suppression must be looked up')
  assert.ok(fn.indexOf('const suppressed') < fn.indexOf('customerDecision'), 'and looked up BEFORE the customer write')
})

test('consent rules exist in exactly one module', () => {
  // PREVENTS: routes drifting into their own inconsistent consent logic.
  const leads = readFileSync(resolve(__dirname, '../leads.ts'), 'utf8')
  assert.ok(/from '\.\/consent'/.test(leads), 'leads.ts must import the shared rules')
})

// ════════════════════════════════════════════════════════════════════════
//  MARKETABLE-AUDIENCE ELIGIBILITY (Phase 10)
//
//  Every campaign, audience and journey path must use ONE eligibility gate.
//  Individual routes implementing their own is how a suppressed contact
//  eventually receives mail.
// ════════════════════════════════════════════════════════════════════════

test('audience resolution requires EXPLICIT consent, never null', () => {
  const src = readFileSync(resolve(__dirname, '../email-audience.ts'), 'utf8')
  const fn = src.slice(src.indexOf('async function consentingEmails'), src.indexOf('export type AudiencePreview'))
  // `emailMarketingConsent: true` — not `{ not: false }`, which would let
  // null through and mail people who were never asked.
  assert.ok(/emailMarketingConsent: true/.test(fn), 'must require an explicit true')
  assert.ok(!/emailMarketingConsent: \{ not:/.test(fn), 'must not use a negation that admits null')
  assert.equal((fn.match(/emailMarketingConsent: true/g) ?? []).length, 2, 'both Customer and Lead must be gated')
})

test('consent is checked on BOTH preview and real dispatch, not just preview', () => {
  // PREVENTS: a preview that looks compliant while the real send is not.
  const src = readFileSync(resolve(__dirname, '../email-audience.ts'), 'utf8')
  assert.ok((src.match(/consentingEmails\(emails\)/g) ?? []).length >= 2, 'preview and dispatch must both gate on consent')
})

test('suppression is resolved alongside consent on every audience path', () => {
  const src = readFileSync(resolve(__dirname, '../email-audience.ts'), 'utf8')
  assert.ok(/emailSuppression/.test(src), 'the suppression list must be consulted')
  assert.ok(/noConsent/.test(src), 'and a no-consent exclusion reason must be recorded')
})

test('the shared isMarketable gate agrees with the audience query', () => {
  // Both must exclude the same people. This is the contract between the
  // pure rule and the SQL that implements it.
  assert.equal(isMarketable({ email: 'a@b.com', consent: null }).marketable, false)
  assert.equal(isMarketable({ email: 'a@b.com', consent: false }).marketable, false)
  assert.equal(isMarketable({ email: 'a@b.com', consent: true }).marketable, true)
  assert.equal(isMarketable({ email: 'a@b.com', consent: true, suppressed: true }).marketable, false)
})

// ════════════════════════════════════════════════════════════════════════
//  SOURCE ATTRIBUTION (Phase 4)
//
//  MEASURED FAILURE: an end-to-end run of the new quote-form payload stored
//  `source: OTHER` despite sending `QUICK_QUOTE_FORM`, because mapLeadSource
//  only knew the legacy free-form channel words. That is exactly the
//  unanswerable-attribution problem this phase exists to fix.
// ════════════════════════════════════════════════════════════════════════

test('a controlled capture surface is stored, not flattened to OTHER', () => {
  for (const v of ['QUICK_QUOTE_FORM', 'HOMEPAGE_ESTIMATE', 'BOOKING_FORM', 'SERVICES_PAGE', 'MOVING_CHECKLIST']) {
    assert.equal(mapLeadSource(v), v, `${v} must survive`)
  }
})

test('capture surfaces are matched case- and separator-insensitively', () => {
  assert.equal(mapLeadSource('quick_quote_form'), 'QUICK_QUOTE_FORM')
  assert.equal(mapLeadSource('services-page'), 'SERVICES_PAGE')
  assert.equal(mapLeadSource('homepage estimate'), 'HOMEPAGE_ESTIMATE')
})

test('a legacy word keeps its ORIGINAL meaning even when a same-named enum value exists', () => {
  // `contact-form` has always meant WEBSITE. CONTACT_FORM now exists as an
  // enum value, and an enum-first lookup would silently re-point every
  // existing /api/contact submission — a live behaviour change disguised as a
  // vocabulary addition. Callers wanting the new value send it explicitly.
  assert.equal(mapLeadSource('contact-form'), 'WEBSITE')
  assert.equal(mapLeadSource('CONTACT_FORM'), 'CONTACT_FORM')
})

test('legacy channel words still map as they always did', () => {
  // PREVENTS: the new branch swallowing the existing vocabulary.
  assert.equal(mapLeadSource('google'), 'GOOGLE')
  assert.equal(mapLeadSource('door-hanger'), 'DOOR_HANGER')
  assert.equal(mapLeadSource('fb'), 'FACEBOOK')
  assert.equal(mapLeadSource('website'), 'WEBSITE')
})

test('a genuinely unknown source still falls back to OTHER', () => {
  assert.equal(mapLeadSource('some-affiliate-nobody-configured'), 'OTHER')
  assert.equal(mapLeadSource(''), 'OTHER')
  assert.equal(mapLeadSource(null), 'OTHER')
})
