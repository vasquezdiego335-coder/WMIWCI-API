// ════════════════════════════════════════════════════════════════════════
//  product-catalog.ts — WHAT WE ARE LEGALLY ALLOWED TO SELL, AND FOR HOW
//  MUCH. The server's answer, not the browser's.
//
//  Implements the binding rules from the 2026-08-14 repair audit:
//    P0-01  full-service intake fails CLOSED while unlicensed
//    P0-02  labor-only is $150/hour, two movers, TWO-HOUR MINIMUM
//    P0-04  retired studio rates are historical-only, never bookable again
//
//  WHY A SEPARATE MODULE. `pricing-config.ts` is the price BOOK — what things
//  cost. This is the product CATALOG — what may currently be sold, to whom,
//  and under which legal constraints. Those are different questions with
//  different owners, and conflating them is how a retired $379 studio stayed
//  bookable for months after it was withdrawn: the price still existed, so
//  the product still existed.
//
//  EVERY AMOUNT HERE IS INTEGER CENTS. No floats touch money in this file.
//
//  ⚠ THIS FILE ENCODES A LEGAL POSITION, NOT A PREFERENCE.
//  The company is NOT currently licensed as a New Jersey public mover.
//  Labor-only (the customer supplies and is responsible for the truck) does
//  not require that licence; full-service — where we transport the customer's
//  property in our own vehicle — does. Until the owner supplies proof of
//  licensing, full-service intake must be refused by the SERVER, because a
//  stale browser tab or a hand-built POST is exactly how an unlicensed
//  carrier booking would otherwise be taken.
// ════════════════════════════════════════════════════════════════════════

import { PACKAGES, type PackageKey } from './pricing-config'

// ── LABOR-ONLY PRICING — the single source, mirrored to the browser ───────
//
// The live booking form has been promising "$150 per hour for two
// professional movers" while the server priced the flat bedroom package.
// These constants end that: the server computes the authoritative amount and
// the browser mirror is GENERATED from here (scripts/gen-pricing-config.ts).
// Never hand-edit the mirror.

/** $150.00 per hour, covering BOTH movers together — not per person. */
export const LABOR_ONLY_RATE_CENTS = 15_000
/** Two hours. The established minimum charge; not a rounding rule. */
export const LABOR_ONLY_MINIMUM_MINUTES = 120
/** Both workers are included in the hourly rate. */
export const LABOR_ONLY_WORKERS = 2
/** Upper bound on a single-day booking. Beyond this an owner must plan it. */
export const LABOR_ONLY_MAX_MINUTES = 12 * 60

/** The labor services a customer may buy. */
export const LABOR_SERVICES = ['loading_only', 'unloading_only', 'load_and_unload'] as const
export type LaborService = (typeof LABOR_SERVICES)[number]

export const LABOR_SERVICE_LABELS: Record<LaborService, { en: string; es: string }> = {
  loading_only: { en: 'Loading only', es: 'Solo carga' },
  unloading_only: { en: 'Unloading only', es: 'Solo descarga' },
  load_and_unload: { en: 'Loading and unloading', es: 'Carga y descarga' },
}

export const isLaborService = (v: unknown): v is LaborService =>
  typeof v === 'string' && (LABOR_SERVICES as readonly string[]).includes(v)

export type LaborEstimate = {
  /** What the customer asked for, exactly as given. Never silently rounded. */
  requestedMinutes: number
  /** What we actually bill: the two-hour minimum, or the request if longer. */
  billableMinutes: number
  /** True when the minimum lifted the price above what was requested. */
  minimumApplied: boolean
  workers: number
  hourlyRateCents: number
  /** INTEGER CENTS. billableMinutes × rate ÷ 60. */
  subtotalCents: number
}

/**
 * THE authoritative labor-only price.
 *
 *     max(requestedMinutes, 120) × 15000 ÷ 60
 *
 * The requested minutes are preserved separately so the customer's own answer
 * is never overwritten by the minimum — an owner needs to see "they asked for
 * 1 hour, we are billing the 2-hour minimum", not a booking that claims the
 * customer requested two hours.
 *
 * No rounding policy beyond the minimum is applied. The audit is explicit
 * that inventing one (to the next 15/30 minutes, say) is not permitted
 * without the owner's approval, because it silently raises prices.
 */
