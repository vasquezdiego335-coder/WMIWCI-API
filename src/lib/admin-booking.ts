// ============================================================================
// admin-booking.ts — pure helpers for the admin Book Move workspace
// (Moving OS Phase 1, owner spec 2026-08-11; correctness pass 2026-08-12).
//
// Everything decision-shaped lives HERE, offline-testable (house rule: route
// files stay thin so the logic can be unit-tested without a Next route):
//   • AdminBookingSchema      — the zod contract for POST /api/admin/bookings
//   • decideStatus            — deposit mode → initial BookingStatus
//   • resolveMoveSchedule     — moveDate + REAL startTime → instants (item 2)
//   • findAdminTruckConflicts — day-level bookings keep the conservative check
//   • resolveCustomerMutation — the picked customer wins over email (item 3)
//   • buildBookingCreateData  — the Booking.create data object, mapping every
//                               structured column the public route maps
//                               (app/api/bookings/route.ts is the bible)
//   • addressColumnValues / deriveMoveDetails — structured-data parity (item 6)
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
//
// CLIENT-BUNDLE RULE: BookMoveForm.tsx ('use client') imports this module's
// vocabulary, so NOTHING here may import a module that pulls in the Prisma
// runtime — that is why scheduling.ts's ET helpers are INJECTED (see
// EtScheduleHelpers) rather than imported: scheduling.ts imports ./db.
// ============================================================================

import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { MOVE_SIZES, type Estimate } from './estimate'
import type { EstimateRecommendation } from './estimate-assistant'
import { assessAddress } from './address'
import type { VerifiedAddress } from './address-verify'
import { buildReviewReasons } from './booking-review'
import {
  findTruckConflictsIn,
  holdKindOf,
  holdsTruck,
  truckConflictBetween,
  type TruckBookingShape,
  type TruckConflict,
} from './truck-conflicts'
import {
  buildStaffingPlan,
  staffingRequirementDataFromPlan,
  type StaffingPlan,
  type StaffingRecommendation,
} from './staffing-plan'

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
    /** The EXISTING customer the owner picked in the workspace search. When it
     *  is present that row IS the customer (correctness pass item 3) — the
     *  route never falls back to matching on the typed email, which is what
     *  created a second CRM record every time a repeat customer's email was
     *  corrected or added. */
    id: optionalTrimmed(64),
    name: z.string().trim().min(1).max(200),
    email: z.preprocess(
      (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
      z.string().trim().toLowerCase().email().max(320).optional(),
    ),
    phone: optionalTrimmed(40),
    /** The customer's EMAIL LANGUAGE. Optional with NO default (R2-7.1): it
     *  used to default to 'en', which made every submission look like the
     *  owner had chosen English, and resolveCustomerMutation dutifully wrote
     *  it — silently flipping a Spanish-speaking repeat customer's lifecycle
     *  emails to English the moment their lead was converted (the lead prefill
     *  carries no locale, so the form's untouched default rode along). Absent
     *  now means "the owner did not state a language": an existing customer
     *  keeps theirs, and a NEW customer is created 'en' (the house default,
     *  applied at create time in resolveCustomerMutation — a create can never
     *  overwrite a stated preference). An empty string is treated as absent
     *  for the same reason. */
    locale: z.preprocess(
      (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
      z.enum(['en', 'es']).optional(),
    ),
  })
  // Phone is required exactly when there is no email — a booking must be
  // reachable somehow.
  .refine((c) => !!c.email || !!(c.phone && c.phone.trim()), {
    message: 'Provide an email or a phone number',
    path: ['phone'],
  })

/** 'HH:MM', 24-hour, ET wall clock. An empty string means "not captured", not
 *  "midnight"; a single-digit hour is zero-padded so '9:05' and '09:05' store
 *  identically. Deliberately NOT a datetime — the date is its own field. */
const StartTimeSchema = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z
    .string()
    .trim()
    .regex(/^([01]?\d|2[0-3]):[0-5]\d$/, 'startTime must be HH:MM (24-hour)')
    .transform((s) => {
      const [h, m] = s.split(':')
      return `${h.padStart(2, '0')}:${m}`
    })
    .optional(),
)

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
  /** The crew's REAL start time as an America/New_York wall clock, 24h HH:MM.
   *  OPTIONAL by design (correctness pass item 2): when the owner has not
   *  committed to a time yet the booking is scheduled at DAY level and
   *  scheduledStart/scheduledEnd stay NULL. Nothing anywhere invents an hour,
   *  and the arrival-window free text below is NEVER parsed into a timestamp. */
  startTime: StartTimeSchema,
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

// ── ITEM 2 — the move schedule (no invented 7:00 AM) ─────────────────────────

/**
 * The two ET helpers this module needs, INJECTED by the caller.
 * They are the real functions from src/lib/scheduling.ts —
 * `etDateTimeToInstant` (DST-correct ET wall clock → UTC instant, via Intl,
 * never a hand-rolled offset) and `calculateEndTime` (start + hours + the
 * house TRAVEL_BUFFER_MINUTES). They are passed in rather than imported
 * because scheduling.ts imports the Prisma client and this module is also
 * loaded by the 'use client' Book Move form.
 */
