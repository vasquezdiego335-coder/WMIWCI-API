// ════════════════════════════════════════════════════════════════════════
//  booking-contract.ts — the DOCUMENTED source of truth for the booking field
//  pipeline: form payload key → API property → DB column → who may see it.
//  ----------------------------------------------------------------------
//  This is data, not logic, so the field-contract test can assert invariants
//  over it and FAIL when the pipeline drifts:
//    • a form field the API doesn't recognize,
//    • an API field nothing documents,
//    • a sensitive field that is customer-visible,
//    • a sensitive field missing from the customer-portal omit list.
//  Keep this in sync when adding/removing booking fields — the test enforces it.
// ════════════════════════════════════════════════════════════════════════

// 'email' is a customer-facing surface (transactional emails). 'admin'/'discord'
// are owner surfaces. Anything email-visible must also be customer-visible.
export type Visibility = 'owner' | 'crew' | 'customer' | 'email'

export type FieldSpec = {
  /** Prisma column on Booking (or a related model, prefixed), '' if derived-only. */
  db: string
  /** API/Zod property name (bookings route), if the API accepts it. */
  api?: string
  /** Booking-form payload key, if the form sends it. */
  form?: string
  /** Must NEVER appear in a customer-facing projection. */
  sensitive?: boolean
  /** Surfaces allowed to show this field (owner ⊇ admin ⊇ discord-owner). */
  visibility: Visibility[]
  /** Operationally required for a dispatchable booking. */
  required?: boolean
  /** Also folded into the legacy itemsDescription blob (compat only). */
  legacyBlob?: boolean
  note?: string
}

// The subset of the pipeline the audit touches. Not every column — the fields
// where correctness/visibility matters. Extend as the form is built out.
export const BOOKING_FIELD_MAP: Record<string, FieldSpec> = {
  customerName: { db: 'customer.name', api: 'fullName', form: 'fullName', required: true, visibility: ['owner', 'crew', 'customer', 'email'] },
  customerPhone: { db: 'customer.phone', api: 'phone', form: 'phone', required: true, visibility: ['owner', 'crew', 'customer', 'email'] },
  customerEmail: { db: 'customer.email', api: 'email', form: 'email', required: true, visibility: ['owner', 'customer', 'email'] },

  originAddress: { db: 'originAddress', api: 'pickupAddresses', form: 'pickupAddresses', required: true, visibility: ['owner', 'crew', 'customer', 'email'] },
  destAddress: { db: 'destAddress', api: 'destinationAddress', form: 'destinationAddress', required: true, visibility: ['owner', 'crew', 'customer', 'email'] },

  originUnit: { db: 'originUnit', api: 'originUnit', form: 'originUnit', visibility: ['owner', 'crew', 'customer'] },
  destUnit: { db: 'destUnit', api: 'destUnit', form: 'destUnit', visibility: ['owner', 'crew', 'customer'] },
  originFloor: { db: 'originFloor', api: 'originFloor', form: 'originFloor', visibility: ['owner', 'crew', 'customer'] },
  destFloor: { db: 'destFloor', api: 'destFloor', form: 'destFloor', visibility: ['owner', 'crew', 'customer'] },
  originHasElevator: { db: 'originHasElevator', api: 'originHasElevator', form: 'originHasElevator', visibility: ['owner', 'crew', 'customer'] },
  destHasElevator: { db: 'destHasElevator', api: 'destHasElevator', form: 'destHasElevator', visibility: ['owner', 'crew', 'customer'] },
  originStairCount: { db: 'originStairCount', api: 'originStairCount', form: 'originStairCount', visibility: ['owner', 'crew', 'customer'] },
  destStairCount: { db: 'destStairCount', api: 'destStairCount', form: 'destStairCount', visibility: ['owner', 'crew', 'customer'] },
  originAccessNotes: { db: 'originAccessNotes', api: 'originAccessNotes', form: 'originAccessNotes', visibility: ['owner', 'crew', 'customer'] },
  destAccessNotes: { db: 'destAccessNotes', api: 'destAccessNotes', form: 'destAccessNotes', visibility: ['owner', 'crew', 'customer'] },

  // SENSITIVE — gate/lockbox codes. Owner always; crew only near move day. NEVER customer.
  originAccessCode: { db: 'originAccessCode', api: 'originAccessCode', form: 'originAccessCode', sensitive: true, visibility: ['owner', 'crew'] },
  destAccessCode: { db: 'destAccessCode', api: 'destAccessCode', form: 'destAccessCode', sensitive: true, visibility: ['owner', 'crew'] },

  serviceType: { db: 'baseRate', api: 'serviceType', form: 'serviceType', required: true, legacyBlob: true, visibility: ['owner', 'crew', 'customer', 'email'], note: 'baseRate=flat dollars from SERVICE_MAP; label also in itemsDescription' },
  truckAddon: { db: 'truckAddonDueOnMoveDay', api: 'truckOption', form: 'truckOption', visibility: ['owner', 'crew', 'customer'] },
  truckProvider: { db: 'truckProvider', api: 'truckProvider', form: 'truckProvider', visibility: ['owner', 'crew'] },
  truckSize: { db: 'truckSize', api: 'truckSize', form: 'truckSize', visibility: ['owner', 'crew'] },
  truckReservationStatus: { db: 'truckReservationStatus', api: 'truckReservationStatus', form: 'truckReservationStatus', visibility: ['owner', 'crew'] },
  truckPickupLocation: { db: 'truckPickupLocation', api: 'truckPickupLocation', form: 'truckPickupLocation', visibility: ['owner', 'crew'] },
  truckReturnResponsibility: { db: 'truckReturnResponsibility', api: 'truckReturnResponsibility', form: 'truckReturnResponsibility', visibility: ['owner', 'crew'] },

  equipmentNeeds: { db: 'equipmentNeeds', api: 'equipmentNeeds', form: 'equipmentNeeds', visibility: ['owner', 'crew'] },
  crewInstructions: { db: 'crewInstructions', api: 'crewInstructions', form: 'crewInstructions', visibility: ['owner', 'crew'] },

  customerNotes: { db: 'customerNotes', api: 'jobDetails', form: 'jobDetails', legacyBlob: true, visibility: ['owner', 'crew', 'customer', 'email'] },
  internalNotes: { db: 'internalNotes', sensitive: true, visibility: ['owner'], note: 'owner/staff only; server-set, never from the form' },

  requestedDate: { db: 'requestedDate', api: 'date', form: 'date', required: true, visibility: ['owner', 'crew', 'customer', 'email'] },
  requestedTime: { db: 'requestedDate', api: 'time', form: 'time', required: true, visibility: ['owner', 'crew', 'customer', 'email'], note: 'folded into requestedDate; drives scheduledStart on approval' },

  travelFee: { db: 'travelFee', visibility: ['owner', 'crew', 'customer'], note: 'server-computed cents; move-day, never in Stripe' },
  depositAmount: { db: 'depositAmount', visibility: ['owner', 'customer'], note: 'cents; the ONLY Stripe charge ($49)' },

  // SENSITIVE — internal identifiers/records. Never customer-facing.
  stripePaymentIntentId: { db: 'stripePaymentIntentId', sensitive: true, visibility: ['owner'] },
  stripeCheckoutId: { db: 'stripeCheckoutId', sensitive: true, visibility: ['owner'] },
  ipAddress: { db: 'ipAddress', sensitive: true, visibility: ['owner'] },
}

