// ============================================================================
// estimate-assistant.ts — recommended crew / truck / hours for a move (Phase 1).
//
// The smart-estimating half of the Book Move workspace: move size + inventory
// + access conditions → a recommendation the owner can interrogate, with a
// human-readable reason for every adjustment.
//
// FOUR HARD RULES (1-3 mirror pricing-intelligence.ts):
//  1. ADVISORY ONLY. This module NEVER prices anything and has no write path
//     to a customer price. The quote shown next to it comes from
//     computeEstimate (estimate.ts); the owner types the final number.
//  2. Deterministic and pure. Same inputs → same recommendation. No DB, no
//     network, no randomness — offline-testable like every other lib here.
//  3. Truth comes from the real tables. The truck is derived from
//     MIN_TRUCK_BY_PACKAGE via assignTruck (pricing-config.ts, read-only) and
//     size labels from MOVE_SIZES (estimate.ts) — never hardcoded guesses.
//     When the size is unconfirmed the recommendation says so instead of
//     inventing confidence.
//  4. An item's own mover requirement is a FLOOR, never an input to an
//     average (fix pass 2026-08-12, item 5). The package band describes the
//     JOB; `recommendedMovers` describes ONE object that physically cannot be
//     carried by fewer people. A 4-mover piano in a studio move is a 4-mover
//     job — see itemCrewFloor / the crew-floor block in recommendEstimate.
//     ROUND 2 (R2-7.2): the floor also fires on a HAND-TYPED line. A custom
//     "Piano" line has no catalog row, so it carried no recommendedMovers and
//     a piano job booked with 2-3 movers while the booking's own hasPiano
//     column said otherwise. The name match now reaches the same floor, and
//     the number still comes from the house catalog (rule 3) rather than a
//     second opinion invented here.
// ============================================================================

import { MOVE_SIZES } from './estimate'
import { DEFAULT_INVENTORY_CATALOG } from './inventory-catalog'
import { assignTruck } from './pricing-config'

export type EstimateDifficulty = 'standard' | 'elevated' | 'high'

export type AssistantInventoryItem = {
  name: string
  quantity: number
  isHeavy?: boolean | null
  needsDisassembly?: boolean | null
  /** From the inventory catalog: movers this item alone needs (piano = 4). */
  recommendedMovers?: number | null
}

export type EstimateAssistantInput = {
  /** Package key from MOVE_SIZES ('little-studio' … '5br', 'not-sure'). */
  serviceType?: string | null
  /** Fallback when no package was chosen — mapped onto the '<n>br' keys. */
  bedrooms?: number | null
  inventory: AssistantInventoryItem[]
  originStairFlights?: number | null
  destStairFlights?: number | null
  originHasElevator?: boolean | null
  destHasElevator?: boolean | null
  longCarry?: boolean | null
  needsPacking?: boolean | null
  needsAssembly?: boolean | null
  needsDisassembly?: boolean | null
  additionalStops?: number | null
}

export type EstimateRecommendation = {
  jobSizeLabel: string
  crewSize: number
  /** '10ft' | '15ft' | '26ft' from the live truck table, or null when the
   *  size is unconfirmed / needs a manual truck plan (5BR+). */
  truckSize: string | null
  estimatedHoursMin: number
  estimatedHoursMax: number
  possibleTrips: number
  difficulty: EstimateDifficulty
  /** WHY — one entry per adjustment, in plain owner language. */
  reasons: string[]
}

// ── Base crew + hour bands per package key (owner spec 2026-08-11) ───────────
// Keys are the live MOVE_SIZES keys (a test asserts full coverage). Hours are
// whole numbers; adjustments below only ever add whole hours.
type BaseBand = { crew: number; hoursMin: number; hoursMax: number }

export const BASE_BY_PACKAGE: Record<string, BaseBand> = {
  'little-studio': { crew: 2, hoursMin: 2, hoursMax: 3 },
  'half-studio': { crew: 2, hoursMin: 2, hoursMax: 3 },
  'full-studio': { crew: 2, hoursMin: 3, hoursMax: 4 },
  '1br': { crew: 2, hoursMin: 3, hoursMax: 4 },
  '2br': { crew: 3, hoursMin: 4, hoursMax: 6 },
  '3br': { crew: 3, hoursMin: 5, hoursMax: 7 },
  '4br': { crew: 4, hoursMin: 6, hoursMax: 8 },
  '5br': { crew: 5, hoursMin: 8, hoursMax: 10 },
}