export function laborOnlyEstimateCents(requestedMinutes: number): LaborEstimate {
  const requested = Number.isFinite(requestedMinutes) ? Math.max(0, Math.round(requestedMinutes)) : 0
  const billable = Math.max(requested, LABOR_ONLY_MINIMUM_MINUTES)
  return {
    requestedMinutes: requested,
    billableMinutes: billable,
    minimumApplied: requested < LABOR_ONLY_MINIMUM_MINUTES,
    workers: LABOR_ONLY_WORKERS,
    hourlyRateCents: LABOR_ONLY_RATE_CENTS,
    // Cents first, divide last: (120 × 15000) ÷ 60 = 30000 exactly. Doing the
    // division in hours first would introduce a float for every half-hour.
    subtotalCents: Math.round((billable * LABOR_ONLY_RATE_CENTS) / 60),
  }
}

/** Hours → minutes, for the form's half-hour selector. 2.5 → 150. */
export const hoursToMinutes = (hours: number): number =>
  Number.isFinite(hours) ? Math.round(hours * 60) : 0

// ── ACTIVE vs HISTORICAL PACKAGES (P0-04) ─────────────────────────────────
//
// A retired price must stay READABLE forever and BOOKABLE never. Those are
// two different questions and the price book only answered the first, so
// $379/$439/$549 studios remained selectable long after they were withdrawn.
//
// Deleting them would corrupt every historical booking that quotes them, so
// they stay in PACKAGES and are excluded here instead.

/** Withdrawn 2026-07-25. Readable on historical bookings; never sellable. */
export const RETIRED_PACKAGE_KEYS: ReadonlySet<string> = new Set([
  'little-studio', // $379
  'half-studio',   // $439
  'full-studio',   // $549
])

/** Packages a NEW booking may select. Order is the order customers see. */
export const ACTIVE_PACKAGE_KEYS: readonly PackageKey[] = (
  Object.keys(PACKAGES) as PackageKey[]
).filter((k) => !RETIRED_PACKAGE_KEYS.has(k))

/** True when this key may be used for NEW intake. */
export const isPackageActiveForNewIntake = (key?: string | null): key is PackageKey =>
  !!key && Object.prototype.hasOwnProperty.call(PACKAGES, key) && !RETIRED_PACKAGE_KEYS.has(key)

/** True when the key is a real package we can still RENDER (any vintage). */
export const isKnownPackage = (key?: string | null): key is PackageKey =>
  !!key && Object.prototype.hasOwnProperty.call(PACKAGES, key)

/** True for a package that was withdrawn — readable, not sellable. */
export const isRetiredPackage = (key?: string | null): boolean =>
  !!key && RETIRED_PACKAGE_KEYS.has(key)

// ── TRUCK PICKUP & RETURN — RETIRED COMPLETELY (owner decision 2026-08-14) ─
//
// We no longer collect and return a customer's rental truck, at $49, $50, or
// any price. This is a WITHDRAWN SERVICE, not a repriced one.
//
// THE RULE THAT MATTERS: a submission asking for it is REFUSED, never
// converted. Silently dropping the option and booking the job without it would
// send a crew to a customer who is expecting us to fetch their U-Haul; silently
// substituting something else would charge for a service nobody chose. Both are
// worse than an honest refusal that tells them to re-book.
//
// HISTORY IS PRESERVED. Bookings that genuinely bought this keep their stored
// label and amount forever — see `isRetiredTruckOption` used only for READ
// paths. Nothing back-fills, deletes or rewrites an old record.
export const RETIRED_TRUCK_OPTION_ALIASES: ReadonlySet<string> = new Set([
  'truck-pickup-return',
  'full-148', // pre-2026 alias, normalised into truck-pickup-return by the form
  'reserve-99', // ditto
  'truck_pickup_return',
  'truckPickupReturn',
])

