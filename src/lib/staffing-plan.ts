// ============================================================================
// staffing-plan.ts — THE crew/truck/hours plan + JobStaffingRequirement spine
// (Moving OS Phase 1 correctness pass, owner spec 2026-08-12 — items 1 and 4).
//
// WHY THIS FILE EXISTS (item 1 — the bug it fixes)
// Phase 1 created the JobStaffingRequirement INLINE in POST /api/admin/bookings,
// and only when the booking was created CONFIRMED (deposit modes collect_on_day
// / waived). The DEFAULT owner path — deposit mode 'stripe_link' — creates the
// booking PENDING_PAYMENT with NO Job; the customer pays the $49 hold, which
// moves it to PENDING_APPROVAL (src/lib/fulfillment.ts), and approveBooking()
// (src/lib/booking-approval.ts) upserts the Job — with nothing anywhere
// creating a staffing requirement. So the most-used path landed a CONFIRMED job
// with no staffing plan: exactly the dispatch blind spot Phase 1 set out to
// close (with no requirement row, conflict-engine reports only the
// INFORMATIONAL "no staffing requirement" and UNDERSTAFFED / MISSING_DRIVER can
// never fire). Public-form bookings had the same hole.
//
// THE SPINE — every path uses these; nobody re-implements them:
//   buildStaffingPlan(input)                  inputs  → plan     (pure)
//   deriveTransportFromBooking(booking)       truck columns → who drives (pure)
//   derivePlanFromBooking(booking)            booking → plan     (pure, 'derived')
//   planForBooking(booking, explicit?)        the plan a booking should use
//   staffingRequirementDataFromPlan(plan,…)   plan    → columns  (pure)
//   ensureStaffingRequirement(tx, …)          plan    → EXACTLY ONE row
//
// EXACTLY ONE ROW: JobStaffingRequirement.jobId is @unique (verified in
// prisma/schema.prisma), so the ensure can never produce a duplicate — safe to
// call twice (create → approve, approve → reopen → approve). It is
// CREATE-IF-MISSING, not a blind upsert (item R2-3): an existing row's values
// belong to the OWNER — they may have hand-tuned it through
// PATCH /api/admin/jobs/[id]/staffing — and a replayed plan never overwrites
// them. Only a NULL column is filled. See ensureStaffingRequirement.
//
// SERVICE-MODE AWARENESS (item 4) lives in ONE commented rule table:
// serviceModeStaffingRules(). Staffing used to be derived as if every job were a
// full-service move with our truck, so labor-only / customer-truck /
// loading-only / unloading-only jobs got the wrong customerProvidedTruck and
// requiredDrivers — which then drove wrong dispatch warnings (a MISSING_DRIVER
// warning on a job where we are not driving at all).
//
// CONTRACT: advisory + operational only. This module inherits
// estimate-assistant.ts's rule — it never prices anything, never emails anyone,
// and is pure except for ensureStaffingRequirement (one upsert on a caller's tx).
// ============================================================================

import type { CrewSkill } from '@prisma/client'
import {
  recommendEstimate,
  type AssistantInventoryItem,
  type EstimateDifficulty,
} from './estimate-assistant'
// The ONE parser of the legacy `Truck:` line inside itemsDescription (pure, no
// prisma). Imported rather than re-regexed here so the staffing spine and the
// Discord/portal cards can never disagree about what a booking's truck line says.
import { TRUCK_OPTION_LABELS, truckLabelFromDescription } from './booking-display'

// ── Plan vocabulary ──────────────────────────────────────────────────────────

/** Bumped only when the persisted shape changes incompatibly. */
export const STAFFING_PLAN_VERSION = 1

/** 'admin_book_move' = captured live by the owner in the Book Move workspace.
 *  'derived'         = reconstructed from the booking's own columns (public
 *                      bookings and legacy rows, which never had a plan). */
export type StaffingPlanSource = 'admin_book_move' | 'derived'

export const STAFFING_SERVICE_MODES = [
  'full_service',
  'labor_only',
  'loading_only',
  'unloading_only',
] as const
export type StaffingServiceMode = (typeof STAFFING_SERVICE_MODES)[number]

export type StaffingPlanFlags = {
  hasStairs: boolean
  hasElevator: boolean
  longCarry: boolean
  heavyItems: boolean
  packing: boolean
  assembly: boolean
  additionalStops: number
}

/**
 * The owner's plan for a job, persisted on Booking.staffingPlan (JSON) and
 * replayed onto the JobStaffingRequirement whenever the job is created.
 * Declared as a TYPE ALIAS (not an interface) so it carries an implicit index
 * signature and is assignable to Prisma's InputJsonValue without a cast.
 */
export type StaffingPlan = {
  version: number
  source: StaffingPlanSource
  /** MOVE_SIZES key when one was chosen ('2br', 'not-sure', …). */
  serviceType: string | null
  jobSizeLabel: string
  serviceMode: StaffingServiceMode | null
  crewSize: number
  minimumWorkers: number
  requiredDrivers: number
  requiresLead: boolean
  /** CrewSkill names the crew must cover between them (dispatch matching). */
  requiredSkills: string[]
  /** A FLEET truck (Booking.truckId) is assigned to this job. */
  truckAssigned: boolean
  /** Recommended minimum truck size from the live truck table (advisory). */
  truckSize: string | null
  /** TruckSource of the assigned fleet truck ('RENTAL' | 'COMPANY_OWNED' | …). */
  truckSource: string | null
  customerProvidedTruck: boolean
  rentalTruckPickup: boolean
  drivingRequired: boolean
  /** ITEM R2-4 — set ONLY when no serviceMode was recorded and the booking's own
   *  truck columns had to decide: what they said. 'unclear' means nobody
   *  recorded who drives, so no driver was staffed. Absent/null on any plan
   *  whose mode the owner actually chose. */
  transportVerdict?: TransportVerdict | null
  /** loading-only / unloading-only jobs happen at ONE location. */
  singleLocation: boolean
  estimatedHoursMin: number
  estimatedHoursMax: number
  possibleTrips: number
  difficulty: EstimateDifficulty
  flags: StaffingPlanFlags
  /** WHY the numbers are what they are (from recommendEstimate). */
  reasons: string[]
  /** Service-mode / truck notes + honest warnings for dispatch. */
  notes: string[]
  workerInstructions: string | null
}