export type EtScheduleHelpers = {
  toInstant: (dateStr: string, timeStr: string) => Date | null
  endTime: (start: Date, hours: number) => Date
}

export type MoveSchedule = {
  /** The instant the booking is anchored to. With a start time it IS that
   *  instant; without one it is 00:00 ET of the move date — a DAY ANCHOR (the
   *  same boundary etDayRange uses), not a claimed crew hour. Null only when
   *  the date itself is unparseable. */
  requestedDate: Date | null
  /** NULL unless the owner actually gave a start time. */
  scheduledStart: Date | null
  /** start + the plan's max hours + the house buffer; null with no start. */
  scheduledEnd: Date | null
  /** True when no start time was captured → day-level scheduling. */
  dayLevel: boolean
  /** Echo of the accepted 'HH:MM' (null when day-level) for the response/UI. */
  startTime: string | null
}

/** 00:00 ET — the day anchor for a booking with no committed start time. */
const DAY_ANCHOR_TIME = '00:00'

/**
 * moveDate (+ optional startTime) → the schedule instants.
 *
 * Phase 1 derived `requestedDate` from a hardcoded 07:00, so Calendar, staffing
 * times and truck conflicts all keyed off an hour nobody chose, and a free-text
 * arrival window was silently promoted into an exact timestamp. Now:
 *   • startTime given  → requestedDate = scheduledStart = that ET wall clock
 *                        (DST-correct), scheduledEnd = + the plan's max hours.
 *   • startTime absent → scheduledStart/scheduledEnd stay NULL and the booking
 *                        is scheduled at DAY level (confirmedDate only). The
 *                        arrival-window text is never parsed for a time.
 */
export function resolveMoveSchedule(
  move: { moveDate: string; startTime?: string | null },
  opts: { estimatedHours?: number | null; helpers: EtScheduleHelpers },
): MoveSchedule {
  const time = (move.startTime ?? '').trim()
  if (!time) {
    return {
      requestedDate: opts.helpers.toInstant(move.moveDate, DAY_ANCHOR_TIME),
      scheduledStart: null,
      scheduledEnd: null,
      dayLevel: true,
      startTime: null,
    }
  }
  const start = opts.helpers.toInstant(move.moveDate, time)
  if (!start) {
    return { requestedDate: null, scheduledStart: null, scheduledEnd: null, dayLevel: true, startTime: null }
  }
  const hours = opts.estimatedHours && opts.estimatedHours > 0 ? opts.estimatedHours : null
  return {
    requestedDate: start,
    scheduledStart: start,
    // No plan hours → no end. The truck-conflict lib's 6h fallback window then
    // holds the truck honestly instead of us guessing a job length.
    scheduledEnd: hours ? opts.helpers.endTime(start, hours) : null,
    dayLevel: false,
    startTime: time,
  }
}

/**
 * Truck conflicts for a booking being CREATED, over the already-loaded
 * candidates for that truck.
 *
 * With a real start time this is exactly `findTruckConflictsIn`. WITHOUT one,
 * that function cannot be used as-is: it treats `query.start` as a real
 * scheduledStart, so handing it the 00:00 day anchor would guard only
 * 00:00–06:00 ET and wave through the 8 AM job on the same truck. A day-level
 * booking instead goes through `truckConflictBetween` with UNKNOWN times, which
 * is the lib's deliberately conservative same-ET-day rule.
 *
 * P0-A: `estimatedHours` rides BOTH branches, so the booking being created is
 * measured by its own length exactly as the stored rows it is compared against
 * are. One derivation (truck-conflicts.truckHoldHours) on both sides.
 */
export function findAdminTruckConflicts(
  candidates: TruckBookingShape[],
  query: {
    truckId?: string | null
    scheduledStart: Date | null
    scheduledEnd?: Date | null
    /** The move's day anchor (used only when there is no start time). */
    moveDay: Date | null
    /** The assistant's estimatedHoursMax for this booking — the same number
     *  the route persists as Booking.estimatedHours. */
    estimatedHours?: number | null
  },
): TruckConflict[] {
  if (!query.truckId) return []
  if (query.scheduledStart) {
    return findTruckConflictsIn(candidates, {
      truckId: query.truckId,
      start: query.scheduledStart,
      end: query.scheduledEnd ?? null,
      estimatedHours: query.estimatedHours ?? null,
    })
  }
  if (!query.moveDay) return []
  const unknownTimes = {
    scheduledStart: null,
    scheduledEnd: null,
    confirmedDate: query.moveDay,
    estimatedHours: query.estimatedHours ?? null,
  }
  const out: TruckConflict[] = []
  for (const b of candidates) {
    if (b.truckId !== query.truckId) continue
    // R2-2: TRUCK_HOLD_STATUSES via holdsTruck — the ONE list. An unpaid
    // PENDING_PAYMENT booking with a truck assigned holds that truck.
    if (!holdsTruck(b.status)) continue
    const reason = truckConflictBetween(unknownTimes, b)
    if (reason) out.push({ booking: b, reason, hold: holdKindOf(b.status) })
  }
  return out
}

