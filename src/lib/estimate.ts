// ════════════════════════════════════════════════════════════════════════
//  estimate.ts — THE canonical booking estimate. One calculation, server-side.
//
//  ⚠ THIS FILE NO LONGER OWNS ANY PRICE. Every amount comes from
//  `pricing-config.ts`, and the browser form reads the SAME numbers via the
//  generated mirror (WMIWCI-SITE/public/js/pricing-config.js). That closes the
//  "$699 on the form vs $599 in the email" class of bug structurally rather
//  than by hand-syncing two tables.
//
//  NEVER trust a client-submitted total. The API recomputes here from validated
//  inputs and stores the result; every downstream surface (admin, Discord,
//  emails, SMS, receipts, reporting) reads that one stored value.
//
//  MONEY MODEL
//    • estimatedTotal = base labor + auto-applicable access add-ons + travel
//        → the full expected job value; the number shown EVERYWHERE.
//    • Charges that need owner review (4+ flights, 400lb+, piano/safe, NY,
//      difficult elevator/building access, >25mi stops) are NOT summed into
//      the total. They surface as `reviewLines` and set `requiresReview`, so a
//      customer is never shown $0 for something that has not been priced yet.
//    • Truck pickup & return ($49) is DUE ON MOVE DAY and is NOT part of
//      estimatedTotal (its own line, never discountable).
//    • The $49 booking authorization is separate from all of the above.
//
//  REMOVED 2026-07-21 (owner decision): the building-age surcharge, and the
//  automatic elevator-distance and parking-distance charges. See
//  NO_BUILDING_AGE_FEE in pricing-config.ts.
// ════════════════════════════════════════════════════════════════════════

import {
  PACKAGES, TRUCK_PICKUP_RETURN, ELEVATOR, PARKING_TOLLS_DELAYS,
  stairChargeForFlights, longCarryChargeForFeet, heavyItemChargeForWeight,
  additionalLocationChargeForMiles, travelChargeForMinutes,
  formatCharge, isAutoApplicable,
  type Charge, type PackageKey,
} from './pricing-config'

/**
 * Move-size flat labor prices (DOLLARS), derived from PACKAGES.
 * Kept as a named export for existing callers (app/api/bookings/route.ts).
 * `starting: true` means the price is a FLOOR and the booking cannot be
 * auto-confirmed — callers must not present it as a settled flat rate.
 */
export const MOVE_SIZES: Record<string, { label: string; price: number; starting: boolean; requiresReview: boolean }> =
  Object.fromEntries(
    Object.values(PACKAGES).map((p) => [
      p.key,
      {
        label: p.label,
        price: p.price.amount ?? 0,
        starting: p.price.kind === 'starting',
        requiresReview: p.requiresReview,
      },
    ])
  )

/** Truck pickup & return add-on (DOLLARS) — due on move day, never discounted. */
export const TRUCK_ADDON_DOLLARS = TRUCK_PICKUP_RETURN.amount

export type HeavyItemInput = {
  /** Free-text description shown on the quote. */
  label?: string
  /** Estimated weight in POUNDS. Under 150 = normal furniture = included. */
  pounds?: number | null
  /** Piano or substantial safe — always a custom quote, never auto-priced. */
  isPianoOrSafe?: boolean | null
}

export type AdditionalStopInput = {
  label?: string
  /** Distance in miles from the main route. */
  miles?: number | null
}

export type EstimateInputs = {
  serviceType?: string | null

  // ── Structured access inputs (preferred) ──────────────────────────────
  /** Flights of stairs at the PICKUP address. 1st flight is included. */
  pickupStairFlights?: number | null
  /** Flights of stairs at the DROP-OFF address. Charged per address. */
  dropoffStairFlights?: number | null
  /** Door-to-truck carry distance in FEET, per location. */
  pickupCarryFeet?: number | null
  dropoffCarryFeet?: number | null
  /** Genuinely difficult elevator access (slow / freight-restricted / long hall). */
  pickupDifficultElevator?: boolean | null
  dropoffDifficultElevator?: boolean | null
  /** Genuinely difficult building access, beyond stairs and carry distance. */
  pickupDifficultBuilding?: boolean | null
  dropoffDifficultBuilding?: boolean | null
  heavyItems?: HeavyItemInput[] | null
  additionalStops?: AdditionalStopInput[] | null
  /** Drive-time minutes beyond the primary service zone. */
  travelMinutes?: number | null
  /** New York job — never auto-priced. */
  isNewYork?: boolean | null

  // ── Legacy boolean inputs (a browser tab opened before the cutover) ────
  /** @deprecated use pickup/dropoffStairFlights */
  stairs?: boolean | null
  /** @deprecated use pickup/dropoffCarryFeet */
  longWalk?: boolean | null
  /** @deprecated use heavyItems[] with weights */
  legacyHeavyItems?: boolean | null

  /** Server-computed service-area fee, in CENTS. Overrides travelMinutes when set. */
  travelFeeCents?: number | null
  truckAddonDueOnMoveDay?: boolean | null
}