/** The recommendation numbers a plan is built on. The admin route already ran
 *  recommendEstimate, so it hands its result in rather than paying for it twice;
 *  omit it and buildStaffingPlan computes it from the same inputs. */
export type StaffingRecommendation = {
  crewSize: number
  estimatedHoursMin?: number | null
  estimatedHoursMax: number
  truckSize?: string | null
  possibleTrips?: number | null
  difficulty?: EstimateDifficulty | null
  jobSizeLabel?: string | null
  reasons?: string[] | null
}

export type StaffingPlanInput = {
  source: StaffingPlanSource
  serviceType?: string | null
  bedrooms?: number | null
  serviceMode?: string | null
  /** Booking.truckId is set → one of OUR trucks is on this job. */
  truckAssigned?: boolean | null
  /** Truck.source of that fleet truck (drives rentalTruckPickup). */
  truckSource?: string | null
  inventory?: AssistantInventoryItem[] | null
  originStairFlights?: number | null
  destStairFlights?: number | null
  originHasElevator?: boolean | null
  destHasElevator?: boolean | null
  longCarry?: boolean | null
  needsPacking?: boolean | null
  needsAssembly?: boolean | null
  needsDisassembly?: boolean | null
  additionalStops?: number | null
  workerInstructions?: string | null
  recommendation?: StaffingRecommendation | null
  /** ITEM R2-4: what the booking's own truck columns say about who drives.
   *  Supplied when the plan is built FROM a booking row (public + legacy);
   *  consulted only when `serviceMode` is absent. */
  transport?: DerivedTransport | null
}

// ── Normalisation helpers ────────────────────────────────────────────────────

export function normalizeServiceMode(mode?: string | null): StaffingServiceMode | null {
  const key = (mode ?? '').trim().toLowerCase()
  return (STAFFING_SERVICE_MODES as readonly string[]).includes(key)
    ? (key as StaffingServiceMode)
    : null
}

/** Loading-only and unloading-only jobs are ONE-location jobs. */
export function isSingleLocationMode(mode: StaffingServiceMode | null): boolean {
  return mode === 'loading_only' || mode === 'unloading_only'
}

const SERVICE_MODE_LABEL: Record<StaffingServiceMode, string> = {
  full_service: 'Full service',
  labor_only: 'Labor only',
  loading_only: 'Loading only',
  unloading_only: 'Unloading only',
}

const int = (n: unknown, fallback = 0): number =>
  typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.floor(n)) : fallback

// ── ITEM R2-4 — who is actually driving on a booking with NO serviceMode ─────
//
// THE DEFECT this closes: only the admin Book Move form ever writes
// `Booking.serviceMode`. Every PUBLIC and legacy booking — the highest-volume
// path — has `serviceMode = null`, which fell through to the full-service
// branch below and staffed `customerProvidedTruck=false, requiredDrivers=1,
// skills=['DRIVING']` on jobs where we are not driving anything. Those wrong
// values only became ACTIVE when R2-3 made approval create requirements for
// public bookings, and they fire MISSING_DRIVER on labor-only jobs.
//
// The booking carries the answer in columns the spine never read. This is the
// ONE place they are interpreted, and the value space is taken from the code
// that WRITES them, not guessed:
//   • `truckAddonDueOnMoveDay`  app/api/bookings/route.ts sets it from
//     truckOption === 'truck-pickup-return'. pricing-config's TRUCK_PICKUP_RETURN
//     is "Crew time to pick up and return a rental truck you reserved ... our
//     driver has been properly authorized" — so TRUE means OUR DRIVER drives.
//     It is the one structured boolean here, so it is DECISIVE.
//   • `truckProvider`  free text, max 80 (booking-schema.ts). schema.prisma
//     documents the value space as "customer / U-Haul / Penske / WMIWCI", and
//     reminder-rules.ts already treats lowercase 'customer' as customer-supplied.
//     A bare RENTAL BRAND says nothing about who drives it — a U-Haul can be
//     rented in the customer's name (they drive) or fetched by us — so a brand
//     alone is AMBIGUOUS, never a driver.
//   • `truckReturnResponsibility`  free text: who takes the rental back.
//   • the `Truck:` line inside `itemsDescription` ("Customer provides truck ($0)"
//     / "Truck Pickup & Return"), parsed by booking-display's shared helper —
//     the only signal legacy rows created before the structured columns have.
//   • `truckReservationStatus` (reserved / not-yet / n/a) is deliberately NOT a
//     signal: it says whether a truck is booked, never who drives it.
//
// AMBIGUITY RESOLVES TO NON-DRIVING (owner rule): never staff a driver we are
// not sending. The plan says plainly that the mode was not recorded, and
// planOpsWarnings() puts that in front of the owner.

/** What a booking's own columns say about who drives. 'unclear' = nothing
 *  decisive was recorded, or the signals contradict each other. */
export type TransportVerdict = 'we_drive' | 'customer_drives' | 'unclear'

export type DerivedTransport = {
  verdict: TransportVerdict
  /** True when nothing decisive was recorded or two signals disagreed. */
  ambiguous: boolean
  /** The exact column values that decided it — quoted into the plan notes so a
   *  dispatcher can see WHY no driver is staffed without opening the booking. */
  evidence: string[]
}

/** The Booking columns that carry transportation evidence. All optional: a
 *  partial `select` (or a DB missing a column) simply yields less evidence. */
export type TransportEvidenceRow = {
  truckProvider?: string | null
  truckSize?: string | null
  truckReservationStatus?: string | null
  truckReturnResponsibility?: string | null
  truckAddonDueOnMoveDay?: boolean | null
  itemsDescription?: string | null
}

