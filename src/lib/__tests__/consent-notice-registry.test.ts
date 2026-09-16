// ════════════════════════════════════════════════════════════════════════
//  consent-notice-registry.test.ts — the server accepts ONLY registered notice
//  copy, on its own surface, in its own locale (DESIGN-v2 §3).
//
//  Pins: every registered hash is the hash of its exact string (so an edit to
//  the copy cannot silently change what recorded events claim was shown); the
//  copy is word-for-word the binding r2 spec and every version is a notice;
//  unknown, removed, wrong-surface, wrong-locale and not-yet-live versions are
//  ABSENT; stored events are re-checked against the registry; only the three
//  existing-template sequences exist, lead_nurture on every surface; a lead's
//  stored basis is replaced only by a notice that keeps every lead sequence.
//  Pure — no database, no network.
// ════════════════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { assertNoProductionCredentials } from './_disposable-test-env'
import {
  NOTICE_HASH_ALGORITHM,
  NOTICE_LOCALES,
  NOTICE_POLICY_START,
  NOTICE_SURFACES,
  NOTICE_VERSIONS,
  OPT_OUT_LABELS,
  PRIVACY_POLICY_PATH,
  SEQUENCE_KINDS,
  SURFACE_SEQUENCE_KINDS,
  leadBasisReplaceableBy,
  normalizeNoticeLocale,
  normalizeNoticeText,
  noticeCopySha256,
  resolveNotice,
  storedNoticeMatchesRegistry,
} from '../consent/notice-registry'

assertNoProductionCredentials()

const LIVE = new Date('2026-09-17T15:00:00Z')

//  The binding r2 copy (owner direction 2026-09-16: a form submission may lead
//  to promotional email, with no separate opt-in or confirmation step), typed
//  out independently of the registry, with the hashes computed outside it.
//  If the registry drifts from the spec, this fails. The booking and popup r2
//  copy was edited in place before deploy (release 2026-09-16: every form now
//  enters an existing sequence, so both name "follow-ups") and re-hashed; r2
//  recorded no events, so no stored event names the earlier wording.
const SPEC: Record<string, { surfaces: string[]; en: string; es: string; sha: { en: string; es: string } }> = {
  'quote-2026-09-16-r2': {
    surfaces: ['quote'],
    en: 'Move It Clear It will email you about this quote request. Submitting your email may also lead to promotional emails from us, such as quote follow-ups and offers on our moving services. To stop them, use the unsubscribe link in any of those emails.',
    es: 'Move It Clear It le enviará correos sobre esta solicitud de cotización. Al enviar su correo, también podría recibir correos promocionales de nuestra parte, como seguimientos de su cotización y ofertas de nuestros servicios de mudanza. Para dejar de recibirlos, use el enlace para darse de baja en cualquiera de esos correos.',
    sha: {
      en: '52937814a6a558798b9fa5482f551c28710c504f1d7f4445414e6adb573e6976',
      es: '6b3995b605e03580fcb855ed9324a0584d3eaf6a0b3e0812d3a7ad929abd28ad',
    },
  },
  'booking-2026-09-16-r2': {
    surfaces: ['booking'],
    en: 'Move It Clear It will email you about this booking request. Submitting your email may also lead to promotional emails from us, such as follow-ups, reminders to finish your booking and offers on our moving services. To stop them, use the unsubscribe link in any of those emails.',
    es: 'Move It Clear It te enviará correos sobre esta solicitud de reserva. Al enviar tu correo, también podrías recibir correos promocionales de nuestra parte, como seguimientos, recordatorios para terminar tu reserva y ofertas de nuestros servicios de mudanza. Para dejar de recibirlos, usa el enlace para darte de baja en cualquiera de esos correos.',
    sha: {
      en: '657b6bcae274cdb1de6228a310e2d85d6f6ab156ec6c6a01d615b57012ddddbf',
      es: '497b8329faeebcdff02df6c903f1bc612275edc46d2ca674ae0d8379439ca3d4',
    },
  },
  'contact-2026-09-16-r2': {
    surfaces: ['contact', 'contact_support'],
    en: 'Move It Clear It will reply to your message first. Submitting your email may also lead to promotional emails from us, such as follow-ups and offers on our moving services. To stop them, use the unsubscribe link in any of those emails.',
    es: 'Move It Clear It primero responderá a su mensaje. Al enviar su correo, también podría recibir correos promocionales de nuestra parte, como seguimientos y ofertas de nuestros servicios de mudanza. Para dejar de recibirlos, use el enlace para darse de baja en cualquiera de esos correos.',
    sha: {
      en: '6df4f878e7767393c53f6c15df99f3a139a7f8d5eb3306edbdccff5c98982818',
      es: 'c42a1f5bcbd2f72f6a0469b3bb546df686b42e7008fb76e94d867d1521bd6280',
    },
  },
  'tracker-2026-09-16-r2': {
    surfaces: ['tracker'],
    en: 'Move It Clear It will contact you about this request. Submitting your email may also lead to promotional emails from us, such as follow-ups and offers on our moving services. To stop them, use the unsubscribe link in any of those emails.',
    es: 'Move It Clear It se comunicará contigo sobre esta solicitud. Al enviar tu correo, también podrías recibir correos promocionales de nuestra parte, como seguimientos y ofertas de nuestros servicios de mudanza. Para dejar de recibirlos, usa el enlace para darte de baja en cualquiera de esos correos.',
    sha: {
      en: '5e1d926ace3d66f45f83d9601ea7e4ca896ccd244e25ba122ffc78372cf3cfa1',
      es: '29ff5d77dc4bab530d4fe3e5c6e058b8a2e577e5229125269f7aa9e1ea898be1',
    },
  },
  'popup-2026-09-16-r2': {
    surfaces: ['popup'],
    en: 'Your 10% code appears here right away. Submitting your email may also lead to promotional emails from Move It Clear It, such as follow-ups and offers on our moving services. To stop them, use the unsubscribe link in any of those emails.',
    es: 'Tu código del 10% aparece aquí de inmediato. Al enviar tu correo, también podrías recibir correos promocionales de Move It Clear It, como seguimientos y ofertas de nuestros servicios de mudanza. Para dejar de recibirlos, usa el enlace para darte de baja en cualquiera de esos correos.',
    sha: {
      en: 'b1448afba02c6cde32c318fa6c90d1255614446e68037edc00524c0d3a8682f5',
      es: 'f6fa0f425346739876f3a66ef44693cfd51cb7ad9c08fa45195dd0f00bbcf3aa',
    },
  },
}

