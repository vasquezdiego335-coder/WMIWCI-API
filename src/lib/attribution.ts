import { z } from 'zod'

// ─────────────────────────────────────────────────────────────────────────────
// First-party marketing attribution.
//
// public/js/attribution.js captures Google click ids (gclid/gbraid/wbraid) + UTM
// params + landing page + referrer + a first-touch timestamp (first visit wins)
// and sends them, snake_case, with the contact + booking POSTs. We sanitize and
// map them to the camelCase columns shared by Lead (utm*/landing/referrer already
// existed; gclid/gbraid/wbraid/firstTouchAt are new) and Booking.
//
// FIRST-PARTY ONLY — never forwarded to GA4 / Google Ads from the server. Ready
// for offline-conversion import keyed by gclid when Ads is connected.
// ─────────────────────────────────────────────────────────────────────────────

// Strip ASCII control chars, trim, length-cap. Click ids / UTMs are short tokens.
function attrField(max: number) {
  return z
    .string()
    .transform((v) => v.replace(/[\u0000-\u001F\u007F]/g, '').trim())
    .pipe(z.string().max(max))
    .optional()
}

/** Zod fields to spread into a request schema: `z.object({ ...base, ...attributionSchemaFields })`. */
export const attributionSchemaFields = {
  gclid: attrField(255),
  gbraid: attrField(255),
  wbraid: attrField(255),
  utm_source: attrField(150),
  utm_medium: attrField(150),
  utm_campaign: attrField(255),
  utm_term: attrField(255),
  utm_content: attrField(255),
  landing_page: attrField(600),
  initial_referrer: attrField(600),
  first_touch_at: attrField(40),
} as const

export interface AttributionInput {
  gclid?: string
  gbraid?: string
  wbraid?: string
  utm_source?: string
  utm_medium?: string
  utm_campaign?: string
  utm_term?: string
  utm_content?: string
  landing_page?: string
  initial_referrer?: string
  first_touch_at?: string
}

/** camelCase columns shared by Lead (extras) and Booking. Nulls for absent values. */
export interface AttributionColumns {
  gclid: string | null
  gbraid: string | null
  wbraid: string | null
  utmSource: string | null
  utmMedium: string | null
  utmCampaign: string | null
  utmTerm: string | null
  utmContent: string | null
  landingPage: string | null
  firstTouchAt: Date | null
}

export function attributionColumns(d: AttributionInput): AttributionColumns {
  let firstTouchAt: Date | null = null
  if (d.first_touch_at) {
    const t = new Date(d.first_touch_at)
    if (!Number.isNaN(t.getTime())) firstTouchAt = t
  }
  return {
    gclid: d.gclid ?? null,
    gbraid: d.gbraid ?? null,
    wbraid: d.wbraid ?? null,
    utmSource: d.utm_source ?? null,
    utmMedium: d.utm_medium ?? null,
    utmCampaign: d.utm_campaign ?? null,
    utmTerm: d.utm_term ?? null,
    utmContent: d.utm_content ?? null,
    landingPage: d.landing_page ?? null,
    firstTouchAt,
  }
}

/** Fields the leads.ts LeadInput accepts (adds referrer, which Lead stores separately). */
export function attributionLeadInput(d: AttributionInput): AttributionColumns & { referrer: string | null } {
  return { ...attributionColumns(d), referrer: d.initial_referrer ?? null }
}

/** True when any Google click identifier is present (a paid-click lead/booking). */
export function hasAdClickId(a: Pick<AttributionColumns, 'gclid' | 'gbraid' | 'wbraid'>): boolean {
  return Boolean(a.gclid || a.gbraid || a.wbraid)
}

/** Compact one-line summary for Discord / admin ('—' when empty). */
export function attributionSummary(a: Partial<AttributionColumns>): string {
  const parts: string[] = []
  if (a.gclid) parts.push(`gclid=${a.gclid}`)
  if (a.gbraid) parts.push(`gbraid=${a.gbraid}`)
  if (a.wbraid) parts.push(`wbraid=${a.wbraid}`)
  const utm = [a.utmSource, a.utmMedium, a.utmCampaign].filter(Boolean).join(' / ')
  if (utm) parts.push(utm)
  if (a.utmTerm) parts.push(`term=${a.utmTerm}`)
  if (a.utmContent) parts.push(`content=${a.utmContent}`)
  return parts.length ? parts.join(' · ') : '—'
}