const lower = (v?: string | null): string => (v ?? '').trim().toLowerCase()

/** Word-boundary match, so "cardboard" never matches "card" and a customer
 *  named "Uster" never matches "us". */
function saysAny(value: string, words: readonly string[]): string | null {
  if (!value) return null
  for (const w of words) {
    const re = new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i')
    if (re.test(value)) return w
  }
  return null
}

/** Values meaning "the customer supplies and drives the truck". */
const CUSTOMER_TRUCK_WORDS = [
  'customer',
  'customer provided',
  'customer-provided',
  'client',
  'own truck',
  'own',
  'self',
  'renter',
  'themselves',
  'their own',
] as const

/** Values meaning "the truck is ours / we fetch it — one of ours drives".
 *  Deliberately NARROW: bare pronouns ("we", "us") and "crew" appear in ordinary
 *  sentences ("we will meet the customer there"), and a false match here staffs
 *  a driver we are not sending — the exact failure this item exists to stop. So
 *  only unambiguous markers of OUR transportation are listed. A value that is
 *  merely unrecognised falls through to 'unclear', which staffs nobody. */
const OUR_TRUCK_WORDS = [
  'wmiwci',
  'move it clear it',
  'moveitclearit',
  'we move it',
  'company',
  'in-house',
  'in house',
  'our driver',
  'our truck',
  'our crew',
  'ours',
] as const

/** Rental brands. On their own these say only that a RENTAL is involved — the
 *  reservation can be in either name — so they are recorded as evidence and
 *  treated as AMBIGUOUS, never as a reason to staff a driver. */
const RENTAL_BRAND_WORDS = ['u-haul', 'uhaul', 'penske', 'budget', 'ryder', 'enterprise', 'home depot', 'avis'] as const

/**
 * Read a booking's own truck columns and say who drives. Pure. Used whenever a
 * booking has no recorded `serviceMode` (every public + legacy row).
 */
export function deriveTransportFromBooking(row: TransportEvidenceRow): DerivedTransport {
  const evidence: string[] = []

  // 1. DECISIVE — the paid pickup & return add-on. Its published terms are
  //    explicitly "our driver", so this outranks every free-text column: a
  //    customer-owned rental that WE fetch is still a driving job for us.
  if (row.truckAddonDueOnMoveDay === true) {
    return {
      verdict: 'we_drive',
      ambiguous: false,
      evidence: ['Truck pickup & return add-on purchased — our driver fetches and returns the rental.'],
    }
  }

  const provider = lower(row.truckProvider)
  const returns = lower(row.truckReturnResponsibility)
  const truckLine = truckLabelFromDescription(row.itemsDescription ?? null)

  // 2. Free-text + legacy-blob signals, collected on both sides before deciding.
  let we = false
  let customer = false

  if (truckLine === TRUCK_OPTION_LABELS['truck-pickup-return']) {
    we = true
    evidence.push('Booking description says truck pickup & return.')
  } else if (truckLine === TRUCK_OPTION_LABELS['own-truck']) {
    customer = true
    evidence.push('Booking description says the customer provides the truck.')
  }

  const providerCustomer = saysAny(provider, CUSTOMER_TRUCK_WORDS)
  const providerOurs = saysAny(provider, OUR_TRUCK_WORDS)
  const providerBrand = saysAny(provider, RENTAL_BRAND_WORDS)
  if (providerCustomer) {
    customer = true
    evidence.push(`Truck provider recorded as "${row.truckProvider}".`)
  } else if (providerOurs) {
    we = true
    evidence.push(`Truck provider recorded as "${row.truckProvider}".`)
  } else if (providerBrand) {
    // A brand with no other signal: a rental, but nobody recorded whose driver.
    evidence.push(`Truck provider "${row.truckProvider}" is a rental brand — it does not say who drives.`)
  }

  const returnsCustomer = saysAny(returns, CUSTOMER_TRUCK_WORDS)
  const returnsOurs = saysAny(returns, OUR_TRUCK_WORDS)
  if (returnsCustomer) {
    customer = true
    evidence.push(`Truck return responsibility recorded as "${row.truckReturnResponsibility}".`)
  } else if (returnsOurs) {
    we = true
    evidence.push(`Truck return responsibility recorded as "${row.truckReturnResponsibility}".`)
  }

  // 3. Verdict. Contradicting signals are NOT resolved by picking a winner —
  //    they are reported as unclear, which staffs no driver.
  if (we && customer) {
    return {
      verdict: 'unclear',
      ambiguous: true,
      evidence: ['Truck details contradict each other:', ...evidence],
    }
  }
  if (we) return { verdict: 'we_drive', ambiguous: false, evidence }
  if (customer) return { verdict: 'customer_drives', ambiguous: false, evidence }
  return {
    verdict: 'unclear',
    ambiguous: true,
    evidence: evidence.length ? evidence : ['No truck details recorded on this booking.'],
  }
}

// ── ITEM 4 — the ONE service-mode rule table ─────────────────────────────────

export type ServiceModeStaffingRules = {
  customerProvidedTruck: boolean
  requiredDrivers: number
  rentalTruckPickup: boolean
  drivingRequired: boolean
  singleLocation: boolean
  requiredSkills: string[]
  notes: string[]
}

