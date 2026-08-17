// ════════════════════════════════════════════════════════════════════════
//  pricing-config.ts — THE single source of truth for the Move It Clear It
//  published price book (packages + every add-on + review triggers).
//
//  WHY THIS FILE EXISTS
//  --------------------
//  Before this file, the same add-on had up to FOUR different prices in four
//  places: services.html said "Heavy Item Fee $30-$60", terms said the same,
//  the booking form charged a flat $60, and estimate.ts mirrored the $60.
//  A price could be changed on the pricing page and stay stale in the quote,
//  the email and the Terms. Everything that quotes a number must now read it
//  from here.
//
//  CONSUMERS
//    • estimate.ts          — server-side quote math (authoritative total)
//    • booking form         — via the generated browser mirror,
//                             WMIWCI-SITE/public/js/pricing-config.js
//                             (npm run gen:pricing-config)
//    • pricing / services / faq / terms pages — display copy
//    • emails, admin, Discord — read the STORED booking total, never re-derive
//
//  UNIT CONTRACT: every amount in this file is WHOLE DOLLARS (integers).
//  Cents-based fields elsewhere (Payment.amount, depositAmount, travelFee)
//  keep their own contract — see pricing.ts. Convert at the boundary.
//
//  TWO SEPARATE $49 CHARGES — never merge, never reuse one variable:
//    • BOOKING_AUTHORIZATION.amount  = 49  (Stripe manual-capture hold)
//    • TRUCK_PICKUP_RETURN.amount    = 49  (labor add-on, due on move day)
//  They coexist on one booking and must render as two distinct line items.
// ════════════════════════════════════════════════════════════════════════

/** How a published price behaves. Drives both math and how it must render. */
export type ChargeKind =
  /** No charge — bundled into the package. Renders "Included". */
  | 'included'
  /** An exact, automatically-applicable amount. Renders "$40". */
  | 'fixed'
  /** A floor, not a quote. Renders "Starting at $100". ALWAYS review-gated. */
  | 'starting'
  /** A reviewed band. Renders "$50-$75". Never auto-applied. */
  | 'range'
  /** No published number is honest. Renders "Custom quote". */
  | 'manual_quote'
  /** Percentage of the base labor price. */
  | 'percent'
  /** Known to apply, amount not yet determined. Renders "Pending review". */
  | 'pending_review'
  /** Customer reimburses the documented actual cost (tolls, parking). */
  | 'actual_cost'

export type Charge = {
  kind: ChargeKind
  /** Dollars. Set for fixed/starting; the LOW end for range; omitted otherwise. */
  amount?: number
  /** Dollars. The HIGH end of a range. */
  amountMax?: number
  /** Percent (0-100) for kind='percent'. */
  percent?: number
  /** True when an owner must approve before this can be charged or confirmed. */
  requiresReview?: boolean
  /** What the charge is applied to — drives duplicate-charge prevention. */
  per?: 'job' | 'address' | 'location' | 'item' | 'flight' | 'half_hour'
  label: string
  label_es?: string
  /** Customer-facing explanation. Shown wherever the charge can appear. */
  note?: string
  note_es?: string
}

const c = (x: Charge): Charge => x

// ── Rendering ───────────────────────────────────────────────────────────────
/** Renders a Charge exactly as it must appear to a customer. The ONE formatter
 *  — so "Starting at" can never be dropped and a review-gated charge can never
 *  masquerade as a settled number. */
export function formatCharge(ch: Charge, lang: 'en' | 'es' = 'en'): string {
  const m = (n: number): string => `$${n.toLocaleString('en-US')}`
  const es = lang === 'es'
  switch (ch.kind) {
    case 'included':
      return es ? 'Incluido' : 'Included'
    case 'fixed':
      return m(ch.amount ?? 0)
    case 'starting':
      return es ? `Desde ${m(ch.amount ?? 0)}` : `Starting at ${m(ch.amount ?? 0)}`
    case 'range':
      return `${m(ch.amount ?? 0)}–${m(ch.amountMax ?? 0)}`
    case 'manual_quote':
      return es ? 'Cotización personalizada' : 'Custom quote'
    case 'percent':
      return `${ch.percent ?? 0}%`
    case 'pending_review':
      return es ? 'Pendiente de revisión' : 'Pending review'
    case 'actual_cost':
      return es ? 'Costo real documentado' : 'Actual documented cost'
  }
}

/** True when a charge may be auto-applied to a quote without owner approval.
 *  Everything else must render as "Pending review" and block auto-confirmation. */
export const isAutoApplicable = (ch: Charge): boolean =>
  (ch.kind === 'included' || ch.kind === 'fixed') && !ch.requiresReview

// ════════════════════════════════════════════════════════════════════════
//  PACKAGES
//  3BR+ are FLOORS ("Starting at"), not flat rates: they require inventory
//  and access review before approval.
// ════════════════════════════════════════════════════════════════════════
export type PackageKey =
  | 'little-studio' | 'half-studio' | 'full-studio'
  | '1br' | '2br' | '3br' | '4br' | '5br'
  | 'not-sure'

export type MovePackage = {
  key: PackageKey
  label: string
  label_es: string
  price: Charge
  /** Rooms of disclosed inventory this package is scoped to. */
  rooms: number | null
  /** Owner review required before the booking can be confirmed. */
  requiresReview: boolean
  // ── Truck assignment (recovered 2026-08-15) ──────────────────────────
  //  Full-service includes a truck IN the flat price. `includedTruck` is that
  //  truck; `upgradeTruck` is the ONE larger size this package may move up to,
  //  at most once and only when reviewed inventory requires it.
  //  3BR and larger already include the 26ft — the biggest we run — so their
  //  `upgradeTruck` is null and a bigger job becomes a manual plan, not a
  //  surcharge. Studios and 'not-sure' carry no truck assignment at all.
  includedTruck?: TruckSizeKey | null
  upgradeTruck?: TruckSizeKey | null
  /** The product this package belongs to. Labor-only has no package. */
  serviceType?: ServiceTypeKey
  /** Crew size is confirmed after inventory review rather than published. */
  crewConfirmedAfterReview?: boolean
}

/** PUBLIC NAMES vs INTERNAL KEYS (owner decision 2026-07-25)
 *  The three studio tiers are marketed as Small / Standard / Large. The KEYS
 *  stay `little-studio` / `half-studio` / `full-studio` on purpose: they are
 *  persisted on every historic Booking row and referenced by the booking
 *  form's radio values, so renaming them would orphan existing data. Change
 *  `label` / `label_es` to change what customers read; never the key.
 */
export const PACKAGES: Record<PackageKey, MovePackage> = {
  'little-studio': { key: 'little-studio', label: 'Small Studio',    label_es: 'Estudio Pequeño',  rooms: 1, requiresReview: false, includedTruck: null, upgradeTruck: null, serviceType: 'full_service', crewConfirmedAfterReview: false, price: c({ kind: 'fixed', amount: 379, label: 'Small Studio' }) },
  'half-studio':   { key: 'half-studio',   label: 'Standard Studio', label_es: 'Estudio Estándar', rooms: 1, requiresReview: false, includedTruck: null, upgradeTruck: null, serviceType: 'full_service', crewConfirmedAfterReview: false, price: c({ kind: 'fixed', amount: 439, label: 'Standard Studio' }) },
  'full-studio':   { key: 'full-studio',   label: 'Large Studio',    label_es: 'Estudio Grande',   rooms: 1, requiresReview: false, includedTruck: null, upgradeTruck: null, serviceType: 'full_service', crewConfirmedAfterReview: false, price: c({ kind: 'fixed', amount: 549, label: 'Large Studio' }) },
  '1br':           { key: '1br',           label: '1 Bedroom',     label_es: '1 Recámara',       rooms: 2, requiresReview: false, includedTruck: '10ft', upgradeTruck: '15ft', serviceType: 'full_service', crewConfirmedAfterReview: false, price: c({ kind: 'fixed', amount: 550, label: '1 Bedroom' }) },
  '2br':           { key: '2br',           label: '2 Bedrooms',    label_es: '2 Recámaras',      rooms: 3, requiresReview: false, includedTruck: '15ft', upgradeTruck: '26ft', serviceType: 'full_service', crewConfirmedAfterReview: false, price: c({ kind: 'fixed', amount: 779, label: '2 Bedrooms' }) },

  // ── Review-gated floors. `kind: 'starting'` makes "Starting at" structural:
  //    formatCharge() cannot render these without the prefix. ──
  '3br': { key: '3br', label: '3 Bedrooms', label_es: '3 Recámaras', rooms: 4, requiresReview: true, includedTruck: '26ft', upgradeTruck: null, serviceType: 'full_service', crewConfirmedAfterReview: true, price: c({ kind: 'starting', amount: 1049, requiresReview: true, label: '3 Bedrooms', note: 'Final price confirmed after we review your inventory and access details.' }) },
  '4br': { key: '4br', label: '4 Bedrooms', label_es: '4 Recámaras', rooms: 5, requiresReview: true, includedTruck: '26ft', upgradeTruck: null, serviceType: 'full_service', crewConfirmedAfterReview: true, price: c({ kind: 'starting', amount: 1449, requiresReview: true, label: '4 Bedrooms', note: 'Final price confirmed after we review your inventory and access details.' }) },
  '5br': { key: '5br', label: '5 Bedrooms', label_es: '5 Recámaras', rooms: 6, requiresReview: true, includedTruck: '26ft', upgradeTruck: null, serviceType: 'full_service', crewConfirmedAfterReview: true, price: c({ kind: 'starting', amount: 1799, requiresReview: true, label: '5 Bedrooms', note: 'Final price confirmed after we review your inventory and access details.' }) },

  'not-sure': { key: 'not-sure', label: 'Need a Quote', label_es: 'Necesito Cotización', rooms: null, requiresReview: true, includedTruck: null, upgradeTruck: null, serviceType: 'full_service', crewConfirmedAfterReview: true, price: c({ kind: 'manual_quote', requiresReview: true, label: 'Need a Quote' }) },
}