// ── ITEM 3 — the picked customer is the customer ─────────────────────────────

/** The Customer columns this decision reads. Every field optional so a partial
 *  `select` (and an offline fake) satisfies it. */
export type CustomerContact = {
  id: string
  name?: string | null
  email?: string | null
  phone?: string | null
  locale?: string | null
}

export type CustomerSubmission = {
  name: string
  email?: string | null
  phone?: string | null
  locale?: string | null
}

/** Only ever contact fields. isFirstTime, consent columns and everything else
 *  on Customer are untouchable from this flow. */
export type CustomerContactPatch = {
  name?: string
  email?: string
  phone?: string
  locale?: string
}

export type CustomerMutation =
  /** The picked row already says what the owner typed — nothing to write. */
  | { mode: 'use'; customerId: string; warning?: string }
  | {
      mode: 'update'
      customerId: string
      data: CustomerContactPatch
      /** The stored values for exactly the fields being changed (audit). */
      before: Record<string, string | null>
      warning?: string
    }
  | {
      mode: 'create'
      data: { email: string; name: string; phone: string; locale: string; isFirstTime: true }
      warning?: string
    }
  /** The submitted email belongs to a DIFFERENT customer — 409, never a merge. */
  | { mode: 'conflict'; customerId: string; conflictingCustomerId: string; message: string }

const sameEmail = (a?: string | null, b?: string | null): boolean =>
  (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase()

/**
 * THE customer decision for POST /api/admin/bookings.
 *
 * Phase 1 upserted by email, so correcting or adding an email on a repeat
 * customer created a SECOND CRM record — breaking their history, lifetime value
 * and the first-time discount logic. Now:
 *   1. `pickedId` (the record the owner clicked in the search) is authoritative.
 *   2. Its contact fields are updated ONLY where the owner supplied a value: a
 *      blank field never erases a stored email or phone.
 *   3. A submitted email that already belongs to another customer is a
 *      CONFLICT — the owner decides; two CRM records are never merged silently.
 *   4. Email matching (or a create) happens ONLY when no id was picked.
 * isFirstTime and every consent column are never written here.
 */
export function resolveCustomerMutation(args: {
  pickedId?: string | null
  /** The picked row, loaded by id. Null/absent = the id no longer exists. */
  existing?: CustomerContact | null
  /** The customer that already OWNS the email being submitted, if any. */
  emailOwner?: CustomerContact | null
  submitted: CustomerSubmission
  /** Email to create with when the owner gave none (the .invalid placeholder). */
  fallbackEmail: string
}): CustomerMutation {
  const submittedName = (args.submitted.name ?? '').trim()
  const submittedEmail = (args.submitted.email ?? '').trim().toLowerCase() || null
  const submittedPhone = (args.submitted.phone ?? '').trim() || null
  const submittedLocale = (args.submitted.locale ?? '').trim() || null

  const pickedId = (args.pickedId ?? '').trim() || null
  const picked = pickedId && args.existing && args.existing.id === pickedId ? args.existing : null
  const emailOwner = args.emailOwner ?? null

  // A picked id that no longer resolves is reported, not silently obeyed.
  const staleWarning =
    pickedId && !picked
      ? 'The selected customer record no longer exists — matched on the email address instead.'
      : undefined

  // The picked row wins. Email matching is reached only when no id was given —
  // or when the given id has vanished, where creating a second row under an
  // email somebody already owns is neither possible (unique column) nor right.
  const target = picked ?? emailOwner

  if (picked && submittedEmail && !sameEmail(submittedEmail, picked.email) && emailOwner && emailOwner.id !== picked.id) {
    return {
      mode: 'conflict',
      customerId: picked.id,
      conflictingCustomerId: emailOwner.id,
      message: `${submittedEmail} already belongs to another customer (${(emailOwner.name ?? 'unnamed').trim()}). Book under that customer, or clear the email — two customer records are never merged automatically.`,
    }
  }

  if (target) {
    const data: CustomerContactPatch = {}
    const before: Record<string, string | null> = {}
    if (submittedName && submittedName !== (target.name ?? '')) {
      data.name = submittedName
      before.name = target.name ?? null
    }
    // Only a supplied email is written, and only when it is not already
    // somebody else's (guarded above for the picked path; on the email-matched
    // path it IS this row's address by construction).
    if (submittedEmail && !sameEmail(submittedEmail, target.email)) {
      data.email = submittedEmail
      before.email = target.email ?? null
    }
    if (submittedPhone && submittedPhone !== (target.phone ?? '')) {
      data.phone = submittedPhone
      before.phone = target.phone ?? null
    }
    if (submittedLocale && submittedLocale !== (target.locale ?? '')) {
      data.locale = submittedLocale
      before.locale = target.locale ?? null
    }
    return Object.keys(data).length
      ? { mode: 'update', customerId: target.id, data, before, ...(staleWarning ? { warning: staleWarning } : {}) }
      : { mode: 'use', customerId: target.id, ...(staleWarning ? { warning: staleWarning } : {}) }
  }

  return {
    mode: 'create',
    data: {
      email: submittedEmail ?? args.fallbackEmail,
      name: submittedName,
      // Customer.phone is a required column — '' is the honest "not provided",
      // never a fabricated number.
      phone: submittedPhone ?? '',
      locale: submittedLocale ?? 'en',
      isFirstTime: true,
    },
    ...(staleWarning ? { warning: staleWarning } : {}),
  }
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
  /** "furniture"|"boxes"|"appliances"|"specialty"|… — drives numBoxes and the
   *  specialty flags on the booking (item 6). Optional: a catalog row loaded by
   *  an older caller simply contributes no category signal. */
  category?: string | null
  /** InventoryCatalogItem.typicalVolumeCuFt — the ONLY honest basis for
   *  estimatedCubicFeet. Absent on custom lines, which is why the derivation
   *  refuses to guess (see deriveMoveDetails). */
  typicalVolumeCuFt?: number | null
}

export type InventorySnapshot = {
  catalogItemId: string | null
  name: string
  quantity: number
  isHeavy: boolean
  needsDisassembly: boolean
  /** Assistant input only — BookingInventoryItem has no such column. */
  recommendedMovers: number | null
  /** Catalog category when this line came from the catalog; null for a custom
   *  line. Not persisted on the line — used to derive booking columns.
   *  OPTIONAL so an existing caller that builds a snapshot literal by hand
   *  still compiles; absent simply means "no category signal". */
  category?: string | null
  /** Catalog volume per unit; null/absent for custom lines. Not persisted. */
  volumeCuFt?: number | null
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
      category: cat?.category ?? null,
      volumeCuFt: cat?.typicalVolumeCuFt ?? null,
      notes: line.notes ?? null,
    }
  })
}