/**
 * Truck + driver + location rules by service mode. THE table — every path
 * (admin create, approval, derived legacy plans) reads it, so a labor-only job
 * can never again be staffed as though we were driving.
 *
 *   RULE 1  our truck assigned (Booking.truckId set)
 *             → customerProvidedTruck = false, requiredDrivers >= 1, the crew
 *               must cover the DRIVING skill. Wins over the service mode: if a
 *               truck of ours is on the job, somebody of ours drives it.
 *   RULE 2  no truck AND labor_only | loading_only | unloading_only
 *             → customerProvidedTruck = true, requiredDrivers = 0 (we are NOT
 *               driving), no driving skill required. Noted plainly so dispatch
 *               reads "customer provides transportation" instead of a phantom
 *               MISSING_DRIVER warning.
 *   RULE 3  full_service with no truck assigned
 *             → requiredDrivers >= 1 AND a warning note: this is a real ops gap
 *               (a full-service move with nothing to move it in), surfaced
 *               honestly instead of being silently staffed as fine.
 *   RULE 4  rentalTruckPickup mirrors the assigned truck's source
 *             (TruckSource.RENTAL → true: somebody has to pick it up/return it).
 *   RULE 5  loading_only / unloading_only are SINGLE-LOCATION jobs — the other
 *             location's access flags are not required, and the plan says so.
 *   RULE 6  (item R2-4) NO recorded mode AND transportation evidence supplied
 *             → the booking's own truck columns decide, via
 *               deriveTransportFromBooking:
 *                 we_drive        → driver required (we fetch the rental)
 *                 customer_drives → customerProvidedTruck, 0 drivers
 *                 unclear         → 0 drivers + an explicit "not recorded" note.
 *             This replaces the old blanket "treat an unknown mode as full
 *             service", which staffed a driver on every public booking.
 *   Unknown/absent mode with NO evidence examined at all (a caller that builds a
 *   plan from form inputs rather than a booking row) still falls through to the
 *   full-service default, and the assumption is written into the notes.
 */
export function serviceModeStaffingRules(args: {
  serviceMode: StaffingServiceMode | null
  truckAssigned: boolean
  truckSource?: string | null
  /** ITEM R2-4: what the BOOKING's own truck columns say. Supplied whenever the
   *  plan is built from a booking row; consulted only when `serviceMode` is
   *  null, because an explicitly recorded mode is the owner's own answer. */
  transport?: DerivedTransport | null
}): ServiceModeStaffingRules {
  const mode = args.serviceMode
  const singleLocation = isSingleLocationMode(mode)
  const notes: string[] = []
  const transport = !mode ? args.transport ?? null : null
  if (!mode && !transport) notes.push('Service mode not recorded — staffed as a full-service move.')

  // RULE 5 — single-location honesty (both truck branches below inherit it).
  if (singleLocation) {
    const here = mode === 'loading_only' ? 'pickup' : 'drop-off'
    const other = mode === 'loading_only' ? 'drop-off' : 'pickup'
    notes.push(
      `${SERVICE_MODE_LABEL[mode as StaffingServiceMode]} — single-location job at the ${here}; ${other} access details are not required.`,
    )
  }

  // RULE 1 (+ RULE 4) — one of our trucks is on the job.
  if (args.truckAssigned) {
    const rental = (args.truckSource ?? '').trim().toUpperCase() === 'RENTAL'
    notes.push('Our truck is assigned — a driver is required on this crew.')
    if (rental) notes.push('Rental truck — pickup and return are on us.')
    if (mode && mode !== 'full_service') {
      notes.push(
        `${SERVICE_MODE_LABEL[mode]} job with one of our trucks assigned — we are driving, so this is not a customer-truck job.`,
      )
    }
    return {
      customerProvidedTruck: false,
      requiredDrivers: 1,
      rentalTruckPickup: rental,
      drivingRequired: true,
      singleLocation,
      requiredSkills: ['DRIVING'],
      notes,
    }
  }

  // RULE 6 — no recorded mode, but the booking's own columns carry evidence.
  if (transport) {
    notes.push('Service mode was not recorded on this booking — transportation derived from its truck details.')
    notes.push(...transport.evidence)
    if (transport.verdict === 'we_drive') {
      notes.push('We are fetching / returning the truck — a driver is required on this crew.')
      return {
        customerProvidedTruck: false,
        requiredDrivers: 1,
        // The truck is a RENTAL somebody has to collect and bring back; that is
        // exactly what rentalTruckPickup means to dispatch.
        rentalTruckPickup: true,
        drivingRequired: true,
        singleLocation: false,
        requiredSkills: ['DRIVING'],
        notes,
      }
    }
    notes.push(
      transport.verdict === 'customer_drives'
        ? 'Customer provides transportation — no driver required from us.'
        : 'Who drives is NOT recorded on this booking — staffed as customer-provided transportation with NO driver. Confirm before dispatch rather than sending a driver we never agreed to.',
    )
    return {
      customerProvidedTruck: true,
      requiredDrivers: 0,
      rentalTruckPickup: false,
      drivingRequired: false,
      singleLocation: false,
      requiredSkills: [],
      notes,
    }
  }

  // RULE 2 — labor-only family with no truck of ours: we are not driving.
  if (mode === 'labor_only' || singleLocation) {
    notes.push(`${SERVICE_MODE_LABEL[mode as StaffingServiceMode]} — customer provides transportation; no driver required from us.`)
    return {
      customerProvidedTruck: true,
      requiredDrivers: 0,
      rentalTruckPickup: false,
      drivingRequired: false,
      singleLocation,
      requiredSkills: [],
      notes,
    }
  }

  // RULE 3 — full service (or unknown) with no truck yet: a real ops gap.
  notes.push('Full-service move with NO truck assigned yet — assign a truck before dispatch.')
  return {
    customerProvidedTruck: false,
    requiredDrivers: 1,
    rentalTruckPickup: false,
    drivingRequired: true,
    singleLocation: false,
    requiredSkills: ['DRIVING'],
    notes,
  }
}

// ── buildStaffingPlan ────────────────────────────────────────────────────────

/**
 * The ONE place a booking's serviceType + inventory + access + serviceMode +
 * truck choice becomes a plan. Pure. The crew/hours/truck-size math is NOT
 * duplicated here — it comes from recommendEstimate (estimate-assistant.ts),
 * either handed in by the caller or computed from these same inputs.
 */
