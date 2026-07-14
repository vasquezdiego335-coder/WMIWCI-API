// ════════════════════════════════════════════════════════════════════════
//  estimate.ts — THE canonical booking estimate. One calculation, server-side.
//
//  The static booking form (WMIWCI-SITE/public/booking-form.html) mirrors these
//  EXACT constants for its live display (its `SERVICES` + `MODIFIERS` tables).
//  estimate.test.ts pins representative option-sets so the form and server can
//  never silently diverge again — this is the fix for the "$699 on the form vs
//  $599 in the email/DB" bug (the server used to drop the access add-ons).
//
//  NEVER trust a client-submitted total. The API recomputes here from validated
//  inputs and stores the result on the booking; every downstream surface (admin,
//  Discord, emails, SMS, receipts, reporting) reads that one stored value.
//
//  MONEY MODEL
//    • estimatedTotal = base labor + access add-ons + travel fee
//        → the full expected job value; the number shown EVERYWHERE.
//    • Access add-ons (stairs / long carry / heavy items / elevator / parking /
//      building age) are INCLUDED in the estimate — they reflect labor difficulty.
//    • Travel fee is part of estimatedTotal but COLLECTED ON MOVE DAY (never in
//      the $49 Stripe deposit).
//    • Truck pickup & return (+$50) is DUE ON MOVE DAY and is NOT part of
//      estimatedTotal (its own line) — matching the form exactly.
//    • The $49 deposit is authorized at checkout, separate from all the above.
// ════════════════════════════════════════════════════════════════════════

// Move-size flat labor prices (DOLLARS). Must match the form's `SERVICES`.
export const MOVE_SIZES: Record<string, { label: string; price: number }> = {
  'little-studio': { label: 'Little Studio', price: 359 },
  'half-studio': { label: 'Half Studio', price: 409 },
  'full-studio': { label: 'Full Studio', price: 509 },
  '1br': { label: '1 Bedroom', price: 599 },
  '2br': { label: '2 Bedrooms', price: 699 },
  '3br': { label: '3 Bedrooms', price: 949 },
  '4br': { label: '4 Bedrooms', price: 1249 },
  '5br': { label: '5 Bedrooms', price: 1549 },
  'not-sure': { label: 'Need a Quote', price: 0 },
}

// Truck pickup & return add-on (DOLLARS) — due on move day, not in estimatedTotal.
export const TRUCK_ADDON_DOLLARS = 50

// Access-difficulty add-ons (DOLLARS). MUST match the form's `MODIFIERS` table.
// (booking-form.html: stairs 40, longWalk 30, heavyItems 60, elevator.far 25,
//  parking.medium 25 / far 50, building.old 40.)
export const ACCESS_MODIFIERS = {
  stairs: 40,
  longWalk: 30,
  heavyItems: 60,
  elevator: { none: 0, close: 0, far: 25 } as Record<string, number>,
  parking: { door: 0, short: 0, medium: 25, far: 50 } as Record<string, number>,
  building: { newer: 0, mid: 0, old: 40, unsure: 0, '': 0 } as Record<string, number>,
}

export type EstimateInputs = {
  serviceType?: string | null
  stairs?: boolean | null
  longWalk?: boolean | null
  heavyItems?: boolean | null
  elevatorAccess?: string | null
  parkingDistance?: string | null
  buildingYear?: string | null
  /** Server-computed service-area fee, in CENTS. */
  travelFeeCents?: number | null
  truckAddonDueOnMoveDay?: boolean | null
}

export type EstimateLine = {
  key: string
  label: string
  amount: number // DOLLARS
  timing: 'included' | 'move_day'
}

export type Estimate = {
  hasService: boolean
  base: number // DOLLARS (0 when the size is unknown / "not-sure")
  accessAddons: number // DOLLARS
  accessLines: EstimateLine[]
  travel: number // DOLLARS (in estimatedTotal, collected on move day)
  truckAddon: number // DOLLARS (move day, NOT in estimatedTotal)
  /** base + access add-ons + travel — the ONE number shown everywhere. */
  estimatedTotal: number
  /** travel + truck add-on — collected on move day, never in the $49 deposit. */
  dueOnMoveDay: number
}

const round2 = (n: number): number => Math.round(n * 100) / 100

/**
 * THE booking estimate. Pure; safe to unit-test and to call from the API route.
 * Mirrors the booking form's live calculation exactly.
 */
export function computeEstimate(i: EstimateInputs): Estimate {
  const svc = i.serviceType ? MOVE_SIZES[i.serviceType] : undefined
  const base = svc ? svc.price : 0

  const lines: EstimateLine[] = []
  const push = (key: string, amount: number, label: string): void => {
    if (amount > 0) lines.push({ key, label, amount, timing: 'included' })
  }
  push('stairs', i.stairs ? ACCESS_MODIFIERS.stairs : 0, 'Stairs')
  push('longWalk', i.longWalk ? ACCESS_MODIFIERS.longWalk : 0, 'Long carry')
  push('heavyItems', i.heavyItems ? ACCESS_MODIFIERS.heavyItems : 0, 'Heavy items')
  push('elevator', ACCESS_MODIFIERS.elevator[i.elevatorAccess ?? ''] ?? 0, 'Elevator access')
  push('parking', ACCESS_MODIFIERS.parking[i.parkingDistance ?? ''] ?? 0, 'Parking distance')
  push('building', ACCESS_MODIFIERS.building[i.buildingYear ?? ''] ?? 0, 'Building access')

  const accessAddons = round2(lines.reduce((s, l) => s + l.amount, 0))
  const travel = round2((i.travelFeeCents ?? 0) / 100)
  const truckAddon = i.truckAddonDueOnMoveDay ? TRUCK_ADDON_DOLLARS : 0
  const estimatedTotal = round2(base + accessAddons + travel)

  return {
    hasService: !!svc,
    base,
    accessAddons,
    accessLines: lines,
    travel,
    truckAddon,
    estimatedTotal,
    dueOnMoveDay: round2(travel + truckAddon),
  }
}

/**
 * The value stored on Booking.totalEstimate. Returns null only when there is
 * genuinely nothing to estimate (no known size and no fees) — preserving the
 * pre-fix "null when empty" behaviour while guaranteeing that whenever a size
 * IS chosen the stored total equals the form's headline (base + add-ons + travel).
 */
export function storedTotalEstimate(i: EstimateInputs): number | null {
  const est = computeEstimate(i)
  const hasKnownSize = !!(i.serviceType && MOVE_SIZES[i.serviceType])
  if (hasKnownSize) return est.estimatedTotal
  return est.estimatedTotal > 0 ? est.estimatedTotal : null
}