/**
 * What EVERY standard package includes. Deliberately inventory- and
 * access-bounded — no "all your stuff", no "unlimited", no "all day".
 */
export const PACKAGE_INCLUDES: { en: string; es: string }[] = [
  // FULL-SERVICE crew wording. This said "Two professional labor workers" —
  // the LABOR-ONLY description — from the era when there was one product. On a
  // full-service package we bring a crew AND a truck, and the crew size for the
  // larger packages is confirmed after review rather than published as two.
  // Labor-only has its own list: LABOR_ONLY_INCLUDES, whose first line is
  // "Two professional workers".
  { en: 'Professional moving crew', es: 'Equipo profesional de mudanza' },
  { en: 'One loading location and one unloading location', es: 'Un lugar de carga y un lugar de descarga' },
  { en: 'Loading and unloading labor', es: 'Mano de obra de carga y descarga' },
  { en: 'Furniture placement in the room you choose', es: 'Colocación de muebles en el cuarto que elija' },
  { en: 'Standard moving equipment', es: 'Equipo de mudanza estándar' },
  { en: 'Dollies, straps, and reusable moving blankets', es: 'Carretillas, correas y cobijas reutilizables' },
  { en: 'One standard bed-frame disassembly, when reasonably required', es: 'Un desarmado de base de cama estándar, cuando sea razonablemente necesario' },
  { en: 'Normal residential access', es: 'Acceso residencial normal' },
  { en: 'The inventory you disclosed and we approved during booking', es: 'El inventario que usted informó y aprobamos durante la reserva' },
]

// ════════════════════════════════════════════════════════════════════════
//  THE TWO $49 CHARGES — separate identifiers, separate labels, separate
//  line items. Never collapse into one "$49 fee" variable.
// ════════════════════════════════════════════════════════════════════════

/** Stripe manual-capture authorization placed at submit; captured only on
 *  owner approval; applied toward the total. NOT a payment for services. */
export const BOOKING_AUTHORIZATION = {
  id: 'bookingAuthorizationAmount',
  amount: 49,
  amountCents: 4900,
  label: 'Booking authorization',
  label_es: 'Autorización de reserva',
  note: 'A $49 authorization is placed when you submit your booking. It is captured only after your move is approved and is applied toward your total.',
  note_es: 'Se coloca una autorización de $49 cuando envía su reserva. Se cobra solo después de aprobar su mudanza y se aplica a su total.',
} as const

/** ⚠ RETIRED 2026-08-14 (owner decision). We no longer collect and return a
 *  customer's rental truck, at $49, $50, or any price.
 *
 *  The constant STAYS so historical bookings that genuinely bought this render
 *  their original label and amount — deleting it would blank the line item on
 *  every past invoice. It must not appear on any NEW-booking surface:
 *  `product-catalog.isRetiredTruckOption()` refuses every alias at intake,
 *  before a Customer, Booking or Stripe object exists.
 *
 *  DO NOT reintroduce this as an active add-on without an owner decision. */
// ── Truck-size upgrade (owner decision, reconciled 2026-08-04) ───────────────
//  NOT the same thing as TRUCK_PICKUP_RETURN below, which is crew time to fetch
//  a truck the CUSTOMER rented. This is the truck WE bring: every package ships
//  with one included, and a larger one costs the difference.
//
//  WHY IT LIVES HERE NOW. These amounts previously existed ONLY as a hand edit
//  inside the GENERATED browser mirror (public/js/pricing-config.js), which the
//  generator overwrites — so the server and the customer's screen could, and
//  did, disagree. The server is the single source from here on; the mirror is
//  regenerated from it and must never be hand-edited again.
//
//  20ft IS RETIRED (owner decision 2026-08-02) and is deliberately ABSENT
//  rather than priced at 0: an unsupported size must be REJECTED, never
//  silently charged as if it were something else. See truckUpgradeAmount().
export const TRUCK_SIZE_UPGRADE = {
  id: 'truckSizeUpgrade',
  label: 'Larger truck',
  label_es: 'Camión más grande',
  requiresReview: true,
  /** Sizes we actually operate, and what each ADDS to the package price. */
  amountByTruck: {
    '10ft': 0,
    '15ft': 100,
    '26ft': 150,
  },
  amountCentsByTruck: {
    '10ft': 0,
    '15ft': 10000,
    '26ft': 15000,
  },
  note: 'The truck included with your package covers most moves of this size. A larger truck is available for the difference, confirmed after we review your inventory.',
  note_es: 'El camión incluido en su paquete cubre la mayoría de las mudanzas de este tamaño. Hay un camión más grande disponible por la diferencia, confirmado después de revisar su inventario.',
} as const

/**
 * THE MINIMUM TRUCK EACH PACKAGE REQUIRES.
 *
 * Truck size is DERIVED from the move size, not offered as a free choice. A
 * customer cannot pick a smaller truck to dodge the upgrade fee: a 3-bedroom
 * move does not fit in a 10ft truck, and letting someone book one produces a
 * crew standing in a driveway with nowhere to put the furniture.
 *
 * A LARGER truck is allowed. The fee is then the LARGER truck's fee and it
 * REPLACES the smaller one — 10ft to 26ft costs $150, never $100 + $150.
 *
 * 5BR is absent on purpose: it may need several trucks or several trips, so it
 * cannot be quoted automatically from a single truck. See requiresManualTruckPlan.
 */
export const MIN_TRUCK_BY_PACKAGE: Record<string, SelectableTruckSize> = {
  'little-studio': '10ft',
  'half-studio': '10ft',
  'full-studio': '10ft',
  '1br': '10ft',
  '2br': '15ft',
  '3br': '26ft',
  '4br': '26ft',
}

/** Packages that cannot be auto-quoted from one truck — owner review instead. */
export const MANUAL_TRUCK_PLAN_PACKAGES: ReadonlySet<string> = new Set(['5br', 'not-sure'])

export function requiresManualTruckPlan(packageKey?: string | null): boolean {
  return MANUAL_TRUCK_PLAN_PACKAGES.has((packageKey ?? '').trim().toLowerCase())
}

/** Ascending capacity. Used to compare "is this at least the minimum?". */
const TRUCK_ORDER: readonly SelectableTruckSize[] = ['10ft', '15ft', '26ft']
const rank = (t: SelectableTruckSize) => TRUCK_ORDER.indexOf(t)

export type TruckAssignment =
  | {
      ok: true
      /** The size actually assigned — never smaller than the minimum. */
      assigned: SelectableTruckSize
      /** The minimum this package requires, for honest UI copy. */
      minimum: SelectableTruckSize
      /** DOLLARS. The assigned size's fee. REPLACES, never stacks. */
      upgradeAmount: number
      /** True when the customer asked for something below the minimum and we
       *  corrected it upward. The UI should say so rather than silently differ. */
      corrected: boolean
      /** True when the customer chose a larger truck than required. */
      upgraded: boolean
    }
  | { ok: false; reason: 'manual_plan' | 'unknown_package' | 'unsupported_truck' }

/**
 * Assign the truck for a package, honouring an optional customer preference.
 *
 * THE SERVER IS AUTHORITATIVE. A request naming a truck below the minimum is
 * CORRECTED upward rather than rejected — the customer still gets a usable
 * quote, and they are told what changed. A truck size we do not operate (a
 * retired 20ft, or anything invented) IS rejected, because silently swapping it
 * for a different size would quote a vehicle nobody agreed to.
 */
export function assignTruck(packageKey?: string | null, requested?: string | null): TruckAssignment {
  const key = (packageKey ?? '').trim().toLowerCase()
  if (!key) return { ok: false, reason: 'unknown_package' }
  if (requiresManualTruckPlan(key)) return { ok: false, reason: 'manual_plan' }

  const minimum = MIN_TRUCK_BY_PACKAGE[key]
  if (!minimum) return { ok: false, reason: 'unknown_package' }

  let assigned: SelectableTruckSize = minimum
  let corrected = false
  let upgraded = false

  const askedRaw = (requested ?? '').trim().toLowerCase()
  if (askedRaw) {
    if (!isSelectableTruckSize(askedRaw)) return { ok: false, reason: 'unsupported_truck' }
    const asked = askedRaw as SelectableTruckSize
    if (rank(asked) < rank(minimum)) {
      // Below the minimum: correct upward. This is the anti-dodge rule.
      assigned = minimum
      corrected = true
    } else {
      assigned = asked
      upgraded = rank(asked) > rank(minimum)
    }
  }

  // The assigned size's own fee — a REPLACEMENT, so upgrading 10ft -> 26ft is
  // $150 and never the sum of the intermediate steps.
  const upgradeAmount = truckUpgradeAmount(assigned) ?? 0
  return { ok: true, assigned, minimum, upgradeAmount, corrected, upgraded }
}

