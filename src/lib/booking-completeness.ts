// ════════════════════════════════════════════════════════════════════════
//  booking-completeness.ts — the ONE shared "is this booking safe to run?"
//  validator. Pure (no prisma / discord.js / network) so it is unit-tested
//  offline and shared by the final form review, the admin page, the Discord
//  owner card, and the pre-approval check.
//
//  Severity contract (owner spec 2026-07-12):
//    • 'block' — the move would be UNSAFE, IMPOSSIBLE, MISPRICED, or IMPOSSIBLE
//                to DISPATCH without this. Callers MAY refuse approval on these.
//    • 'warn'  — operationally important but the owner can resolve it (e.g. call
//                the customer). Never blocks; always shown.
//  Harmless optional fields produce NOTHING (never block on those).
//
//  ADDRESS heuristics are intentionally conservative: they operate on the stored
//  single-line address string (the current source), flagging the exact failure
//  that produced "Myrtle Ave boonton nj" — a missing street number and/or ZIP —
//  without hard-failing a genuinely complete address.
// ════════════════════════════════════════════════════════════════════════

import { pricingConsistencyIssues } from './pricing'
import { assessAddress } from './address'

export type CompletenessSeverity = 'block' | 'warn' | 'info'
export type CompletenessWarning = { code: string; message: string; severity: CompletenessSeverity }

export type CompletenessBooking = {
  originAddress?: string | null
  destAddress?: string | null
  manualReviewRequired?: boolean | null
  truckAddonDueOnMoveDay?: boolean | null
  truckProvider?: string | null
  truckPickupLocation?: string | null
  truckReservationStatus?: string | null
  // Per-location structured access (may be null on older/current rows).
  originStairCount?: number | null
  destStairCount?: number | null
  // Legacy blob — used ONLY to detect selections not yet in structured columns
  // (e.g. "Stairs:"/"Heavy items:" the current form still writes as text).
  itemsDescription?: string | null
  equipmentNeeds?: string | null
  // Pricing inputs (optional) — when present, run the shared consistency check.
  baseRate?: number | null
  totalEstimate?: number | null
  travelFee?: number | null
  truckAddonAmount?: number | null
  depositAmount?: number | null
  payments?: { amount: number; status: string }[]
}

function addressWarnings(
  label: string,
  addr: string | null | undefined,
  prefix: string,
): CompletenessWarning[] {
  const a = assessAddress(addr)
  if (a.isVague) {
    return [{ code: `${prefix}_address_missing`, message: `${label} address is missing or unconfirmed.`, severity: 'block' }]
  }
  const out: CompletenessWarning[] = []
  if (!a.hasStreetNumber) {
    out.push({
      code: `${prefix}_street_number`,
      message: `${label} address has no street number — confirm the exact address before dispatch.`,
      severity: 'warn',
    })
  }
  if (!a.hasZip) {
    out.push({ code: `${prefix}_zip`, message: `${label} address is missing a ZIP code.`, severity: 'warn' })
  }
  if (!a.hasCityState) {
    out.push({ code: `${prefix}_city_state`, message: `${label} address may be missing a city/state.`, severity: 'warn' })
  }
  return out
}

/**
 * All operationally-relevant gaps for a booking, most severe first. Empty array
 * means "nothing to flag". Pure — the caller decides how to display / whether to
 * gate approval on any 'block' entries.
 */
export function bookingCompleteness(b: CompletenessBooking): CompletenessWarning[] {
  const w: CompletenessWarning[] = []

  w.push(...addressWarnings('Pickup', b.originAddress, 'pickup'))
  w.push(...addressWarnings('Drop-off', b.destAddress, 'dropoff'))

  if (b.manualReviewRequired) {
    w.push({
      code: 'manual_review',
      message: 'Service area / travel price needs owner review — not finalized.',
      severity: 'warn',
    })
  }

  // Truck Pickup & Return was selected, but we lack the info to actually perform it.
  if (b.truckAddonDueOnMoveDay) {
    if (!b.truckProvider) w.push({ code: 'truck_provider', message: 'Truck pickup & return selected but no rental provider recorded.', severity: 'warn' })
    if (!b.truckPickupLocation) w.push({ code: 'truck_pickup_location', message: 'Truck pickup & return selected but no pickup location recorded.', severity: 'warn' })
    if (!b.truckReservationStatus) w.push({ code: 'truck_reservation', message: 'Truck pickup & return selected but reservation status is unknown.', severity: 'warn' })
  }

  // Legacy-blob-derived hints (until the form sends structured columns): a
  // selection is present in itemsDescription but its structured detail is absent.
  const desc = b.itemsDescription ?? ''
  if (/(^|\n)\s*stairs\b/i.test(desc) && b.originStairCount == null && b.destStairCount == null) {
    w.push({ code: 'stairs_no_count', message: 'Stairs indicated but no stair-flight count recorded.', severity: 'info' })
  }
  if (/heavy items?/i.test(desc) && !(b.equipmentNeeds && b.equipmentNeeds.trim())) {
    w.push({ code: 'heavy_no_details', message: 'Heavy/specialty items indicated but no item details recorded.', severity: 'info' })
  }

  // Customer-facing vs internal pricing inconsistency (shared checker).
  for (const issue of pricingConsistencyIssues(b)) {
    w.push({ code: 'pricing_inconsistent', message: `Pricing inconsistency: ${issue}`, severity: 'warn' })
  }

  // block > warn > info so the most serious gaps read at the top.
  const rank: Record<CompletenessSeverity, number> = { block: 0, warn: 1, info: 2 }
  return w.sort((a, z) => rank[a.severity] - rank[z.severity])
}

/** True when any gap is severe enough that a caller may refuse approval. */
export function hasBlockingGaps(b: CompletenessBooking): boolean {
  return bookingCompleteness(b).some((x) => x.severity === 'block')
}

const SEVERITY_ICON: Record<CompletenessSeverity, string> = { block: '⛔', warn: '⚠️', info: 'ℹ️' }

/** Display lines (emoji-prefixed) for a card / admin / review surface. */
export function completenessLines(b: CompletenessBooking): string[] {
  return bookingCompleteness(b).map((x) => `${SEVERITY_ICON[x.severity]} ${x.message}`)
}
