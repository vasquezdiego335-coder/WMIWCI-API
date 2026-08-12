// ============================================================================
// admin-booking.ts — pure helpers for the admin Book Move workspace
// (Moving OS Phase 1, owner spec 2026-08-11).
//
// Everything decision-shaped lives HERE, offline-testable (house rule: route
// files stay thin so the logic can be unit-tested without a Next route):
//   • AdminBookingSchema      — the zod contract for POST /api/admin/bookings
//   • decideStatus            — deposit mode → initial BookingStatus
//   • buildBookingCreateData  — the Booking.create data object, mapping every
//                               structured column the public route maps
//                               (app/api/bookings/route.ts is the bible)
//   • buildStaffingRequirementData — recommendation → JobStaffingRequirement
//   • resolveInventorySnapshots    — catalog rows → immutable line snapshots
//   • synthesizePlaceholderEmail   — the deliberate never-deliverable address
//   • requiresOverrideReason / adminPortalTokenExpiry / helpers
//
// MONEY RULES (docs/moving-os.md hard rule 1): the owner's number goes to
// per-booking columns (totalEstimate + priceOverrideReason) with a
// PRICE_CHANGED audit. This module never touches pricing-config/service-area
// values — it only READS the canonical estimate handed in by the route.
//
// NO CUSTOMER EMAILS: nothing here (or in the route) sends anything. The UI
// surfaces the portal link + optional Stripe hold link for the owner to send
// by hand — that is the Phase 1 contract, stated in the workspace copy.
// ============================================================================

import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { MOVE_SIZES, type Estimate } from './estimate'
import type { EstimateRecommendation } from './estimate-assistant'

// ── Vocabulary ───────────────────────────────────────────────────────────────

export const DEPOSIT_MODES = ['stripe_link', 'collect_on_day', 'waived'] as const
export type DepositMode = (typeof DEPOSIT_MODES)[number]

export const PROPERTY_TYPES = ['house', 'apartment', 'storage', 'office', 'other'] as const
export type PropertyType = (typeof PROPERTY_TYPES)[number]

export const SERVICE_MODES = ['full_service', 'labor_only', 'loading_only', 'unloading_only'] as const
export type ServiceMode = (typeof SERVICE_MODES)[number]

export const SERVICE_MODE_LABELS: Record<ServiceMode, string> = {
  full_service: 'Full service',
  labor_only: 'Labor only (customer truck)',
  loading_only: 'Loading only',
  unloading_only: 'Unloading only',
}

/** Valid serviceType keys: the live MOVE_SIZES table (which includes
 *  'not-sure'). Never a hardcoded list that could drift from pricing-config. */
export function isServiceTypeKey(key: string): boolean {
  return key === 'not-sure' || key in MOVE_SIZES
}

// ── ET date helpers (pure; no scheduling.ts import so tests stay light) ──────

/** 'YYYY-MM-DD' for the America/New_York calendar day containing `now`.
 *  en-CA is the locale whose date format IS ISO — same trick as
 *  truck-conflicts.etDayKey / availability-engine. */
export function todayEtDay(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

// ── Zod schema ───────────────────────────────────────────────────────────────

const AddressSchema = z.object({
  street: z.string().trim().min(1).max(200),
  city: z.string().trim().min(1).max(120),
  state: z.string().trim().min(2).max(40).default('NJ'),
  zip: z.string().trim().regex(/^\d{5}$/, 'ZIP must be 5 digits'),
})
export type AdminAddress = z.infer<typeof AddressSchema>

// Empty string → undefined so an untouched optional form field never trips
// email validation.
const optionalTrimmed = (max: number) =>
  z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().trim().max(max).optional(),
  )

const CustomerSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    email: z.preprocess(
      (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
      z.string().trim().toLowerCase().email().max(320).optional(),
    ),
    phone: optionalTrimmed(40),
    locale: z.enum(['en', 'es']).default('en'),
  })
  // Phone is required exactly when there is no email — a booking must be
  // reachable somehow.
  .refine((c) => !!c.email || !!(c.phone && c.phone.trim()), {
    message: 'Provide an email or a phone number',
    path: ['phone'],
  })

