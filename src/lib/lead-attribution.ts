// ════════════════════════════════════════════════════════════════════════
//  lead-attribution.ts — THE evidence-based channel classifier for a Lead.
//
//  WHY THIS EXISTS (owner spec 2026-08-03). Every lead whose channel we did
//  not recognise landed in LeadSource.OTHER, which meant three completely
//  different situations were indistinguishable in the admin:
//     • someone typed the URL / used a bookmark          -> genuinely DIRECT
//     • someone arrived from a site we do not classify   -> genuinely UNKNOWN
//     • someone arrived correctly tagged from a channel  -> a MAPPING BUG
//  A door-hanger QR scan was hitting the third case: js/site-copy.js cloaks
//  utm_* out of the address bar into sessionStorage, so by the time a form
//  read location.search the tags were gone and every scan read as OTHER.
//
//  THE ONE RULE THIS MODULE ENFORCES: never claim attribution we do not have.
//  ORGANIC_SEARCH is returned ONLY when a search engine actually referred the
//  visit (or an explicit organic tag says so). An unattributed visitor is
//  DIRECT when there is no external referrer at all, and UNKNOWN when there
//  IS a referrer we cannot classify. Guessing "organic" for the unattributed
//  is what makes an ad budget look free.
//
//  PURE + OFFLINE. No prisma, no env, no network — so the whole precedence
//  ladder is unit-tested in lead-attribution.test.ts.
// ════════════════════════════════════════════════════════════════════════
import { LeadSource } from '@prisma/client'

/** Everything the browser can honestly tell us about how a visit began. */
export type AttributionEvidence = {
  /** The form's own free-form source string (may be an internal page marker). */
  source?: string | null
  utmSource?: string | null
  utmMedium?: string | null
  utmCampaign?: string | null
  /** Google Ads click id. Its mere presence is proof of a paid click. */
  gclid?: string | null
  /** Facebook click id. Proof of a Facebook/Instagram referral, not of paid. */
  fbclid?: string | null
  /** document.referrer as sent by the browser. */
  referrer?: string | null
  /** The page the visitor landed on (used only to recognise our own host). */
  landingPage?: string | null
}

// ── Explicit source strings ─────────────────────────────────────────────
// Kept as a plain map so an integration can name its channel directly. This
// is the ORIGINAL SOURCE_MAP, preserved key-for-key, plus the values the
// 2026-08-03 spec added. Nothing was removed: existing callers that send
// 'contact-form' must keep resolving to WEBSITE.
const SOURCE_MAP: Record<string, LeadSource> = {
  google: LeadSource.GOOGLE,
  'google-business': LeadSource.GOOGLE,
  gbp: LeadSource.GOOGLE,
  facebook: LeadSource.FACEBOOK,
  fb: LeadSource.FACEBOOK,
  messenger: LeadSource.FACEBOOK,
  instagram: LeadSource.INSTAGRAM,
  ig: LeadSource.INSTAGRAM,
  tiktok: LeadSource.TIKTOK,
  tt: LeadSource.TIKTOK,
  door_hanger: LeadSource.DOOR_HANGER,
  'door-hanger': LeadSource.DOOR_HANGER,
  doorhanger: LeadSource.DOOR_HANGER,
  yard_sign: LeadSource.YARD_SIGN,
  'yard-sign': LeadSource.YARD_SIGN,
  referral: LeadSource.REFERRAL,
  craigslist: LeadSource.CRAIGSLIST,
  offerup: LeadSource.OFFERUP,
  marketplace: LeadSource.MARKETPLACE,
  'facebook-marketplace': LeadSource.MARKETPLACE,
  'fb-marketplace': LeadSource.MARKETPLACE,
  nextdoor: LeadSource.MARKETPLACE,
  returning: LeadSource.RETURNING_CUSTOMER,
  returning_customer: LeadSource.RETURNING_CUSTOMER,
  website: LeadSource.WEBSITE,
  contact: LeadSource.WEBSITE,
  'contact-form': LeadSource.WEBSITE,
  web: LeadSource.WEBSITE,
  // ── Added 2026-08-03 ──
  qr: LeadSource.QR_CODE,
  'qr-code': LeadSource.QR_CODE,
  qr_code: LeadSource.QR_CODE,
  qrcode: LeadSource.QR_CODE,
  google_ads: LeadSource.GOOGLE_ADS,
  'google-ads': LeadSource.GOOGLE_ADS,
  googleads: LeadSource.GOOGLE_ADS,
  adwords: LeadSource.GOOGLE_ADS,
  organic: LeadSource.ORGANIC_SEARCH,
  organic_search: LeadSource.ORGANIC_SEARCH,
  'organic-search': LeadSource.ORGANIC_SEARCH,
  direct: LeadSource.DIRECT,
}