/** The honest band when the size is not confirmed yet. */
const UNCONFIRMED_BAND: BaseBand = { crew: 2, hoursMin: 3, hoursMax: 5 }

const STUDIO_CLASS = new Set(['little-studio', 'half-studio', 'full-studio'])

/** Items that make a move high-difficulty by name, whatever the weight flag. */
const HIGH_DIFFICULTY_ITEM = /\b(piano|safe|pool\s*table)\b/i

export const CREW_MIN = 2
export const CREW_MAX = 5
export const HOURS_MIN = 2
export const HOURS_MAX = 12

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))

// ── Specialty crew floor by NAME (fix pass round 2, R2-7.2) ─────────────────
//
// The Book Move picker lets the owner type a line that is not in the catalog.
// A typed "Piano" therefore arrives with recommendedMovers = null, so the item
// floor above never fired and the recommendation came back at the package base
// — a 2-3 mover piano job, on a booking whose own hasPiano column said there
// was a piano. The booking-review derivation reads the NAME (admin-booking's
// PIANO_RE / SAFE_RE / POOL_TABLE_RE); the crew floor now reads it too, so the
// two can no longer disagree about the same line.
//
// The MOVER COUNTS are not invented here: they are read out of
// DEFAULT_INVENTORY_CATALOG, the house's own rating for those items (piano 4,
// safe 3, pool table 3 at the time of writing). If a rating is ever changed
// there, this follows it; if a row is removed entirely, no floor is claimed
// for that kind rather than a number being made up.
//
// The name match is deliberately BROAD (a "piano bench" line reaches the piano
// floor). The recommendation is advisory — the owner reads it back on the
// phone and can lower it — and of the two ways to be wrong, sending too few
// people to a piano is the one that hurts somebody.

type SpecialtyPattern = { kind: string; re: RegExp }

/** The three specialty kinds a NAME alone identifies — the same three the
 *  booking's hasPiano / hasSafe / hasPoolTable columns track. */
const SPECIALTY_NAME_PATTERNS: SpecialtyPattern[] = [
  { kind: 'piano', re: /\bpianos?\b/i },
  { kind: 'safe', re: /\bsafes?\b/i },
  { kind: 'pool table', re: /\b(pool\s*table|billiards?)\b/i },
]

/** kind → the movers the house catalog rates that kind of item for. Built
 *  ONCE at module load from the real catalog rows (no /g flags, so `.test` is
 *  stateless and this stays pure). */
const SPECIALTY_FLOORS: Array<{ kind: string; re: RegExp; movers: number }> = (() => {
  const out: Array<{ kind: string; re: RegExp; movers: number }> = []
  for (const pattern of SPECIALTY_NAME_PATTERNS) {
    let movers = 0
    for (const row of DEFAULT_INVENTORY_CATALOG) {
      if (!pattern.re.test(row.name)) continue
      const rated = Math.floor(Number(row.recommendedMovers ?? 0))
      if (Number.isFinite(rated) && rated > movers) movers = rated
    }
    // No catalog row rates this kind → claim no floor for it.
    if (movers > 0) out.push({ kind: pattern.kind, re: pattern.re, movers })
  }
  return out
})()

/**
 * The crew floor a line's NAME alone justifies, or null. Exported so the rule
 * is readable and testable on its own — and so a caller can tell a
 * catalog-rated floor from a name-derived one.
 */
export function specialtyCrewFloor(name: string): { movers: number; kind: string } | null {
  const s = (name ?? '').trim()
  if (!s) return null
  let best: { movers: number; kind: string } | null = null
  for (const floor of SPECIALTY_FLOORS) {
    if (!floor.re.test(s)) continue
    if (!best || floor.movers > best.movers) best = { movers: floor.movers, kind: floor.kind }
  }
  return best
}

/** The item that needs the most movers, and how many. Null when nothing in the
 *  inventory carries a usable `recommendedMovers` value AND no line names a
 *  specialty item. Pure + exported so the floor rule can be tested (and read)
 *  on its own. */
export function itemCrewFloor(
  inventory: AssistantInventoryItem[]
): { movers: number; name: string } | null {
  let best: { movers: number; name: string } | null = null
  for (const item of inventory ?? []) {
    const raw = Number(item?.recommendedMovers ?? 0)
    // null / NaN / Infinity from bad catalog data contributes nothing, but the
    // NAME on that same line still can.
    const rated = Number.isFinite(raw) ? Math.floor(raw) : 0
    const named = specialtyCrewFloor(item?.name ?? '')
    const movers = Math.max(rated, named ? named.movers : 0)
    if (movers < 1) continue
    // First item wins a tie, so the reason string is stable for the same input.
    if (!best || movers > best.movers) best = { movers, name: item.name }
  }
  return best
}

