// ════════════════════════════════════════════════════════════════════════
//  booking-projections.ts — explicit ALLOW-LIST projections for each audience.
//  ----------------------------------------------------------------------
//  Security posture (owner spec Part 5): a customer/crew payload is built by
//  PICKING allowed fields, never by spreading the full booking and deleting a
//  few. A newly-added sensitive column is therefore excluded BY DEFAULT — it
//  only appears if an allow-list explicitly opts it in. The field-contract +
//  projection tests fail if a sensitive field ever lands on an allow-list.
//
//  Sensitive/owner-only (never customer, crew only near move day): access codes,
//  Stripe IDs, internal notes, IP/UA, Discord channel IDs, internal JSON.
// ════════════════════════════════════════════════════════════════════════

function pick<T extends Record<string, unknown>>(obj: T | null | undefined, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!obj) return out
  for (const k of keys) if (k in obj) out[k] = (obj as Record<string, unknown>)[k]
  return out
}

// ── Customer-safe booking scalars (NO codes, Stripe IDs, internal notes, IP/UA,
//    Discord IDs, addressEvaluation, discountApprovedById). ──
export const CUSTOMER_BOOKING_ALLOW = [
  'id', 'displayId', 'status', 'createdAt', 'updatedAt', 'completedAt',
  'requestedDate', 'confirmedDate', 'scheduledStart', 'scheduledEnd', 'rescheduleCount',
  'originAddress', 'destAddress',
  'originUnit', 'destUnit', 'originFloor', 'destFloor',
  'originHasElevator', 'destHasElevator', 'originStairCount', 'destStairCount',
  'originAccessNotes', 'destAccessNotes',
  'itemsDescription', 'estimatedHours',
  'baseRate', 'totalEstimate', 'finalAmount',
  'depositAmount', 'depositPaid',
  'truckAddonDueOnMoveDay', 'truckAddonAmount',
  'truckProvider', 'truckSize', 'truckReservationStatus', 'truckPickupLocation', 'truckReturnResponsibility',
  'travelFee', 'travelFeeDueOnMoveDay', 'serviceAreaZone', 'manualReviewRequired', 'serviceAreaMessage',
  'distanceFromWestOrangeMiles', 'estimatedDriveTimeMinutes',
  'discountCode', 'discountType', 'discountPercent',
  'customerNotes', 'equipmentNeeds',
  'agreementAccepted', 'agreementVersion', 'agreementAcceptedAt', 'agreementName',
  'customerToken', 'customerTokenExpiry', 'source', 'foundUs',
] as const

// ── Crew: what a worker needs to run the move. Includes access codes (needed on
//    site) but NO payment IDs / pricing internals / customer PII beyond contact. ──
export const CREW_BOOKING_ALLOW = [
  'id', 'displayId', 'status',
  'requestedDate', 'confirmedDate', 'scheduledStart', 'scheduledEnd',
  'originAddress', 'destAddress',
  'originUnit', 'destUnit', 'originFloor', 'destFloor',
  'originHasElevator', 'destHasElevator', 'originStairCount', 'destStairCount',
  'originAccessNotes', 'destAccessNotes',
  'originAccessCode', 'destAccessCode', // operationally necessary for the crew
  'truckAddonDueOnMoveDay', 'truckProvider', 'truckSize', 'truckReservationStatus',
  'truckPickupLocation', 'truckReturnResponsibility',
  'equipmentNeeds', 'crewInstructions', 'itemsDescription',
] as const

// Sensitive columns that must NEVER be on a customer projection. The test asserts
// none of these appears in CUSTOMER_BOOKING_ALLOW.
export const SENSITIVE_BOOKING_COLUMNS = [
  'originAccessCode', 'destAccessCode',
  'stripeCheckoutId', 'stripePaymentIntentId',
  'internalNotes', 'ipAddress', 'userAgent',
  'discordJobChannelId', 'discordPaperworkChannelId', 'discordPhotosChannelId', 'discordApprovalMessageId',
  'addressEvaluation', 'discountApprovedById',
] as const

type AnyBooking = Record<string, unknown> & {
  customer?: Record<string, unknown> | null
  payments?: Record<string, unknown>[]
  job?: Record<string, unknown> | null
  files?: Record<string, unknown>[]
  receipt?: Record<string, unknown> | null
}

/** Customer portal payload — explicit allow-list, safe relations only. */
export function customerBookingProjection(b: AnyBooking): Record<string, unknown> {
  const out = pick(b, CUSTOMER_BOOKING_ALLOW)
  if (b.customer) out.customer = pick(b.customer, ['name', 'email', 'phone', 'locale'])
  if (b.payments) out.payments = b.payments.map((p) => pick(p, ['amount', 'status', 'createdAt'])) // NO stripe IDs
  if (b.job) out.job = pick(b.job, ['status', 'startedAt', 'completedAt'])
  if (b.files) out.files = b.files.map((f) => pick(f, ['id', 'type', 'filename', 'cloudinaryUrl', 'createdAt']))
  if (b.receipt) out.receipt = pick(b.receipt, ['cloudinaryUrl', 'sentAt'])
  return out
}

/** Crew dispatch payload — operational fields + access codes, no money/IDs. */
export function crewBookingProjection(b: AnyBooking): Record<string, unknown> {
  const out = pick(b, CREW_BOOKING_ALLOW)
  if (b.customer) out.customer = pick(b.customer, ['name', 'phone']) // contact only
  if (b.files) out.files = b.files.map((f) => pick(f, ['type', 'filename', 'cloudinaryUrl']))
  return out
}