const MoveSchema = z.object({
  serviceType: z
    .string()
    .trim()
    .toLowerCase()
    .refine(isServiceTypeKey, { message: 'Unknown move size' }),
  // ISO calendar date, not in the past (America/New_York — the business
  // timezone, so a late-night ET booking for "today" still validates).
  moveDate: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'moveDate must be YYYY-MM-DD')
    .refine((d) => d >= todayEtDay(), { message: 'Move date is in the past' }),
  arrivalWindow: optionalTrimmed(60),
  originAddress: AddressSchema,
  destAddress: AddressSchema,
  originPropertyType: z.enum(PROPERTY_TYPES).optional(),
  destPropertyType: z.enum(PROPERTY_TYPES).optional(),
  originFloor: z.number().int().min(0).max(100).optional(),
  destFloor: z.number().int().min(0).max(100).optional(),
  originStairFlights: z.number().int().min(0).max(20).optional(),
  destStairFlights: z.number().int().min(0).max(20).optional(),
  originHasElevator: z.boolean().optional(),
  destHasElevator: z.boolean().optional(),
  longCarry: z.boolean().optional(),
  coiRequired: z.boolean().optional(),
  accessNotes: optionalTrimmed(2000),
  additionalStopsCount: z.number().int().min(0).max(10).optional(),
})

const ServicesSchema = z.object({
  serviceMode: z.enum(SERVICE_MODES),
  needsPacking: z.boolean().default(false),
  needsUnpacking: z.boolean().default(false),
  needsAssembly: z.boolean().default(false),
  needsDisassembly: z.boolean().default(false),
})

const InventoryLineSchema = z.object({
  catalogItemId: optionalTrimmed(64),
  name: z.string().trim().min(1).max(200),
  quantity: z.number().int().min(1).max(99).default(1),
  notes: optionalTrimmed(500),
})
export type AdminInventoryLine = z.infer<typeof InventoryLineSchema>

export const AdminBookingSchema = z.object({
  customer: CustomerSchema,
  move: MoveSchema,
  services: ServicesSchema,
  // May be empty — the route returns a WARNING string, never a refusal (a
  // phone booking can be taken before the inventory conversation happens).
  inventory: z.array(InventoryLineSchema).max(300).default([]),
  truckId: optionalTrimmed(64),
  /** Explicit acknowledgement of a truck double-booking. Without it the route
   *  REFUSES (409) — a silent double-booking is the expensive mistake. */
  truckConflictOverride: z.boolean().default(false),
  itemsDescription: optionalTrimmed(4000),
  crewInstructions: optionalTrimmed(2000),
  /** From /admin/book?leadId= — converts that exact lead on success. */
  leadId: optionalTrimmed(64),
  pricing: z.object({
    /** DOLLARS. The owner's price — totalEstimate on the booking. */
    ownerTotal: z.number().positive().max(100_000),
    /** Required by the ROUTE when ownerTotal differs from the server
     *  recommendation by > $1 (the schema cannot know the server number). */
    overrideReason: optionalTrimmed(500),
  }),
  deposit: z.object({ mode: z.enum(DEPOSIT_MODES) }),
})
export type AdminBookingInput = z.infer<typeof AdminBookingSchema>

// ── Pure decision helpers ────────────────────────────────────────────────────

/**
 * Deposit mode → initial BookingStatus.
 *   stripe_link    → PENDING_PAYMENT (the $49 hold link is created and handed
 *                    to the owner to send; payment completes the usual flow)
 *   collect_on_day → CONFIRMED (the owner took the booking on the phone;
 *                    deposit is a move-day matter)
 *   waived         → CONFIRMED (owner decision, recorded in the audit)
 */
export function decideStatus(mode: DepositMode): 'PENDING_PAYMENT' | 'CONFIRMED' {
  return mode === 'stripe_link' ? 'PENDING_PAYMENT' : 'CONFIRMED'
}

/**
 * Does the owner's price need a written reason? Only when the server actually
 * HAS a recommendation (a real package) and the owner moved more than $1 away
 * from it. A 'not-sure' booking has no recommended price to differ from.
 */
export function requiresOverrideReason(
  ownerTotal: number,
  estimate: Pick<Estimate, 'hasService' | 'estimatedTotal'>,
): boolean {
  if (!estimate.hasService) return false
  return Math.abs(ownerTotal - estimate.estimatedTotal) > 1
}

/**
 * The deliberate never-deliverable address for a phone-only customer.
 * Customer.email is unique+required, so a row needs SOME address — and this
 * one is HONEST: `.invalid` is the reserved TLD that can never resolve, and
 * guardedSend's validation refuses it outright, so no lifecycle email can
 * ever be "sent" to a customer who never gave an address. That refusal is the
 * correct behavior, not a bug to fix.
 */
export function synthesizePlaceholderEmail(phone: string): string {
  const digits = phone.replace(/\D/g, '')
  return `no-email-${digits || 'unknown'}@placeholder.invalid`
}

