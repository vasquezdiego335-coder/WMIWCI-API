// ════════════════════════════════════════════════════════════════════════
//  address-verify.ts — SERVER-side address verification (Google Address
//  Validation API). The browser's autocomplete selection is UX only; nothing
//  the client claims (components, place_id, coordinates) is ever persisted.
//  This module is the single place a booking address becomes VERIFIED.
//
//  Degrade-safe by design (a provider outage must never lose a booking):
//    • no GOOGLE_MAPS_SERVER_KEY  → status 'skipped'  (heuristics take over)
//    • timeout / network / non-200 → status 'skipped' + reason
//    • API answers                 → 'verified' | 'partial' | 'unverified'
//  interpretVerdict() is PURE so the decision table is unit-tested offline.
//
//  Request/response shape per official docs (validated 2026-07-12):
//  POST https://addressvalidation.googleapis.com/v1:validateAddress?key=KEY
//  { address: { regionCode:'US', addressLines:[...] } } →
//  result.{ verdict{addressComplete,validationGranularity,hasUnconfirmedComponents},
//           address{formattedAddress,addressComponents[]}, geocode{location,placeId} }
// ════════════════════════════════════════════════════════════════════════

export type VerificationStatus = 'verified' | 'partial' | 'unverified' | 'skipped'

export type VerifiedAddress = {
  status: VerificationStatus
  reason?: string
  formatted?: string
  streetNumber?: string
  route?: string
  city?: string
  county?: string
  state?: string
  zip?: string
  country?: string
  lat?: number
  lng?: number
  placeId?: string
}

type Verdict = {
  addressComplete?: boolean
  validationGranularity?: string
  hasUnconfirmedComponents?: boolean
}

/** PURE decision table: Google verdict → our status. Offline-tested. */
export function interpretVerdict(v: Verdict | undefined): { status: VerificationStatus; reason?: string } {
  if (!v) return { status: 'unverified', reason: 'no_verdict' }
  const gran = v.validationGranularity ?? 'OTHER'
  const deliverable = gran === 'PREMISE' || gran === 'SUB_PREMISE'
  if (v.addressComplete && deliverable && !v.hasUnconfirmedComponents) return { status: 'verified' }
  if (deliverable) {
    // Right building, but something was inferred/unconfirmed (e.g. missing unit).
    return { status: 'partial', reason: v.hasUnconfirmedComponents ? 'unconfirmed_components' : 'incomplete' }
  }
  // ROUTE/BLOCK/OTHER granularity = street or city level only — not deliverable.
  return { status: 'unverified', reason: `granularity_${gran.toLowerCase()}` }
}

type GoogleComponent = { componentType?: string; componentName?: { text?: string } }

/** PURE: pluck structured components out of the validation response. */
export function extractComponents(components: GoogleComponent[] | undefined): Partial<VerifiedAddress> {
  const out: Partial<VerifiedAddress> = {}
  const map: Record<string, keyof VerifiedAddress> = {
    street_number: 'streetNumber',
    route: 'route',
    locality: 'city',
    sublocality_level_1: 'city', // NYC boroughs etc. — only used when locality absent
    administrative_area_level_2: 'county',
    administrative_area_level_1: 'state',
    postal_code: 'zip',
    country: 'country',
  }
  for (const c of components ?? []) {
    const key = c.componentType ? map[c.componentType] : undefined
    const text = c.componentName?.text
    if (key && text && out[key] == null) (out as Record<string, unknown>)[key] = text
  }
  return out
}

/**
 * Verify one address (best-effort, never throws). addressLines example:
 * ['123 Main St', 'West Orange, NJ 07052'].
 */
export async function verifyAddress(addressLines: string[], opts?: { timeoutMs?: number }): Promise<VerifiedAddress> {
  const key = process.env.GOOGLE_MAPS_SERVER_KEY
  const lines = addressLines.map((l) => (l ?? '').trim()).filter(Boolean)
  if (!lines.length) return { status: 'unverified', reason: 'empty_address' }
  if (!key) return { status: 'skipped', reason: 'no_provider_key' }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts?.timeoutMs ?? 5000)
  try {
    const res = await fetch(`https://addressvalidation.googleapis.com/v1:validateAddress?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: { regionCode: 'US', addressLines: lines } }),
      signal: ctrl.signal,
    })
    if (!res.ok) return { status: 'skipped', reason: `provider_http_${res.status}` }
    const data = (await res.json()) as {
      result?: {
        verdict?: Verdict
        address?: { formattedAddress?: string; addressComponents?: GoogleComponent[] }
        geocode?: { location?: { latitude?: number; longitude?: number }; placeId?: string }
      }
    }
    const r = data.result
    const { status, reason } = interpretVerdict(r?.verdict)
    return {
      status,
      reason,
      formatted: r?.address?.formattedAddress,
      ...extractComponents(r?.address?.addressComponents),
      lat: r?.geocode?.location?.latitude,
      lng: r?.geocode?.location?.longitude,
      placeId: r?.geocode?.placeId,
    }
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError'
    return { status: 'skipped', reason: aborted ? 'provider_timeout' : 'provider_error' }
  } finally {
    clearTimeout(timer)
  }
}