// ── ITEM 6 — move details derived from the captured inventory ────────────────

/** Box lines are identified by the CATALOG category, never by name-guessing. */
const BOX_CATEGORY = 'boxes'
const APPLIANCE_CATEGORY = 'appliances'
const SPECIALTY_CATEGORY = 'specialty'

const PIANO_RE = /\bpianos?\b/i
const SAFE_RE = /\bsafes?\b/i
const POOL_TABLE_RE = /\b(pool table|billiards?)\b/i
const APPLIANCE_RE = /\b(washer|dryer|washing machine|refrigerator|fridge|freezer|stove|oven|range|dishwasher)\b/i

export type DerivedMoveDetails = {
  numBoxes: number | null
  estimatedCubicFeet: number | null
  hasPiano: boolean | null
  hasSafe: boolean | null
  hasPoolTable: boolean | null
  hasAppliances: boolean | null
  specialtyItems: string | null
}

/**
 * The Booking "move details" columns the reporting/Action Center/job surfaces
 * read, derived from what the owner actually captured. NOTHING is invented:
 *   • numBoxes — quantities of catalog lines in the `boxes` category. NULL when
 *     no line carries a category at all (an empty list, or the catalog
 *     migration unapplied): "unknown" is not "zero boxes".
 *   • estimatedCubicFeet — only when EVERY line has a catalog volume, so a
 *     half-catalog list can never report a confidently-too-small number.
 *   • hasPiano/hasSafe/hasPoolTable/hasAppliances — NULL when no inventory was
 *     captured ("not asked"), otherwise the honest answer for this list.
 */
export function deriveMoveDetails(snapshots: InventorySnapshot[]): DerivedMoveDetails {
  if (!snapshots.length) {
    return {
      numBoxes: null,
      estimatedCubicFeet: null,
      hasPiano: null,
      hasSafe: null,
      hasPoolTable: null,
      hasAppliances: null,
      specialtyItems: null,
    }
  }
  const categorized = snapshots.filter((s) => !!s.category)
  const numBoxes = categorized.length
    ? snapshots
        .filter((s) => (s.category ?? '').toLowerCase() === BOX_CATEGORY)
        .reduce((sum, s) => sum + s.quantity, 0)
    : null

  const everyLineHasVolume = snapshots.every((s) => typeof s.volumeCuFt === 'number' && s.volumeCuFt > 0)
  const estimatedCubicFeet = everyLineHasVolume
    ? Math.round(snapshots.reduce((sum, s) => sum + (s.volumeCuFt ?? 0) * s.quantity, 0))
    : null

  const specialty: string[] = []
  let hasPiano = false
  let hasSafe = false
  let hasPoolTable = false
  let hasAppliances = false
  for (const s of snapshots) {
    const cat = (s.category ?? '').toLowerCase()
    const piano = PIANO_RE.test(s.name)
    const safe = SAFE_RE.test(s.name)
    const pool = POOL_TABLE_RE.test(s.name)
    if (piano) hasPiano = true
    if (safe) hasSafe = true
    if (pool) hasPoolTable = true
    if (cat === APPLIANCE_CATEGORY || APPLIANCE_RE.test(s.name)) hasAppliances = true
    if (piano || safe || pool || cat === SPECIALTY_CATEGORY) specialty.push(s.name)
  }
  return {
    numBoxes,
    estimatedCubicFeet,
    hasPiano,
    hasSafe,
    hasPoolTable,
    hasAppliances,
    specialtyItems: specialty.length ? Array.from(new Set(specialty)).join(', ') : null,
  }
}