/** The truck sizes a NEW booking may choose. 20ft is retired and excluded. */
export const SELECTABLE_TRUCK_SIZES = ['10ft', '15ft', '26ft'] as const
export type SelectableTruckSize = (typeof SELECTABLE_TRUCK_SIZES)[number]

/**
 * DOLLARS added by a given truck size, or null when the size is not one we
 * operate.
 *
 * Returning null rather than 0 for an unknown or retired size is the whole
 * point: 0 reads as "this truck is free", which would let a retired 20ft
 * selection through at no charge. Callers must treat null as a rejection.
 */
export function truckUpgradeAmount(size?: string | null): number | null {
  const key = (size ?? '').trim().toLowerCase()
  if (!key) return null
  return Object.prototype.hasOwnProperty.call(TRUCK_SIZE_UPGRADE.amountByTruck, key)
    ? TRUCK_SIZE_UPGRADE.amountByTruck[key as SelectableTruckSize]
    : null
}

/** CENTS twin of truckUpgradeAmount, for anything that stores money. */
export function truckUpgradeAmountCents(size?: string | null): number | null {
  const key = (size ?? '').trim().toLowerCase()
  if (!key) return null
  return Object.prototype.hasOwnProperty.call(TRUCK_SIZE_UPGRADE.amountCentsByTruck, key)
    ? TRUCK_SIZE_UPGRADE.amountCentsByTruck[key as SelectableTruckSize]
    : null
}

export function isSelectableTruckSize(size?: string | null): size is SelectableTruckSize {
  return truckUpgradeAmount(size) !== null
}

export const TRUCK_PICKUP_RETURN = {
  id: 'truckPickupReturnFee',
  amount: 49,
  amountCents: 4900,
  label: 'Truck pickup & return add-on',
  label_es: 'Complemento de recogida y devolución del camión',
  requiresReview: true,
  /** OWNER RULE 2026-07-21: never discountable, by any coupon or campaign.
   *  It is near-cost crew time, not margin. Enforced by applyDiscount(). */
  discountable: false,
  /** Pickup-related waiting included before WAITING_TIME starts. */
  includedWaitMinutes: 30,
  note: 'Crew time to pick up and return a rental truck you reserved, when the rental location is in our primary service area and our driver has been properly authorized by the rental company. Requires manual approval — we do not guarantee truck driving until it is approved. You remain responsible for the rental, fuel, mileage, tolls, parking, protection-plan choices, deposits, and any late-return or damage charges.',
  note_es: 'Tiempo del equipo para recoger y devolver un camión que usted reservó, cuando el lugar de alquiler está en nuestra área principal y la compañía de alquiler ha autorizado a nuestro conductor. Requiere aprobación manual. Usted sigue siendo responsable del alquiler, combustible, millaje, peajes, estacionamiento, planes de protección, depósitos y cargos por devolución tardía o daños.',
} as const

// ════════════════════════════════════════════════════════════════════════
//  ADD-ONS
// ════════════════════════════════════════════════════════════════════════

/** Stairs — per AFFECTED ADDRESS, not per flight, not per job. */
export const STAIRS = {
  /** Does an exterior building-entrance flight (stoop/porch steps up to the
   *  front door) count toward the total? NO — only interior flights between
   *  floors count. Stated explicitly so the crew and the customer agree. */
  exteriorEntranceFlightCounts: false,
  exteriorEntranceNote: 'A single exterior entrance stoop or porch step-up to the front door is not counted as a flight. Flights are counted between floors.',
  tiers: [
    c({ kind: 'included', per: 'address', label: 'First flight', note: 'Included in every package.' }),
    c({ kind: 'fixed', amount: 40, per: 'address', label: 'Second flight' }),
    c({ kind: 'fixed', amount: 70, per: 'address', label: 'Third flight' }),
    c({ kind: 'starting', amount: 100, per: 'address', requiresReview: true, label: 'Four or more flights', note: 'Requires review before we can approve the move.' }),
  ] as Charge[],
}

/** Long carry — door-to-truck walking distance, per LOCATION. */
export const LONG_CARRY = {
  tiers: [
    c({ kind: 'included', per: 'location', label: 'Under 100 feet' }),
    c({ kind: 'fixed', amount: 40, per: 'location', label: '100–250 feet' }),
    c({ kind: 'fixed', amount: 75, per: 'location', label: '251–400 feet' }),
    c({ kind: 'starting', amount: 100, per: 'location', requiresReview: true, label: 'More than 400 feet', note: 'Requires review before we can approve the move.' }),
  ] as Charge[],
}

/** Elevators. A normal reserved elevator is NEVER a surcharge — only genuinely
 *  difficult elevator access is, and only after review. */
export const ELEVATOR = {
  normal: c({ kind: 'included', per: 'location', label: 'Normal reserved elevator access', note: 'Having an elevator is never a surcharge on its own.' }),
  difficult: c({
    kind: 'range', amount: 40, amountMax: 75, per: 'location', requiresReview: true,
    label: 'Difficult elevator access',
    note: 'Applies only after review, for a slow elevator, a long hallway to the elevator, a freight-elevator restriction, or a restricted move-in window.',
  }),
}

/** Additional stops. One loading + one unloading address are included; every
 *  further pickup, delivery, storage unit or stop is an additional location. */
export const ADDITIONAL_LOCATION = {
  includedLoading: 1,
  includedUnloading: 1,
  countsAsLocation: ['additional pickup', 'additional delivery', 'storage unit', 'any other stop'],
  tiers: [
    c({ kind: 'fixed', amount: 75, per: 'location', label: 'Additional location within 10 miles' }),
    c({ kind: 'fixed', amount: 125, per: 'location', label: 'Additional location 10–25 miles away' }),
    c({ kind: 'manual_quote', per: 'location', requiresReview: true, label: 'More than 25 miles' }),
  ] as Charge[],
}

/** Heavy items — by WEIGHT, per item. Deliberately cheaper than the old
 *  $30-$60 catch-all at the low end and honest (review/decline) at the top.
 *  There is NO oversized-furniture fee: normal large household furniture that
 *  was disclosed is included. See NO_OVERSIZED_FURNITURE_FEE below. */
export const HEAVY_ITEM = {
  tiers: [
    c({ kind: 'fixed', amount: 50, per: 'item', label: '150–249 pounds' }),
    c({ kind: 'fixed', amount: 100, per: 'item', label: '250–399 pounds' }),
    c({ kind: 'pending_review', per: 'item', requiresReview: true, label: '400 pounds or more', note: 'Manual review — we may decline if we cannot move it safely.' }),
    c({ kind: 'manual_quote', per: 'item', requiresReview: true, label: 'Upright piano or substantial safe', note: 'Custom quote and manual approval. We do not publish one automatic price for every piano or safe.' }),
  ] as Charge[],
  /** Everything the owner must check before approving a piano, safe, or any
   *  item at/above 400 lb. Surfaced in the admin review checklist. */
  reviewChecklist: [
    'Estimated weight',
    'Item dimensions',
    'Number of stairs',
    'Carry distance',
    'Doorway and hallway width',
    'Required equipment',
    'Number of workers required',
    'Pickup access',
    'Unloading access',
  ],
}

/**
 * EXPLICIT NEGATIVE RULE. Normal household furniture handling is INCLUDED when
 * the item was disclosed and fits the approved package. A sectional, armoire,
 * large mirror, table or entertainment center gets NO automatic surcharge.
 * Another charge applies only when one of `escalatesVia` is genuinely true.
 *
 * Do not add an oversizedFurnitureFee. A test asserts no such key exists.
 */
export const NO_OVERSIZED_FURNITURE_FEE = {
  exists: false as const,
  includedExamples: ['sectional', 'armoire', 'large mirror', 'dining table', 'entertainment center'],
  escalatesVia: [
    'meets the heavy-item weight tiers',
    'requires additional workers',
    'requires substantial disassembly',
    'creates unusually difficult access',
    'was not disclosed during booking',
    'materially changes the approved workload',
  ],
}

/** Additional rooms: NOT a small generic add-on. Re-package or re-quote. */
export const ADDITIONAL_ROOMS = {
  policy: 'reprice' as const,
  note: 'When the disclosed move contains more rooms than the selected package, we move you to the correct package or send an updated custom quote — there is no per-room add-on fee.',
  note_es: 'Cuando la mudanza informada tiene más cuartos que el paquete elegido, lo cambiamos al paquete correcto o le enviamos una cotización actualizada — no hay un cargo por cuarto.',
}

/** Weekends carry NO automatic surcharge. Only major holidays, after review. */
export const WEEKEND_HOLIDAY = {
  saturday: c({ kind: 'included', per: 'job', label: 'Saturday' }),
  sunday: c({ kind: 'included', per: 'job', label: 'Sunday' }),
  majorHoliday: c({ kind: 'range', amount: 100, amountMax: 150, per: 'job', requiresReview: true, label: 'Major holiday', note: 'Applies only after review and approval.' }),
}

/**
 * Travel zones, measured as DRIVE TIME beyond the primary service zone.
 *
 * ZONE ORIGIN (the boundary the code measures from), stated explicitly so the
 * calculation is auditable: the primary service zone is Essex County, NJ.
 * Travel time is measured from the primary-zone boundary to the job's first
 * address. Inside the primary zone there is no travel charge.
 */