export function buildStaffingPlan(input: StaffingPlanInput): StaffingPlan {
  const inventory = (input.inventory ?? []).filter(Boolean)
  const serviceMode = normalizeServiceMode(input.serviceMode)
  const singleLocation = isSingleLocationMode(serviceMode)

  const rec =
    input.recommendation ??
    recommendEstimate({
      serviceType: input.serviceType,
      bedrooms: input.bedrooms,
      inventory,
      originStairFlights: input.originStairFlights,
      destStairFlights: input.destStairFlights,
      originHasElevator: input.originHasElevator,
      destHasElevator: input.destHasElevator,
      longCarry: input.longCarry,
      needsPacking: input.needsPacking,
      needsAssembly: input.needsAssembly,
      needsDisassembly: input.needsDisassembly,
      additionalStops: input.additionalStops,
    })

  const rules = serviceModeStaffingRules({
    serviceMode,
    truckAssigned: !!input.truckAssigned,
    truckSource: input.truckSource,
    transport: input.transport ?? null,
  })

  // RULE 5 in practice: only the end(s) this job actually touches contribute
  // access flags. A loading-only crew never sees the drop-off stairs.
  const originCounts = !singleLocation || serviceMode === 'loading_only'
  const destCounts = !singleLocation || serviceMode === 'unloading_only'
  const hasStairs =
    (originCounts && int(input.originStairFlights) > 0) || (destCounts && int(input.destStairFlights) > 0)
  const hasElevator =
    (originCounts && !!input.originHasElevator) || (destCounts && !!input.destHasElevator)

  const crewSize = Math.max(1, int(rec.crewSize, 2))
  const hoursMax = Math.max(1, int(rec.estimatedHoursMax, 4))
  const hoursMinRaw = int(rec.estimatedHoursMin ?? null, 0)
  const estimatedHoursMin = hoursMinRaw > 0 ? Math.min(hoursMinRaw, hoursMax) : hoursMax

  return {
    version: STAFFING_PLAN_VERSION,
    source: input.source,
    serviceType: input.serviceType ?? null,
    jobSizeLabel: rec.jobSizeLabel ?? 'Size unconfirmed',
    serviceMode,
    crewSize,
    // Unchanged rule: the crew may run one short before dispatch screams, but
    // never below a safe pair.
    minimumWorkers: Math.max(2, crewSize - 1),
    requiredDrivers: rules.requiredDrivers,
    requiresLead: true,
    requiredSkills: rules.requiredSkills,
    truckAssigned: !!input.truckAssigned,
    truckSize: rec.truckSize ?? null,
    truckSource: input.truckSource ?? null,
    customerProvidedTruck: rules.customerProvidedTruck,
    rentalTruckPickup: rules.rentalTruckPickup,
    drivingRequired: rules.drivingRequired,
    transportVerdict: !serviceMode && input.transport ? input.transport.verdict : null,
    singleLocation: rules.singleLocation,
    estimatedHoursMin,
    estimatedHoursMax: hoursMax,
    possibleTrips: Math.max(1, int(rec.possibleTrips ?? null, 1)),
    difficulty: rec.difficulty ?? 'standard',
    flags: {
      hasStairs,
      hasElevator,
      longCarry: !!input.longCarry,
      heavyItems: inventory.some((i) => !!i.isHeavy),
      packing: !!input.needsPacking,
      assembly:
        !!input.needsAssembly || !!input.needsDisassembly || inventory.some((i) => !!i.needsDisassembly),
      additionalStops: int(input.additionalStops),
    },
    reasons: (rec.reasons ?? []).slice(),
    notes: rules.notes,
    workerInstructions: input.workerInstructions ?? null,
  }
}

/**
 * The plan facts the OWNER needs to see, not just the plan JSON: a full-service
 * move with no truck is a real ops gap, and "no driver is being staffed" is a
 * decision the owner should read back before hanging up. Surfaced in the Book
 * Move response's warnings[]. Derived from the same rule table, so it can never
 * disagree with what was actually staffed.
 */
export function planOpsWarnings(plan: StaffingPlan): string[] {
  const out: string[] = []
  // Rule 3 — we are expected to drive, but nothing has been assigned to drive.
  // Rule 6/we_drive is a different sentence: the truck is the customer's rental
  // that our driver collects, so "assign a truck" would be wrong advice.
  if (!plan.truckAssigned && plan.requiredDrivers > 0) {
    out.push(
      plan.rentalTruckPickup
        ? 'Truck pickup & return — one of our drivers collects the rental; no fleet truck is assigned to this job.'
        : 'Full-service move with no truck assigned — assign a truck before dispatch.',
    )
  }
  // Rule 2 — deliberate, but the owner should know no driver is on this crew.
  // Rule 6/unclear is NOT deliberate: say that nobody recorded it rather than
  // asserting the customer has a truck (item R2-4 — no faked certainty).
  if (plan.customerProvidedTruck) {
    out.push(
      plan.transportVerdict === 'unclear'
        ? 'Nobody recorded who provides the truck — this job is staffed with NO driver. Confirm before dispatch.'
        : 'Customer provides the truck — no driver is being staffed for this job.',
    )
  }
  return out
}

// ── Booking-shaped input (approval path + legacy rows) ───────────────────────

/** The Booking columns the staffing spine reads. Every field is optional so an
 *  offline fake (and a partial `select`) can satisfy it; prisma returns a
 *  superset. Inventory lines come from BookingInventoryItem (+ its catalog row
 *  when included, for recommendedMovers). */
