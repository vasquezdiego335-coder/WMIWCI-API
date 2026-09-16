// ════════════════════════════════════════════════════════════════════════
//  NOTICE REGISTRY — the ONLY marketing notice versions the server accepts
//  (email consent release 2026-09-16, DESIGN-v2 §3).
//  ---------------------------------------------------------------------
//  WHY A SERVER REGISTRY. Before this, `consentVersion` was free text of up to
//  40 characters sent by the browser, and `consentSource` was whatever the
//  page claimed. Anyone with curl could record "the visitor saw version X on
//  the booking form". A record the sender cannot prove is not evidence.
//
//  So a notice is identified by a version id that must exist HERE, for the
//  surface the ROUTE derives (never the body) and the locale the page rendered.
//  Anything else — an unknown id, the quote notice claimed on the contact
//  route, a Spanish hash for an English page, a version before it went live —
//  is treated as ABSENT: no basis, and the route records `basis_withheld` with
//  reason 'unknown_notice_version'.
//
//  THE COPY IS PINNED BY HASH. The site renders these strings verbatim, and a
//  site test hashes the rendered text with the algorithm below. Changing a
//  word means a NEW version id, never an edit to an existing one: events
//  already recorded name the old id and must keep resolving to the text that
//  was actually shown.
//
//  HASH ALGORITHM (share this description with the site test verbatim):
//    SHA-256, lowercase hex, of the UTF-8 bytes of the text after every run of
//    whitespace is collapsed to a single space and the result is trimmed.
//
//  Pure: no database, no network, no environment.
// ════════════════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto'

/** Plain-language statement of the hash, for tests and documentation. */
export const NOTICE_HASH_ALGORITHM =
  'sha256 hex of the UTF-8 text after collapsing every whitespace run to one space and trimming'

/** Locales a notice is registered in. */
export const NOTICE_LOCALES = ['en', 'es'] as const
export type NoticeLocale = (typeof NOTICE_LOCALES)[number]

/**
 * Capture surfaces. DERIVED BY THE ROUTE, never read from a request body:
 *   quote           — POST /api/leads/quote-capture   (quote.html)
 *   booking         — POST /api/leads/partial (Step-1 Continue) and POST /api/bookings
 *   contact         — POST /api/contact, topic 'quote' (getting a quote / planning a move)
 *   contact_support — POST /api/contact, topic 'booking' or 'other' (an existing
 *                     booking, anything else): the team is alerted first, then
 *                     the general lead nurture (see SURFACE_SEQUENCE_KINDS)
 *   tracker         — POST /api/notify/lead forwarded by the tracker landing page
 *   popup           — POST /api/leads/offer-signup (10%-off popup)
 */
export const NOTICE_SURFACES = ['quote', 'booking', 'contact', 'contact_support', 'tracker', 'popup'] as const
export type NoticeSurface = (typeof NOTICE_SURFACES)[number]

/**
 * Scenario sequences. A notice basis only ever permits the sequence tied to
 * the submission that recorded it (see SURFACE_SEQUENCE_KINDS).
 *
 * ONLY EXISTING TEMPLATES (owner direction 2026-09-16: no new templates; the
 * one copy change is the lead-nurture footer, corrected so it no longer claims
 * an opt-in). Every kind is an existing sequence with its existing cadence:
 *   quote_followup     — quote-followup-1/2/final (+24h/+3d/+7d): a real
 *                        server quote exists
 *   abandoned_checkout — abandoned-checkout 1/2/3 (+45m/+24h/+72h): a booking
 *                        was submitted and not paid
 *   lead_nurture       — lead-nurture-1/2/final (+4h/+24h/+72h): the general
 *                        follow-up for everyone else who gave us an email
 */
export const SEQUENCE_KINDS = [
  'quote_followup', // Sequence A — a real server quote exists
  'abandoned_checkout', // booking submitted, not paid
  'lead_nurture', // Sequence B — the general follow-up
] as const
export type SequenceKind = (typeof SEQUENCE_KINDS)[number]

/**
 * Which sequences a notice recorded on each surface may start (owner direction
 * 2026-09-16: every genuine submission enters the most relevant EXISTING
 * sequence):
 *   quote            — a priced quote → quote_followup; no price → lead_nurture
 *   booking          — the contact step's Continue click → lead_nurture; the
 *                      submitted, unpaid booking → abandoned_checkout
 *   contact, contact_support (every topic, answered first), tracker, popup
 *                    → lead_nurture
 * The route names the one sequence its submission starts; this table only
 * bounds which a stored notice may ever permit.
 */