export const RETIRED_TRUCK_OPTION_LABEL = 'Truck Pickup & Return (retired)'

/** True for any spelling of the withdrawn truck-fetching service. */
export const isRetiredTruckOption = (value?: string | null): boolean => {
  const v = (value ?? '').trim()
  return !!v && RETIRED_TRUCK_OPTION_ALIASES.has(v)
}

/** The message a customer sees. It does not offer a substitute, because there
 *  isn't one — and inventing one would be a sale they never agreed to. */
export const RETIRED_TRUCK_OPTION_MESSAGE =
  'We no longer offer the Truck Pickup & Return add-on, where we collect and return your rental truck. ' +
  'Please arrange to have your rental truck at the address yourself, then submit your booking again. ' +
  'Everything else about your move is unchanged.'

// ── PRODUCT AVAILABILITY (P0-01) ──────────────────────────────────────────

export type ProductKey = 'labor_only' | 'full_service'

/**
 * Bumped whenever any published amount in this catalogue changes. Stamped onto
 * every booking so a historical quote can always be read back against the
 * price book it was actually sold under, and never silently re-priced by a
 * later change.
 */
export const PRICING_VERSION = '2026-08-14'

/**
 * BOTH PRODUCTS ARE ACTIVE (owner decision 2026-08-14).
 *
 * An earlier revision of the repair audit asserted the company was unlicensed
 * and required full-service intake to fail closed behind
 * FULL_SERVICE_INTAKE_ENABLED. The owner has since confirmed that is wrong:
 * Move It Clear It sells two products and both are bookable. That gate — and
 * the 422 it produced — is removed.
 *
 * This is deliberately a plain constant rather than an environment flag. A
 * product being sellable is a business fact, not deployment configuration, and
 * the previous flag defaulted to "off" in every environment that had not been
 * told otherwise — which is exactly how a live product disappeared.
 */
export const ACTIVE_PRODUCTS: readonly ProductKey[] = ['full_service', 'labor_only']

export const isProductActive = (p: ProductKey): boolean => ACTIVE_PRODUCTS.includes(p)

// ── THE SERVICE CATALOGUE — one server-side source for the SITE ───────────
//
// The booking form, the services page and the generated browser pricing mirror
// must all originate here (GET /api/services). Hand-maintained copies of these
// numbers on the SITE are what let the form advertise $150/hour while the
// server priced a flat package.

export type ServicePackage = {
  key: PackageKey
  label: string
  label_es: string
  /** INTEGER CENTS. null for "Need a Quote", which has no published price. */
  priceCents: number | null
  requiresReview: boolean
}

export type ServiceCatalogEntry = {
  key: ProductKey
  label: string
  label_es: string
  description: string
  description_es: string
  pricingModel: 'flat_package' | 'hourly'
  /** Who supplies transportation. THE structural difference between them. */
  truckResponsibility: 'company' | 'customer'
  active: boolean
  pricingVersion: string
  /** flat_package only: the packages a NEW booking may select. */
  packages?: ServicePackage[]
  /** hourly only: the published rate and its minimum. */
  hourly?: {
    rateCents: number
    minimumMinutes: number
    workers: number
    maxMinutes: number
    services: { key: LaborService; label: string; label_es: string }[]
  }
}

/**
 * THE canonical service catalogue. Pure and dependency-free so the API route,
 * the mirror generator and the tests all read the identical structure.
 */