/**
 * Map a single free-form source string to the enum.
 *
 * UNCHANGED CONTRACT (2026-07-15): an unrecognised or missing string returns
 * OTHER. Callers that need evidence-based classification must use
 * `classifyLeadSource`, which treats this OTHER as "no explicit answer" and
 * goes looking at the UTM/referrer evidence instead. Keeping the primitive
 * honest is what lets the classifier tell "unmapped" from "mapped".
 */
export function mapLeadSource(source?: string | null): LeadSource {
  const key = (source ?? '').trim().toLowerCase()
  return SOURCE_MAP[key] ?? LeadSource.OTHER
}

// ── Internal page markers ───────────────────────────────────────────────
// `src` doubles as a PAGE marker on this site ("which widget did they use"),
// which is not a channel. Treating HOME_ESTIMATE_STARTER as a traffic source
// is how a lead ends up attributed to our own homepage. These are recorded
// verbatim in Lead.sourceDetail and excluded from channel classification.
const INTERNAL_SOURCE_MARKERS = new Set([
  'quick_quote_form',
  'quote',
  'home_estimate_starter',
  'pricing_estimate_starter',
  'estimate_starter',
  'booking-form',
  'booking_form',
  'partial-lead',
  'marketing-tracker',
])

export function isInternalSourceMarker(source?: string | null): boolean {
  return INTERNAL_SOURCE_MARKERS.has((source ?? '').trim().toLowerCase())
}

// ── Referrer host tables ────────────────────────────────────────────────
const SEARCH_HOSTS = [
  'google.', 'bing.', 'duckduckgo.', 'search.yahoo.', 'yahoo.',
  'ecosia.org', 'startpage.com', 'search.brave.com', 'baidu.com', 'yandex.',
  'qwant.com', 'lycos.com', 'ask.com', 'aol.',
]
const HOST_CHANNELS: Array<[string[], LeadSource]> = [
  [['facebook.com', 'fb.com', 'fb.me', 'messenger.com', 'm.facebook.com', 'l.facebook.com', 'lm.facebook.com'], LeadSource.FACEBOOK],
  [['instagram.com', 'l.instagram.com'], LeadSource.INSTAGRAM],
  [['tiktok.com', 'vm.tiktok.com'], LeadSource.TIKTOK],
  [['craigslist.org'], LeadSource.CRAIGSLIST],
  [['offerup.com'], LeadSource.OFFERUP],
  [['nextdoor.com', 'marketplace.'], LeadSource.MARKETPLACE],
  [['thumbtack.com', 'yelp.com', 'angi.com', 'homeadvisor.com', 'bark.com'], LeadSource.REFERRAL],
]

/** Our own hosts — a referrer from one of these is internal navigation, not a
 *  referral, and must never be read as "someone sent them to us". */
const OWN_HOSTS = ['moveitclearit.com', 'wemoveitweclearit.com', 'localhost', '127.0.0.1']

function hostOf(url?: string | null): string | null {
  const raw = (url ?? '').trim()
  if (!raw) return null
  try {
    return new URL(raw).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return null
  }
}

function isOwnHost(host: string | null): boolean {
  if (!host) return false
  return OWN_HOSTS.some((h) => host === h || host.endsWith('.' + h))
}

/** Paid-search mediums. `display`/`social` are deliberately NOT here — they
 *  identify the format, not the search product, and would mislabel paid
 *  Facebook traffic as Google Ads. */
const PAID_MEDIUMS = new Set(['cpc', 'ppc', 'paid', 'paidsearch', 'paid_search', 'paid-search', 'sem', 'adwords'])

const lower = (v?: string | null) => (v ?? '').trim().toLowerCase()

/**
 * THE classifier. Returns the channel the evidence actually supports.
 *
 * PRECEDENCE (first match wins) — ordered most-specific-evidence first:
 *   1. an explicit, recognised source string (an integration naming itself)
 *   2. paid-click proof: gclid, or a paid medium
 *   3. door hanger  (a door-hanger QR is a DOOR HANGER, not a generic QR)
 *   4. QR code
 *   5. referral tagging
 *   6. a recognised utm_source
 *   7. the referring host
 *   8. DIRECT   — no tags, no click id, no external referrer
 *   9. UNKNOWN  — everything else (referred by a host we cannot classify)
 */