// ── R2-5 — the inventory's own review verdict (public-path parity) ───────────
//
// THE DEFECT: the admin route calls computeEstimate() with no heavy/specialty
// input, and every heavy/specialty review reason in the canonical estimator
// exists only under that input. So an admin 2BR booking carrying the catalog's
// "Piano (upright)" landed with hasPiano = true and specialtyItems =
// "Piano (upright)" but manualReviewRequired = false and reviewReasons = [] —
// a row that contradicts itself. The IDENTICAL public booking is review-gated
// (computeEstimate's HEAVY_PIANO_SAFE line is a manual_quote → requiresReview),
// so Action Center rules, booking-completeness, the Discord card and the
// "pending review" copy all behaved differently for the same job depending on
// who typed it in.
//
// WHY IT LIVES HERE and not in the route's computeEstimate call: this is the
// one function the route already hands the captured inventory to. Deriving the
// verdict from those same snapshots means no route wiring can be forgotten
// later — the guarantee is structural, not a call site somebody has to
// remember. It also keeps the ESTIMATE untouched: these are review lines worth
// $0 in the estimator, so folding them in here cannot move estimatedTotal and
// therefore cannot move the owner-price comparison (requiresOverrideReason).
//
// NOTHING IS INVENTED. The catalog carries no weights, so no pounds are
// fabricated to reach a weight tier; these three items are the ones the
// estimator itself treats as "custom quote, manual approval" regardless of
// weight, and the reason names the exact line the owner typed.

/** Piano / safe / pool-table lines in the captured inventory, worded as owner
 *  review reasons. Empty when the inventory has none — and empty for an
 *  inventory that was never captured, which is "not asked", not "none".
 *
 *  One reason per KIND (the first matching line names it), so ten boxes of
 *  sheet music next to one piano still produce one sentence. */
export function specialtyReviewReasons(snapshots: InventorySnapshot[]): string[] {
  const reasons: string[] = []
  const seen = { piano: false, safe: false, pool: false }
  for (const s of snapshots ?? []) {
    const name = (s?.name ?? '').trim()
    if (!name) continue
    if (!seen.piano && PIANO_RE.test(name)) {
      seen.piano = true
      reasons.push(`${name} on the inventory — a piano is quoted and approved by hand, never auto-priced`)
    }
    if (!seen.safe && SAFE_RE.test(name)) {
      seen.safe = true
      reasons.push(`${name} on the inventory — a substantial safe is quoted and approved by hand, never auto-priced`)
    }
    if (!seen.pool && POOL_TABLE_RE.test(name)) {
      seen.pool = true
      reasons.push(`${name} on the inventory — a pool table needs disassembly and a hand-quoted price`)
    }
  }
  return reasons
}

// ── ITEM 6 — structured address columns (public-route parity) ────────────────

export type AddressColumnValues = {
  streetNumber: string | null
  route: string | null
  city: string | null
  county: string | null
  state: string | null
  zip: string | null
  country: string | null
  formatted: string | null
  lat: number | null
  lng: number | null
  placeId: string | null
  /** 'verified' | 'partial' | 'unverified' | 'skipped' — the REAL provider
   *  verdict, or null when no verification ran at all. */
  verification: string | null
  validationReason: string | null
}

/** "12 Main St" → { streetNumber: '12', route: 'Main St' }. A street line with
 *  no leading house number keeps the whole string as the route (honest: we do
 *  not know the number) — the same information the owner typed, split, never
 *  embellished. */
export function splitStreetLine(street: string): { streetNumber: string | null; route: string | null } {
  const s = (street ?? '').trim()
  if (!s) return { streetNumber: null, route: null }
  const m = /^(\d+[A-Za-z]?)\s+(.+)$/.exec(s)
  return m ? { streetNumber: m[1], route: m[2].trim() } : { streetNumber: null, route: s }
}

/**
 * The origin_* / dest_* structured columns for one address.
 *
 * ADDRESS-VERIFICATION HONESTY: components come from the SERVER verification
 * when it actually verified the address (Google's canonical spelling), and
 * otherwise from what the owner typed — but `verification` is ALWAYS the real
 * status. It is never 'verified' unless the provider said so, and it stays NULL
 * when no verification ran, so `booking-address-unverified` fires honestly.
 * lat/lng/placeId/formatted are provider-only: we never fabricate coordinates
 * or a canonical formatting.
 */