export function serviceCatalog(): ServiceCatalogEntry[] {
  return [
    {
      key: 'full_service',
      label: 'Full-Service Moving',
      label_es: 'Mudanza de Servicio Completo',
      description: 'Our crew and our truck. One flat price for your move size.',
      description_es: 'Nuestro equipo y nuestro camión. Un precio fijo según el tamaño de su mudanza.',
      pricingModel: 'flat_package',
      truckResponsibility: 'company',
      active: isProductActive('full_service'),
      pricingVersion: PRICING_VERSION,
      packages: ACTIVE_PACKAGE_KEYS.map((key) => ({
        key,
        label: PACKAGES[key].label,
        label_es: PACKAGES[key].label_es,
        // The price book is in DOLLARS; the wire contract is integer CENTS.
        priceCents: PACKAGES[key].price.amount != null ? Math.round(PACKAGES[key].price.amount! * 100) : null,
        requiresReview: PACKAGES[key].requiresReview,
      })),
    },
    {
      key: 'labor_only',
      label: 'Labor-Only Moving Help',
      label_es: 'Ayuda de Mudanza Solo con Mano de Obra',
      description: 'You provide the truck or container. Two movers at $150/hour, two-hour minimum.',
      description_es: 'Usted pone el camión o contenedor. Dos trabajadores a $150 por hora, mínimo dos horas.',
      pricingModel: 'hourly',
      truckResponsibility: 'customer',
      active: isProductActive('labor_only'),
      pricingVersion: PRICING_VERSION,
      hourly: {
        rateCents: LABOR_ONLY_RATE_CENTS,
        minimumMinutes: LABOR_ONLY_MINIMUM_MINUTES,
        workers: LABOR_ONLY_WORKERS,
        maxMinutes: LABOR_ONLY_MAX_MINUTES,
        services: LABOR_SERVICES.map((key) => ({
          key,
          label: LABOR_SERVICE_LABELS[key].en,
          label_es: LABOR_SERVICE_LABELS[key].es,
        })),
      },
    },
  ]
}

/** The two customer-facing one-liners every downstream surface must use, so
 *  admin, Discord, email, portal and receipt describe a job identically. */
export const SERVICE_DESCRIPTORS: Record<ProductKey, { en: string; es: string }> = {
  full_service: {
    en: 'Full-Service Moving — crew and truck included',
    es: 'Mudanza de Servicio Completo — equipo y camión incluidos',
  },
  labor_only: {
    en: 'Labor-Only Moving — customer provides transportation',
    es: 'Mudanza Solo con Mano de Obra — el cliente pone el transporte',
  },
}

export const describeService = (p: ProductKey, locale: 'en' | 'es' = 'en'): string =>
  SERVICE_DESCRIPTORS[p][locale]

// ── INTAKE VALIDATION ─────────────────────────────────────────────────────

export type IntakeRejection = {
  code:
    | 'service_type_missing'
    | 'package_retired'
    | 'package_unknown'
    | 'package_missing'
    | 'labor_below_minimum'
    | 'labor_too_long'
    | 'labor_hours_missing'
    | 'labor_service_missing'
    | 'contradictory_product'
    | 'service_retired'
  /** Which submitted field is at fault, for a field-mapped 422. */
  field: string
  message: string
}

export type IntakeCheckInput = {
  /**
   * REQUIRED. Never inferred from the package, the truck provider, the notes,
   * or a legacy field — inference is what produced bookings whose product
   * nobody could state with confidence.
   */
  product?: string | null
  /** Full-service only: the selected package key. */
  packageKey?: string | null
  /** Labor-only only: requested duration in MINUTES. */
  laborMinutes?: number | null
  laborService?: string | null
  /** Fields that only make sense for a company truck. */
  hasCompanyTruckFields?: boolean
  /** The raw `truckOption` as submitted, in any historical spelling. */
  truckOption?: string | null
}

export const isProductKey = (v: unknown): v is ProductKey =>
  v === 'full_service' || v === 'labor_only'

/**
 * THE new-intake gate. Every rejection is a sentence a customer can act on;
 * none of them silently repair the request, because silently mapping a
 * retired $379 studio onto a live $550 package would charge someone $171 they
 * never agreed to.
 */