test('the registry holds exactly the five r2 versions, with the spec copy, hashes and surfaces — every one a notice', () => {
  assert.deepEqual(Object.keys(NOTICE_VERSIONS).sort(), Object.keys(SPEC).sort())
  for (const [version, spec] of Object.entries(SPEC)) {
    const entry = NOTICE_VERSIONS[version]
    assert.deepEqual([...entry.surfaces].sort(), [...spec.surfaces].sort(), `${version} surfaces`)
    assert.equal(entry.locales.en, spec.en, `${version} EN copy`)
    assert.equal(entry.locales.es, spec.es, `${version} ES copy`)
    assert.deepEqual({ ...entry.copySha256 }, spec.sha, `${version} hashes`)
    assert.equal(entry.basis, 'notice', `${version}: no form is ever recorded as an opt-in`)
    assert.equal(entry.liveFrom, '2026-09-16')
    assert.equal(entry.liveUntil, undefined, `${version} is live`)
    assert.ok(!('requiresConfirmation' in entry), `${version}: there is no confirm-by-email step`)
  }
  //  The first-release ids (never deployed, no events) are gone, not retired.
  for (const removed of ['quote-2026-09-16', 'booking-2026-09-16', 'contact-2026-09-16', 'popup-2026-09-16']) {
    assert.ok(!Object.prototype.hasOwnProperty.call(NOTICE_VERSIONS, removed), removed)
  }
})

test('the surfaces are exactly the six route-derived ones; every surface has a registered notice', () => {
  assert.deepEqual([...NOTICE_SURFACES], ['quote', 'booking', 'contact', 'contact_support', 'tracker', 'popup'])
  for (const surface of NOTICE_SURFACES) {
    const versions = Object.entries(NOTICE_VERSIONS).filter(([, e]) => e.surfaces.includes(surface))
    assert.equal(versions.length, 1, `${surface} has exactly one live notice`)
  }
})

test('every registered hash is SHA-256 of its exact normalised string', () => {
  for (const [version, entry] of Object.entries(NOTICE_VERSIONS)) {
    for (const locale of NOTICE_LOCALES) {
      const text = entry.locales[locale]
      const independent = createHash('sha256').update(text.replace(/\s+/g, ' ').trim(), 'utf8').digest('hex')
      assert.equal(entry.copySha256[locale], independent, `${version}/${locale} hash`)
      assert.equal(noticeCopySha256(text), independent)
      assert.match(entry.copySha256[locale], /^[0-9a-f]{64}$/)
    }
  }
  //  All ten strings are distinct, so no hash can stand in for another notice.
  const all = Object.values(NOTICE_VERSIONS).flatMap((e) => NOTICE_LOCALES.map((l) => e.copySha256[l]))
  assert.equal(all.length, 10)
  assert.equal(new Set(all).size, all.length)
})

