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

// ════════════════════════════════════════════════════════════════════════
//  UNIT EXTRACTION
//  ----------------------------------------------------------------------
//  THE BUG (owner spec, booking WMIC-1019): the address read
//  "1000 Executive Dr apt 443a" while the Apartment / Unit field read "—".
//  The customer typed the unit where they were asked for the address, so it
//  ended up inside the street string and nowhere else. The crew got an
//  address they could not buzz, and the unit was invisible to every filter,
//  label and access check that reads originUnit/destUnit.
//
//  THE RULE: parse it out, and do not leave a copy behind. A unit that lives
//  in two fields drifts between them the first time one is edited.
// ════════════════════════════════════════════════════════════════════════

/** Words that introduce a unit within a street line. */
const UNIT_WORDS = 'apt|apartment|unit|ste|suite|rm|room|no|number|lot|spc|space|trlr|trailer|dept|department|bldg|building|box'
/** Floor is captured too, but it is a FLOOR — it never becomes the unit. */
const FLOOR_WORDS = 'fl|flr|floor|level'

//  A designator plus its value, at the END of a street line: "… apt 443a".
//  The value must contain a digit, or be a 1–3 character token like "B" —
//  which is what keeps a street genuinely named "Building Road" intact.
const UNIT_TAIL = new RegExp(
  String.raw`[\s,]+(?:(?:${UNIT_WORDS})\.?\s*|#\s*)([A-Za-z0-9][A-Za-z0-9\-]{0,9})\s*$`,
  'i',
)
const FLOOR_TAIL = new RegExp(String.raw`[\s,]+(?:${FLOOR_WORDS})\.?\s*(\d{1,3})(?:st|nd|rd|th)?\s*$`, 'i')
/** A whole comma segment that is nothing but a unit: "…, Apt 4B, Newark, NJ". */
const UNIT_SEGMENT = new RegExp(String.raw`^(?:(?:${UNIT_WORDS})\.?\s*|#\s*)([A-Za-z0-9][A-Za-z0-9\-]{0,9})$`, 'i')

/** A unit value must look like one: it carries a digit, or it is a short
 *  letter code ("B", "2R", "PH"). "Way" and "Road" never qualify. */
function looksLikeUnitValue(v: string): boolean {
  const s = v.trim()
  if (!s) return false
  if (/\d/.test(s)) return true
  return s.length <= 3
}

/** "443a" → "443A". Units are printed on labels and read aloud on the phone. */
export const normalizeUnit = (v: string): string => v.trim().toUpperCase().replace(/\s+/g, '')

export type ParsedAddress = {
  /** The address with the unit removed. Never contains the unit again. */
  address: string
  /** The extracted unit, normalized. Null when none was embedded. */
  unit: string | null
  /** A floor number found in the string ("floor 3"). Null when absent. */
  floor: number | null
  /** True when something was actually pulled out of the address. */
  changed: boolean
}

/**
 * Pull an apartment / suite / unit out of a single-line address.
 *
 * Only the STREET portion is searched — the part before the first comma, plus
 * any comma segment that is nothing but a unit. City, state and ZIP are never
 * touched, so "Suite Ridge, NJ" cannot lose its town.
 *
 * Conservative by construction: when nothing convincingly looks like a unit
 * the address is returned unchanged. A missed unit is a display gap; an
 * invented one sends a crew to the wrong door.
 */
export function parseAddressUnit(raw?: string | null): ParsedAddress {
  const input = (raw ?? '').trim()
  if (!input || isVagueAddress(input)) {
    return { address: input, unit: null, floor: null, changed: false }
  }

  const segments = input.split(',').map((s) => s.trim())
  let unit: string | null = null
  let floor: number | null = null

  // 1. A comma segment that is ONLY a unit — drop the whole segment.
  const kept: string[] = []
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    const m = i > 0 ? seg.match(UNIT_SEGMENT) : null
    if (m && !unit && looksLikeUnitValue(m[1])) {
      unit = normalizeUnit(m[1])
      continue // segment removed — no duplicate left behind
    }
    kept.push(seg)
  }

  // 2. A unit hanging off the end of the street line ("1000 Executive Dr apt 443a").
  if (kept.length) {
    let street = kept[0]
    const fm = street.match(FLOOR_TAIL)
    if (fm) {
      floor = parseInt(fm[1], 10)
      street = street.slice(0, fm.index).trim().replace(/[,\s]+$/, '')
    }
    const um = street.match(UNIT_TAIL)
    if (um && !unit && looksLikeUnitValue(um[1])) {
      // Never strip the street number itself: "443 Main" must keep its 443.
      const remainder = street.slice(0, um.index).trim().replace(/[,\s]+$/, '')
      if (hasStreetNumber(remainder)) {
        unit = normalizeUnit(um[1])
        street = remainder
      }
    }
    kept[0] = street
  }

  const address = kept.filter(Boolean).join(', ')
  return {
    address: address || input,
    unit,
    floor,
    changed: unit != null || floor != null,
  }
}

/**
 * Reconcile a stored address with a stored unit.
 *
 * Used on every READ path so an existing booking displays correctly without a
 * back-fill, and on the WRITE path so new bookings are stored clean. When the
 * booking already has a unit recorded, that one wins — the customer typed it
 * into the field we asked about — and the copy inside the address string is
 * still removed so the two can never disagree.
 */
export function normalizeAddressAndUnit(
  address?: string | null,
  unit?: string | null,
): { address: string; unit: string | null; floor: number | null } {
  const parsed = parseAddressUnit(address)
  const stored = (unit ?? '').trim()
  return {
    address: parsed.address,
    unit: stored ? normalizeUnit(stored) : parsed.unit,
    floor: parsed.floor,
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
