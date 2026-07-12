// ════════════════════════════════════════════════════════════════════════
//  address.ts — the ONE place address strings are assessed for completeness.
//  Pure + offline-tested. Shared by the completeness validator, the API (to
//  route incomplete addresses to manual review), and later the structured
//  address contract. NO paid autocomplete provider is chosen here — this only
//  ASSESSES what was submitted; it never fabricates a completed address from a
//  partial string.
//
//  UNIT SEPARATION: pickup (origin) and drop-off (dest) are always assessed
//  independently; nothing here merges or copies one into the other.
// ════════════════════════════════════════════════════════════════════════

export type AddressParts = {
  street?: string | null
  unit?: string | null
  city?: string | null
  state?: string | null
  zip?: string | null
}

export type AddressAssessment = {
  hasStreetNumber: boolean
  hasZip: boolean
  hasCityState: boolean
  isVague: boolean
  isCommercial: boolean
  /** street number + ZIP + a city/state signal all present. */
  complete: boolean
}

const VAGUE = /provided at confirmation/i
// Commercial / storage / multi-unit signals that mean extra intake is expected.
const COMMERCIAL = /\b(suite|ste|unit|apt|apartment|floor|fl|dock|loading dock|facility|storage|self[- ]?storage|warehouse|plaza|building|bldg|office|business)\b/i

/** True for empty or placeholder ("Provided at confirmation") addresses. */
export function isVagueAddress(a?: string | null): boolean {
  const s = (a ?? '').trim()
  return !s || VAGUE.test(s)
}

/** A real US street address begins with a house/building number. */
export function hasStreetNumber(a?: string | null): boolean {
  return !!a && /^\s*\d+\s*\S/.test(a.trim())
}

/** A 5-digit ZIP appears somewhere in the string. */
export function hasZip(a?: string | null): boolean {
  return !!a && /\b\d{5}\b/.test(a)
}

/** A city/state signal: ≥2 comma-separated parts OR a 2-letter uppercase state. */
export function hasCityState(a?: string | null): boolean {
  const s = (a ?? '').trim()
  if (!s) return false
  const parts = s.split(',').filter((p) => p.trim()).length
  return parts >= 2 || /\b[A-Z]{2}\b/.test(s)
}

/** Contains a suite/unit/dock/storage/facility keyword. */
export function looksCommercial(a?: string | null): boolean {
  return !!a && COMMERCIAL.test(a)
}

/** Assess a single-line address string. */
export function assessAddress(a?: string | null): AddressAssessment {
  const vague = isVagueAddress(a)
  const streetNo = !vague && hasStreetNumber(a)
  const zip = !vague && hasZip(a)
  const cityState = !vague && hasCityState(a)
  return {
    hasStreetNumber: streetNo,
    hasZip: zip,
    hasCityState: cityState,
    isVague: vague,
    isCommercial: looksCommercial(a),
    complete: streetNo && zip && cityState,
  }
}

/** Assess structured components (the shape the UI session will send later). */
export function assessStructured(p: AddressParts): AddressAssessment {
  const street = (p.street ?? '').trim()
  const streetNo = /^\s*\d+\s*\S/.test(street)
  const zip = !!(p.zip && /\b\d{5}\b/.test(p.zip))
  const cityState = !!((p.city && p.city.trim()) || (p.state && p.state.trim()))
  const unitCommercial = looksCommercial([p.street, p.unit].filter(Boolean).join(' '))
  return {
    hasStreetNumber: streetNo,
    hasZip: zip,
    hasCityState: cityState,
    isVague: !street && !zip,
    isCommercial: unitCommercial || !!(p.unit && p.unit.trim()),
    complete: streetNo && zip && cityState,
  }
}