export const SURFACE_SEQUENCE_KINDS: Readonly<Record<NoticeSurface, readonly SequenceKind[]>> = {
  quote: ['quote_followup', 'lead_nurture'],
  booking: ['abandoned_checkout', 'lead_nurture'],
  contact: ['lead_nurture'],
  contact_support: ['lead_nurture'],
  tracker: ['lead_nurture'],
  popup: ['lead_nurture'],
}

/**
 * May a LEAD's stored basis (recorded on `currentSurface`) be replaced by a
 * newer notice from `nextSurface`? Only when the newer one permits every
 * lead-scoped sequence the current one does. Several forms merge into the
 * person's newest open lead; replacing a quote notice with, say, a contact
 * notice would end that lead's running quote follow-ups at send time.
 */
export function leadBasisReplaceableBy(currentSurface: string | null | undefined, nextSurface: NoticeSurface): boolean {
  if (!currentSurface || !isNoticeSurface(currentSurface)) return true
  const leadKinds = (s: NoticeSurface) => SURFACE_SEQUENCE_KINDS[s].filter((k) => k !== 'abandoned_checkout')
  const next = leadKinds(nextSurface)
  return leadKinds(currentSurface).every((k) => next.includes(k))
}

/**
 * Every registered notice is an INFORMATIONAL notice: submitting a form after
 * seeing it may lead to promotional email. It is never recorded as an opt-in
 * (owner direction 2026-09-16: no separate opt-in or confirmation step, and a
 * form submission is never labelled an explicit opt-in).
 */
export type NoticeBasis = 'notice'

export type NoticeVersion = {
  /** Surfaces this copy is rendered on. */
  surfaces: readonly NoticeSurface[]
  /** The exact copy, per locale. */
  locales: Readonly<Record<NoticeLocale, string>>
  /** SHA-256 of `locales[locale]` under NOTICE_HASH_ALGORITHM. */
  copySha256: Readonly<Record<NoticeLocale, string>>
  /** First day (America/New_York) the copy may be accepted. */
  liveFrom: string
  /** Last day it may be accepted, once retired. Absent = still live. */
  liveUntil?: string
  basis: NoticeBasis
}