export const TRAVEL = {
  primaryZone: 'Essex County, NJ',
  originNote: 'Travel time is measured from the edge of our primary service zone (Essex County, NJ) to your first address. Inside the primary zone there is no travel charge.',
  tiers: [
    c({ kind: 'included', per: 'job', label: 'Inside the primary service zone' }),
    c({ kind: 'fixed', amount: 50, per: 'job', label: '21–40 minutes outside the primary zone' }),
    c({ kind: 'fixed', amount: 100, per: 'job', label: '41–60 minutes outside the primary zone' }),
    c({ kind: 'fixed', amount: 150, per: 'job', label: '61–90 minutes outside the primary zone' }),
    c({ kind: 'manual_quote', per: 'job', requiresReview: true, label: 'More than 90 minutes outside the primary zone' }),
  ] as Charge[],
  /** Charged at most ONCE per job. Never stacks with TRUCK_PICKUP_RETURN for
   *  the same normal local pickup — see DUPLICATE_CHARGE_RULES. */
  chargeOncePerJob: true,
}

/** New York work — never auto-priced. */
export const NEW_YORK = {
  nearby: c({ kind: 'starting', amount: 150, per: 'job', requiresReview: true, label: 'Nearby New York work' }),
  nycManhattan: c({ kind: 'range', amount: 250, amountMax: 350, per: 'job', requiresReview: true, label: 'NYC or Manhattan access', note: 'Starting range. Tolls, parking, building restrictions, route requirements, and difficult access may be added after review.' }),
  requiresManualApproval: true,
  note: 'New York work is never priced automatically. We review access, parking, building rules, and route requirements before approving.',
}

/** Parking, tolls, and delays. */
export const PARKING_TOLLS_DELAYS = {
  parkingAndTolls: c({ kind: 'actual_cost', per: 'job', label: 'Parking and tolls', note: 'You pay the actual documented parking and toll charges when they apply.' }),
  difficultBuildingAccess: c({ kind: 'fixed', amount: 50, per: 'location', requiresReview: true, label: 'Difficult building access', note: 'Applies after review. More severe access conditions may require a custom quote.' }),
  severeAccess: c({ kind: 'manual_quote', per: 'location', requiresReview: true, label: 'Severe access conditions' }),
}

/** Waiting time — one rule, used by the truck add-on and by move-day delays. */
export const WAITING_TIME = {
  includedMinutes: 30,
  increment: c({ kind: 'fixed', amount: 50, per: 'half_hour', label: 'Waiting time after the first 30 minutes' }),
  /** The crew must explain and get approval BEFORE the meter keeps running. */
  requiresApprovalBeforeAccruing: true,
  note: 'The first 30 minutes of unavoidable waiting are included. After that, waiting is $50 for each additional 30 minutes. We explain the charge and get your approval before it continues.',
  note_es: 'Los primeros 30 minutos de espera inevitable están incluidos. Después, la espera cuesta $50 por cada 30 minutos adicionales. Le explicamos el cargo y obtenemos su aprobación antes de que continúe.',
}

/** Disassembly / reassembly. ONE bed frame included; everything else priced. */
export const ASSEMBLY = {
  includedBedFrames: 1,
  includedNote: 'One standard bed-frame disassembly is included when reasonably required.',
  includedNote_es: 'Se incluye un desarmado de base de cama estándar cuando sea razonablemente necesario.',
  simpleDisassembly: c({ kind: 'fixed', amount: 25, per: 'item', label: 'Additional simple disassembly' }),
  complexDisassembly: c({ kind: 'range', amount: 50, amountMax: 100, per: 'item', requiresReview: true, label: 'Complex disassembly' }),
  complexReassembly: c({ kind: 'range', amount: 50, amountMax: 100, per: 'item', requiresReview: true, label: 'Complex reassembly' }),
}

/**
 * Equipment the crew ALWAYS brings — never separately billed. This list is the
 * contradiction guard for MATERIALS below: anything included here cannot also
 * be sold as an optional material.
 */
export const INCLUDED_EQUIPMENT: { en: string; es: string }[] = [
  { en: 'Reusable moving blankets', es: 'Cobijas de mudanza reutilizables' },
  { en: 'Flat dolly', es: 'Carretilla plana' },
  { en: 'Stair-capable dolly', es: 'Carretilla para escaleras' },
  { en: 'Shoulder dolly', es: 'Correas de hombro' },
  { en: 'Straps', es: 'Correas' },
  { en: 'Bubble wrap or basic protective wrap when reasonably needed', es: 'Plástico de burbujas o envoltura protectora básica cuando sea necesario' },
  { en: 'Mattress protection when available and appropriate', es: 'Protección de colchón cuando esté disponible y sea apropiada' },
]

/**
 * Optional CONSUMABLE material packages — beyond the included supplies above.
 *
 * OWNER RULE 2026-07-21: MATTRESS PROTECTION IS INCLUDED. There is deliberately
 * NO mattress-bag SKU, checkbox, price or line item anywhere in this system —
 * selling a bag we already promise to bring is the contradiction this audit
 * removed. `NO_MATTRESS_BAG_SKU` below is the explicit negative rule and a test
 * asserts no `mattress`-keyed charge can be reintroduced here.
 */
export const MATERIALS = {
  packages: [
    c({ kind: 'fixed', amount: 39, per: 'job', label: 'Studio material package' }),
    c({ kind: 'fixed', amount: 69, per: 'job', label: 'One- or two-bedroom material package' }),
    c({ kind: 'starting', amount: 99, per: 'job', requiresReview: true, label: 'Three-bedroom or larger material package' }),
  ] as Charge[],
}

/** Explicit negative rule — mattress protection is included, never sold. */
export const NO_MATTRESS_BAG_SKU = {
  exists: false as const,
  reason: 'Mattress protection is part of INCLUDED_EQUIPMENT. Charging for a bag would contradict the package promise.',
}

/**
 * Explicit negative rule — there is NO building-age surcharge.
 *
 * REMOVED 2026-07-21 (owner decision). The quote path used to add $40 whenever
 * `buildingYear === 'old'`. That fee appeared on no price list, no FAQ and no
 * Terms page, so it was charged without ever being disclosed, and it duplicated
 * `PARKING_TOLLS_DELAYS.difficultBuildingAccess`. A genuinely difficult building
 * still bills through that reviewed $50 charge.
 */
export const NO_BUILDING_AGE_FEE = {
  exists: false as const,
  removedOn: '2026-07-21',
  billVia: 'PARKING_TOLLS_DELAYS.difficultBuildingAccess ($50, after review)',
}

/** Work beyond the approved scope — by crew size, per additional 30 minutes. */
export const SCOPE_OVERAGE = {
  requiresApprovalBeforeWork: true,
  byCrewSize: {
    2: c({ kind: 'fixed', amount: 75, per: 'half_hour', label: 'Two-person crew — additional 30 minutes' }),
    3: c({ kind: 'fixed', amount: 105, per: 'half_hour', label: 'Three-person crew — additional 30 minutes' }),
    4: c({ kind: 'fixed', amount: 140, per: 'half_hour', label: 'Four-person crew — additional 30 minutes' }),
  } as Record<number, Charge>,
  note: 'If you add inventory, or the approved work takes materially longer because the details submitted were incomplete, we pause, explain the change, and get your approval before continuing.',
  note_es: 'Si agrega inventario, o el trabajo aprobado toma mucho más tiempo porque los detalles enviados estaban incompletos, hacemos una pausa, le explicamos el cambio y obtenemos su aprobación antes de continuar.',
}

// ════════════════════════════════════════════════════════════════════════
//  GUARDS
// ════════════════════════════════════════════════════════════════════════

/**
 * Pairs that must never both be applied for the SAME underlying cost.
 * `check` describes the condition under which both ARE legitimate.
 */
export const DUPLICATE_CHARGE_RULES: { a: string; b: string; rule: string }[] = [
  { a: 'truckPickupReturnFee', b: 'travel', rule: 'The $49 truck add-on already covers normal local pickup. A travel charge may be added only when the rental location is OUTSIDE the primary service area or creates substantial extra travel the add-on does not cover.' },
  { a: 'stairs', b: 'difficultBuildingAccess', rule: 'Stairs already price vertical carry. Difficult-access applies only for a distinct condition (loading-dock rules, restricted window), not for the same flights.' },
  { a: 'longCarry', b: 'difficultBuildingAccess', rule: 'Long carry already prices walking distance. Do not also bill difficult-access for that same distance.' },
  { a: 'additionalLocation', b: 'travel', rule: 'The additional-location fee covers reaching that stop within its mileage band. Travel-zone pricing applies to the job as a whole, once.' },
  { a: 'materials', b: 'includedEquipment', rule: 'Never sell a material the crew already brings (see INCLUDED_EQUIPMENT) — notably mattress protection.' },
  { a: 'bookingAuthorizationAmount', b: 'truckPickupReturnFee', rule: 'Two different $49 charges. Both may appear on one booking and must render as separate, differently-labelled line items — never merged, never deduplicated by amount.' },
  { a: 'heavyItem', b: 'scopeOverage', rule: 'Do not bill a heavy-item fee AND additional labor for the same normal handling work already covered by that fee.' },
]

/** Conditions that BLOCK automatic final approval. Every one needs an owner. */
export const MANUAL_REVIEW_TRIGGERS = [
  'package_3br_or_larger',
  'new_york_address',
  'heavy_item_400lb_or_more',
  'piano_or_safe',
  'four_or_more_stair_flights',
  'carry_over_400_feet',
  'additional_location_over_25_miles',
  'travel_over_90_minutes',
  'truck_pickup_and_driving',
  'major_holiday',
  'difficult_elevator_or_building_access',
] as const
export type ManualReviewTrigger = (typeof MANUAL_REVIEW_TRIGGERS)[number]