test('a one-character change to the copy changes the hash', () => {
  const q = NOTICE_VERSIONS['quote-2026-09-16-r2']
  const en = q.locales.en
  assert.notEqual(noticeCopySha256(en.replace('quote follow-ups', 'quote follow-up')), q.copySha256.en)
  assert.notEqual(noticeCopySha256(en.replace('those emails.', 'those emails')), q.copySha256.en)
  assert.notEqual(noticeCopySha256(en.replace('may also lead', 'will also lead')), q.copySha256.en)
})

test('the hash normalisation collapses rendered whitespace and nothing else', () => {
  const c = NOTICE_VERSIONS['contact-2026-09-16-r2']
  const en = c.locales.en
  const rendered = `\n    ${en.split(' ').join('\n      ')}\t `
  assert.equal(normalizeNoticeText(rendered), en)
  assert.equal(noticeCopySha256(rendered), c.copySha256.en)
  //  Case and punctuation are content, not whitespace.
  assert.notEqual(noticeCopySha256(en.toLowerCase()), c.copySha256.en)
  assert.match(NOTICE_HASH_ALGORITHM, /sha256/i)
  assert.match(NOTICE_HASH_ALGORITHM, /whitespace/i)
})

test('resolveNotice accepts each version on each of its surfaces and locales', () => {
  let accepted = 0
  for (const [version, entry] of Object.entries(NOTICE_VERSIONS)) {
    for (const surface of entry.surfaces) {
      for (const locale of NOTICE_LOCALES) {
        const r = resolveNotice({ version, surface, locale, now: LIVE })
        assert.equal(r.ok, true, `${version} ${surface} ${locale}`)
        if (r.ok) {
          accepted++
          assert.equal(r.version, version)
          assert.equal(r.surface, surface)
          assert.equal(r.locale, locale)
          assert.equal(r.copySha256, entry.copySha256[locale])
          assert.equal(r.text, entry.locales[locale])
          assert.equal(r.basis, 'notice')
        }
      }
    }
  }
  //  Six surfaces × two locales: the contact copy serves contact AND contact_support.
  assert.equal(accepted, 12)
})

test('an unknown version is absent — including the removed first-release ids', () => {
  for (const version of [
    '',
    '   ',
    'quote-2026-09-15',
    'QUOTE-2026-09-16-R2',
    'quote-2026-09-16-r3',
    'quote-2026-09-16',
    'booking-2026-09-16',
    'contact-2026-09-16',
    'popup-2026-09-16',
    '2026-07-v1',
    '2026-07-24',
    '__proto__',
    'constructor',
    'toString',
  ]) {
    const r = resolveNotice({ version, surface: 'quote', locale: 'en', now: LIVE })
    assert.equal(r.ok, false, `version ${JSON.stringify(version)} must be refused`)
    if (!r.ok) assert.equal(r.reason, 'unknown_notice_version')
  }
  assert.equal(resolveNotice({ version: null, surface: 'quote', locale: 'en', now: LIVE }).ok, false)
  assert.equal(resolveNotice({ version: undefined, surface: 'quote', locale: 'en', now: LIVE }).ok, false)
})

test('a version used on the wrong surface is absent — the quote notice cannot be claimed on contact', () => {
  const cases: Array<[string, (typeof NOTICE_SURFACES)[number]]> = [
    ['quote-2026-09-16-r2', 'contact'],
    ['quote-2026-09-16-r2', 'contact_support'],
    ['quote-2026-09-16-r2', 'booking'],
    ['booking-2026-09-16-r2', 'quote'],
    ['contact-2026-09-16-r2', 'quote'],
    ['contact-2026-09-16-r2', 'popup'],
    ['contact-2026-09-16-r2', 'tracker'],
    ['tracker-2026-09-16-r2', 'contact'],
    ['tracker-2026-09-16-r2', 'contact_support'],
    ['popup-2026-09-16-r2', 'quote'],
    ['popup-2026-09-16-r2', 'tracker'],
  ]
  for (const [version, surface] of cases) {
    const r = resolveNotice({ version, surface, locale: 'en', now: LIVE })
    assert.deepEqual(r, { ok: false, reason: 'unknown_notice_version', detail: 'wrong_surface' }, `${version} on ${surface}`)
  }
})