/** Collapse whitespace runs to one space and trim — the text that is hashed. */
export function normalizeNoticeText(text: string): string {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

/** SHA-256 (lowercase hex) of normalizeNoticeText(text), UTF-8. */
export function noticeCopySha256(text: string): string {
  return createHash('sha256').update(normalizeNoticeText(text), 'utf8').digest('hex')
}

/**
 * THE REGISTRY. Do not edit copy in place — add a new version.
 * The hashes are literal on purpose: a test recomputes each one from the text,
 * so an accidental edit to a string fails loudly instead of silently changing
 * what old events claim was shown.
 *
 * r2 (owner direction 2026-09-16): submitting an email through any form may
 * lead to promotional email, with no separate opt-in or confirmation step. The
 * first-release versions (…-2026-09-16, including the popup confirm-by-email
 * copy) were never deployed and recorded no events, so they are removed rather
 * than retired. FLAGGED FOR OWNER / LEGAL REVIEW before launch.
 * Spanish register follows each page: usted on quote.html and contact.html,
 * tú on booking-form.html, the popup and the tracker landing page.
 */
export const NOTICE_VERSIONS: Readonly<Record<string, NoticeVersion>> = {
  'quote-2026-09-16-r2': {
    surfaces: ['quote'],
    locales: {
      en: 'Move It Clear It will email you about this quote request. Submitting your email may also lead to promotional emails from us, such as quote follow-ups and offers on our moving services. To stop them, use the unsubscribe link in any of those emails.',
      es: 'Move It Clear It le enviará correos sobre esta solicitud de cotización. Al enviar su correo, también podría recibir correos promocionales de nuestra parte, como seguimientos de su cotización y ofertas de nuestros servicios de mudanza. Para dejar de recibirlos, use el enlace para darse de baja en cualquiera de esos correos.',
    },
    copySha256: {
      en: '52937814a6a558798b9fa5482f551c28710c504f1d7f4445414e6adb573e6976',
      es: '6b3995b605e03580fcb855ed9324a0584d3eaf6a0b3e0812d3a7ad929abd28ad',
    },
    liveFrom: '2026-09-16',
    basis: 'notice',
  },
  'booking-2026-09-16-r2': {
    surfaces: ['booking'],
    locales: {
      en: 'Move It Clear It will email you about this booking request. Submitting your email may also lead to promotional emails from us, such as follow-ups, reminders to finish your booking and offers on our moving services. To stop them, use the unsubscribe link in any of those emails.',
      es: 'Move It Clear It te enviará correos sobre esta solicitud de reserva. Al enviar tu correo, también podrías recibir correos promocionales de nuestra parte, como seguimientos, recordatorios para terminar tu reserva y ofertas de nuestros servicios de mudanza. Para dejar de recibirlos, usa el enlace para darte de baja en cualquiera de esos correos.',
    },
    copySha256: {
      en: '657b6bcae274cdb1de6228a310e2d85d6f6ab156ec6c6a01d615b57012ddddbf',
      es: '497b8329faeebcdff02df6c903f1bc612275edc46d2ca674ae0d8379439ca3d4',
    },
    liveFrom: '2026-09-16',
    basis: 'notice',
  },
  'contact-2026-09-16-r2': {
    surfaces: ['contact', 'contact_support'],
    locales: {
      en: 'Move It Clear It will reply to your message first. Submitting your email may also lead to promotional emails from us, such as follow-ups and offers on our moving services. To stop them, use the unsubscribe link in any of those emails.',
      es: 'Move It Clear It primero responderá a su mensaje. Al enviar su correo, también podría recibir correos promocionales de nuestra parte, como seguimientos y ofertas de nuestros servicios de mudanza. Para dejar de recibirlos, use el enlace para darse de baja en cualquiera de esos correos.',
    },
    copySha256: {
      en: '6df4f878e7767393c53f6c15df99f3a139a7f8d5eb3306edbdccff5c98982818',
      es: 'c42a1f5bcbd2f72f6a0469b3bb546df686b42e7008fb76e94d867d1521bd6280',
    },
    liveFrom: '2026-09-16',
    basis: 'notice',
  },
  'popup-2026-09-16-r2': {
    surfaces: ['popup'],
    locales: {
      en: 'Your 10% code appears here right away. Submitting your email may also lead to promotional emails from Move It Clear It, such as follow-ups and offers on our moving services. To stop them, use the unsubscribe link in any of those emails.',
      es: 'Tu código del 10% aparece aquí de inmediato. Al enviar tu correo, también podrías recibir correos promocionales de Move It Clear It, como seguimientos y ofertas de nuestros servicios de mudanza. Para dejar de recibirlos, usa el enlace para darte de baja en cualquiera de esos correos.',
    },
    copySha256: {
      en: 'b1448afba02c6cde32c318fa6c90d1255614446e68037edc00524c0d3a8682f5',
      es: 'f6fa0f425346739876f3a66ef44693cfd51cb7ad9c08fa45195dd0f00bbcf3aa',
    },
    liveFrom: '2026-09-16',
    basis: 'notice',
  },
  'tracker-2026-09-16-r2': {
    surfaces: ['tracker'],
    locales: {
      en: 'Move It Clear It will contact you about this request. Submitting your email may also lead to promotional emails from us, such as follow-ups and offers on our moving services. To stop them, use the unsubscribe link in any of those emails.',
      es: 'Move It Clear It se comunicará contigo sobre esta solicitud. Al enviar tu correo, también podrías recibir correos promocionales de nuestra parte, como seguimientos y ofertas de nuestros servicios de mudanza. Para dejar de recibirlos, usa el enlace para darte de baja en cualquiera de esos correos.',
    },
    copySha256: {
      en: '5e1d926ace3d66f45f83d9601ea7e4ca896ccd244e25ba122ffc78372cf3cfa1',
      es: '29ff5d77dc4bab530d4fe3e5c6e058b8a2e577e5229125269f7aa9e1ea898be1',
    },
    liveFrom: '2026-09-16',
    basis: 'notice',
  },
}

/**
 * The opt-out checkbox label rendered directly below each notice. Not hashed
 * (the box state is recorded, not the label), but pinned by the site tests.
 */
export const OPT_OUT_LABELS: Readonly<Record<NoticeLocale, string>> = {
  en: "Don't send me follow-up or marketing emails. This won't affect your quote or our reply.",
  es: 'No quiero recibir correos de seguimiento ni de marketing. Esto no afecta tu cotización ni nuestra respuesta.',
}

/** Every notice is followed by this Privacy Policy link. */
export const PRIVACY_POLICY_PATH = '/privacy/'

/** Map a page locale ('es', 'ES', 'es-US', 'es_MX') to a registered locale, or null. */
export function normalizeNoticeLocale(locale: string | null | undefined): NoticeLocale | null {
  if (typeof locale !== 'string') return null
  const primary = locale.trim().toLowerCase().split(/[-_]/)[0]
  return (NOTICE_LOCALES as readonly string[]).includes(primary) ? (primary as NoticeLocale) : null
}

export function isNoticeSurface(v: unknown): v is NoticeSurface {
  return typeof v === 'string' && (NOTICE_SURFACES as readonly string[]).includes(v)
}

export function isSequenceKind(v: unknown): v is SequenceKind {
  return typeof v === 'string' && (SEQUENCE_KINDS as readonly string[]).includes(v)
}

/** Midnight America/New_York on a YYYY-MM-DD day, as an instant. EDT/EST aware. */
function startOfDayNewYork(day: string): Date {
  // Two candidate offsets; the right one is the one whose local date is `day`.
  for (const offset of ['-04:00', '-05:00']) {
    const d = new Date(`${day}T00:00:00${offset}`)
    const local = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(d)
    const get = (t: string) => local.find((p) => p.type === t)?.value
    if (`${get('year')}-${get('month')}-${get('day')}` === day && get('hour') === '00') return d
  }
  return new Date(`${day}T05:00:00Z`)
}

export type ResolvedNotice = {
  ok: true
  version: string
  surface: NoticeSurface
  locale: NoticeLocale
  basis: NoticeBasis
  copySha256: string
  text: string
}

export type NoticeRejection = {
  ok: false
  /** Always recorded as withheld reason 'unknown_notice_version'. */
  reason: 'unknown_notice_version'
  /** Which check failed — for logs only, never shown to the visitor. */
  detail: 'missing_version' | 'unknown_version' | 'wrong_surface' | 'wrong_locale' | 'not_live'
}

/**
 * Resolve a browser-supplied notice version against the route's own surface
 * and the page's locale. Anything that does not match EXACTLY is absent.
 *
 * @param input.surface the surface the ROUTE derived — never the body's claim
 * @param input.locale  the locale the page rendered; missing or unsupported = absent
 */
export function resolveNotice(input: {
  version: string | null | undefined
  surface: NoticeSurface
  locale: string | null | undefined
  now?: Date
}): ResolvedNotice | NoticeRejection {
  const reject = (detail: NoticeRejection['detail']): NoticeRejection => ({
    ok: false,
    reason: 'unknown_notice_version',
    detail,
  })
  const version = typeof input.version === 'string' ? input.version.trim() : ''
  if (!version) return reject('missing_version')
  if (!Object.prototype.hasOwnProperty.call(NOTICE_VERSIONS, version)) return reject('unknown_version')
  const entry = NOTICE_VERSIONS[version]
  if (!entry.surfaces.includes(input.surface)) return reject('wrong_surface')
  const locale = normalizeNoticeLocale(input.locale)
  if (!locale) return reject('wrong_locale')
  const now = input.now ?? new Date()
  if (now.getTime() < startOfDayNewYork(entry.liveFrom).getTime()) return reject('not_live')
  if (entry.liveUntil) {
    const end = startOfDayNewYork(entry.liveUntil).getTime() + 24 * 60 * 60 * 1000
    if (now.getTime() >= end) return reject('not_live')
  }
  return {
    ok: true,
    version,
    surface: input.surface,
    locale,
    basis: entry.basis,
    copySha256: entry.copySha256[locale],
    text: entry.locales[locale],
  }
}

/**
 * Does a STORED event still describe registered copy? Used at send time so a
 * row written by anything other than resolveNotice (a hand-edited database, a
 * future bug) cannot become a basis: the version must exist, list the surface,
 * and its registered hash for the stored locale must equal the stored hash.
 */
export function storedNoticeMatchesRegistry(event: {
  noticeVersion: string | null
  noticeCopySha256: string | null
  locale: string | null
  surface: string
}): boolean {
  if (!event.noticeVersion || !event.noticeCopySha256) return false
  if (!Object.prototype.hasOwnProperty.call(NOTICE_VERSIONS, event.noticeVersion)) return false
  const entry = NOTICE_VERSIONS[event.noticeVersion]
  if (!isNoticeSurface(event.surface) || !entry.surfaces.includes(event.surface)) return false
  const locale = normalizeNoticeLocale(event.locale)
  if (!locale) return false
  return entry.copySha256[locale] === event.noticeCopySha256
}

/** NOTICE_POLICY_START: a notice recorded before this instant is never a basis. */
export const NOTICE_POLICY_START_DAY = '2026-09-16'
export const NOTICE_POLICY_START: Date = startOfDayNewYork(NOTICE_POLICY_START_DAY)