/**
 * Coupon policy. Public discounts are capped at 10%; nothing stacks.
 *
 * DOOR-HANGER CAMPAIGN REMOVED 2026-07-21 (owner decision). The 30% approval
 * path exceeded this cap and disagreed with the admin route, which wrote 10%
 * for the same click. The rule, its admin button and its Discord action are
 * gone. The Prisma `DiscountType` enum values are deliberately RETAINED so
 * historical bookings still read correctly — see the migration note in the
 * audit. Nothing may reintroduce a discount above `maxPublicPercent`.
 */
export const DISCOUNT_POLICY = {
  maxPublicPercent: 10,
  allowStacking: false,
  /** Never discountable — pass-through, third-party, or near-cost charges.
   *  `truck_addon` is here by owner rule: it is crew time, not margin. */
  excludedFromDiscount: ['tolls', 'parking', 'materials', 'waiting', 'third_party_costs', 'truck_addon'] as const,
  truckAddonDiscountable: false,
  requireExpiration: true,
  recordSourceAndCode: true,
  /** Campaigns removed by owner decision — must never be reintroduced above the cap. */
  retiredCampaigns: ['DOOR_HANGER'] as const,
}

/** A discount application. Amounts in DOLLARS. */
export type DiscountableTotals = {
  /** Base labor + discountable add-ons. */
  discountableSubtotal: number
  /** Truck add-on, materials, waiting, tolls, parking — never discounted. */
  nonDiscountableSubtotal: number
}

/**
 * THE discount calculation. Applies `percent` to the discountable subtotal ONLY,
 * so the $49 truck add-on (and every other excluded charge) can never be
 * reduced by a coupon. Caps at `maxPublicPercent` — an over-cap coupon is
 * clamped, never honoured silently.
 */
export function applyDiscount(
  totals: DiscountableTotals,
  percent: number
): { percentApplied: number; discountAmount: number; total: number; clamped: boolean } {
  const raw = Number.isFinite(percent) ? Math.max(0, percent) : 0
  const percentApplied = Math.min(raw, DISCOUNT_POLICY.maxPublicPercent)
  const clamped = raw > DISCOUNT_POLICY.maxPublicPercent
  const discountAmount = Math.round(totals.discountableSubtotal * percentApplied) / 100
  const total = Math.round((totals.discountableSubtotal - discountAmount + totals.nonDiscountableSubtotal) * 100) / 100
  return { percentApplied, discountAmount, total, clamped }
}

// ════════════════════════════════════════════════════════════════════════
//  RESOLVERS — form input → Charge.
//  THE only place a raw number (flights, feet, pounds, miles, minutes) is
//  turned into money. estimate.ts and the browser mirror both call these, so
//  a tier boundary can never be interpreted two different ways.
// ════════════════════════════════════════════════════════════════════════

/** Flights of stairs at ONE address → its charge. First flight is included. */
export function stairChargeForFlights(flights: number): Charge {
  const n = Math.max(0, Math.floor(flights || 0))
  if (n <= 1) return STAIRS.tiers[0]
  if (n === 2) return STAIRS.tiers[1]
  if (n === 3) return STAIRS.tiers[2]
  return STAIRS.tiers[3]
}

/** Door-to-truck carry distance in FEET at one location → its charge. */
export function longCarryChargeForFeet(feet: number): Charge {
  const f = Math.max(0, Math.floor(feet || 0))
  if (f < 100) return LONG_CARRY.tiers[0]
  if (f <= 250) return LONG_CARRY.tiers[1]
  if (f <= 400) return LONG_CARRY.tiers[2]
  return LONG_CARRY.tiers[3]
}

/**
 * Heavy item weight in POUNDS → its charge. Under 150 lb is normal household
 * furniture and is INCLUDED — a sectional or armoire gets nothing here.
 */
export function heavyItemChargeForWeight(pounds: number): Charge {
  const lb = Math.max(0, Math.floor(pounds || 0))
  if (lb < 150) return c({ kind: 'included', per: 'item', label: 'Normal household furniture' })
  if (lb <= 249) return HEAVY_ITEM.tiers[0]
  if (lb <= 399) return HEAVY_ITEM.tiers[1]
  return HEAVY_ITEM.tiers[2]
}

/** Distance in MILES to an extra stop → its charge. */
export function additionalLocationChargeForMiles(miles: number): Charge {
  const m = Math.max(0, miles || 0)
  if (m <= 10) return ADDITIONAL_LOCATION.tiers[0]
  if (m <= 25) return ADDITIONAL_LOCATION.tiers[1]
  return ADDITIONAL_LOCATION.tiers[2]
}

/** Drive-time MINUTES beyond the primary service zone → travel charge. */
export function travelChargeForMinutes(minutes: number | null | undefined): Charge {
  if (minutes == null) return TRAVEL.tiers[0]
  const m = Math.max(0, minutes)
  if (m <= 20) return TRAVEL.tiers[0]
  if (m <= 40) return TRAVEL.tiers[1]
  if (m <= 60) return TRAVEL.tiers[2]
  if (m <= 90) return TRAVEL.tiers[3]
  return TRAVEL.tiers[4]
}

/** Crew size → per-30-minute overage rate. Falls back to the 2-person rate. */
export function scopeOverageForCrew(crew: number): Charge {
  return SCOPE_OVERAGE.byCrewSize[crew] ?? SCOPE_OVERAGE.byCrewSize[2]
}

// ════════════════════════════════════════════════════════════════════════
//  CANONICAL CUSTOMER-FACING COPY
//  These strings are the approved replacements for the removed absolute
//  promises. Every surface must use THESE — not a local paraphrase.
// ════════════════════════════════════════════════════════════════════════
export const COPY = {
  /** Shown when a route genuinely could not be measured. It promises a REVIEW,
   *  never a price — quoting $0 for an unmeasurable trip is the failure this
   *  wording exists to avoid. */
  /** Advisory wording for the live form: the figure is real but re-measured
   *  server-side at submission, so it can move if an address changes. */
  route_may_change: {
    en: 'Estimated from the addresses entered. We re-check the route when you submit, so this can change if an address or stop changes.',
    es: 'Estimado a partir de las direcciones ingresadas. Verificamos la ruta nuevamente al enviar, por lo que puede cambiar si cambia una dirección o parada.',
  },
  route_failed: {
    en: 'We could not measure the driving route for these addresses automatically. Your transportation charge will be confirmed during review, before anything is approved.',
    es: 'No pudimos medir automáticamente la ruta de conducción para estas direcciones. Su cargo de transporte se confirmará durante la revisión, antes de aprobar cualquier cosa.',
  },
  /** Replaces "no hidden fees" / "guaranteed flat rate regardless of changes". */
  scope_promise: {
    en: 'Your approved flat rate covers the inventory, locations, services, and access conditions submitted during booking. Any potential additional charges will be explained and approved before extra work is performed.',
    es: 'Su tarifa fija aprobada cubre el inventario, las ubicaciones, los servicios y las condiciones de acceso enviados durante la reserva. Cualquier cargo adicional posible se explicará y aprobará antes de realizar trabajo extra.',
  },
  /** Replaces "no hidden fees" as a standalone claim. */
  no_surprise: {
    en: 'No surprise charges. Any price change must be explained and approved before additional work is performed.',
    es: 'Sin cargos sorpresa. Cualquier cambio de precio debe explicarse y aprobarse antes de realizar trabajo adicional.',
  },
  /** THE underquoting disclaimer. Required beneath the pricing packages,
   *  before booking submission, in quote summaries, and in confirmations. */
  underquoting_disclaimer: {
    en: 'Your flat rate is based on the inventory, number of rooms, locations, access conditions, stairs, carry distance, heavy items, required labor, and other move details disclosed during booking.\n\nIf the job changes materially—including additional items, rooms, stops, stairs, long carries, waiting time, access restrictions, or labor not included in the approved scope—we will pause, explain the change, and obtain your approval for an updated price before performing the additional work. No price adjustment will be applied without your approval.',
    es: 'Su tarifa fija se basa en el inventario, el número de cuartos, las ubicaciones, las condiciones de acceso, las escaleras, la distancia de acarreo, los artículos pesados, la mano de obra requerida y otros detalles de la mudanza informados durante la reserva.\n\nSi el trabajo cambia materialmente —incluyendo artículos, cuartos, paradas, escaleras, acarreos largos, tiempo de espera, restricciones de acceso o mano de obra adicionales no incluidos en el alcance aprobado— haremos una pausa, explicaremos el cambio y obtendremos su aprobación para un precio actualizado antes de realizar el trabajo adicional. No se aplicará ningún ajuste de precio sin su aprobación.',
  },
  /** Required checkbox before submission. Store the acceptance + timestamp. */
  accuracy_checkbox: {
    en: 'I confirm that the inventory, locations, and access information I submitted are complete and accurate.',
    es: 'Confirmo que el inventario, las ubicaciones y la información de acceso que envié están completos y son correctos.',
  },
  /** Must accompany every "Starting at" package. */
  starting_at_context: {
    en: 'Starting prices are a floor, not a final quote. Three-bedroom and larger moves are confirmed only after we review your inventory and access details.',
    es: 'Los precios iniciales son un mínimo, no una cotización final. Las mudanzas de tres recámaras o más se confirman solo después de revisar su inventario y detalles de acceso.',
  },
  /** Labor-only scope. No transportation claim. */
  labor_only: {
    en: 'Labor only — loading, unloading, lifting, furniture handling, placement, and approved disassembly or assembly. You reserve and pay for the rental truck; transportation is not included.',
    es: 'Solo mano de obra — carga, descarga, levantamiento, manejo y colocación de muebles, y desarmado o armado aprobado. Usted reserva y paga el camión de alquiler; el transporte no está incluido.',
  },
} as const

