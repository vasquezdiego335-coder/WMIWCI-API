// ════════════════════════════════════════════════════════════════════════
//  booking-schema.ts - THE validation contract for POST /api/bookings.
//
//  Extracted from app/api/bookings/route.ts on 2026-07-28. Next.js App Router
//  route files may export only route handlers, so anything that needs to be
//  unit tested has to live here.
//
//  NOTE ON UNKNOWN KEYS: this is a plain z.object(), which STRIPS keys it does
//  not know rather than rejecting them. That is deliberate - a browser tab
//  opened before a cutover must never 422 on a field it cannot know about. The
//  cost is that a field the form sends but this schema omits vanishes silently,
//  which is exactly how the five access/inventory answers were lost. When you
//  add a field to the booking form, add it HERE in the same change.
// ════════════════════════════════════════════════════════════════════════

import { z } from 'zod'
import { ELEVATOR_LABELS, PARKING_LABELS, BUILDING_LABELS } from '@/lib/booking-display'

function sanitizeText(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim()
}

function sanitizeNotes(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

function normalizeTruckOption(value?: string): string | undefined {
  const clean = value ? sanitizeText(value) : undefined
  if (!clean) return undefined
  if (clean === 'full-148' || clean === 'reserve-99') return 'truck-pickup-return'
  return clean
}

const cleanString = (min: number, max: number) =>
  z.string().transform(sanitizeText).pipe(z.string().min(min).max(max))

export const BookingSchema = z.object({
  fullName: cleanString(2, 100),
  phone: cleanString(7, 25),
  email: z.string().transform((v) => sanitizeText(v).toLowerCase()).pipe(z.string().email()),
  /** @deprecated LEGACY. This field meant BOTH the product and the bedroom
   *  package, which is the overload the two-product contract exists to end.
   *  New payloads send `serviceTypeKey` (the product) and `moveSizeKey` (the
   *  package). Kept OPTIONAL so a browser tab opened before the cutover still
   *  parses; the route reads it only as a fallback for `moveSizeKey`. */
  serviceType: z.string().transform(sanitizeText).pipe(z.string().max(60)).optional(),
  date: z.string().transform(sanitizeText).optional(),
  time: z.string().transform(sanitizeText).optional(),
  truckOption: z.string().transform(normalizeTruckOption).optional(),
  jobDetails: z.string().transform(sanitizeNotes).pipe(z.string().max(2000)).optional(),
  discountCode: z.string().transform(sanitizeText).pipe(z.string().max(50)).optional(),

  // ── Addresses & access (collected on the booking form) ──
  addressFrom: z.string().transform(sanitizeText).pipe(z.string().max(200)).optional(),
  addressTo: z.string().transform(sanitizeText).pipe(z.string().max(200)).optional(),

  // ── Structured service-area addresses (new booking form) ──
  // Optional; when present, drive the server-side travel-fee/zone decision. The
  // single-line addressFrom/addressTo above stay for back-compat.
  pickupAddresses: z
    .array(
      z.object({
        street: z.string().transform(sanitizeText).pipe(z.string().max(200)).optional(),
        city: z.string().transform(sanitizeText).pipe(z.string().max(120)).optional(),
        state: z.string().transform(sanitizeText).pipe(z.string().max(40)).optional(),
        zip: z.string().transform(sanitizeText).pipe(z.string().max(12)).optional(),
      }),
    )
    .max(10)
    .optional(),
  destinationAddress: z
    .object({
      street: z.string().transform(sanitizeText).pipe(z.string().max(200)).optional(),
      city: z.string().transform(sanitizeText).pipe(z.string().max(120)).optional(),
      state: z.string().transform(sanitizeText).pipe(z.string().max(40)).optional(),
      zip: z.string().transform(sanitizeText).pipe(z.string().max(12)).optional(),
    })
    .optional(),
  // ── LEGACY access booleans. Kept so a browser tab opened before the
  //    2026-07-21 cutover still submits successfully; they map to the LOWEST
  //    tier server-side and never guess a heavy-item weight. ──
  stairs: z.coerce.boolean().optional(),
  longWalk: z.coerce.boolean().optional(),
  heavyItems: z.coerce.boolean().optional(),

  // ── TIERED access details (2026-07-21). Stairs and carry distance are
  //    priced PER ADDRESS, so each end is captured separately. ──
  pickupStairFlights: z.coerce.number().int().min(0).max(60).optional(),
  dropoffStairFlights: z.coerce.number().int().min(0).max(60).optional(),
  pickupCarryFeet: z.coerce.number().int().min(0).max(5000).optional(),
  dropoffCarryFeet: z.coerce.number().int().min(0).max(5000).optional(),

  /** Heavy items WITH weights. Weight is what makes the $50/$100/review tiers
   *  computable; a piano or safe is always a custom quote regardless. */
  heavyItemsDetail: z
    .array(
      z.object({
        label: z.string().transform(sanitizeText).pipe(z.string().max(80)).optional(),
        pounds: z.coerce.number().int().min(0).max(5000).optional(),
        isPianoOrSafe: z.coerce.boolean().optional(),
      })
    )
    .max(20)
    .optional(),

  /** Stops beyond the included one pickup + one drop-off. */
  additionalStops: z
    .array(
      z.object({
        label: z.string().transform(sanitizeText).pipe(z.string().max(120)).optional(),
        miles: z.coerce.number().min(0).max(500).optional(),
      })
    )
    .max(10)
    .optional(),

  // ── ACCESS DIFFICULTY (owner fix 2026-07-28) ────────────────────────────
  //    The form has ALWAYS sent these five. They were missing from this schema,
  //    and z.object() STRIPS unknown keys rather than rejecting them, so every
  //    answer was silently discarded — while the form told the customer that a
  //    freight-restricted elevator or a loading-dock restriction is "Reviewed
  //    before any charge applies". Nothing was ever reviewed.
  //
  //    These are REVIEW TRIGGERS, never auto-priced: the matching charges in
  //    pricing-config.ts carry requiresReview:true, so isAutoApplicable() keeps
  //    them out of the headline total by design. Adding them here does not
  //    change a single price — it makes the promised review actually fire.
  //
  //    Optional/coerced so a browser tab opened before this cutover still
  //    submits; undefined means "not asked", which is not the same as "no".
  difficultElevatorPickup: z.coerce.boolean().optional(),
  difficultElevatorDropoff: z.coerce.boolean().optional(),
  difficultBuildingPickup: z.coerce.boolean().optional(),
  difficultBuildingDropoff: z.coerce.boolean().optional(),

  // ── Structured access details (booking form selects). Unknown values are
  //    dropped rather than rejected so an old cached form can never 422.
  //    NOTE: as of 2026-07-21 these are STORED FOR THE CREW ONLY and price
  //    nothing. The building-age surcharge was removed as undisclosed. ──
  elevatorAccess: z
    .string()
    .transform((v) => (ELEVATOR_LABELS[sanitizeText(v)] ? sanitizeText(v) : undefined))
    .optional(),
  parkingDistance: z
    .string()
    .transform((v) => (PARKING_LABELS[sanitizeText(v)] ? sanitizeText(v) : undefined))
    .optional(),
  buildingYear: z
    .string()
    .transform((v) => (BUILDING_LABELS[sanitizeText(v)] ? sanitizeText(v) : undefined))
    .optional(),

  // ── Structured access details (owner spec 2026-07-12) — all optional so an
  //    older cached form never 422s. Pickup=origin, drop-off=dest stay separate.
  //    Access CODES are persisted to their own columns and NEVER folded into
  //    itemsDescription (which reaches public emails + the customer summary). ──
  originUnit: z.string().transform(sanitizeText).pipe(z.string().max(40)).optional(),
  destUnit: z.string().transform(sanitizeText).pipe(z.string().max(40)).optional(),
  originFloor: z.coerce.number().int().min(-5).max(200).optional(),
  destFloor: z.coerce.number().int().min(-5).max(200).optional(),
  originHasElevator: z.coerce.boolean().optional(),
  destHasElevator: z.coerce.boolean().optional(),
  originStairCount: z.coerce.number().int().min(0).max(200).optional(),
  destStairCount: z.coerce.number().int().min(0).max(200).optional(),
  originAccessNotes: z.string().transform(sanitizeNotes).pipe(z.string().max(500)).optional(),
  destAccessNotes: z.string().transform(sanitizeNotes).pipe(z.string().max(500)).optional(),
  originAccessCode: z.string().transform(sanitizeText).pipe(z.string().max(60)).optional(),
  destAccessCode: z.string().transform(sanitizeText).pipe(z.string().max(60)).optional(),
  truckProvider: z.string().transform(sanitizeText).pipe(z.string().max(80)).optional(),
  truckSize: z.string().transform(sanitizeText).pipe(z.string().max(40)).optional(),
  truckReservationStatus: z.string().transform(sanitizeText).pipe(z.string().max(40)).optional(),
  truckPickupLocation: z.string().transform(sanitizeText).pipe(z.string().max(200)).optional(),
  truckReturnResponsibility: z.string().transform(sanitizeText).pipe(z.string().max(120)).optional(),
  equipmentNeeds: z.string().transform(sanitizeNotes).pipe(z.string().max(500)).optional(),
  crewInstructions: z.string().transform(sanitizeNotes).pipe(z.string().max(1000)).optional(),

  // ── Phase 2 address verification handshake. addressFormVersion >= 2 means the
  //    form ran the autocomplete widget and enforced suggestion selection, so the
  //    server may hard-reject undeliverable strings. manualEntryReason is the
  //    controlled fallback (verification genuinely failed) — it always routes the
  //    booking to owner manual review instead of rejecting. ──
  addressFormVersion: z.coerce.number().int().min(1).max(10).optional(),
  manualEntryReason: z.string().transform(sanitizeNotes).pipe(z.string().max(300)).optional(),

  // ── Client-side estimate snapshot (display only — NEVER drives pricing).
  //    Shown to the owner so the approval card matches what the customer saw. ──
  estimateTotal: z.coerce.number().min(0).max(100000).optional(),
  estimateAddons: z.coerce.number().min(0).max(100000).optional(),

  // ── Marketing attribution (?src= from the QR / landing URL) ──
  source: z.string().transform(sanitizeText).pipe(z.string().max(60)).optional(),
  // "Where did you find us?" self-report from the booking-form dropdown.
  foundUs: z.string().transform(sanitizeText).pipe(z.string().max(40)).optional(),

  // ── Partial-lead linkage + promotional consent (owner spec 2026-07-24) — all
  //    optional/additive. bookingSessionId lets markLeadConverted find + convert
  //    the exact partial lead captured in Step 1; marketingConsent (tri-state:
  //    present only when the visitor toggled the box) is propagated to the
  //    Customer. Absent on any tab opened before this cutover — safely ignored. ──
  bookingSessionId: z.string().transform(sanitizeText).pipe(z.string().max(80)).optional(),
  marketingConsent: z.boolean().optional(),

  // ── THE PRODUCT (owner spec 2026-08-14, booking WMIC-1019) ──────────────
  //    The booking form has been sending serviceTypeKey / laborService /
  //    customerTruckStatus for a while. They were not in this schema, so
  //    z.object() dropped all three on every submission — which is precisely
  //    how a labor-only job on the customer's own truck was stored as a
  //    full-service bedroom package.
  //
  //    serviceType (the PACKAGE) stays separate on purpose: a labor-only job
  //    still has a size, and the size is not a claim about whose truck it is.
  //  REQUIRED. The discriminant for the whole booking contract. It is not
  //  optional and it is never inferred: guessing the product from the package,
  //  the truck provider or the notes is how a job on the customer's own U-Haul
  //  was recorded as a company-truck move. A browser tab opened before this
  //  cutover fails validation with a field-mapped message telling the customer
  //  to choose a service, which is the honest outcome.
  serviceTypeKey: z
    .string({ required_error: 'Choose a service: Full-Service Moving or Labor-Only Moving Help.' })
    .transform((v) => sanitizeText(v).toLowerCase().replace(/[\s-]+/g, '_'))
    .pipe(z.enum(['labor_only', 'full_service'], {
      errorMap: () => ({ message: 'Choose a service: Full-Service Moving or Labor-Only Moving Help.' }),
    })),
  /** FULL-SERVICE only: which flat package. Replaces the overloaded
   *  `serviceType`, which meant both the product and the bedroom size. */
  moveSizeKey: z.string().transform(sanitizeText).pipe(z.string().max(40)).optional(),
  /** Which labor product ("loading_only", "unloading_only", "load_and_unload"). */
  laborService: z.string().transform(sanitizeText).pipe(z.string().max(40)).optional(),
  laborHours: z.coerce.number().min(0).max(24).optional(),
  /** Labor-only crew size. Omitted = the published two-worker product. Range
   *  is validated by checkIntake (2–6, $75/worker/hour ladder) so the customer
   *  gets a sentence, not a bare Zod error; the wide bound here only stops
   *  garbage. */
  laborWorkers: z.coerce.number().int().min(1).max(99).optional(),
  /** Whether the customer's rental truck is booked yet. */
  customerTruckStatus: z.string().transform(sanitizeText).pipe(z.string().max(40)).optional(),
  /** FULL-SERVICE only: the customer asked for a larger COMPANY truck. Its
   *  presence on a labor-only payload is a contradiction the product gate
   *  rejects — we supply no truck on those jobs. */
  truckSizeUpgradeRequested: z.coerce.boolean().optional(),

  // ── DISCLOSED INVENTORY (owner spec 2026-08-14) ─────────────────────────
  //    Counted items and the declared flags. Until now the browser folded
  //    these into the notes text because the server had nowhere to put them,
  //    so nothing could compare the load against the selected package. Every
  //    field is optional and capped; a tab opened before this cutover simply
  //    sends none of them and the notes fallback still works.
  inventory: z
    .object({
      boxes: z.coerce.number().int().min(0).max(999).optional(),
      beds: z.coerce.number().int().min(0).max(99).optional(),
      dressers: z.coerce.number().int().min(0).max(99).optional(),
      sofas: z.coerce.number().int().min(0).max(99).optional(),
      tables: z.coerce.number().int().min(0).max(99).optional(),
      tvs: z.coerce.number().int().min(0).max(99).optional(),
      mirrors: z.coerce.number().int().min(0).max(99).optional(),
      appliances: z.coerce.number().int().min(0).max(99).optional(),
      wardrobes: z.coerce.number().int().min(0).max(99).optional(),
      desks: z.coerce.number().int().min(0).max(99).optional(),
      piano: z.coerce.boolean().optional(),
      safe: z.coerce.boolean().optional(),
      oversized: z.coerce.boolean().optional(),
      assembly: z.coerce.boolean().optional(),
    })
    .optional(),

  // ── ASSEMBLY / DISASSEMBLY AS A SCOPE, NOT A SENTENCE ───────────────────
  //    "Assembly needed" in the notes told the crew nothing about WHAT. These
  //    say which furniture. When assembly is requested and neither list is
  //    provided, the booking is flagged ASSEMBLY SCOPE UNKNOWN and the quote
  //    is not treated as final — see src/lib/booking-scope.ts.
  needsAssembly: z.coerce.boolean().optional(),
  needsDisassembly: z.coerce.boolean().optional(),
  assemblyItems: z.string().transform(sanitizeNotes).pipe(z.string().max(500)).optional(),
  disassemblyItems: z.string().transform(sanitizeNotes).pipe(z.string().max(500)).optional(),

  // ── CERTIFICATE OF INSURANCE ────────────────────────────────────────────
  //    Tri-state, and 'unknown' is the honest default for a building nobody
  //    has called. A COI discovered on move day is a crew turned away.
  coiRequiredOrigin: z.enum(['yes', 'no', 'unknown']).optional().catch(undefined),
  coiRequiredDest: z.enum(['yes', 'no', 'unknown']).optional().catch(undefined),
  coiNotes: z.string().transform(sanitizeNotes).pipe(z.string().max(500)).optional(),

  // ── Inventory accuracy attestation (hard-required, owner fix 2026-07-28) ──
  //    The flat rate is quoted against the inventory the customer described, so
  //    the attestation is what makes a later change order fair. Like
  //    agreementAccepted this must be literally true — a booking that does not
  //    carry it is refused with a field-mapped 422 the form can point at.
  inventoryAccuracyConfirmed: z.literal(true, {
    errorMap: () => ({ message: 'Please confirm your inventory and access details are accurate.' }),
  }),

  // ── Moving Service Agreement (hard-required) ──
  // Must be literally true — booking + Stripe session are refused otherwise.
  agreementAccepted: z.literal(true, {
    errorMap: () => ({ message: 'You must accept the Moving Service Agreement to book.' }),
  }),
  agreementName: cleanString(2, 100),
  // Frontend sends the version it displayed; we store the server's canonical version.
  agreementVersion: z.string().transform(sanitizeText).pipe(z.string().max(40)).optional(),
  agreementSignature: z.string().transform(sanitizeText).pipe(z.string().max(120)).optional(),

  // Preferred language from the site's EN/ES toggle — drives bilingual email/SMS.
  locale: z.string().transform(sanitizeText).pipe(z.string().max(8)).optional(),

  // ── Job photos (uploaded client-side to Cloudinary before submit) ──
  // Each entry is the {url, publicId} Cloudinary returns. Optional + capped so a
  // malformed/oversized payload can't bloat the booking. Persisted as File rows.
  photos: z
    .array(
      z.object({
        url: z.string().url().max(500),
        publicId: z.string().transform(sanitizeText).pipe(z.string().min(1).max(300)),
      })
    )
    .max(20)
    .optional(),
})