export function addressColumnValues(typed: AdminAddress, verified: VerifiedAddress | null): AddressColumnValues {
  const usable = verified && verified.status === 'verified'
  const { streetNumber, route } = splitStreetLine(typed.street)
  return {
    streetNumber: (usable ? verified?.streetNumber : null) ?? streetNumber,
    route: (usable ? verified?.route : null) ?? route,
    city: (usable ? verified?.city : null) ?? (typed.city.trim() || null),
    county: (usable ? verified?.county : null) ?? null,
    state: (usable ? verified?.state : null) ?? (typed.state.trim() || null),
    zip: (usable ? verified?.zip : null) ?? (typed.zip.trim() || null),
    country: (usable ? verified?.country : null) ?? null,
    formatted: verified?.formatted ?? null,
    lat: verified?.lat ?? null,
    lng: verified?.lng ?? null,
    placeId: verified?.placeId ?? null,
    verification: verified?.status ?? null,
    validationReason: verified?.reason ?? null,
  }
}

/** Does this address need the owner's eyes? Same rule as the public route's
 *  legacy path: an 'unverified' verdict, or a 'skipped' provider plus a string
 *  that fails the offline completeness check. No verification at all → judge
 *  the string alone. 'partial'/'verified' pass. */
export function addressNeedsReview(typed: AdminAddress, verified: VerifiedAddress | null): boolean {
  const assessment = assessAddress(composeAddress(typed))
  if (!verified) return !assessment.complete
  if (verified.status === 'unverified') return true
  if (verified.status === 'skipped') return !assessment.complete
  return false
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
   *  from the browser — same rule as the public route). EVERY output it
   *  produces is persisted (item 6), not just the zone and the fee. */
  travel: {
    zone: string | null
    travelFeeCents: number | null
    message?: string | null
    manualReviewRequired?: boolean | null
    distanceFromWestOrangeMiles?: number | null
    estimatedDriveTimeMinutes?: number | null
    evaluatedAddresses?: unknown
  }
  /** The atomic WMIC-#### reference (nextBookingReference()). */
  reference: string
  /** Optional explicit portal token; omit to use the column's cuid default. */
  token?: string
  tokenExpiry: Date
  /** The requested move instant — resolveMoveSchedule().requestedDate. */
  requestedDate: Date
  /** resolveMoveSchedule() output (item 2). Absent = day-level scheduling. */
  schedule?: MoveSchedule | null
  /** From the assistant: the job length estimate. */
  estimatedHours?: number | null
  /** The SERVER-side address verification results (verifyAddress). Omit when it
   *  did not run: the verification columns then stay NULL rather than claiming
   *  a state nobody checked. */
  verification?: { origin: VerifiedAddress | null; dest: VerifiedAddress | null } | null
  /** The owner's staffing plan (crew/truck/hours) captured on this call —
   *  persisted on EVERY deposit mode, including stripe_link where no Job exists
   *  yet, so approveBooking can build the right requirement later (fix item 1). */
  staffingPlan?: StaffingPlan | null
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
 *   • scheduledStart/End ONLY when a real start time was captured AND the
 *     booking is created CONFIRMED (item 2)
 *   • manualReviewRequired/reviewReasons from the SAME buildReviewReasons the
 *     public route uses, so review-gated charges and the Action Center behave
 *     identically for an admin-created job (item 6) — INCLUDING the captured
 *     inventory's own piano/safe/pool-table verdict (R2-5), which is why the
 *     `snapshots` argument is load-bearing for review and not just for the
 *     derived move-detail columns
 */