export type StaffingBookingRow = TransportEvidenceRow & {
  id?: string
  truckId?: string | null
  truck?: { source?: string | null } | null
  serviceMode?: string | null
  bedrooms?: number | null
  originStairCount?: number | null
  destStairCount?: number | null
  originHasElevator?: boolean | null
  destHasElevator?: boolean | null
  needsPacking?: boolean | null
  needsAssembly?: boolean | null
  needsDisassembly?: boolean | null
  crewInstructions?: string | null
  estimatedHours?: number | null
  scheduledStart?: Date | null
  scheduledEnd?: Date | null
  /** Present for completeness; the staffing spine NEVER schedules from it. A
   *  day-level booking's confirmedDate is the 00:00 ET day anchor, and turning
   *  that into an `estimatedStartAt` is the item R2-1 defect one layer down. */
  confirmedDate?: Date | null
  /** Booking.startTimeKnown (item R2-1). FALSE = the owner committed to a DATE,
   *  not an hour. Optional so a partial select / unapplied migration reads
   *  `undefined` and nothing changes. */
  startTimeKnown?: boolean | null
  /** The persisted Booking.staffingPlan JSON (unknown until parsed). */
  staffingPlan?: unknown
  inventoryItems?: Array<{
    name?: string | null
    quantity?: number | null
    isHeavy?: boolean | null
    needsDisassembly?: boolean | null
    catalogItem?: { recommendedMovers?: number | null } | null
  }> | null
}

function inventoryFromBooking(booking: StaffingBookingRow): AssistantInventoryItem[] {
  return (booking.inventoryItems ?? []).map((line) => ({
    name: (line.name ?? 'Item').trim() || 'Item',
    quantity: Math.max(1, int(line.quantity, 1)),
    isHeavy: !!line.isHeavy,
    needsDisassembly: !!line.needsDisassembly,
    recommendedMovers: line.catalogItem?.recommendedMovers ?? null,
  }))
}

/**
 * A plan for a booking that never had one: public-form bookings and every row
 * that predates Booking.staffingPlan. Built from the booking's OWN data
 * (BookingInventoryItem rows + the structured access columns + bedrooms +
 * serviceMode + the assigned truck) — nothing invented. Marked source
 * 'derived' so a reader can always tell it apart from what the owner planned.
 *
 * Honest gaps: Booking has no long-carry column and no package key, so
 * longCarry reads false and the size comes from `bedrooms` (recommendEstimate's
 * documented fallback), which says "size unconfirmed" when there is none.
 */
export function derivePlanFromBooking(booking: StaffingBookingRow): StaffingPlan {
  const plan = buildStaffingPlan({
    source: 'derived',
    serviceType: null,
    bedrooms: booking.bedrooms ?? null,
    serviceMode: booking.serviceMode ?? null,
    truckAssigned: !!booking.truckId,
    truckSource: booking.truck?.source ?? null,
    // ITEM R2-4 — a public/legacy row has no serviceMode, so its own truck
    // columns decide whether we are driving. Without this the derived plan
    // staffed a driver for every one of them.
    transport: deriveTransportFromBooking(booking),
    inventory: inventoryFromBooking(booking),
    originStairFlights: booking.originStairCount ?? null,
    destStairFlights: booking.destStairCount ?? null,
    originHasElevator: booking.originHasElevator ?? null,
    destHasElevator: booking.destHasElevator ?? null,
    needsPacking: booking.needsPacking ?? null,
    needsAssembly: booking.needsAssembly ?? null,
    needsDisassembly: booking.needsDisassembly ?? null,
    workerInstructions: booking.crewInstructions ?? null,
  })
  plan.notes = [
    'Plan derived from the booking record — no staffing plan was captured at booking time.',
    ...plan.notes,
  ]
  return plan
}

/** Defensive read of the persisted JSON. Returns null (→ derive) for anything
 *  that is not a usable plan, so a hand-edited or half-written column can never
 *  produce a nonsense requirement. */
export function parseStaffingPlan(value: unknown): StaffingPlan | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const crewSize = int(raw.crewSize, 0)
  const hoursMax = int(raw.estimatedHoursMax, 0)
  if (crewSize <= 0 || hoursMax <= 0) return null
  const flags = (raw.flags && typeof raw.flags === 'object' ? raw.flags : {}) as Record<string, unknown>
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []
  const hoursMin = int(raw.estimatedHoursMin, 0)
  return {
    version: int(raw.version, STAFFING_PLAN_VERSION),
    source: raw.source === 'admin_book_move' ? 'admin_book_move' : 'derived',
    serviceType: typeof raw.serviceType === 'string' ? raw.serviceType : null,
    jobSizeLabel: typeof raw.jobSizeLabel === 'string' ? raw.jobSizeLabel : 'Size unconfirmed',
    serviceMode: normalizeServiceMode(typeof raw.serviceMode === 'string' ? raw.serviceMode : null),
    crewSize,
    minimumWorkers: Math.max(2, int(raw.minimumWorkers, crewSize - 1)),
    requiredDrivers: int(raw.requiredDrivers, 0),
    requiresLead: raw.requiresLead !== false,
    requiredSkills: strings(raw.requiredSkills),
    truckAssigned: raw.truckAssigned === true,
    truckSize: typeof raw.truckSize === 'string' ? raw.truckSize : null,
    truckSource: typeof raw.truckSource === 'string' ? raw.truckSource : null,
    customerProvidedTruck: raw.customerProvidedTruck === true,
    rentalTruckPickup: raw.rentalTruckPickup === true,
    drivingRequired: raw.drivingRequired !== false,
    transportVerdict:
      raw.transportVerdict === 'we_drive' || raw.transportVerdict === 'customer_drives' || raw.transportVerdict === 'unclear'
        ? raw.transportVerdict
        : null,
    singleLocation: raw.singleLocation === true,
    estimatedHoursMin: hoursMin > 0 ? Math.min(hoursMin, hoursMax) : hoursMax,
    estimatedHoursMax: hoursMax,
    possibleTrips: Math.max(1, int(raw.possibleTrips, 1)),
    difficulty:
      raw.difficulty === 'high' || raw.difficulty === 'elevated'
        ? (raw.difficulty as EstimateDifficulty)
        : 'standard',
    flags: {
      hasStairs: flags.hasStairs === true,
      hasElevator: flags.hasElevator === true,
      longCarry: flags.longCarry === true,
      heavyItems: flags.heavyItems === true,
      packing: flags.packing === true,
      assembly: flags.assembly === true,
      additionalStops: int(flags.additionalStops, 0),
    },
    reasons: strings(raw.reasons),
    notes: strings(raw.notes),
    workerInstructions: typeof raw.workerInstructions === 'string' ? raw.workerInstructions : null,
  }
}