export type EstimateLine = {
  key: string
  label: string
  /** DOLLARS. 0 for review/quote lines — read `display` for what to show. */
  amount: number
  /** Exactly what the customer must see: "$40", "Included", "Pending review". */
  display: string
  timing: 'included' | 'move_day'
  /** True when this line still needs owner review before it is real. */
  pendingReview: boolean
}

export type Estimate = {
  hasService: boolean
  base: number
  /** True when the package price is a floor ("Starting at"). */
  baseIsStarting: boolean
  accessAddons: number
  accessLines: EstimateLine[]
  /** Charges that need owner review — NOT summed into estimatedTotal. */
  reviewLines: EstimateLine[]
  travel: number
  truckAddon: number
  /** base + auto-applicable access add-ons + travel. */
  estimatedTotal: number
  /** travel + truck add-on — collected on move day, never in the $49 deposit. */
  dueOnMoveDay: number
  /** Blocks automatic confirmation. Any review line, floor price, or NY job. */
  requiresReview: boolean
  reviewReasons: string[]
}

const round2 = (n: number): number => Math.round(n * 100) / 100

/** Piano / substantial safe — custom quote, manual approval, never auto-priced. */
const HEAVY_PIANO_SAFE: Charge = {
  kind: 'manual_quote',
  per: 'item',
  requiresReview: true,
  label: 'Upright piano or substantial safe',
  note: 'Custom quote and manual approval.',
}

/** Build an EstimateLine from a resolved Charge. */
function lineFrom(key: string, ch: Charge, labelOverride?: string): EstimateLine {
  const auto = isAutoApplicable(ch)
  return {
    key,
    label: labelOverride ?? ch.label,
    amount: auto ? ch.amount ?? 0 : 0,
    display: formatCharge(ch),
    timing: 'included',
    pendingReview: !auto && ch.kind !== 'included',
  }
}

/**
 * THE booking estimate. Pure; safe to unit-test and to call from the API route.
 * Mirrors the browser form's calculation exactly (same config, same resolvers).
 */