// ════════════════════════════════════════════════════════════════════════
//  BANNED PHRASES — the contradiction check runs against this list.
//  Any customer-facing string matching one of these must be replaced with the
//  COPY entries above. `checkBannedPhrases` powers the automated guard test.
// ════════════════════════════════════════════════════════════════════════
export const BANNED_PHRASES: RegExp[] = [
  /no stair fees?/i,
  /no long[- ]carry fees?/i,
  /no travel[- ]time fees?/i,
  /no weekend surcharges?/i,
  /all your stuff/i,
  /everything included/i,
  /\ball[- ]day (moving|job)\b/i,
  /free (assembly|disassembly)/i,
  /guaranteed flat rate/i,
  /no hidden fees?/i,
  /unlimited (labor|wrapping|furniture|boxes)/i,
  /any amount of furniture/i,
  /full house guaranteed/i,
  /no additional fees?\b/i,
]

/** Returns the banned phrases present in `text`. Empty = clean. */
export function checkBannedPhrases(text: string): string[] {
  return BANNED_PHRASES.filter((re) => re.test(text)).map((re) => re.source)
}

// ══════════════════════════════════════════════════════════════════════════
//  THE TWO-PRODUCT PRICE BOOK  (reconstructed 2026-08-15)
//
//  RECOVERY NOTE — read before editing.
//  These exports were generated into WMIWCI-SITE/public/js/pricing-config.js
//  on 2026-08-05 from a version of THIS file that no longer exists in any
//  branch or stash. The browser mirror was the only surviving copy. Every
//  literal below was recovered from it verbatim; the TYPES, the invariants
//  and the two behavioural corrections marked OWNER RULE are authored here.
//
//  This section is LOAD-BEARING FOR THE SITE, not documentation: the live
//  booking form builds its labor-service grid from PRICING.LABOR_SERVICE_KEYS
//  (booking-form.html:3217) and its rate copy from LABOR_ONLY.
// ══════════════════════════════════════════════════════════════════════════

export type ServiceTypeKey = 'full_service' | 'labor_only'
/** 20ft is deliberately ABSENT — retired 2026-08-02. An unsupported size must
 *  be REJECTED, never silently charged as if it were something else. */
export type TruckSizeKey = '10ft' | '15ft' | '26ft'
export type LaborServiceKey =
  | 'loading_only' | 'unloading_only' | 'loading_and_unloading'
  | 'in_home_furniture' | 'storage_unit_help' | 'moving_container_help'
type Bilingual = { en: string; es: string }

/**
 * THE STRUCTURAL OPPOSITION between the two products. These four booleans are
 * the cross-contamination guard: a labor-only job that ever reads
 * chargesMileage or includesTruck as true is billing for a truck we never
 * brought, and a full-service job reading hourly:true is not the flat rate we
 * published.
 */
export const SERVICE_TYPES = {
  "full_service": {
    "key": "full_service",
    "label": "Full-Service Moving",
    "label_es": "Mudanza de servicio completo",
    "description": "We provide the professional moving crew, moving truck, equipment, loading, transportation, and unloading.",
    "description_es": "Nosotros proporcionamos el equipo profesional de mudanza, el camión, el equipo, la carga, el transporte y la descarga.",
    "pricingMethod": "Flat-rate package plus transportation mileage and any approved adjustments.",
    "pricingMethod_es": "Paquete de tarifa fija más el millaje de transporte y cualquier ajuste aprobado.",
    "includesTruck": true,
    "chargesMileage": true,
    "includesTransportation": true,
    "hourly": false
  },
  "labor_only": {
    "key": "labor_only",
    "label": "Labor-Only Moving Help",
    "label_es": "Ayuda de mudanza solo con mano de obra",
    "description": "You provide the truck or container. We provide two professional workers for loading, unloading, or both.",
    "description_es": "Usted proporciona el camión o contenedor. Nosotros proporcionamos dos trabajadores profesionales para carga, descarga o ambas.",
    "pricingMethod": "$150 per hour for two workers, based on actual billable time.",
    "pricingMethod_es": "$150 por hora por dos trabajadores, según el tiempo real facturable.",
    "includesTruck": false,
    "chargesMileage": false,
    "includesTransportation": false,
    "hourly": true
  }
} as const

export const TRUCK_SIZES = {
  "10ft": {
    "key": "10ft",
    "label": "10-foot truck",
    "label_es": "Camión de 10 pies",
    "feet": 10
  },
  "15ft": {
    "key": "15ft",
    "label": "15-foot truck",
    "label_es": "Camión de 15 pies",
    "feet": 15
  },
  "26ft": {
    "key": "26ft",
    "label": "26-foot truck",
    "label_es": "Camión de 26 pies",
    "feet": 26
  }
} as const

/**
 * Labor-only: two workers on one clock, $150 per hour.
 *
 * OWNER RULE 2026-08-15 — `minimumHours` was `null` in the recovered mirror.
 * The published minimum is TWO HOURS, and an estimate below it is REFUSED at
 * intake rather than silently billed up: see `laborOnlyQuoteCents` (refuses)
 * versus `laborOnlyBillingCents` (applies the minimum CHARGE to actual worked
 * time, which is what a minimum means once a crew has turned up).
 *
 * `billingIncrementMinutes` stays null on purpose. No rounding policy beyond
 * the published minimum was invented, because inventing one silently raises
 * every price.
 */
export const LABOR_ONLY = {
  "id": "labor_only_two_workers",
  "label": "Labor-Only Moving Help",
  "label_es": "Ayuda de mudanza solo con mano de obra",
  "hourlyRate": 150,
  "hourlyRateCents": 15000,
  "includedWorkers": 2,
  "truckIncluded": false,
  "transportationIncluded": false,
  "rateLabel": "Two-worker labor rate: $150 per hour",
  "rateLabel_es": "Tarifa de mano de obra por dos trabajadores: $150 por hora",
  "minimumHours": 2,
  "billingIncrementMinutes": null,
  "timing": {
    "startsWhen": "Billable time begins when both workers arrive at the first scheduled service address and are ready to begin.",
    "startsWhen_es": "El tiempo facturable comienza cuando ambos trabajadores llegan a la primera dirección de servicio programada y están listos para comenzar.",
    "endsWhen": "Billable time ends when the approved labor work is completed.",
    "endsWhen_es": "El tiempo facturable termina cuando se completa el trabajo aprobado.",
    "betweenCustomerAddressesIsBillable": true,
    "betweenAddressesNote": "When loading and unloading are requested at different addresses, time traveling between your pickup and drop-off locations counts as billable labor time because the crew remains assigned to your job.",
    "betweenAddressesNote_es": "Cuando se solicita carga y descarga en direcciones diferentes, el tiempo de viaje entre sus lugares de recogida y entrega cuenta como tiempo facturable porque el equipo permanece asignado a su trabajo.",
    "baseToFirstAddressIsBillable": false,
    "returnToBaseIsBillable": false,
    "baseTravelNote": "Travel from our base to your first address, and our return afterward, are not part of your hourly labor calculation.",
    "baseTravelNote_es": "El viaje desde nuestra base hasta su primera dirección, y nuestro regreso posterior, no forman parte de su cálculo de mano de obra por hora.",
    "customerCausedWaitingIsBillable": true,
    "crewCausedPausesAreBillable": false,
    "pauseNote": "Waiting time caused by the customer during the active job may count as billable time when documented. Pauses caused by our crew are not billed.",
    "pauseNote_es": "El tiempo de espera causado por el cliente durante el trabajo activo puede contar como tiempo facturable cuando está documentado. Las pausas causadas por nuestro equipo no se cobran."
  },
  "minimumMinutes": 120
} as const

export const LABOR_SERVICES = {
  "loading_only": {
    "key": "loading_only",
    "label": "Loading only",
    "label_es": "Solo carga",
    "twoAddresses": false
  },
  "unloading_only": {
    "key": "unloading_only",
    "label": "Unloading only",
    "label_es": "Solo descarga",
    "twoAddresses": false
  },
  "loading_and_unloading": {
    "key": "loading_and_unloading",
    "label": "Loading and unloading",
    "label_es": "Carga y descarga",
    "twoAddresses": true
  },
  "in_home_furniture": {
    "key": "in_home_furniture",
    "label": "In-home furniture moving",
    "label_es": "Movimiento de muebles en casa",
    "twoAddresses": false
  },
  "storage_unit_help": {
    "key": "storage_unit_help",
    "label": "Storage-unit help",
    "label_es": "Ayuda con unidad de almacenamiento",
    "twoAddresses": false
  },
  "moving_container_help": {
    "key": "moving_container_help",
    "label": "Moving-container help",
    "label_es": "Ayuda con contenedor de mudanza",
    "twoAddresses": false
  }
} as const

/** Display order for the form grid. */
export const LABOR_SERVICE_KEYS = [
  "loading_only",
  "unloading_only",
  "loading_and_unloading",
  "in_home_furniture",
  "storage_unit_help",
  "moving_container_help"
] as readonly LaborServiceKey[]

