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
}

export const PACKAGES: Record<PackageKey, MovePackage> = {
  'little-studio': { key: 'little-studio', label: 'Little Studio', label_es: 'Estudio Pequeño', rooms: 1, requiresReview: false, price: c({ kind: 'fixed', amount: 379, label: 'Little Studio' }) },
  'half-studio':   { key: 'half-studio',   label: 'Half Studio',   label_es: 'Medio Estudio',    rooms: 1, requiresReview: false, price: c({ kind: 'fixed', amount: 439, label: 'Half Studio' }) },
  'full-studio':   { key: 'full-studio',   label: 'Full Studio',   label_es: 'Estudio Completo', rooms: 1, requiresReview: false, price: c({ kind: 'fixed', amount: 549, label: 'Full Studio' }) },
  '1br':           { key: '1br',           label: '1 Bedroom',     label_es: '1 Recámara',       rooms: 2, requiresReview: false, price: c({ kind: 'fixed', amount: 649, label: '1 Bedroom' }) },
  '2br':           { key: '2br',           label: '2 Bedrooms',    label_es: '2 Recámaras',      rooms: 3, requiresReview: false, price: c({ kind: 'fixed', amount: 779, label: '2 Bedrooms' }) },

  // ── Review-gated floors. `kind: 'starting'` makes "Starting at" structural:
  //    formatCharge() cannot render these without the prefix. ──
  '3br': { key: '3br', label: '3 Bedrooms', label_es: '3 Recámaras', rooms: 4, requiresReview: true, price: c({ kind: 'starting', amount: 1049, requiresReview: true, label: '3 Bedrooms', note: 'Final price confirmed after we review your inventory and access details.' }) },
  '4br': { key: '4br', label: '4 Bedrooms', label_es: '4 Recámaras', rooms: 5, requiresReview: true, price: c({ kind: 'starting', amount: 1449, requiresReview: true, label: '4 Bedrooms', note: 'Final price confirmed after we review your inventory and access details.' }) },
  '5br': { key: '5br', label: '5 Bedrooms', label_es: '5 Recámaras', rooms: 6, requiresReview: true, price: c({ kind: 'starting', amount: 1799, requiresReview: true, label: '5 Bedrooms', note: 'Final price confirmed after we review your inventory and access details.' }) },

  'not-sure': { key: 'not-sure', label: 'Need a Quote', label_es: 'Necesito Cotización', rooms: null, requiresReview: true, price: c({ kind: 'manual_quote', requiresReview: true, label: 'Need a Quote' }) },
}

/**
 * What EVERY standard package includes. Deliberately inventory- and
 * access-bounded — no "all your stuff", no "unlimited", no "all day".
 */
export const PACKAGE_INCLUDES: { en: string; es: string }[] = [
  { en: 'Two professional labor workers', es: 'Dos trabajadores profesionales' },
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

/** Crew labor add-on to collect and return a truck the CUSTOMER reserved.
 *  Due on move day, never charged in Stripe, always manually approved. */
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