export function classifyLeadSource(ev: AttributionEvidence): LeadSource {
  const src = lower(ev.utmSource)
  const medium = lower(ev.utmMedium)
  const campaign = lower(ev.utmCampaign)
  // `src` (the page marker) is included in the probe on purpose: old QR codes
  // carry their channel there and nowhere else.
  const probe = [src, medium, campaign, lower(ev.source)].join(' ')

  const refHost = hostOf(ev.referrer)
  const externalRef = refHost && !isOwnHost(refHost) ? refHost : null

  // 1 ── PAID-CLICK PROOF OUTRANKS EVERYTHING, including an explicit source
  //      string. This ordering is load-bearing: booking-form.html derives its
  //      `source` from utm_source, so a Google Ads click arrives as
  //      source='google' WITH a gclid. Checking the explicit string first
  //      answered GOOGLE (the free Business Profile) and made paid traffic
  //      look free — the precise failure this module exists to prevent.
  //      A gclid is only ever minted by Google Ads.
  if (lower(ev.gclid)) return LeadSource.GOOGLE_ADS
  if (PAID_MEDIUMS.has(medium)) {
    if (src.includes('google') || src.includes('adwords')) return LeadSource.GOOGLE_ADS
    if (src.includes('facebook') || src.includes('fb') || src.includes('meta')) return LeadSource.FACEBOOK
    if (src.includes('instagram') || src === 'ig') return LeadSource.INSTAGRAM
    if (src.includes('tiktok')) return LeadSource.TIKTOK
    // A paid click we cannot attribute to a platform (Bing, a network we do
    // not model, or a medium with no source at all). It is NOT Google Ads —
    // reporting it as such would credit spend to the wrong platform, which is
    // worse than admitting we do not know.
    return LeadSource.UNKNOWN
  }

  // 2 ── An explicit, recognised source string. Internal page markers
  //      ("QUICK_QUOTE_FORM") are skipped: they say WHICH FORM, not which
  //      channel, and answering with them would bury the real answer.
  if (!isInternalSourceMarker(ev.source)) {
    const explicit = mapLeadSource(ev.source)
    if (explicit !== LeadSource.OTHER) return explicit
  }

  // 3 ── Door hanger before QR: our /qr short link IS the door-hanger code
  //      (utm_medium=doorhanger). Reporting those as "QR" would erase the
  //      only channel the owner actually pays to print.
  if (/door[_-]?hanger/.test(probe)) return LeadSource.DOOR_HANGER
  if (/yard[_-]?sign/.test(probe)) return LeadSource.YARD_SIGN

  // 4 ── A QR scan with no more specific print channel attached.
  if (/\bqr\b|qr[_-]?code|qrcode/.test(probe)) return LeadSource.QR_CODE

  // 5 ── Referral tagging.
  if (/referr?als?\b/.test(probe)) return LeadSource.REFERRAL

  // 6 ── A recognised utm_source.
  if (src) {
    const mapped = mapLeadSource(src)
    if (mapped !== LeadSource.OTHER) return mapped
    if (src.includes('facebook') || src.includes('meta')) return LeadSource.FACEBOOK
    if (src.includes('instagram')) return LeadSource.INSTAGRAM
    if (src.includes('tiktok')) return LeadSource.TIKTOK
    if (src.includes('google')) {
      // Tagged google traffic that is not paid: Business Profile / organic.
      return LeadSource.GOOGLE
    }
  }

  // 7 ── The referring host. This is the ONLY route to ORGANIC_SEARCH
  //      without an explicit organic tag.
  if (externalRef) {
    if (SEARCH_HOSTS.some((h) => externalRef.includes(h))) return LeadSource.ORGANIC_SEARCH
    for (const [hosts, channel] of HOST_CHANNELS) {
      if (hosts.some((h) => externalRef.includes(h))) return channel
    }
    // An fbclid alongside an unclassifiable referrer still proves Facebook.
    if (lower(ev.fbclid)) return LeadSource.FACEBOOK
    // Referred by someone we cannot name. NOT organic, NOT direct.
    return LeadSource.UNKNOWN
  }

  // An fbclid with no referrer at all (in-app browser strips it) is still
  // proof the click came from Meta.
  if (lower(ev.fbclid)) return LeadSource.FACEBOOK

  // 8 ── No tags, no click id, no external referrer: typed, bookmarked, or
  //      opened from a messaging app that sends no referrer. DIRECT is the
  //      honest label — this is a real category, not a failure.
  if (!src && !medium && !campaign) return LeadSource.DIRECT

  // 9 ── Tagged with something we could not place. Say so.
  return LeadSource.UNKNOWN
}

/** Human label for the admin UI. Kept beside the enum so a new value cannot
 *  be added without a display name. */
export const LEAD_SOURCE_LABELS: Record<LeadSource, string> = {
  DIRECT: 'Direct',
  ORGANIC_SEARCH: 'Organic search',
  GOOGLE: 'Google Business',
  GOOGLE_ADS: 'Google Ads',
  FACEBOOK: 'Facebook',
  INSTAGRAM: 'Instagram',
  TIKTOK: 'TikTok',
  MARKETPLACE: 'Marketplace',
  CRAIGSLIST: 'Craigslist',
  OFFERUP: 'OfferUp',
  REFERRAL: 'Referral',
  DOOR_HANGER: 'Door hanger',
  YARD_SIGN: 'Yard sign',
  QR_CODE: 'QR code',
  RETURNING_CUSTOMER: 'Returning customer',
  WEBSITE: 'Website',
  UNKNOWN: 'Unknown',
  OTHER: 'Other',
}

export function leadSourceLabel(source?: LeadSource | string | null): string {
  if (!source) return LEAD_SOURCE_LABELS.UNKNOWN
  return LEAD_SOURCE_LABELS[source as LeadSource] ?? String(source).replace(/_/g, ' ').toLowerCase()
}
