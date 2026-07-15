import { z } from 'zod'

// ─────────────────────────────────────────────────────────────────────────────
// First-party marketing attribution.
//
// Google click identifiers (gclid/gbraid/wbraid) + UTM parameters + first-touch
// context are captured CLIENT-SIDE by public/js/attribution.js on the marketing
// site (first visit wins) and sent along with contact + booking submissions.
//
// These are stored on the Lead / Booking record so the business can later answer
// "which campaign/keyword produced this lead" and (when Google Ads is connected)
// import offline conversions keyed by gclid. They are FIRST-PARTY ONLY — never
// forwarded to GA4 / Google Ads from the browser, and never PII.
//
// The payload uses the raw names the browser reads from the URL (snake_case);
// we normalize them to the camelCase Prisma columns here so both the contact and
// booking routes share one definition.
// ─────────────────────────────────────────────────────────────────────────────

// Strip ASCII control characters, trim, and length-cap. Click IDs / UTMs are
// short opaque tokens; anything longer than the caps below is not a real value.
function attrField(max: number) {
  return z
    .string()
    .transform((v) => v.replace(/[\u0000-\u001F\u007F]/g, '').trim())
    .pipe(z.string().max(max))
    .optional()
}

/** Zod fields to spread into a request schema: `z.object({ ...existing, ...attributionSchemaFields })`. */
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
  initialReferrer: string | null
  firstTouchAt: Date | null
}

/** Map the sanitized snake_case payload to the camelCase Lead/Booking columns. */
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
    initialReferrer: d.initial_referrer ?? null,
    firstTouchAt,
  }
}

/** True when any Google click identifier is present (a paid-click lead). */
export function hasAdClickId(a: AttributionColumns): boolean {
  return Boolean(a.gclid || a.gbraid || a.wbraid)
}

/** Compact one-line human summary for Discord / admin display ('—' when empty). */
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