/** Map a bare bedroom count onto the live package keys (1 → '1br' … 5+ → '5br'). */
function packageKeyFromBedrooms(bedrooms: number): string | null {
  const n = Math.floor(bedrooms)
  if (n < 1) return null
  const key = n >= 5 ? '5br' : `${n}br`
  return key in BASE_BY_PACKAGE ? key : null
}

/**
 * THE recommendation. Pure — safe to unit-test and to call from the API route.
 * Every numeric adjustment pushes a reason the owner can read back to the
 * customer on the phone.
 */
export function recommendEstimate(input: EstimateAssistantInput): EstimateRecommendation {
  const reasons: string[] = []
  const inventory = input.inventory ?? []

  // ── Size → base crew + hours ──────────────────────────────────────────────
  const rawKey = (input.serviceType ?? '').trim().toLowerCase()
  let key: string | null = rawKey in BASE_BY_PACKAGE ? rawKey : null
  if (!key && rawKey !== 'not-sure' && input.bedrooms != null) {
    key = packageKeyFromBedrooms(input.bedrooms)
    if (key) reasons.push('Size derived from bedroom count — confirm the package on the call')
  }

  let jobSizeLabel: string
  let crewSize: number
  let hoursMin: number
  let hoursMax: number
  if (key) {
    const base = BASE_BY_PACKAGE[key]
    jobSizeLabel = MOVE_SIZES[key]?.label ?? key
    crewSize = base.crew
    hoursMin = base.hoursMin
    hoursMax = base.hoursMax
    reasons.push(`${jobSizeLabel} inventory — base crew of ${base.crew}, ${base.hoursMin}-${base.hoursMax}h`)
  } else {
    jobSizeLabel = 'Size unconfirmed'
    crewSize = UNCONFIRMED_BAND.crew
    hoursMin = UNCONFIRMED_BAND.hoursMin
    hoursMax = UNCONFIRMED_BAND.hoursMax
    reasons.push('Size unconfirmed — verify on the call')
  }

  // ── Truck: derived from the LIVE table, never guessed ─────────────────────
  // assignTruck owns the minimum-truck rule (MIN_TRUCK_BY_PACKAGE) and the
  // manual-plan carve-outs (5br / not-sure). We only translate its answer.
  let truckSize: string | null = null
  const truck = assignTruck(key ?? rawKey ?? null)
  if (truck.ok) {
    truckSize = truck.assigned
    reasons.push(`${truck.assigned} truck minimum for ${jobSizeLabel}`)
  } else if (truck.reason === 'manual_plan' && (key === '5br' || rawKey === '5br')) {
    reasons.push('5+ bedroom moves need a manual truck plan — may take multiple trucks or trips')
  } else {
    reasons.push('Truck not assigned — confirm the move size first')
  }

  // ── Heavy items → crew ────────────────────────────────────────────────────
  const heavyCount = inventory.reduce(
    (sum, item) => sum + (item.isHeavy ? Math.max(1, Math.floor(item.quantity || 1)) : 0),
    0
  )
  const bigCrewItem = inventory.find((i) => (i.recommendedMovers ?? 0) >= 3)
  if (heavyCount >= 2 || bigCrewItem) {
    crewSize += 1
    if (heavyCount >= 2) reasons.push(`${heavyCount} heavy items — extra mover added`)
    if (bigCrewItem) reasons.push(`${bigCrewItem.name} needs ${bigCrewItem.recommendedMovers} movers — extra mover added`)
  }

  // ── Stairs → hours. Only ends WITHOUT an elevator cost stair time. ────────
  let countedFlights = 0
  const ends = [
    { where: 'pickup', flights: input.originStairFlights ?? 0, elevator: !!input.originHasElevator },
    { where: 'drop-off', flights: input.destStairFlights ?? 0, elevator: !!input.destHasElevator },
  ]
  for (const end of ends) {
    const flights = Math.max(0, Math.floor(end.flights || 0))
    if (flights === 0 || end.elevator) continue
    countedFlights += flights
    if (flights >= 2) reasons.push(`${flights} flights of stairs at ${end.where}, no elevator`)
  }
  // +1h to both bounds per 2 flights beyond the first, across both ends.
  const stairHours = Math.floor(Math.max(0, countedFlights - 1) / 2)
  if (stairHours > 0) {
    hoursMin += stairHours
    hoursMax += stairHours
    reasons.push(`Stair carry adds ~${stairHours}h`)
  }

  // ── Packing → max bound only (it widens uncertainty, not the floor) ───────
  if (input.needsPacking) {
    hoursMax += 1
    reasons.push('Packing requested — allow up to an extra hour')
  }

  // ── Assembly / disassembly → 30-min equivalents, rounded UP to whole hours
  //    on the max bound (bounds stay integers; the floor stays honest). ──────
  const disassemblyItem = inventory.find((i) => i.needsDisassembly)
  if (input.needsDisassembly || disassemblyItem) {
    hoursMax += 1
    reasons.push(disassemblyItem ? `${disassemblyItem.name} disassembly required` : 'Disassembly required')
  }
  if (input.needsAssembly) {
    hoursMax += 1
    reasons.push('Reassembly at destination — allow extra time')
  }

  // ── Possible trips ────────────────────────────────────────────────────────
  const itemCount = inventory.reduce((sum, i) => sum + Math.max(1, Math.floor(i.quantity || 1)), 0)
  let possibleTrips = 1
  const studioClass = key != null && STUDIO_CLASS.has(key)
  if (itemCount > 40) {
    possibleTrips += 1
    reasons.push(`${itemCount} items — may take a second trip`)
  } else if (studioClass && heavyCount >= 2) {
    possibleTrips += 1
    reasons.push('Heavy items on a studio-size truck — may take a second trip')
  }

  // ── Difficulty ────────────────────────────────────────────────────────────
  const hasHeavy = heavyCount >= 1
  const hasStairs = countedFlights >= 2
  const specialItem = inventory.find((i) => HIGH_DIFFICULTY_ITEM.test(i.name))
  let difficulty: EstimateDifficulty = 'standard'
  if (hasHeavy || hasStairs) difficulty = 'elevated'
  if ((hasHeavy && hasStairs) || specialItem) {
    difficulty = 'high'
    if (specialItem) reasons.push(`${specialItem.name} on the inventory — high-difficulty move`)
    else reasons.push('Heavy items plus stairs — high-difficulty move')
  }

  // ── Advisory-only notes (no numeric change defined for these in Phase 1) ──
  if (input.longCarry) reasons.push('Long carry — confirm the walk distance on the call')
  const stops = Math.max(0, Math.floor(input.additionalStops ?? 0))
  if (stops > 0) reasons.push(`${stops} additional stop${stops === 1 ? '' : 's'} — extra drive time between locations`)

  // ── Item crew FLOOR — never averaged away (fix pass item 5) ───────────────
  // Everything above adjusts the crew for the JOB (package band, heavy count,
  // a single +1 for a big-crew item). None of that may talk an item BELOW the
  // number of people it takes to carry it: a piano rated for 4 movers stays a
  // 4-mover item even inside a studio package whose base is 2. So the floor is
  // a max(), applied AFTER every adjustment and BEFORE the cap, and it names
  // the item whenever the floor is what decided the number.
  const crewFloor = itemCrewFloor(inventory)
  const adjustedCrew = crewSize
  if (crewFloor && crewFloor.movers > adjustedCrew) crewSize = crewFloor.movers

  // ── Caps: crew 2..5, hours 2..12, bounds ordered ──────────────────────────
  crewSize = clamp(crewSize, CREW_MIN, CREW_MAX)
  hoursMin = clamp(hoursMin, HOURS_MIN, HOURS_MAX)
  hoursMax = clamp(hoursMax, HOURS_MIN, HOURS_MAX)
  if (hoursMax < hoursMin) hoursMax = hoursMin

  // The floor's reason is written AFTER the cap so it describes what the owner
  // actually sees. Over the cap: the number stands (we never promise a crew we
  // cannot field) but the shortfall is said out loud instead of being swallowed
  // by the clamp — advisory only, possibleTrips stays a footage/heavy signal.
  if (crewFloor && crewFloor.movers > CREW_MAX) {
    reasons.push(
      `${crewFloor.name} requires ${crewFloor.movers} movers — crew capped at ${CREW_MAX}; plan a second trip or outside help for this item`
    )
  } else if (crewFloor && crewFloor.movers > adjustedCrew) {
    reasons.push(
      `${crewFloor.name} requires ${crewFloor.movers} movers — crew raised to ${crewFloor.movers}`
    )
  }

  return {
    jobSizeLabel,
    crewSize,
    truckSize,
    estimatedHoursMin: hoursMin,
    estimatedHoursMax: hoursMax,
    possibleTrips,
    difficulty,
    reasons,
  }
}