export function buildBookingCreateData(
  input: AdminBookingInput,
  ctx: BookingCreateContext,
  snapshots: InventorySnapshot[] = [],
): Omit<Prisma.BookingUncheckedCreateInput, 'customerId'> {
  const { estimate, travel } = ctx
  const travelFeeCents = travel.travelFeeCents ?? 0
  const overridden = requiresOverrideReason(input.pricing.ownerTotal, estimate)
  const status = decideStatus(input.deposit.mode)

  // ── Item 2: real times or none. A CONFIRMED booking with a start time is
  //    stamped exactly like approveBooking stamps one; without a start time it
  //    is day-level (confirmedDate only) and every schedule view reads it by
  //    day. scheduledStart is NEVER back-filled from an invented hour.
  const scheduledStart = ctx.schedule?.scheduledStart ?? null
  const scheduledEnd = ctx.schedule?.scheduledEnd ?? null
  // ── Item R2-1: RECORD the absence, don't just leave a null. Round 1 left
  //    scheduledStart null on the stripe_link path and approval promoted the
  //    00:00 ET day anchor into it — a 12:00 AM job, and (worse) an interval
  //    truck check instead of the conservative whole-day one. This boolean is
  //    the fact approval was missing. A caller that hands us no schedule at all
  //    gets the column default (true) rather than a fabricated claim of
  //    day-level scheduling.
  const startTimeKnown = ctx.schedule ? !ctx.schedule.dayLevel : true

  // ── Item 6: structured address components + the REAL verification verdicts.
  const originCols = addressColumnValues(input.move.originAddress, ctx.verification?.origin ?? null)
  const destCols = addressColumnValues(input.move.destAddress, ctx.verification?.dest ?? null)
  const needsAddressReview =
    addressNeedsReview(input.move.originAddress, ctx.verification?.origin ?? null) ||
    addressNeedsReview(input.move.destAddress, ctx.verification?.dest ?? null)

  const details = deriveMoveDetails(snapshots)

  // ── Item 6 + R2-5: ONE review verdict, built by the helper the public route
  //    uses. The inventory's own specialty verdict is folded into the ESTIMATE
  //    channel — the same channel the public path's piano/safe review line
  //    arrives through — so `buildReviewReasons` sees it and the flag and the
  //    reasons can never disagree. `estimate` itself is NOT mutated: only this
  //    call's view of it carries the extra reasons, so estimatedTotal (and the
  //    owner-price comparison built on it) is untouched. Duplicates are
  //    collapsed by buildReviewReasons' own Set.
  const specialtyReasons = specialtyReviewReasons(snapshots)
  const reviewReasons = buildReviewReasons({
    estimate: {
      requiresReview: estimate.requiresReview || specialtyReasons.length > 0,
      reviewReasons: estimate.reviewReasons.concat(specialtyReasons),
    },
    serviceArea: {
      manualReviewRequired: travel.manualReviewRequired ?? undefined,
      zone: travel.zone,
      message: travel.message ?? null,
    },
    addressNeedsReview: needsAddressReview,
  })

  return {
    bookingReference: ctx.reference,
    displayId: ctx.reference,
    status,
    originAddress: composeAddress(input.move.originAddress),
    destAddress: composeAddress(input.move.destAddress),
    itemsDescription: buildItemsDescription(input, snapshots, estimate, travel),
    requestedDate: ctx.requestedDate,
    arrivalWindow: input.move.arrivalWindow ?? null,

    // ── Schedule (item 2 + R2-1) ──
    //    startTimeKnown rides EVERY deposit mode, including the default
    //    stripe_link one where the booking is created PENDING_PAYMENT and the
    //    schedule columns are written days later by approveBooking. That is
    //    exactly the path where the day anchor used to be promoted to 12:00 AM.
    startTimeKnown,
    ...(status === 'CONFIRMED'
      ? {
          confirmedDate: ctx.requestedDate,
          scheduledStart,
          scheduledEnd,
        }
      : {}),

    // ── Structured access (same columns the public route maps) ──
    originFloor: input.move.originFloor ?? null,
    destFloor: input.move.destFloor ?? null,
    originHasElevator: input.move.originHasElevator ?? null,
    destHasElevator: input.move.destHasElevator ?? null,
    originStairCount: input.move.originStairFlights ?? null,
    destStairCount: input.move.destStairFlights ?? null,
    originAccessNotes: input.move.accessNotes ?? null,
    crewInstructions: input.crewInstructions ?? null,

    // ── Structured address components (item 6). The owner's typed components
    //    are kept even when no provider verified them; the *Verification
    //    columns carry the real verdict (null = never checked).
    originStreetNumber: originCols.streetNumber,
    originRoute: originCols.route,
    originCity: originCols.city,
    originCounty: originCols.county,
    originState: originCols.state,
    originZip: originCols.zip,
    originCountry: originCols.country,
    originFormatted: originCols.formatted,
    originLat: originCols.lat,
    originLng: originCols.lng,
    originPlaceId: originCols.placeId,
    originVerification: originCols.verification,
    originValidationReason: originCols.validationReason,
    destStreetNumber: destCols.streetNumber,
    destRoute: destCols.route,
    destCity: destCols.city,
    destCounty: destCols.county,
    destState: destCols.state,
    destZip: destCols.zip,
    destCountry: destCols.country,
    destFormatted: destCols.formatted,
    destLat: destCols.lat,
    destLng: destCols.lng,
    destPlaceId: destCols.placeId,
    destVerification: destCols.verification,
    destValidationReason: destCols.validationReason,

    // ── Move details ──
    bedrooms: bedroomsFromServiceType(input.move.serviceType),
    needsPacking: input.services.needsPacking,
    needsUnpacking: input.services.needsUnpacking,
    needsAssembly: input.services.needsAssembly,
    needsDisassembly: input.services.needsDisassembly,
    // Derived from the captured inventory only — never guessed (item 6).
    numBoxes: details.numBoxes,
    estimatedCubicFeet: details.estimatedCubicFeet,
    hasPiano: details.hasPiano,
    hasSafe: details.hasSafe,
    hasPoolTable: details.hasPoolTable,
    hasAppliances: details.hasAppliances,
    specialtyItems: details.specialtyItems,

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
    distanceFromWestOrangeMiles: travel.distanceFromWestOrangeMiles ?? null,
    estimatedDriveTimeMinutes: travel.estimatedDriveTimeMinutes ?? null,
    ...(travel.evaluatedAddresses !== undefined && travel.evaluatedAddresses !== null
      ? {
          addressEvaluation: travel.evaluatedAddresses as Prisma.BookingUncheckedCreateInput['addressEvaluation'],
        }
      : {}),

    // ── Review verdict (same helper as the public route) ──
    manualReviewRequired: reviewReasons.length > 0,
    reviewReasons,

    // ── Moving OS Phase 1 columns ──
    truckId: input.truckId ?? null,
    originPropertyType: input.move.originPropertyType ?? null,
    destPropertyType: input.move.destPropertyType ?? null,
    serviceMode: input.services.serviceMode,
    coiRequired: input.move.coiRequired ?? false,
    priceOverrideReason: overridden ? (input.pricing.overrideReason ?? null) : null,
    // The staffing plan rides the booking on EVERY deposit mode. Phase 1 built
    // it, used it only when the booking was created CONFIRMED, and threw it
    // away on the default stripe_link path — where the Job (and therefore the
    // staffing requirement) is created days later by approveBooking. Persisted
    // here, that path finally has the owner's real plan to work from.
    ...(ctx.staffingPlan ? { staffingPlan: ctx.staffingPlan } : {}),

    // ── Attribution + portal ──
    source: 'admin',
    ...(ctx.token ? { customerToken: ctx.token } : {}),
    customerTokenExpiry: ctx.tokenExpiry,
  }
}