test('a missing or unsupported locale is absent; regional tags map to their language', () => {
  for (const locale of [undefined, null, '', 'fr', 'pt-BR', 'english', 'e']) {
    const r = resolveNotice({ version: 'quote-2026-09-16-r2', surface: 'quote', locale, now: LIVE })
    assert.equal(r.ok, false, `locale ${JSON.stringify(locale)}`)
    if (!r.ok) assert.equal(r.detail, 'wrong_locale')
  }
  assert.equal(normalizeNoticeLocale('ES'), 'es')
  assert.equal(normalizeNoticeLocale('es-US'), 'es')
  assert.equal(normalizeNoticeLocale('en_US'), 'en')
  const es = resolveNotice({ version: 'quote-2026-09-16-r2', surface: 'quote', locale: 'es-MX', now: LIVE })
  assert.ok(es.ok && es.copySha256 === NOTICE_VERSIONS['quote-2026-09-16-r2'].copySha256.es)
})

test('a version is not accepted before its live day (America/New_York)', () => {
  for (const version of Object.keys(NOTICE_VERSIONS)) {
    const surface = NOTICE_VERSIONS[version].surfaces[0]
    const before = resolveNotice({ version, surface, locale: 'en', now: new Date('2026-09-16T03:59:59Z') })
    assert.deepEqual(before, { ok: false, reason: 'unknown_notice_version', detail: 'not_live' }, version)
    const midnightEt = resolveNotice({ version, surface, locale: 'en', now: new Date('2026-09-16T04:00:00Z') })
    assert.equal(midnightEt.ok, true, version)
  }
  assert.equal(NOTICE_POLICY_START.toISOString(), '2026-09-16T04:00:00.000Z')
})

test('stored events are re-checked: a hash for another locale or surface does not match', () => {
  const q = NOTICE_VERSIONS['quote-2026-09-16-r2']
  const good = { noticeVersion: 'quote-2026-09-16-r2', noticeCopySha256: q.copySha256.en, locale: 'en', surface: 'quote' }
  assert.equal(storedNoticeMatchesRegistry(good), true)
  assert.equal(storedNoticeMatchesRegistry({ ...good, locale: 'es' }), false, 'EN hash stored with ES locale')
  assert.equal(storedNoticeMatchesRegistry({ ...good, surface: 'contact' }), false)
  assert.equal(storedNoticeMatchesRegistry({ ...good, surface: 'not_a_surface' }), false)
  assert.equal(storedNoticeMatchesRegistry({ ...good, noticeCopySha256: '0'.repeat(64) }), false)
  assert.equal(storedNoticeMatchesRegistry({ ...good, noticeVersion: 'nope' }), false)
  assert.equal(storedNoticeMatchesRegistry({ ...good, noticeVersion: 'quote-2026-09-16' }), false, 'a removed first-release id')
  assert.equal(storedNoticeMatchesRegistry({ ...good, noticeVersion: null }), false)
  assert.equal(storedNoticeMatchesRegistry({ ...good, locale: null }), false)
  //  One version on two surfaces: the contact copy matches on both.
  const c = NOTICE_VERSIONS['contact-2026-09-16-r2']
  const contact = { noticeVersion: 'contact-2026-09-16-r2', noticeCopySha256: c.copySha256.es, locale: 'es', surface: 'contact' }
  assert.equal(storedNoticeMatchesRegistry(contact), true)
  assert.equal(storedNoticeMatchesRegistry({ ...contact, surface: 'contact_support' }), true)
  assert.equal(storedNoticeMatchesRegistry({ ...contact, surface: 'tracker' }), false)
})