/**
 * The 2026-08-14 product catalogue shipped three labor keys, one spelled
 * `load_and_unload`, and `Booking.laborService` is a free-text column that may
 * already hold it. Reads normalise through this map; nothing is renamed in the
 * database, because renaming stored values to match new code is how history
 * stops matching the invoice it produced.
 */
export const LEGACY_LABOR_SERVICE_ALIASES: Readonly<Record<string, LaborServiceKey>> = {
  load_and_unload: 'loading_and_unloading',
}

export const LABOR_ONLY_INCLUDES: readonly Bilingual[] = [
  {
    "en": "Two professional workers",
    "es": "Dos trabajadores profesionales"
  },
  {
    "en": "Loading, unloading, or both",
    "es": "Carga, descarga o ambas"
  },
  {
    "en": "Furniture carrying and placement",
    "es": "Acarreo y colocación de muebles"
  },
  {
    "en": "Moving blankets, dollies, and standard labor equipment when appropriate",
    "es": "Cobijas de mudanza, carretillas y equipo de trabajo estándar cuando sea apropiado"
  },
  {
    "en": "Basic disassembly and reassembly included in the approved scope",
    "es": "Desarmado y rearmado básico incluido en el alcance aprobado"
  }
]
export const LABOR_ONLY_EXCLUDES: readonly Bilingual[] = [
  {
    "en": "Moving truck",
    "es": "Camión de mudanza"
  },
  {
    "en": "Truck rental",
    "es": "Alquiler de camión"
  },
  {
    "en": "Transportation of your belongings",
    "es": "Transporte de sus pertenencias"
  },
  {
    "en": "Fuel",
    "es": "Combustible"
  },
  {
    "en": "Mileage charge",
    "es": "Cargo por millaje"
  },
  {
    "en": "Truck pickup or return",
    "es": "Recogida o devolución del camión"
  },
  {
    "en": "Driving your rental truck unless separately approved",
    "es": "Conducir su camión de alquiler a menos que se apruebe por separado"
  }
]
export const LABOR_ONLY_EXAMPLES = [
  {
    "hours": 2,
    "total": 300
  },
  {
    "hours": 3,
    "total": 450
  },
  {
    "hours": 4.5,
    "total": 675
  }
] as const

/**
 * FULL-SERVICE TRANSPORTATION — $3 per ROUTED mile, fuel included.
 * `appliesTo` is load-bearing: labor-only must never reach this charge.
 */
export const TRANSPORTATION_MILEAGE = {
  "id": "transportation_mileage",
  "ratePerMile": 3,
  "ratePerMileCents": 300,
  "fuelIncluded": true,
  "appliesTo": "full_service",
  "label": "Transportation mileage",
  "label_es": "Millaje de transporte",
  "rounding": "up_to_whole_mile",
  "note": "Transportation is charged at $3 per routed mile from the first pickup address to the final drop-off address. Fuel is included in the mileage charge.",
  "note_es": "El transporte se cobra a $3 por milla de ruta desde la primera dirección de recogida hasta la dirección final de entrega. El combustible está incluido en el cargo por millaje.",
  "routeRules": [
    "Begin at the first customer pickup address.",
    "End at the final customer drop-off address.",
    "Include all customer-requested stops in route order.",
    "Use driving mileage, never straight-line distance.",
    "Round the complete route up to the nearest whole mile.",
    "Recalculate when any address or stop changes.",
    "Require manual review when an address cannot be matched reliably.",
    "Never calculate from county or ZIP-code center points.",
    "Tolls and paid parking are shown separately when they apply.",
    "Additional trucks and second trips require manual review."
  ]
} as const

/**
 * RETIRED — the old distance-band / drive-time travel fee.
 *
 * `exists: false` is what stops a NEW booking receiving it. Historical
 * bookings keep the fee they approved, READ FROM THE STORED ROW and never
 * recalculated. Charging this alongside TRANSPORTATION_MILEAGE would bill one
 * journey twice, which is why `assertNoDoubleTravelCharge` exists.
 */
export const LEGACY_TRAVEL = {
  "exists": false,
  "retiredOn": "2026-07-31",
  "replacedBy": "TRANSPORTATION_MILEAGE ($3 per routed mile, fuel included)",
  "retiredBands": [
    "Within 25 driving miles of West Orange — included",
    "26–40 driving miles — $25",
    "41–60 driving miles — $50",
    "Drive-time ladder: 21–40 min $50 / 41–60 min $100 / 61–90 min $150"
  ],
  "historicalNote": "Bookings approved before 2026-07-31 keep the travel fee they approved. It is read from the stored booking, never recalculated."
} as const

export const SERVICE_AREA = {
  "base": "West Orange, NJ",
  "publicNote": "Serving West Orange and surrounding New Jersey communities. Full-service transportation is calculated from the first pickup address to the final drop-off address. Longer-distance and out-of-state moves are reviewed individually.",
  "publicNote_es": "Prestamos servicio en West Orange y las comunidades cercanas de Nueva Jersey. El transporte de servicio completo se calcula desde la primera dirección de recogida hasta la dirección final de entrega. Las mudanzas de larga distancia y fuera del estado se revisan individualmente.",
  "countyTooltip": "Availability subject to route review",
  "countyTooltip_es": "Disponibilidad sujeta a revisión de ruta",
  "chargesTravelFee": false
} as const

export const ANALYTICS_IDS = {
  "serviceType": {
    "full_service": "full_service",
    "labor_only": "labor_only"
  },
  "package": {
    "1br": "one_bedroom",
    "2br": "two_bedrooms",
    "3br": "three_bedrooms",
    "4br": "four_bedrooms",
    "5br": "five_bedrooms",
    "little-studio": "legacy_small_studio",
    "half-studio": "legacy_standard_studio",
    "full-studio": "legacy_large_studio",
    "not-sure": "need_a_quote"
  },
  "laborService": {
    "loading_only": "loading_only",
    "unloading_only": "unloading_only",
    "loading_and_unloading": "loading_and_unloading",
    "in_home_furniture": "in_home_furniture",
    "storage_unit_help": "storage_unit_help",
    "moving_container_help": "moving_container_help"
  },
  "events": [
    "service_type_selected",
    "full_service_package_selected",
    "labor_only_service_selected",
    "labor_hours_estimated",
    "mileage_calculation_succeeded",
    "mileage_calculation_failed",
    "truck_size_question_answered",
    "quote_form_started",
    "booking_step_completed",
    "quote_form_completed",
    "phone_click",
    "text_click"
  ],
  "forbiddenFields": [
    "name",
    "fullName",
    "firstName",
    "lastName",
    "phone",
    "email",
    "address",
    "addressFrom",
    "addressTo",
    "street",
    "zip",
    "inventory",
    "itemsDescription",
    "jobDetails",
    "notes",
    "filename",
    "photoName",
    "smsBody",
    "messageContent"
  ]
} as const

/**
 * Packages with a published price that a NEW booking may select (5).
 * Deliberately distinct from `product-catalog.ACTIVE_PACKAGE_KEYS`, which is
 * the INTAKE-VALID set and also admits `not-sure` (a quote request, which has
 * no price). Two questions, two names.
 */
export const PRICED_PACKAGE_KEYS = [
  "1br",
  "2br",
  "3br",
  "4br",
  "5br"
] as readonly string[]

/** Withdrawn studio tiers — readable forever, sellable never. */
export const LEGACY_PACKAGE_KEYS = [
  "little-studio",
  "half-studio",
  "full-studio"
] as readonly string[]

// ── HELPERS ───────────────────────────────────────────────────────────────
//  Authored, not recovered. The mirror's JavaScript versions are the reference
//  for BEHAVIOUR, but two of them encoded pre-owner-rule semantics and are
//  deliberately different here. Each difference is marked OWNER RULE.

export const isServiceTypeKey = (v: unknown): v is ServiceTypeKey =>
  v === 'full_service' || v === 'labor_only'

export const isTruckSizeKey = (v: unknown): v is TruckSizeKey =>
  v === '10ft' || v === '15ft' || v === '26ft'

/** A stored labor-service value, normalised through the legacy alias map.
 *  Returns null for anything unrecognised — never a guess. */
export function normalizeLaborService(v?: string | null): LaborServiceKey | null {
  const s = (v ?? '').trim()
  if (!s) return null
  if (Object.prototype.hasOwnProperty.call(LABOR_SERVICES, s)) return s as LaborServiceKey
  return LEGACY_LABOR_SERVICE_ALIASES[s] ?? null
}

export const isLaborService = (v: unknown): v is LaborServiceKey =>
  typeof v === 'string' && normalizeLaborService(v) !== null

/** True when this labor service inherently spans two addresses, so the crew's
 *  time between them is billable (see LABOR_ONLY.timing). */
export const laborServiceUsesTwoAddresses = (v?: string | null): boolean => {
  const k = normalizeLaborService(v)
  return k ? LABOR_SERVICES[k].twoAddresses : false
}

/** A package a NEW full-service booking may select. */
export const isSelectablePackage = (key?: string | null): boolean =>
  !!key && PRICED_PACKAGE_KEYS.includes(key)

/** The truck included in a package's flat price. Null when it has none (a
 *  quote request), which is NOT the same as "the smallest one". */
export function includedTruckForPackage(key?: string | null): TruckSizeKey | null {
  const pkg = key ? (PACKAGES as Record<string, { includedTruck?: string | null }>)[key] : null
  const t = pkg?.includedTruck
  return isTruckSizeKey(t) ? t : null
}