/**
 * Re-apply the item-4 rule table to a plan using the booking's CURRENT truck +
 * service mode. A plan captured at booking time can be days old by approval —
 * the owner may have assigned (or removed) a truck since. Crew size, hours and
 * job flags stay the owner's; only the truck/driver/location facts are
 * recomputed, and any change is written into the notes rather than applied
 * silently.
 */
export function reconcilePlanWithBooking(plan: StaffingPlan, booking: StaffingBookingRow): StaffingPlan {
  const truckAssigned = !!booking.truckId
  const serviceMode = normalizeServiceMode(booking.serviceMode ?? null) ?? plan.serviceMode
  const truckSource = booking.truck?.source ?? (truckAssigned ? plan.truckSource : null)
  // ITEM R2-4 — reconcile runs on EVERY plan at approval, so the derived
  // transportation facts have to be re-derived here too; otherwise this
  // function would immediately undo derivePlanFromBooking's work and staff a
  // driver again for every public booking.
  const transport = serviceMode ? null : deriveTransportFromBooking(booking)
  const rules = serviceModeStaffingRules({ serviceMode, truckAssigned, truckSource, transport })
  const changed =
    truckAssigned !== plan.truckAssigned ||
    serviceMode !== plan.serviceMode ||
    rules.requiredDrivers !== plan.requiredDrivers ||
    rules.customerProvidedTruck !== plan.customerProvidedTruck
  const notes = changed
    ? [
        'Truck / service mode changed after the plan was captured — truck and driver rules re-derived from the booking.',
        ...rules.notes,
      ]
    : plan.notes
  return {
    ...plan,
    serviceMode,
    truckAssigned,
    truckSource: truckSource ?? null,
    requiredDrivers: rules.requiredDrivers,
    requiredSkills: rules.requiredSkills,
    customerProvidedTruck: rules.customerProvidedTruck,
    rentalTruckPickup: rules.rentalTruckPickup,
    drivingRequired: rules.drivingRequired,
    transportVerdict: transport ? transport.verdict : null,
    singleLocation: rules.singleLocation,
    notes,
  }
}

/** THE plan a booking should be staffed with: an explicitly supplied one (the
 *  admin create, which just built it), else the persisted column, else a
 *  derived one — always reconciled against the booking's live truck/mode. */
export function planForBooking(booking: StaffingBookingRow, explicit?: StaffingPlan | null): StaffingPlan {
  const base = explicit ?? parseStaffingPlan(booking.staffingPlan) ?? derivePlanFromBooking(booking)
  return reconcilePlanWithBooking(base, booking)
}

// ── plan → JobStaffingRequirement columns ────────────────────────────────────

/** Exactly the JobStaffingRequirement columns this spine owns. Anything else on
 *  the model (preferredWorkers, privateNotes, reportTime, …) stays owner-edited
 *  territory and is never written here. */
export type StaffingRequirementColumns = {
  requiredWorkers: number
  minWorkers: number
  requiredDrivers: number
  requiresLead: boolean
  requiredSkills: CrewSkill[]
  additionalStops: number
  hasStairs: boolean
  hasElevator: boolean
  longCarry: boolean
  heavyItems: boolean
  packing: boolean
  assembly: boolean
  customerProvidedTruck: boolean
  rentalTruckPickup: boolean
  drivingRequired: boolean
  estimatedStartAt: Date | null
  estimatedEndAt: Date | null
  workerInstructions: string | null
}

export type StaffingRequirementData = StaffingRequirementColumns & { jobId?: string }

const HOUR_MS = 60 * 60 * 1000

const KNOWN_SKILLS = new Set<string>([
  'PACKING',
  'FURNITURE_PROTECTION',
  'ASSEMBLY',
  'HEAVY_ITEMS',
  'STAIR_CARRY',
  'DRIVING',
  'LEAD',
  'LOADING',
  'UNLOADING',
])

/**
 * The ONE mapping from a plan onto JobStaffingRequirement columns. Pure.
 * `estimatedEndAt` falls back to start + the plan's max hours when the caller
 * has no scheduled end — that column IS an estimate, and the plan's hours are
 * its honest basis. With no known start, both stay NULL (day-level scheduling)
 * rather than inventing a clock time.
 */
export function staffingRequirementDataFromPlan(
  plan: StaffingPlan,
  opts: {
    jobId?: string
    estimatedStartAt?: Date | null
    estimatedEndAt?: Date | null
    workerInstructions?: string | null
  } = {},
): StaffingRequirementData {
  const start = opts.estimatedStartAt ?? null
  const end =
    opts.estimatedEndAt ?? (start ? new Date(start.getTime() + plan.estimatedHoursMax * HOUR_MS) : null)
  const data: StaffingRequirementData = {
    requiredWorkers: plan.crewSize,
    minWorkers: plan.minimumWorkers,
    requiredDrivers: plan.requiredDrivers,
    requiresLead: plan.requiresLead,
    requiredSkills: plan.requiredSkills.filter((s) => KNOWN_SKILLS.has(s)) as CrewSkill[],
    additionalStops: plan.flags.additionalStops,
    hasStairs: plan.flags.hasStairs,
    hasElevator: plan.flags.hasElevator,
    longCarry: plan.flags.longCarry,
    heavyItems: plan.flags.heavyItems,
    packing: plan.flags.packing,
    assembly: plan.flags.assembly,
    customerProvidedTruck: plan.customerProvidedTruck,
    rentalTruckPickup: plan.rentalTruckPickup,
    drivingRequired: plan.drivingRequired,
    estimatedStartAt: start,
    estimatedEndAt: end,
    workerInstructions: opts.workerInstructions ?? plan.workerInstructions ?? null,
  }
  if (opts.jobId) data.jobId = opts.jobId
  return data
}

