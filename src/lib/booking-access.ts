// ════════════════════════════════════════════════════════════════════════
//  booking-access.ts — the ONE place structured access details become display
//  lines, and the ONE place the sensitive/non-sensitive boundary is enforced.
//  ----------------------------------------------------------------------
//  Pure (no prisma / discord.js / network) so it is unit-tested offline and
//  shared by the customer summary, the admin views, and the owner-gated Discord
//  "View Full Booking" response.
//
//  SECURITY RULE (owner spec 2026-07-12): gate/lockbox/buzzer CODES are
//  sensitive. accessSections({ includeSensitive: false }) NEVER returns them —
//  that projection is what feeds customer-facing surfaces. Only the owner-gated
//  Discord view and authorized admin views pass includeSensitive: true.
// ════════════════════════════════════════════════════════════════════════

export type AccessBookingInput = {
  originUnit?: string | null
  destUnit?: string | null
  originFloor?: number | null
  destFloor?: number | null
  originHasElevator?: boolean | null
  destHasElevator?: boolean | null
  originStairCount?: number | null
  destStairCount?: number | null
  originAccessNotes?: string | null
  destAccessNotes?: string | null
  originAccessCode?: string | null
  destAccessCode?: string | null
  truckProvider?: string | null
  truckSize?: string | null
  truckReservationStatus?: string | null
  truckPickupLocation?: string | null
  truckReturnResponsibility?: string | null
  equipmentNeeds?: string | null
  crewInstructions?: string | null
}

export type AccessSection = { title: string; lines: string[]; sensitive?: boolean }

function nonEmpty(...lines: Array<string | null | undefined>): string[] {
  return lines.filter((l): l is string => !!l && l.trim().length > 0)
}

function locationSection(
  title: string,
  unit?: string | null,
  floor?: number | null,
  hasElevator?: boolean | null,
  stairCount?: number | null,
  accessNotes?: string | null,
): AccessSection | null {
  const lines = nonEmpty(
    unit ? `Unit/Apt: ${unit}` : null,
    floor != null ? `Floor: ${floor}` : null,
    hasElevator != null ? `Elevator: ${hasElevator ? 'Yes' : 'No'}` : null,
    stairCount != null && stairCount > 0 ? `Stairs: ${stairCount} flight${stairCount === 1 ? '' : 's'}` : null,
    accessNotes ? `Access notes: ${accessNotes}` : null,
  )
  return lines.length ? { title, lines } : null
}

/**
 * Structured access as titled sections, ready to render as Discord fields,
 * admin rows, or a customer summary list. Pickup (origin) and drop-off (dest)
 * are always separate sections. The "🔒 Access Codes" section is included ONLY
 * when opts.includeSensitive is true — omit it for anything customer-facing.
 */
export function accessSections(
  b: AccessBookingInput,
  opts: { includeSensitive: boolean },
): AccessSection[] {
  const sections: AccessSection[] = []

  const pickup = locationSection('📍 Pickup Access', b.originUnit, b.originFloor, b.originHasElevator, b.originStairCount, b.originAccessNotes)
  if (pickup) sections.push(pickup)

  const dropoff = locationSection('📍 Drop-off Access', b.destUnit, b.destFloor, b.destHasElevator, b.destStairCount, b.destAccessNotes)
  if (dropoff) sections.push(dropoff)

  const truck = nonEmpty(
    b.truckProvider ? `Provider: ${b.truckProvider}` : null,
    b.truckSize ? `Size: ${b.truckSize}` : null,
    b.truckReservationStatus ? `Reservation: ${b.truckReservationStatus}` : null,
    b.truckPickupLocation ? `Pickup at: ${b.truckPickupLocation}` : null,
    b.truckReturnResponsibility ? `Return: ${b.truckReturnResponsibility}` : null,
  )
  if (truck.length) sections.push({ title: '🚚 Truck', lines: truck })

  const logistics = nonEmpty(
    b.equipmentNeeds ? `Equipment: ${b.equipmentNeeds}` : null,
    b.crewInstructions ? `Crew instructions: ${b.crewInstructions}` : null,
  )
  if (logistics.length) sections.push({ title: '🧰 Equipment & Crew', lines: logistics })

  if (opts.includeSensitive) {
    const codes = nonEmpty(
      b.originAccessCode ? `Pickup code: ${b.originAccessCode}` : null,
      b.destAccessCode ? `Drop-off code: ${b.destAccessCode}` : null,
    )
    if (codes.length) sections.push({ title: '🔒 Access Codes', lines: codes, sensitive: true })
  }

  return sections
}

/** True when the booking carries any gate/lockbox/access code. */
export function hasAccessCodes(b: AccessBookingInput): boolean {
  return !!(b.originAccessCode || b.destAccessCode)
}