// Fields that MUST be stripped from the token-addressable customer portal
// response (app/api/customer/booking/[token]). Kept beside the map so the test
// can assert every sensitive field is covered.
export const CUSTOMER_PORTAL_OMIT: readonly string[] = [
  'stripeCheckoutId',
  'stripePaymentIntentId',
  'ipAddress',
  'userAgent',
  'discordJobChannelId',
  'discordPaperworkChannelId',
  'discordPhotosChannelId',
  'discordApprovalMessageId',
  'internalNotes',
  'originAccessCode',
  'destAccessCode',
] as const

/** Structural invariants over the field map. Returns [] when the contract holds. */
export function contractViolations(): string[] {
  const problems: string[] = []
  const dbSeen = new Map<string, string>()

  for (const [key, spec] of Object.entries(BOOKING_FIELD_MAP)) {
    // A form field must map to something the API recognizes.
    if (spec.form && !spec.api) problems.push(`${key}: form sends "${spec.form}" but no API property is documented`)
    // Sensitive fields must never be customer- or email-visible.
    if (spec.sensitive && spec.visibility.includes('customer')) problems.push(`${key}: sensitive field is marked customer-visible`)
    if (spec.sensitive && spec.visibility.includes('email')) problems.push(`${key}: sensitive field is marked email-visible`)
    // Anything shown in an email must also be allowed to the customer.
    if (spec.visibility.includes('email') && !spec.visibility.includes('customer')) problems.push(`${key}: email-visible but not customer-visible`)
    // Every field must document at least one surface.
    if (spec.visibility.length === 0) problems.push(`${key}: no visibility documented`)
    // Duplicate DB columns (excluding intentional shared columns e.g. requestedDate).
    if (spec.db && spec.db !== 'requestedDate' && spec.db !== 'baseRate') {
      const prev = dbSeen.get(spec.db)
      if (prev) problems.push(`${key}: DB column "${spec.db}" already mapped by ${prev}`)
      dbSeen.set(spec.db, key)
    }
  }

  // Every sensitive DB column must be in the customer-portal omit list.
  for (const [key, spec] of Object.entries(BOOKING_FIELD_MAP)) {
    if (spec.sensitive && spec.db && !spec.db.includes('.') && !CUSTOMER_PORTAL_OMIT.includes(spec.db)) {
      problems.push(`${key}: sensitive DB column "${spec.db}" is not in CUSTOMER_PORTAL_OMIT`)
    }
  }
  return problems
}

/** True if any documented sensitive field key appears in a projection object. */
export function sensitiveKeysPresent(projection: Record<string, unknown>): string[] {
  const sensitiveDbCols = Object.values(BOOKING_FIELD_MAP)
    .filter((s) => s.sensitive && s.db && !s.db.includes('.'))
    .map((s) => s.db)
  return sensitiveDbCols.filter((col) => col in projection)
}