// ── ensureStaffingRequirement — EXACTLY ONE row per job ──────────────────────

/** The three columns of an existing requirement this spine may still fill (the
 *  only NULLABLE ones it owns — see prisma/schema.prisma JobStaffingRequirement;
 *  everything else has a non-null default and therefore always holds a real
 *  owner-visible value). */
export type StaffingRequirementSnapshot = {
  estimatedStartAt?: Date | null
  estimatedEndAt?: Date | null
  workerInstructions?: string | null
}

/** The minimal transaction surface this spine needs. Structural, so the real
 *  Prisma `tx` satisfies it and an offline fake can too (no DB in tests). */
export type StaffingRequirementDelegate = {
  findUnique(args: { where: { jobId: string } }): Promise<StaffingRequirementSnapshot | null>
  create(args: {
    data: StaffingRequirementColumns & { jobId: string; createdById?: string | null }
  }): Promise<unknown>
  update(args: {
    where: { jobId: string }
    data: Partial<StaffingRequirementColumns> & { updatedById?: string | null }
  }): Promise<unknown>
}

export type StaffingTx = { jobStaffingRequirement: StaffingRequirementDelegate }

/** What the ensure DID. 'unchanged' is a success: the row exists, which is the
 *  whole guarantee, and the values on it are the owner's. */
export type EnsureStaffingOutcome = 'created' | 'filled' | 'unchanged'

export type EnsureStaffingResult = {
  jobId: string
  plan: StaffingPlan
  data: StaffingRequirementData
  outcome: EnsureStaffingOutcome
  /** Which NULL columns on an existing row were filled from the plan. */
  filled: string[]
}

/**
 * Give a job THE staffing requirement it must have — CREATE-IF-MISSING.
 *
 * EXISTENCE IS THE GUARANTEE, NOT THE VALUES (item R2-3). This used to be a
 * blind upsert whose `update` branch rewrote requiredWorkers / minWorkers /
 * requiredDrivers / the job flags / workerInstructions from the plan every time
 * it ran. A Job can exist BEFORE approval (crew assigned early) and its
 * requirement hand-tuned by the owner through PATCH /api/admin/jobs/[id]/staffing
 * — and now that an already-confirmed replay re-runs this (the repair path for a
 * failed ensure), a replayed plan would silently stomp those edits, with no
 * audit trail. So: when the row already exists, the owner's numbers stand.
 *
 * The ONE exception, deliberately narrow: a column that is NULL on the existing
 * row and has a value in the plan is FILLED (`outcome: 'filled'`, and the filled
 * column names are returned). Filling a null adds information the owner never
 * entered; it never overwrites a decision they made. Only the three nullable
 * columns this spine owns are eligible.
 *
 * EXACTLY ONE ROW: JobStaffingRequirement.jobId is @unique, so the index — not
 * this read-then-write — is the real exactly-once guarantee. A create that loses
 * a race with a concurrent approval raises a unique violation, which the caller
 * logs; the row exists either way, and the next replay reports 'unchanged'.
 *
 * MAY THROW (missing table on an unapplied migration, DB error). Every caller
 * WRAPS it: on the approval path a staffing failure must never block capturing
 * the deposit or confirming the booking (see booking-approval.ts).
 */
export async function ensureStaffingRequirement(
  tx: StaffingTx,
  args: {
    jobId: string
    booking: StaffingBookingRow
    plan?: StaffingPlan | null
    createdById?: string | null
    updatedById?: string | null
    estimatedStartAt?: Date | null
    estimatedEndAt?: Date | null
  },
): Promise<EnsureStaffingResult> {
  const plan = planForBooking(args.booking, args.plan ?? null)
  // ITEM R2-1 — the times are only ever a REAL scheduled start. A day-level
  // booking has `scheduledStart = null` and this must stay null: `confirmedDate`
  // and `requestedDate` are 00:00 ET day anchors, and promoting one of them into
  // `estimatedStartAt` is how a crew ends up reporting at midnight. An explicit
  // caller argument (the admin create passes the schedule it just resolved) wins;
  // otherwise the booking's own start is used, and nothing is invented.
  const start =
    args.estimatedStartAt !== undefined ? args.estimatedStartAt : args.booking.scheduledStart ?? null
  const end = args.estimatedEndAt !== undefined ? args.estimatedEndAt : args.booking.scheduledEnd ?? null
  const data = staffingRequirementDataFromPlan(plan, {
    jobId: args.jobId,
    estimatedStartAt: start,
    estimatedEndAt: end,
  })
  const { jobId: _ignored, ...columns } = data

  const existing = await tx.jobStaffingRequirement.findUnique({ where: { jobId: args.jobId } })
  if (!existing) {
    await tx.jobStaffingRequirement.create({
      data: { jobId: args.jobId, createdById: args.createdById ?? null, ...columns },
    })
    return { jobId: args.jobId, plan, data, outcome: 'created', filled: [] }
  }

  // The row is already there. Fill only what is genuinely absent.
  const fills: Partial<StaffingRequirementColumns> = {}
  const filled: string[] = []
  if (existing.estimatedStartAt == null && columns.estimatedStartAt != null) {
    fills.estimatedStartAt = columns.estimatedStartAt
    filled.push('estimatedStartAt')
  }
  if (existing.estimatedEndAt == null && columns.estimatedEndAt != null) {
    fills.estimatedEndAt = columns.estimatedEndAt
    filled.push('estimatedEndAt')
  }
  if (existing.workerInstructions == null && columns.workerInstructions != null) {
    fills.workerInstructions = columns.workerInstructions
    filled.push('workerInstructions')
  }
  if (filled.length === 0) {
    return { jobId: args.jobId, plan, data, outcome: 'unchanged', filled }
  }
  await tx.jobStaffingRequirement.update({
    where: { jobId: args.jobId },
    data: { ...fills, updatedById: args.updatedById ?? args.createdById ?? null },
  })
  return { jobId: args.jobId, plan, data, outcome: 'filled', filled }
}
