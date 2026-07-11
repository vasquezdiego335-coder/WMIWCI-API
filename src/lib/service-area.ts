// ─────────────────────────────────────────────────────────────────────────
// Service-area rule engine — the SINGLE source of truth for travel zones/fees.
//
// The business is based in West Orange, NJ (Essex County). Every pickup and
// destination address on a booking is classified into a zone:
//
//   primary      Essex County + the listed nearby towns (~20-30 min).  No fee.
//   extended_nj  Any other New Jersey address.                          +$50 (once).
//   new_york     Any New York address.        MANUAL REVIEW — no fixed price.
//   unsupported  Any other state.             MANUAL REVIEW.
//   manual_review  Address we could not classify (missing/garbled).     MANUAL REVIEW.
//
// This module is PURE and deterministic (no network, no geocoding key). Distance
// and drive-time are optional enrichments left null here; the zone decision never
// depends on them. The frontend may call this via /api/service-area/check for a
// live estimate, but /api/bookings MUST re-run it server-side — never trust a fee
// sent by the browser.
// ─────────────────────────────────────────────────────────────────────────

export const TRAVEL_FEE_CENTS = 5000 // $50, charged once, due on move day (like the truck add-on)

// Reference point (for future geocoding / drive-time; unused by the ZIP classifier).
export const WEST_ORANGE = { zip: '07052', lat: 40.7987, lng: -74.2391 } as const

export type ServiceAreaZone =
  | 'primary'
  | 'extended_nj'
  | 'new_york'
  | 'manual_review'
  | 'unsupported'

export interface AddressInput {
  street?: string
  city?: string
  state?: string
  zip?: string
  /** Optional raw single-line address (back-compat with the old free-text field). */
  raw?: string
}

export interface EvaluatedAddress {
  input: AddressInput
  zone: ServiceAreaZone
  zip: string | null
  state: string | null
  city: string | null
  reason: string
}

export interface ServiceAreaResult {
  serviceable: boolean
  zone: ServiceAreaZone
  /** Cents. 0 = primary, 5000 = extended NJ, null = pending manual review. */
  travelFeeCents: number | null
  manualReviewRequired: boolean
  message: string
  distanceFromWestOrangeMiles: number | null
  estimatedDriveTimeMinutes: number | null
  evaluatedAddresses: EvaluatedAddress[]
}

// ── Primary zone: Essex County, NJ ──────────────────────────────────────────
// The listed primary towns are all Essex County municipalities. We match on ZIP
// first (most reliable), then fall back to town name. Easily edited if the owner
// wants to widen the no-fee radius.
const PRIMARY_ZIPS = new Set<string>([
  '07003', // Bloomfield
  '07004', // Fairfield
  '07006', // Caldwell / West Caldwell / North Caldwell
  '07007', // Caldwell (PO)
  '07009', // Cedar Grove
  '07017', '07018', '07019', // East Orange
  '07021', // Essex Fells
  '07028', // Glen Ridge
  '07039', // Livingston
  '07040', // Maplewood
  '07041', // Millburn
  '07042', '07043', // Montclair
  '07044', // Verona
  '07050', '07051', // Orange
  '07052', // West Orange (HQ)
  '07068', // Roseland
  '07078', // Short Hills
  '07079', // South Orange
  '07101', '07102', '07103', '07104', '07105', '07106',
  '07107', '07108', '07112', '07114', // Newark
  '07109', // Belleville
  '07110', // Nutley
  '07111', // Irvington
])

const PRIMARY_TOWNS = new Set<string>([
  'west orange', 'newark', 'montclair', 'bloomfield', 'nutley', 'east orange',
  'maplewood', 'south orange', 'livingston', 'millburn', 'short hills', 'verona',
  'cedar grove', 'caldwell', 'west caldwell', 'north caldwell', 'fairfield',
  'glen ridge', 'orange', 'irvington', 'belleville', 'essex fells', 'roseland',
])

// New Jersey ZIP prefixes are 070-089. New York ZIP prefixes are 100-149.
const NJ_ZIP = /^0[78]\d{3}$/
const NY_ZIP = /^1[0-4]\d{3}$/

function normState(s?: string): string | null {
  if (!s) return null
  const t = s.trim().toLowerCase()
  if (!t) return null
  if (t === 'nj' || t === 'new jersey') return 'NJ'
  if (t === 'ny' || t === 'new york') return 'NY'
  return t.toUpperCase().slice(0, 20)
}

function normTown(s?: string): string | null {
  if (!s) return null
  const t = s.trim().toLowerCase().replace(/\s+/g, ' ')
  return t || null
}

function extractZip(...parts: Array<string | undefined>): string | null {
  for (const p of parts) {
    if (!p) continue
    const m = p.match(/\b(\d{5})(?:-\d{4})?\b/)
    if (m) return m[1]
  }
  return null
}