/** "street, city, STATE zip" — the same display composition the public route's
 *  formatAddr produces, so every downstream surface reads consistently. */
export function composeAddress(a: AdminAddress): string {
  const region = [a.state, a.zip].map((s) => s.trim()).filter(Boolean).join(' ')
  return [a.street, a.city, region].map((s) => s.trim()).filter(Boolean).join(', ')
}

/** Bedrooms derivable from the package key ('2br' → 2; studios → 0). Null when
 *  nothing honest can be derived ('not-sure'). */
export function bedroomsFromServiceType(serviceType: string): number | null {
  const key = serviceType.trim().toLowerCase()
  const m = key.match(/^(\d)br$/)
  if (m) return Number(m[1])
  if (key === 'little-studio' || key === 'half-studio' || key === 'full-studio') return 0
  return null
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Portal token expiry for an admin-created booking: the LATER of
 * (move date + 3 days) and (now + 7 days). The public route's flat 7 days
 * left week-out moves with dead portal links on move day (the audit finding
 * booking-approval.extendedPortalExpiry fixed for approvals); an admin-created
 * booking gets the survivable expiry from birth.
 */
export function adminPortalTokenExpiry(moveDate: Date | null, now: Date = new Date()): Date {
  const floor = new Date(now.getTime() + 7 * DAY_MS)
  if (!moveDate) return floor
  const untilAfterMove = new Date(moveDate.getTime() + 3 * DAY_MS)
  return untilAfterMove > floor ? untilAfterMove : floor
}

// ── Inventory snapshots ──────────────────────────────────────────────────────

/** The catalog columns a booking line snapshots (plus recommendedMovers for
 *  the estimating assistant — NOT persisted on the line). */
export type CatalogSnapshotSource = {
  id: string
  name: string
  isHeavy: boolean
  needsDisassembly: boolean
  recommendedMovers: number | null
}

export type InventorySnapshot = {
  catalogItemId: string | null
  name: string
  quantity: number
  isHeavy: boolean
  needsDisassembly: boolean
  /** Assistant input only — BookingInventoryItem has no such column. */
  recommendedMovers: number | null
  notes: string | null
}

/**
 * Resolve submitted lines against the catalog. When catalogItemId matches a
 * row, the catalog's name/isHeavy/needsDisassembly are SNAPSHOTTED onto the
 * line (editing the catalog later never rewrites what a past move carried).
 * A custom line (no catalog id, or an id the catalog no longer has) keeps the
 * typed name with honest false flags.
 */
export function resolveInventorySnapshots(
  lines: AdminInventoryLine[],
  catalogById: Map<string, CatalogSnapshotSource>,
): InventorySnapshot[] {
  return lines.map((line) => {
    const cat = line.catalogItemId ? catalogById.get(line.catalogItemId) : undefined
    return {
      catalogItemId: cat ? cat.id : null,
      name: cat ? cat.name : line.name,
      quantity: line.quantity,
      isHeavy: cat?.isHeavy ?? false,
      needsDisassembly: cat?.needsDisassembly ?? false,
      recommendedMovers: cat?.recommendedMovers ?? null,
      notes: line.notes ?? null,
    }
  })
}

// ── itemsDescription (the human-readable blob every surface reads) ───────────

const round2 = (n: number): number => Math.round(n * 100) / 100

export function buildItemsDescription(
  input: AdminBookingInput,
  snapshots: InventorySnapshot[],
  estimate: Estimate,
  travel: { zone: string | null; travelFeeCents: number | null },
): string {
  const svc = MOVE_SIZES[input.move.serviceType]
  const lines: string[] = []
  lines.push(`Service: ${svc ? svc.label : input.move.serviceType}`)
  lines.push(`Mode: ${SERVICE_MODE_LABELS[input.services.serviceMode]}`)
  if (snapshots.length) {
    lines.push(`Inventory (${snapshots.reduce((s, i) => s + i.quantity, 0)} items):`)
    for (const item of snapshots) {
      const flags = [item.isHeavy ? 'heavy' : null, item.needsDisassembly ? 'disassembly' : null]
        .filter(Boolean)
        .join(', ')
      lines.push(`  ${item.quantity}x ${item.name}${flags ? ` (${flags})` : ''}${item.notes ? ` — ${item.notes}` : ''}`)
    }
  } else {
    lines.push('Inventory: not captured yet — confirm before move day')
  }
  const access: string[] = []
  const stair = (where: string, flights?: number, elevator?: boolean) => {
    if (flights && flights > 0) access.push(`Stairs at ${where}: ${flights} flight${flights === 1 ? '' : 's'}${elevator ? ' (elevator available)' : ', no elevator'}`)
    else if (elevator) access.push(`Elevator at ${where}`)
  }
  stair('pickup', input.move.originStairFlights, input.move.originHasElevator)
  stair('drop-off', input.move.destStairFlights, input.move.destHasElevator)
  if (input.move.longCarry) access.push('Long carry')
  if (input.move.coiRequired) access.push('COI required')
  if (input.move.additionalStopsCount) access.push(`${input.move.additionalStopsCount} additional stop(s)`)
  if (access.length) lines.push(...access)
  if (input.move.accessNotes) lines.push(`Access notes: ${input.move.accessNotes}`)
  const services: string[] = []
  if (input.services.needsPacking) services.push('packing')
  if (input.services.needsUnpacking) services.push('unpacking')
  if (input.services.needsAssembly) services.push('assembly')
  if (input.services.needsDisassembly) services.push('disassembly')
  if (services.length) lines.push(`Services: ${services.join(', ')}`)
  if (estimate.hasService) lines.push(`Recommended estimate: $${estimate.estimatedTotal}`)
  lines.push(`Owner price: $${round2(input.pricing.ownerTotal)}`)
  if (input.pricing.overrideReason) lines.push(`Price reason: ${input.pricing.overrideReason}`)
  if (travel.zone === 'extended_nj' && travel.travelFeeCents) {
    lines.push(`Extended service-area fee: $${travel.travelFeeCents / 100} (due on move day)`)
  }
  if (travel.zone && travel.zone !== 'primary' && travel.zone !== 'extended_nj') {
    lines.push('Service area: owner-reviewed at booking (admin-created)')
  }
  if (input.itemsDescription) lines.push(`Notes: ${input.itemsDescription}`)
  lines.push('Source: admin Book Move')
  return lines.join('\n')
}

// ── The Booking.create data object ───────────────────────────────────────────

export type BookingCreateContext = {
  /** computeEstimate() over the same inputs — the server recommendation. */
  estimate: Estimate
  /** checkServiceArea() outcome (zone/fee recomputed server-side, never trusted
   *  from the browser — same rule as the public route). */
  travel: { zone: string | null; travelFeeCents: number | null; message?: string | null }
  /** The atomic WMIC-#### reference (nextBookingReference()). */
  reference: string
  /** Optional explicit portal token; omit to use the column's cuid default. */
  token?: string
  tokenExpiry: Date
  /** The requested move instant (ET wall clock via etDateTimeToInstant). */
  requestedDate: Date
  /** From the assistant: drives scheduledEnd via confirmationScheduleData. */
  estimatedHours?: number | null
}

/**
 * Every column the admin create writes, mirroring the public route's mapping
 * (app/api/bookings/route.ts ~377-466) plus the Phase-1 columns. Returned
 * WITHOUT customerId/relations — the route spreads `{ customerId, ...data }`.
 *
 * Conventions pinned by tests:
 *   • originAddress/destAddress = "street, city, STATE zip"
 *   • baseRate      = estimate.estimatedTotal − travel (labor + access, $)
 *   • totalEstimate = the OWNER's price (per-booking pricing, hard rule 1)
 *   • depositAmount = 4900 cents regardless of deposit mode
 *   • status per decideStatus; source 'admin'
 */
export function buildBookingCreateData(
  input: AdminBookingInput,
  ctx: BookingCreateContext,
  snapshots: InventorySnapshot[] = [],
): Omit<Prisma.BookingUncheckedCreateInput, 'customerId'> {
  const { estimate, travel } = ctx
  const travelFeeCents = travel.travelFeeCents ?? 0
  const overridden = requiresOverrideReason(input.pricing.ownerTotal, estimate)
  return {
    bookingReference: ctx.reference,
    displayId: ctx.reference,
    status: decideStatus(input.deposit.mode),
    originAddress: composeAddress(input.move.originAddress),
    destAddress: composeAddress(input.move.destAddress),
    itemsDescription: buildItemsDescription(input, snapshots, estimate, travel),
    requestedDate: ctx.requestedDate,
    arrivalWindow: input.move.arrivalWindow ?? null,

    // ── Structured access (same columns the public route maps) ──
    originFloor: input.move.originFloor ?? null,
    destFloor: input.move.destFloor ?? null,
    originHasElevator: input.move.originHasElevator ?? null,
    destHasElevator: input.move.destHasElevator ?? null,
    originStairCount: input.move.originStairFlights ?? null,
    destStairCount: input.move.destStairFlights ?? null,
    originAccessNotes: input.move.accessNotes ?? null,
    crewInstructions: input.crewInstructions ?? null,

    // ── Move details ──
    bedrooms: bedroomsFromServiceType(input.move.serviceType),
    needsPacking: input.services.needsPacking,
    needsUnpacking: input.services.needsUnpacking,
    needsAssembly: input.services.needsAssembly,
    needsDisassembly: input.services.needsDisassembly,

    // ── Money (per-booking owner pricing; the price book is never touched) ──
    depositAmount: 4900,
    depositPaid: false,
    // Labor + access add-ons WITHOUT travel — the number comparable to the
    // package base the public route stores. estimatedTotal includes travel,
    // so subtracting it keeps travelFee from being double-counted downstream.
    baseRate: estimate.hasService ? round2(estimate.estimatedTotal - estimate.travel) : null,
    totalEstimate: round2(input.pricing.ownerTotal),
    estimatedHours: ctx.estimatedHours ?? null,

    // ── Service area (server-computed; fee due on move day, never in Stripe) ──
    serviceAreaZone: (travel.zone ?? null) as Prisma.BookingUncheckedCreateInput['serviceAreaZone'],
    travelFee: travelFeeCents,
    travelFeeDueOnMoveDay: travelFeeCents > 0,
    serviceAreaMessage: travel.message ?? null,

    // ── Moving OS Phase 1 columns ──
    truckId: input.truckId ?? null,
    originPropertyType: input.move.originPropertyType ?? null,
    destPropertyType: input.move.destPropertyType ?? null,
    serviceMode: input.services.serviceMode,
    coiRequired: input.move.coiRequired ?? false,
    priceOverrideReason: overridden ? (input.pricing.overrideReason ?? null) : null,

    // ── Attribution + portal ──
    source: 'admin',
    ...(ctx.token ? { customerToken: ctx.token } : {}),
    customerTokenExpiry: ctx.tokenExpiry,
  }
}

// ── JobStaffingRequirement from the recommendation ───────────────────────────

/**
 * The auto-created staffing requirement — the fix for the dispatch blind spot
 * (JobStaffingRequirement was never auto-created, so UNDERSTAFFED /
 * MISSING_DRIVER could never fire for real jobs). Derived from the assistant
 * recommendation + the booking's own inputs; jobId is supplied by the route.
 */
export function buildStaffingRequirementData(
  rec: Pick<EstimateRecommendation, 'crewSize' | 'estimatedHoursMax'>,
  input: AdminBookingInput,
  snapshots: InventorySnapshot[],
  estimatedStartAt: Date | null,
): Omit<Prisma.JobStaffingRequirementUncheckedCreateInput, 'jobId'> {
  return {
    requiredWorkers: rec.crewSize,
    minWorkers: Math.max(2, rec.crewSize - 1),
    requiredDrivers: 1,
    requiresLead: true,
    additionalStops: input.move.additionalStopsCount ?? 0,
    hasStairs: (input.move.originStairFlights ?? 0) > 0 || (input.move.destStairFlights ?? 0) > 0,
    hasElevator: !!input.move.originHasElevator || !!input.move.destHasElevator,
    longCarry: !!input.move.longCarry,
    heavyItems: snapshots.some((s) => s.isHeavy),
    packing: input.services.needsPacking,
    assembly:
      input.services.needsAssembly ||
      input.services.needsDisassembly ||
      snapshots.some((s) => s.needsDisassembly),
    estimatedStartAt,
    workerInstructions: input.crewInstructions ?? null,
  }
}

// ── Warnings (surfaced to the owner, never blocking) ─────────────────────────

export function collectBookingWarnings(args: {
  inventoryCount: number
  zone: string | null
  serviceType: string
  truckOverrideUsed: boolean
}): string[] {
  const warnings: string[] = []
  if (args.inventoryCount === 0) {
    warnings.push('No inventory captured — confirm the item list before move day.')
  }
  if (args.zone && args.zone !== 'primary' && args.zone !== 'extended_nj') {
    warnings.push('Service area needs manual review — travel pricing is an owner decision on this one.')
  }
  if (args.serviceType === 'not-sure') {
    warnings.push('Move size unconfirmed — the estimate has no package behind it yet.')
  }
  if (args.truckOverrideUsed) {
    warnings.push('Truck double-booking explicitly overridden — two jobs share this truck.')
  }
  return warnings
}