export function computeEstimate(i: EstimateInputs): Estimate {
  const pkg = i.serviceType ? PACKAGES[i.serviceType as PackageKey] : undefined
  const base = pkg?.price.amount ?? 0
  const baseIsStarting = pkg?.price.kind === 'starting'

  const accessLines: EstimateLine[] = []
  const reviewLines: EstimateLine[] = []
  const reviewReasons: string[] = []

  const consider = (key: string, ch: Charge, label?: string): void => {
    const line = lineFrom(key, ch, label)
    if (ch.kind === 'included') return // nothing to show as a charge
    if (line.pendingReview) {
      reviewLines.push(line)
      reviewReasons.push(line.label)
    } else if (line.amount > 0) {
      accessLines.push(line)
    }
  }

  // ── Stairs: PER ADDRESS. Legacy boolean maps to the 2nd-flight tier only. ──
  const pickupFlights = i.pickupStairFlights ?? (i.stairs ? 2 : 0)
  const dropoffFlights = i.dropoffStairFlights ?? 0
  consider('stairs_pickup', stairChargeForFlights(pickupFlights), 'Stairs — pickup')
  consider('stairs_dropoff', stairChargeForFlights(dropoffFlights), 'Stairs — drop-off')

  // ── Long carry: PER LOCATION. Legacy boolean maps to the 100–250ft tier. ──
  const pickupFeet = i.pickupCarryFeet ?? (i.longWalk ? 100 : 0)
  const dropoffFeet = i.dropoffCarryFeet ?? 0
  consider('carry_pickup', longCarryChargeForFeet(pickupFeet), 'Long carry — pickup')
  consider('carry_dropoff', longCarryChargeForFeet(dropoffFeet), 'Long carry — drop-off')

  // ── Elevator: a normal elevator is NEVER charged. Only difficult access. ──
  if (i.pickupDifficultElevator) consider('elevator_pickup', ELEVATOR.difficult, 'Difficult elevator — pickup')
  if (i.dropoffDifficultElevator) consider('elevator_dropoff', ELEVATOR.difficult, 'Difficult elevator — drop-off')

  // ── Difficult building access (replaces the removed building-age fee). ──
  if (i.pickupDifficultBuilding) consider('building_pickup', PARKING_TOLLS_DELAYS.difficultBuildingAccess, 'Difficult building access — pickup')
  if (i.dropoffDifficultBuilding) consider('building_dropoff', PARKING_TOLLS_DELAYS.difficultBuildingAccess, 'Difficult building access — drop-off')

  // ── Heavy items: by weight, per item. Piano/safe is always a custom quote. ──
  const heavy = i.heavyItems ?? []
  for (let n = 0; n < heavy.length; n++) {
    const item = heavy[n]
    const label = item.label?.trim() || `Heavy item ${n + 1}`
    if (item.isPianoOrSafe) {
      consider(`heavy_${n}`, { ...HEAVY_PIANO_SAFE, label }, label)
      continue
    }
    consider(`heavy_${n}`, heavyItemChargeForWeight(item.pounds ?? 0), label)
  }
  // A legacy "heavy items" checkbox carries NO weight, so it can only mean
  // "review this" — never a silent charge at a guessed tier.
  if (i.legacyHeavyItems && !(i.heavyItems ?? []).length) {
    consider('heavy_legacy', { kind: 'pending_review', per: 'item', requiresReview: true, label: 'Heavy item (weight not provided)' })
  }

  // ── Additional stops beyond the included 1 pickup + 1 drop-off. ──
  const stops = i.additionalStops ?? []
  for (let n = 0; n < stops.length; n++) {
    const stop = stops[n]
    const label = stop.label?.trim() || `Additional location ${n + 1}`
    consider(`stop_${n}`, additionalLocationChargeForMiles(stop.miles ?? 0), label)
  }

  // ── Travel. An explicit server-computed fee wins; else the drive-time ladder. ──
  let travel = 0
  if (typeof i.travelFeeCents === 'number') {
    travel = round2(i.travelFeeCents / 100)
  } else if (i.travelMinutes != null) {
    const ch = travelChargeForMinutes(i.travelMinutes)
    if (isAutoApplicable(ch)) {
      travel = ch.amount ?? 0
    } else if (ch.kind !== 'included') {
      reviewLines.push(lineFrom('travel', ch))
      reviewReasons.push('Travel beyond 90 minutes')
    }
  }

  if (i.isNewYork) reviewReasons.push('New York address')
  if (pkg?.requiresReview) reviewReasons.push(`${pkg.label} requires inventory and access review`)

  const accessAddons = round2(accessLines.reduce((s, l) => s + l.amount, 0))
  const truckAddon = i.truckAddonDueOnMoveDay ? TRUCK_ADDON_DOLLARS : 0
  const estimatedTotal = round2(base + accessAddons + travel)

  return {
    hasService: !!pkg && pkg.key !== 'not-sure',
    base,
    baseIsStarting,
    accessAddons,
    accessLines,
    reviewLines,
    travel,
    truckAddon,
    estimatedTotal,
    dueOnMoveDay: round2(travel + truckAddon),
    requiresReview: reviewReasons.length > 0,
    reviewReasons,
  }
}

/**
 * The value stored on Booking.totalEstimate. Returns null only when there is
 * genuinely nothing to estimate (no known size and no fees).
 */
export function storedTotalEstimate(i: EstimateInputs): number | null {
  const est = computeEstimate(i)
  const hasKnownSize = !!(i.serviceType && PACKAGES[i.serviceType as PackageKey] && i.serviceType !== 'not-sure')
  if (hasKnownSize) return est.estimatedTotal
  return est.estimatedTotal > 0 ? est.estimatedTotal : null
}
