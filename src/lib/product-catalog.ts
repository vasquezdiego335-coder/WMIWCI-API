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

// ── PRODUCT AVAILABILITY (P0-01) ──────────────────────────────────────────

export type ProductKey = 'labor_only' | 'full_service'

/**
 * Is full-service intake open?
 *
 * FAIL-CLOSED BY CONSTRUCTION: this returns true only for the exact string
 * 'true'. An unset variable, a typo, a missing deployment config, or an
 * env-var that failed to load all yield FALSE — the legally safe answer.
 * Never invert this to an opt-out.
 *
 * Read at call time rather than module load so a test (and a deployment that
 * changes the variable) does not need a process restart to take effect.
 */
export function isFullServiceIntakeEnabled(): boolean {
  return process.env.FULL_SERVICE_INTAKE_ENABLED === 'true'
}

export type AvailabilityVerdict =
  | { available: true }
  | { available: false; code: 'product_unavailable'; message: string; message_es: string }

/**
 * May this product be sold RIGHT NOW?
 *
 * The message is deliberately honest and non-committal: it says we are not
 * currently offering it and offers the product we CAN legally sell. It does
 * not claim a licence application is in progress, give a date, or make any
 * statement about our regulatory status — none of which we can substantiate.
 */
export function checkProductAvailability(product: ProductKey): AvailabilityVerdict {
  if (product === 'labor_only') return { available: true }
  if (isFullServiceIntakeEnabled()) return { available: true }
  return {
    available: false,
    code: 'product_unavailable',
    message:
      'We are not currently taking full-service moving bookings where we supply the truck. ' +
      'We do offer labor-only moving help — two movers at $150/hour with a two-hour minimum — ' +
      'for a truck you rent. Please choose labor-only, or contact us and we will help.',
    message_es:
      'Por el momento no estamos aceptando reservas de mudanza de servicio completo con nuestro camión. ' +
      'Sí ofrecemos ayuda de mudanza solo con mano de obra: dos trabajadores a $150 por hora con un mínimo de dos horas, ' +
      'para un camión que usted rente. Elija la opción de solo mano de obra o contáctenos y le ayudamos.',
  }
}

/** Products a customer may currently choose. Drives the SITE mirror. */
export function activeProducts(): ProductKey[] {
  return isFullServiceIntakeEnabled() ? ['labor_only', 'full_service'] : ['labor_only']
}

// ── INTAKE VALIDATION ─────────────────────────────────────────────────────

export type IntakeRejection = {
  code: 'product_unavailable' | 'package_retired' | 'package_unknown' | 'labor_below_minimum' | 'labor_too_long' | 'contradictory_product'
  /** Which submitted field is at fault, for a field-mapped 422. */
  field: string
  message: string
}

export type IntakeCheckInput = {
  product: ProductKey
  /** Full-service only: the selected package key. */
  packageKey?: string | null
  /** Labor-only only: requested duration in MINUTES. */
  laborMinutes?: number | null
  laborService?: string | null
  /** Fields that only make sense for a company truck. */
  hasCompanyTruckFields?: boolean
}

/**
 * THE new-intake gate. Every rejection is a sentence a customer can act on;
 * none of them silently repair the request, because silently mapping a
 * retired $379 studio onto a live $550 package would charge someone $171 they
 * never agreed to.
 */
export function checkIntake(i: IntakeCheckInput): IntakeRejection[] {
  const out: IntakeRejection[] = []

  const availability = checkProductAvailability(i.product)
  if (!availability.available) {
    out.push({ code: 'product_unavailable', field: 'serviceTypeKey', message: availability.message })
    // No point validating the details of a product we cannot sell at all.
    return out
  }

  if (i.product === 'full_service') {
    if (!isKnownPackage(i.packageKey)) {
      out.push({ code: 'package_unknown', field: 'serviceType', message: 'Choose a move size from the list.' })
    } else if (isRetiredPackage(i.packageKey)) {
      out.push({
        code: 'package_retired',
        field: 'serviceType',
        message:
          `${PACKAGES[i.packageKey].label} is no longer offered at that rate. ` +
          'Please refresh the page and choose from the current sizes.',
      })
    }
    if (i.laborMinutes != null || i.laborService != null) {
      out.push({
        code: 'contradictory_product',
        field: 'laborHours',
        message: 'This booking mixes full-service and labor-only details. Please refresh the page and submit again.',
      })
    }
    return out
  }

  // ── labor-only ──
  const minutes = i.laborMinutes ?? 0
  if (minutes > 0 && minutes < LABOR_ONLY_MINIMUM_MINUTES) {
    out.push({
      code: 'labor_below_minimum',
      field: 'laborHours',
      message: `Labor-only moving help has a ${LABOR_ONLY_MINIMUM_MINUTES / 60}-hour minimum. Please choose ${LABOR_ONLY_MINIMUM_MINUTES / 60} hours or more.`,
    })
  }
  if (minutes > LABOR_ONLY_MAX_MINUTES) {
    out.push({
      code: 'labor_too_long',
      field: 'laborHours',
      message: `For jobs over ${LABOR_ONLY_MAX_MINUTES / 60} hours, please contact us so we can plan the crew properly.`,
    })
  }
  if (i.laborService != null && !isLaborService(i.laborService)) {
    out.push({ code: 'contradictory_product', field: 'laborService', message: 'Choose loading, unloading, or both.' })
  }
  // A labor-only job runs on the CUSTOMER's truck. Company-truck fields on it
  // are a contradiction, not a preference — see service-shape.ts.
  if (i.hasCompanyTruckFields) {
    out.push({
      code: 'contradictory_product',
      field: 'serviceTypeKey',
      message: 'Labor-only help does not include a truck from us. Please refresh the page and submit again.',
    })
  }
  if (i.packageKey && isKnownPackage(i.packageKey)) {
    // A move SIZE is fine on a labor-only job (it scopes the crew); a
    // full-service PACKAGE PRICE is not. Nothing to reject here — the price
    // comes from laborOnlyEstimateCents, never from the package.
  }
  return out
}