/** Classify one address. Deterministic; never throws. */
export function evaluateAddress(input: AddressInput): EvaluatedAddress {
  const zip = extractZip(input.zip, input.raw, input.street, input.city)
  const typedState = normState(input.state)
  const city = normTown(input.city)

  // NJ/NY region: a valid NJ/NY ZIP is authoritative (a real ZIP beats a
  // mistyped state dropdown, so a NY ZIP still flags NY for review); then the
  // typed state; then a state named in the raw single-line address.
  let region: 'NJ' | 'NY' | null = null
  if (zip && NJ_ZIP.test(zip)) region = 'NJ'
  else if (zip && NY_ZIP.test(zip)) region = 'NY'
  else if (typedState === 'NJ' || typedState === 'NY') region = typedState
  else if (input.raw) {
    const r = ` ${input.raw.toLowerCase()} `
    if (/\bnj\b|new jersey/.test(r)) region = 'NJ'
    else if (/\bny\b|new york/.test(r)) region = 'NY'
  }

  const state = region ?? typedState
  const base = { input, zip: zip ?? null, state: state ?? null, city: city ?? null }

  if (region === 'NY') {
    return { ...base, zone: 'new_york', reason: 'New York address — state travel fee applies, manual review.' }
  }

  if (region === 'NJ') {
    const isPrimary =
      (zip !== null && PRIMARY_ZIPS.has(zip)) ||
      (city !== null && PRIMARY_TOWNS.has(city))
    return isPrimary
      ? { ...base, zone: 'primary', reason: 'Essex County / primary service area — no travel fee.' }
      : { ...base, zone: 'extended_nj', reason: 'New Jersey outside the primary area — $50 travel fee.' }
  }

  if (typedState && typedState !== 'NJ' && typedState !== 'NY') {
    return { ...base, zone: 'unsupported', reason: `Out-of-area address (${typedState}) — manual review.` }
  }

  return { ...base, zone: 'manual_review', reason: 'Could not determine the service area — manual review.' }
}

// Higher rank = farther / more restrictive. The aggregate zone is the max rank
// across every evaluated address ("use the farthest applicable service zone").
const ZONE_RANK: Record<ServiceAreaZone, number> = {
  primary: 0,
  extended_nj: 1,
  manual_review: 2,
  new_york: 3,
  unsupported: 4,
}

const MESSAGES: Record<ServiceAreaZone, string> = {
  primary: 'This address is within our primary service area — no travel fee.',
  extended_nj: 'This address is within our extended New Jersey service area.',
  new_york: 'New York moves require manual review because tolls, traffic, and travel distance may affect pricing.',
  unsupported: 'This address is outside our usual service area and needs manual review before we can confirm pricing.',
  manual_review: 'We could not automatically verify this address, so it needs a quick manual review.',
}

/**
 * Evaluate every pickup + the destination and return the aggregate decision.
 * The farthest zone wins; the $50 extended fee is charged at most once; New York
 * and anything we cannot place are flagged for manual review with no fixed fee.
 */
export function checkServiceArea(
  pickupAddresses: AddressInput[],
  destinationAddress: AddressInput,
): ServiceAreaResult {
  const all = [...(pickupAddresses ?? []), destinationAddress].filter(
    (a): a is AddressInput => !!a && (!!a.zip || !!a.city || !!a.state || !!a.raw),
  )

  const evaluated = all.map(evaluateAddress)

  // Empty / unusable input → manual review rather than a silent free pass.
  if (evaluated.length === 0) {
    return {
      serviceable: false,
      zone: 'manual_review',
      travelFeeCents: null,
      manualReviewRequired: true,
      message: MESSAGES.manual_review,
      distanceFromWestOrangeMiles: null,
      estimatedDriveTimeMinutes: null,
      evaluatedAddresses: [],
    }
  }

  const zone = evaluated.reduce<ServiceAreaZone>(
    (worst, e) => (ZONE_RANK[e.zone] > ZONE_RANK[worst] ? e.zone : worst),
    'primary',
  )

  const manualReviewRequired = zone === 'new_york' || zone === 'unsupported' || zone === 'manual_review'
  const travelFeeCents =
    zone === 'primary' ? 0 : zone === 'extended_nj' ? TRAVEL_FEE_CENTS : null

  return {
    serviceable: zone !== 'unsupported',
    zone,
    travelFeeCents,
    manualReviewRequired,
    message: MESSAGES[zone],
    distanceFromWestOrangeMiles: null,
    estimatedDriveTimeMinutes: null,
    evaluatedAddresses: evaluated,
  }
}

/** Dollars for the public API response (spec contract), from internal cents. */
export function travelFeeDollars(cents: number | null): number | null {
  return cents === null ? null : Math.round(cents) / 100
}