export function checkIntake(i: IntakeCheckInput): IntakeRejection[] {
  const out: IntakeRejection[] = []

  // A withdrawn service is refused FIRST and outright. It is never dropped
  // silently (the crew would not turn up for the truck the customer is
  // expecting) and never substituted (that is a sale they did not agree to).
  //
  // ⚠ Truck Pickup & Return is NOT full-service. It was a separate add-on in
  // which we fetched a truck the CUSTOMER rented. Full-service includes our
  // own truck in the package price and is fully active.
  if (isRetiredTruckOption(i.truckOption)) {
    out.push({ code: 'service_retired', field: 'truckOption', message: RETIRED_TRUCK_OPTION_MESSAGE })
    return out
  }

  // ── THE DISCRIMINANT ────────────────────────────────────────────────────
  //    Required, never inferred. Inference from the package / truck provider /
  //    notes is how a booking ended up with a product nobody could state with
  //    confidence, and how a customer's own U-Haul job was dispatched as a
  //    company-truck move.
  if (!isProductKey(i.product)) {
    out.push({
      code: 'service_type_missing',
      field: 'serviceTypeKey',
      message: 'Choose a service: Full-Service Moving (our crew and truck) or Labor-Only Moving Help (you provide the truck).',
    })
    return out
  }

  if (i.product === 'full_service') {
    // Requires an ACTIVE package…
    if (!i.packageKey) {
      out.push({ code: 'package_missing', field: 'moveSizeKey', message: 'Choose your move size.' })
    } else if (!isKnownPackage(i.packageKey)) {
      out.push({ code: 'package_unknown', field: 'moveSizeKey', message: 'Choose a move size from the list.' })
    } else if (isRetiredPackage(i.packageKey)) {
      out.push({
        code: 'package_retired',
        field: 'moveSizeKey',
        message:
          `${PACKAGES[i.packageKey].label} is no longer offered at that rate. ` +
          'Please refresh the page and choose from the current sizes.',
      })
    }
    // …and rejects every labor-only field. A full-service price is the flat
    // package; hours on it would mean two pricing models on one booking.
    if (i.laborMinutes != null || i.laborService != null) {
      out.push({
        code: 'contradictory_product',
        field: 'laborHours',
        message: 'Full-service moving is priced by move size, not by the hour. Please refresh the page and submit again.',
      })
    }
    return out
  }

  // ── labor_only ──────────────────────────────────────────────────────────
  //    Requires a labor service and an estimate; rejects every full-service
  //    field. The truck is the customer's, so no package price and no
  //    company-truck charge can attach.
  if (i.laborMinutes == null) {
    out.push({
      code: 'labor_hours_missing',
      field: 'laborHours',
      message: `About how many hours do you need? There is a ${LABOR_ONLY_MINIMUM_MINUTES / 60}-hour minimum.`,
    })
  } else {
    if (i.laborMinutes < LABOR_ONLY_MINIMUM_MINUTES) {
      out.push({
        code: 'labor_below_minimum',
        field: 'laborHours',
        message: `Labor-only moving help has a ${LABOR_ONLY_MINIMUM_MINUTES / 60}-hour minimum. Please choose ${LABOR_ONLY_MINIMUM_MINUTES / 60} hours or more.`,
      })
    }
    if (i.laborMinutes > LABOR_ONLY_MAX_MINUTES) {
      out.push({
        code: 'labor_too_long',
        field: 'laborHours',
        message: `For jobs over ${LABOR_ONLY_MAX_MINUTES / 60} hours, please contact us so we can plan the crew properly.`,
      })
    }
  }
  if (i.laborService == null) {
    out.push({ code: 'labor_service_missing', field: 'laborService', message: 'Choose loading, unloading, or both.' })
  } else if (!isLaborService(i.laborService)) {
    out.push({ code: 'contradictory_product', field: 'laborService', message: 'Choose loading, unloading, or both.' })
  }
  // A full-service PACKAGE on a labor-only booking would attach a flat truck-
  // inclusive price to a job where the customer supplies the truck.
  if (i.packageKey) {
    out.push({
      code: 'contradictory_product',
      field: 'moveSizeKey',
      message: 'Labor-only help is priced by the hour, not by move size. Please refresh the page and submit again.',
    })
  }
  if (i.hasCompanyTruckFields) {
    out.push({
      code: 'contradictory_product',
      field: 'serviceTypeKey',
      message: 'Labor-only help does not include a truck from us. Please refresh the page and submit again.',
    })
  }
  return out
}