test('only the three EXISTING-template sequences exist; every surface permits lead_nurture, and quote/booking only their own extra', () => {
  //  Owner direction 2026-09-16: every genuine submission enters the most
  //  relevant EXISTING sequence. No new kind (and so no new template) appears.
  assert.deepEqual([...SEQUENCE_KINDS], ['quote_followup', 'abandoned_checkout', 'lead_nurture'])
  assert.deepEqual(
    Object.fromEntries(Object.entries(SURFACE_SEQUENCE_KINDS).map(([s, kinds]) => [s, [...kinds]])),
    {
      quote: ['quote_followup', 'lead_nurture'],
      booking: ['abandoned_checkout', 'lead_nurture'],
      contact: ['lead_nurture'],
      contact_support: ['lead_nurture'],
      tracker: ['lead_nurture'],
      popup: ['lead_nurture'],
    },
  )
  assert.deepEqual(Object.keys(SURFACE_SEQUENCE_KINDS).sort(), [...NOTICE_SURFACES].sort())
  for (const kinds of Object.values(SURFACE_SEQUENCE_KINDS)) {
    for (const k of kinds) assert.ok((SEQUENCE_KINDS as readonly string[]).includes(k))
    assert.equal(new Set(kinds).size, kinds.length, 'no kind listed twice on a surface')
  }
  //  A quote notice never permits abandoned-checkout recovery, and a booking
  //  notice never permits quote follow-ups: each extra kind stays on its own form.
  for (const surface of NOTICE_SURFACES) {
    assert.equal(SURFACE_SEQUENCE_KINDS[surface].includes('quote_followup'), surface === 'quote', `${surface} quote_followup`)
    assert.equal(SURFACE_SEQUENCE_KINDS[surface].includes('abandoned_checkout'), surface === 'booking', `${surface} abandoned_checkout`)
  }
})

// ── leadBasisReplaceableBy: a newer notice replaces a lead's basis only when
//    it keeps every LEAD-scoped sequence (abandoned_checkout is booking-scoped
//    and ignored). The table is typed out, not derived from the registry.
test('leadBasisReplaceableBy — full truth table over null, unknown and all six surfaces', () => {
  type Row = Record<(typeof NOTICE_SURFACES)[number], boolean>
  const ALL_TRUE: Row = { quote: true, booking: true, contact: true, contact_support: true, tracker: true, popup: true }
  //  Only a quote basis can lose something (quote_followup): it is kept unless
  //  the newer notice is also a quote notice.
  const QUOTE_ONLY: Row = { quote: true, booking: false, contact: false, contact_support: false, tracker: false, popup: false }
  const TABLE: Array<[string | null | undefined, Row]> = [
    //  No basis yet, or a stored surface the registry does not know: replaceable.
    [null, ALL_TRUE],
    [undefined, ALL_TRUE],
    ['', ALL_TRUE],
    ['not_a_surface', ALL_TRUE],
    ['QUOTE', ALL_TRUE],
    //  quote → anything but quote would drop running quote follow-ups.
    ['quote', QUOTE_ONLY],
    //  booking's abandoned_checkout lives on the booking, not the lead: its
    //  lead-scoped set is just lead_nurture, which every surface permits.
    ['booking', ALL_TRUE],
    ['contact', ALL_TRUE],
    ['contact_support', ALL_TRUE],
    ['tracker', ALL_TRUE],
    ['popup', ALL_TRUE],
  ]
  let cells = 0
  for (const [current, row] of TABLE) {
    assert.deepEqual(Object.keys(row).sort(), [...NOTICE_SURFACES].sort(), 'every next surface has a cell')
    for (const next of NOTICE_SURFACES) {
      assert.equal(leadBasisReplaceableBy(current, next), row[next], `${JSON.stringify(current)} → ${next}`)
      cells++
    }
  }
  assert.equal(cells, 11 * 6)
  //  Every known surface appears as a current basis in the table.
  for (const surface of NOTICE_SURFACES) {
    assert.ok(TABLE.some(([current]) => current === surface), `${surface} row`)
  }

  //  The spec's named cases, spelled out.
  assert.equal(leadBasisReplaceableBy('quote', 'contact'), false, 'quote → contact: quote_followup would be lost')
  assert.equal(leadBasisReplaceableBy('quote', 'popup'), false)
  assert.equal(leadBasisReplaceableBy('quote', 'booking'), false, 'booking does not permit quote_followup')
  assert.equal(leadBasisReplaceableBy('contact', 'quote'), true)
  assert.equal(leadBasisReplaceableBy('popup', 'contact'), true)
  assert.equal(leadBasisReplaceableBy('booking', 'contact'), true, 'abandoned_checkout is booking-scoped, ignored')
  assert.equal(leadBasisReplaceableBy('contact', 'booking'), true)
  assert.equal(leadBasisReplaceableBy('contact_support', 'popup'), true)
  assert.equal(leadBasisReplaceableBy('quote', 'quote'), true, 'same surface')
})

test('the opt-out labels and privacy link are the spec strings', () => {
  assert.equal(OPT_OUT_LABELS.en, "Don't send me follow-up or marketing emails. This won't affect your quote or our reply.")
  assert.equal(OPT_OUT_LABELS.es, 'No quiero recibir correos de seguimiento ni de marketing. Esto no afecta tu cotización ni nuestra respuesta.')
  assert.equal(PRIVACY_POLICY_PATH, '/privacy/')
})