// ── Staffing plan from the Book Move form ────────────────────────────────────

/**
 * The Book Move form's inputs as a staffing plan. THE adapter — it only
 * translates the admin payload into staffing-plan.ts's vocabulary; every rule
 * (crew/hours from recommendEstimate, the service-mode truck/driver table,
 * single-location access) lives there so the admin create, the stripe_link
 * approval and public bookings all staff jobs the same way.
 */
export function buildAdminStaffingPlan(
  input: AdminBookingInput,
  snapshots: InventorySnapshot[],
  opts: {
    /** The route already ran recommendEstimate — reuse it, never recompute. */
    recommendation?: StaffingRecommendation | null
    /** Truck.source of the assigned fleet truck ('RENTAL' → pickup/return is on us). */
    truckSource?: string | null
  } = {},
): StaffingPlan {
  return buildStaffingPlan({
    source: 'admin_book_move',
    serviceType: input.move.serviceType,
    bedrooms: bedroomsFromServiceType(input.move.serviceType),
    serviceMode: input.services.serviceMode,
    truckAssigned: !!input.truckId,
    truckSource: opts.truckSource ?? null,
    inventory: snapshots.map((s) => ({
      name: s.name,
      quantity: s.quantity,
      isHeavy: s.isHeavy,
      needsDisassembly: s.needsDisassembly,
      recommendedMovers: s.recommendedMovers,
    })),
    originStairFlights: input.move.originStairFlights ?? null,
    destStairFlights: input.move.destStairFlights ?? null,
    originHasElevator: input.move.originHasElevator ?? null,
    destHasElevator: input.move.destHasElevator ?? null,
    longCarry: input.move.longCarry ?? null,
    needsPacking: input.services.needsPacking,
    needsAssembly: input.services.needsAssembly,
    needsDisassembly: input.services.needsDisassembly,
    additionalStops: input.move.additionalStopsCount ?? null,
    workerInstructions: input.crewInstructions ?? null,
    recommendation: opts.recommendation ?? null,
  })
}

/**
 * @deprecated Kept for the Phase-1 call shape; the plan spine is the real path.
 * Equivalent to buildAdminStaffingPlan(...) → staffingRequirementDataFromPlan(...),
 * which is what the route now calls through ensureStaffingRequirement. Left
 * exported so nothing that still imports it silently diverges from the spine.
 */
export function buildStaffingRequirementData(
  rec: Pick<EstimateRecommendation, 'crewSize' | 'estimatedHoursMax'>,
  input: AdminBookingInput,
  snapshots: InventorySnapshot[],
  estimatedStartAt: Date | null,
): Omit<Prisma.JobStaffingRequirementUncheckedCreateInput, 'jobId'> {
  const plan = buildAdminStaffingPlan(input, snapshots, { recommendation: rec })
  return staffingRequirementDataFromPlan(plan, { estimatedStartAt })
}

// ── Warnings (surfaced to the owner, never blocking) ─────────────────────────

export function collectBookingWarnings(args: {
  inventoryCount: number
  zone: string | null
  serviceType: string
  truckOverrideUsed: boolean
  /** No crew start time was captured (item 2) — say so plainly rather than
   *  letting the owner assume a time was set. */
  dayLevelScheduling?: boolean
}): string[] {
  const warnings: string[] = []
  if (args.dayLevelScheduling) {
    warnings.push(
      'No crew start time — day-level scheduling (truck conflicts are checked by day, not by hour). Set the start time on the job when you commit to one.',
    )
  }
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