export type TruckUpgrade = {
  available: boolean
  from: TruckSizeKey | null
  to: TruckSizeKey | null
  /** DOLLARS. Null when there is no upgrade to price. */
  amount: number | null
  amountCents: number | null
  /** The largest truck we run is already included — a bigger job needs a plan,
   *  not a surcharge. */
  requiresCustomQuote: boolean
  /** Never auto-applied: an owner confirms the reviewed inventory needs it. */
  requiresReview: boolean
}

/**
 * The ONE larger-truck upgrade a package may take, at most once.
 *
 * 1BR 10ft to 15ft (+$100); 2BR 15ft to 26ft (+$150). 3BR and up already
 * include the 26ft, so they cannot upgrade — they need a custom plan.
 *
 * Note the hasOwnProperty + ?? rather than ||: the 10ft upgrade amount is a
 * legitimate ZERO, and || would read it as missing and report a real size as
 * unsupported. That falsy-zero trap is why this is spelled out.
 */
export function truckUpgradeForPackage(key?: string | null): TruckUpgrade {
  const none: TruckUpgrade = {
    available: false, from: null, to: null, amount: null, amountCents: null,
    requiresCustomQuote: false, requiresReview: false,
  }
  const included = includedTruckForPackage(key)
  if (!included) return none

  const pkg = (PACKAGES as Record<string, { upgradeTruck?: string | null }>)[key as string]
  const to = pkg?.upgradeTruck
  if (!isTruckSizeKey(to)) {
    return { ...none, from: included, requiresCustomQuote: true }
  }

  const table = TRUCK_SIZE_UPGRADE.amountByTruck as Record<string, number>
  if (!Object.prototype.hasOwnProperty.call(table, to)) {
    return { ...none, from: included, requiresCustomQuote: true }
  }
  const amount = table[to] ?? 0
  return {
    available: true,
    from: included,
    to,
    amount,
    amountCents: Math.round(amount * 100),
    requiresCustomQuote: false,
    requiresReview: true,
  }
}

// ── LABOR-ONLY MONEY ──────────────────────────────────────────────────────
//
// OWNER RULE 2026-08-15. The recovered mirror had ONE function that CLAMPED a
// short request up to the minimum and quoted it. That is exactly what must not
// happen: someone asking for one hour would be quoted two without being told.
// It is split in two, because the minimum means different things before and
// after the crew turns up.

export type LaborQuote =
  | {
      ok: true
      requestedMinutes: number
      billableMinutes: number
      workers: number
      hourlyRateCents: number
      subtotalCents: number
    }
  | {
      ok: false
      code: 'labor_below_minimum' | 'labor_hours_missing'
      requestedMinutes: number
      minimumMinutes: number
    }

/**
 * INTAKE. What we may quote before any work happens.
 * Below the published minimum this REFUSES — it never silently bills the
 * minimum, and it never quotes the short amount either.
 */
export function laborOnlyQuoteCents(requestedMinutes: number | null | undefined): LaborQuote {
  const min = LABOR_ONLY.minimumMinutes
  if (requestedMinutes == null || !Number.isFinite(requestedMinutes) || requestedMinutes <= 0) {
    return { ok: false, code: 'labor_hours_missing', requestedMinutes: 0, minimumMinutes: min }
  }
  const requested = Math.round(requestedMinutes)
  if (requested < min) {
    return { ok: false, code: 'labor_below_minimum', requestedMinutes: requested, minimumMinutes: min }
  }
  return {
    ok: true,
    requestedMinutes: requested,
    billableMinutes: requested,
    workers: LABOR_ONLY.includedWorkers,
    hourlyRateCents: LABOR_ONLY.hourlyRateCents,
    // Cents first, divide last: (180 x 15000) / 60 = 45000 exactly.
    subtotalCents: Math.round((requested * LABOR_ONLY.hourlyRateCents) / 60),
  }
}

export type LaborBilling = {
  actualMinutes: number
  billableMinutes: number
  minimumApplied: boolean
  workers: number
  hourlyRateCents: number
  subtotalCents: number
}

/**
 * POST-JOB CLOSEOUT. What we may charge for work already done.
 * Here the minimum DOES apply: the crew arrived, and a two-hour minimum that
 * evaporates when a job runs short is not a minimum. Actual minutes are kept
 * beside it so an owner can always see the difference.
 */
export function laborOnlyBillingCents(actualMinutes: number | null | undefined): LaborBilling {
  const actual = Number.isFinite(actualMinutes as number)
    ? Math.max(0, Math.round(actualMinutes as number))
    : 0
  const billable = Math.max(actual, LABOR_ONLY.minimumMinutes)
  return {
    actualMinutes: actual,
    billableMinutes: billable,
    minimumApplied: billable > actual,
    workers: LABOR_ONLY.includedWorkers,
    hourlyRateCents: LABOR_ONLY.hourlyRateCents,
    subtotalCents: Math.round((billable * LABOR_ONLY.hourlyRateCents) / 60),
  }
}

/**
 * The BROWSER adapter the mirror ships, called with HOURS by booking-form.html.
 *
 * Below the minimum it returns a ZERO subtotal plus belowMinimum:true — it must
 * not quote $150 (the short amount) and must not quote $300 (the clamped
 * amount). The form shows the minimum message and blocks submit; the server
 * refuses independently, because a form is a courtesy and not a control.
 */
export function laborOnlyEstimate(hours: number): {
  hours: number
  workers: number
  hourlyRate: number
  subtotal: number
  subtotalCents: number
  belowMinimum: boolean
  minimumHours: number
} {
  const raw = Number.isFinite(hours) ? Math.max(0, hours) : 0
  const below = raw > 0 && raw < LABOR_ONLY.minimumHours
  const q = below ? null : laborOnlyQuoteCents(Math.round(raw * 60))
  const cents = q && q.ok ? q.subtotalCents : 0
  return {
    hours: raw,
    workers: LABOR_ONLY.includedWorkers,
    hourlyRate: LABOR_ONLY.hourlyRate,
    subtotal: cents / 100,
    subtotalCents: cents,
    belowMinimum: below,
    minimumHours: LABOR_ONLY.minimumHours,
  }
}

// ── FULL-SERVICE TRANSPORTATION ───────────────────────────────────────────

export type MileageCharge = Charge & {
  /** The WHOLE route, rounded up. Null when it could not be measured. */
  billableMiles: number | null
  amountCents?: number
}

/**
 * $3 per routed mile, fuel included, rounded UP over the WHOLE route.
 *
 * An unmeasurable route is pending_review with NO amount — so nothing can sum
 * it as $0 and quietly ship a free trip. That absence is load-bearing.
 */
export function mileageChargeForMiles(miles: number | null | undefined): MileageCharge {
  if (miles == null || !Number.isFinite(miles) || miles < 0) {
    return {
      kind: 'pending_review',
      per: 'job',
      requiresReview: true,
      label: TRANSPORTATION_MILEAGE.label,
      note: TRANSPORTATION_MILEAGE.note,
      billableMiles: null,
    }
  }
  // Round the COMPLETE route up — even a tenth of a mile is a billable mile.
  const billableMiles = Math.ceil(miles)
  const amountCents = billableMiles * TRANSPORTATION_MILEAGE.ratePerMileCents
  return {
    kind: 'fixed',
    per: 'job',
    requiresReview: false,
    label: TRANSPORTATION_MILEAGE.label,
    note: TRANSPORTATION_MILEAGE.note,
    amount: amountCents / 100,
    amountCents,
    billableMiles,
  }
}

/** Transportation applies to full-service ONLY. */
export const chargesMileage = (serviceTypeKey?: string | null): boolean =>
  serviceTypeKey === TRANSPORTATION_MILEAGE.appliesTo

/**
 * THE DOUBLE-TRAVEL GUARD.
 *
 * One journey, one charge. A booking may carry a historical travel-band fee OR
 * a routed-mileage charge, never both — and a NEW booking may only carry
 * mileage, because LEGACY_TRAVEL.exists is false. Returns the problems; empty
 * means the booking is coherent.
 */
export function assertNoDoubleTravelCharge(b: {
  serviceTypeKey?: string | null
  /** CENTS. The historical band fee, read from the stored row. */
  travelFeeCents?: number | null
  /** CENTS. The routed-mileage charge. */
  transportationCents?: number | null
  /** True for a booking created before the bands were retired. */
  isHistorical?: boolean
}): string[] {
  const issues: string[] = []
  const band = b.travelFeeCents ?? 0
  const mileage = b.transportationCents ?? 0

  if (band > 0 && mileage > 0) {
    issues.push(
      `This booking carries both a $${(band / 100).toFixed(2)} travel-band fee and a ` +
        `$${(mileage / 100).toFixed(2)} routed-mileage charge. One journey may only be billed once.`,
    )
  }
  if (band > 0 && !b.isHistorical && !LEGACY_TRAVEL.exists) {
    issues.push(
      `The travel-band fee was retired on ${LEGACY_TRAVEL.retiredOn} and must not apply to a new ` +
        `booking. Full-service transportation is $${TRANSPORTATION_MILEAGE.ratePerMile} per routed mile.`,
    )
  }
  if (mileage > 0 && !chargesMileage(b.serviceTypeKey)) {
    issues.push('Routed mileage is a full-service charge; this booking is not full-service.')
  }
  return issues
}
