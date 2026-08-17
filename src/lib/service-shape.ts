// ════════════════════════════════════════════════════════════════════════
//  service-shape.ts — WHAT WAS ACTUALLY SOLD, as three independent facts.
//
//  THE BUG THIS FILE EXISTS TO KILL (owner spec, booking WMIC-1019):
//  the booking form collapsed three separate questions into one answer.
//  "1 Bedroom" was simultaneously the LABOR SIZE, the PRICE TIER, and an
//  implicit claim that we were bringing a truck. So a customer who rented
//  their own U-Haul and booked "1 Bedroom" was recorded, priced, dispatched
//  and reported as a full-service move — and every truck-shaped cost
//  (fuel, mileage, rental, truck markup) became applicable to a job where we
//  never touched a truck.
//
//  They are three questions:
//
//      SERVICE TYPE   what we are selling      LABOR_ONLY | FULL_SERVICE
//      MOVE SIZE      how much there is        a package key (1br, 2br, …)
//      TRUCK PROVIDER whose truck moves it     CUSTOMER | COMPANY | UNKNOWN
//
//  A labor-only job still HAS a move size — that is what scopes the crew,
//  the hours and the price. What it does not have is a truck we own. Those
//  are orthogonal, and this module keeps them that way.
//
//  DERIVATION, NOT MIGRATION. Historical rows carry no service_type_key, so
//  the shape is inferred from what they DO carry (truck_provider, the
//  "Truck:" line in items_description, the truck add-on flag). A stored key
//  always wins; inference is only ever the fallback, and it reports its own
//  confidence so a caller can ask the owner rather than guess in silence.
//
//  Pure — no prisma, no network — so it is unit-tested offline and shared by
//  the API, the admin page, the Discord cards and the emails.
// ════════════════════════════════════════════════════════════════════════

import { PACKAGES, type PackageKey } from './pricing-config'

export type ServiceTypeKey = 'labor_only' | 'full_service'
export type TruckProvider = 'customer' | 'company' | 'unknown'

export const SERVICE_TYPE_LABELS: Record<ServiceTypeKey, string> = {
  labor_only: 'Labor Only',
  full_service: 'Full Service',
}

export const TRUCK_PROVIDER_LABELS: Record<TruckProvider, string> = {
  customer: 'Customer',
  company: 'Move It Clear It',
  unknown: 'Not confirmed',
}

/** The columns this module reads. Every one is optional — a legacy row has
 *  almost none of them and must still produce an honest answer. */
export type ServiceShapeInput = {
  /** Explicit product key, when the booking form sent one. Always wins. */
  serviceTypeKey?: string | null
  /** Explicit package key, when stored. Falls back to the items blob. */
  moveSizeKey?: string | null
  /** Free-text provider from the booking form ("customer", "U-Haul", "WMIWCI"). */
  truckProvider?: string | null
  /** Crew collects + returns a truck the CUSTOMER rented. Labor, not a truck. */
  truckAddonDueOnMoveDay?: boolean | null
  /** The legacy human blob — carries "Service:" and "Truck:" lines. */
  itemsDescription?: string | null
  /** DOLLARS. Used only to recover a package when nothing else names one. */
  baseRate?: number | null
}

export type ServiceShape = {
  serviceType: ServiceTypeKey
  serviceTypeLabel: string
  /** Package key when we know it, else null. NEVER implies a truck. */
  moveSizeKey: PackageKey | null
  /** "2 Bedrooms" — the human size, independent of the service type. */
  moveSizeLabel: string | null
  truckProvider: TruckProvider
  truckProviderLabel: string
  /** Free-text rental company when the customer named one ("U-Haul"). */
  truckProviderDetail: string | null
  /** True only when WE supply the truck. Gates every truck-shaped cost. */
  companyTruckIncluded: boolean
  /** True when the service type was stored rather than inferred. */
  explicit: boolean
  /** How the answer was reached — shown to the owner, never hidden. */
  reason: string
}

// ── Provider strings that mean the CUSTOMER is supplying transportation ────
//   Rental brands are included because the booking form's free-text field is
//   where customers type "U-Haul" rather than picking "customer".
const CUSTOMER_TRUCK = /\b(customer|self|own|mine|my\s+truck|u-?haul|penske|budget|ryder|home\s*depot|enterprise|rental|rented|renting)\b/i
const COMPANY_TRUCK = /\b(wmiwci|move\s*it\s*clear\s*it|company|yours?|your\s+truck|we\s+provide|our\s+truck|moveit)\b/i

/** The truck line in items_description. Accepts the current "Truck Provider:"
 *  wording and the legacy "Truck:" every historical row carries. */
function truckLineOf(description?: string | null): string | null {
  const m = (description ?? '').match(/^Truck(?:\s*Provider)?:\s*(.+)$/im)
  return m ? m[1].trim() : null
}

/** The size line — a human label like "1 Bedroom", not a key. "Move Size:" is
 *  the current wording; "Service:" is what every row before 2026-08-14 has. */
function serviceLineOf(description?: string | null): string | null {
  const m = (description ?? '').match(/^(?:Move\s*Size|Service):\s*(.+)$/im)
  return m ? m[1].trim() : null
}

/** An explicit "Service Type: Labor Only" line, when the blob carries one. */
function serviceTypeLineOf(description?: string | null): ServiceTypeKey | null {
  const m = (description ?? '').match(/^Service\s*Type:\s*(.+)$/im)
  if (!m) return null
  const v = m[1].trim().toLowerCase()
  if (/labor\s*only/.test(v)) return 'labor_only'
  if (/full\s*service/.test(v)) return 'full_service'
  return null
}

/** Recover a package key from a human label ("2 Bedrooms" → '2br'). */
export function packageKeyFromLabel(label?: string | null): PackageKey | null {
  const want = (label ?? '').trim().toLowerCase()
  if (!want) return null
  for (const p of Object.values(PACKAGES)) {
    if (p.label.toLowerCase() === want || p.label_es.toLowerCase() === want) return p.key
  }
  // Tolerate "1 bedroom" vs "1 Bedrooms" and the bare key itself.
  const compact = want.replace(/\s+/g, '')
  for (const p of Object.values(PACKAGES)) {
    if (p.key === want || p.key === compact) return p.key
    if (p.label.toLowerCase().replace(/s\b/g, '').replace(/\s+/g, '') === compact.replace(/s\b/g, '')) return p.key
  }
  return null
}

/** Recover a package from its exact flat price. Last resort only. */
function packageKeyFromPrice(baseRate?: number | null): PackageKey | null {
  if (typeof baseRate !== 'number' || baseRate <= 0) return null
  const hits = Object.values(PACKAGES).filter((p) => p.price.amount === baseRate)
  // Two packages at the same price would make this a guess, so refuse.
  return hits.length === 1 ? hits[0].key : null
}

function isPackageKey(k?: string | null): k is PackageKey {
  return !!k && Object.prototype.hasOwnProperty.call(PACKAGES, k)
}

/**
 * THE service-shape derivation. Deterministic, and it explains itself.
 *
 * Precedence for the service type:
 *   1. a stored service_type_key (the form asked, the customer answered)
 *   2. a customer-supplied truck, from truck_provider or the items blob
 *   3. the truck pickup & return add-on — that add-on is crew time spent on a
 *      truck the CUSTOMER rented, so it is labor-only with an add-on, never a
 *      company truck
 *   4. otherwise full-service, because every package ships with our truck
 */
export function resolveServiceShape(b: ServiceShapeInput): ServiceShape {
  const storedType = (b.serviceTypeKey ?? '').trim().toLowerCase() || (serviceTypeLineOf(b.itemsDescription) ?? '')
  const providerRaw = (b.truckProvider ?? '').trim()
  const truckLine = truckLineOf(b.itemsDescription)

  // ── Who is bringing the truck ──────────────────────────────────────────
  let truckProvider: TruckProvider = 'unknown'
  let providerEvidence = ''
  if (providerRaw) {
    if (COMPANY_TRUCK.test(providerRaw)) {
      truckProvider = 'company'
      providerEvidence = `truck provider "${providerRaw}"`
    } else if (CUSTOMER_TRUCK.test(providerRaw)) {
      truckProvider = 'customer'
      providerEvidence = `truck provider "${providerRaw}"`
    }
  }
  if (truckProvider === 'unknown' && truckLine) {
    if (/customer provides|own[- ]truck|customer[- ]provided/i.test(truckLine)) {
      truckProvider = 'customer'
      providerEvidence = 'the booking recorded a customer-provided truck'
    } else if (/pickup\s*&(amp;)?\s*return/i.test(truckLine)) {
      // We fetch and return a truck the CUSTOMER rented. Still their truck.
      truckProvider = 'customer'
      providerEvidence = 'truck pickup & return of the customer\'s rental'
    }
  }
  if (truckProvider === 'unknown' && b.truckAddonDueOnMoveDay) {
    truckProvider = 'customer'
    providerEvidence = 'the truck pickup & return add-on was selected'
  }

  // ── Which product ──────────────────────────────────────────────────────
  let serviceType: ServiceTypeKey
  let explicit = false
  let reason: string
  if (storedType === 'labor_only' || storedType === 'full_service') {
    serviceType = storedType
    explicit = true
    reason = `Service type recorded on the booking as ${SERVICE_TYPE_LABELS[serviceType]}.`
  } else if (truckProvider === 'customer') {
    serviceType = 'labor_only'
    reason = `Labor only — ${providerEvidence}. No company truck is part of this job.`
  } else if (truckProvider === 'company') {
    serviceType = 'full_service'
    reason = `Full service — ${providerEvidence}.`
  } else {
    serviceType = 'full_service'
    reason = 'Full service assumed — nothing on this booking says the customer supplies a truck.'
  }

  // An explicit labor-only key means the customer supplies transportation even
  // when nobody wrote down whose truck it is.
  if (serviceType === 'labor_only' && truckProvider === 'unknown') truckProvider = 'customer'
  // Guard the mirror image: a stored full_service key must never be reported
  // as running on the customer's truck.
  if (serviceType === 'full_service' && explicit) truckProvider = 'company'

  // ── How big the job is — orthogonal to both answers above ──────────────
  const moveSizeKey: PackageKey | null = isPackageKey(b.moveSizeKey)
    ? b.moveSizeKey
    : packageKeyFromLabel(b.moveSizeKey) ??
      packageKeyFromLabel(serviceLineOf(b.itemsDescription)) ??
      packageKeyFromPrice(b.baseRate)

  return {
    serviceType,
    serviceTypeLabel: SERVICE_TYPE_LABELS[serviceType],
    moveSizeKey,
    moveSizeLabel: moveSizeKey ? PACKAGES[moveSizeKey].label : null,
    truckProvider,
    truckProviderLabel: TRUCK_PROVIDER_LABELS[truckProvider],
    // Only surface free text that is not just the word "customer" again.
    truckProviderDetail: providerRaw && !/^customer$/i.test(providerRaw) ? providerRaw : null,
    companyTruckIncluded: serviceType === 'full_service' && truckProvider !== 'customer',
    explicit,
    reason,
  }
}

export const isLaborOnly = (b: ServiceShapeInput): boolean =>
  resolveServiceShape(b).serviceType === 'labor_only'

// ── The charge guard ──────────────────────────────────────────────────────
//
// On a labor-only job we bring people and equipment. We do not bring a truck,
// buy its fuel, drive its miles, rent it, or mark it up. Any such amount on
// the booking is a defect, not a price — so it is reported, loudly, rather
// than quietly billed.
//
// TRUCK PICKUP & RETURN IS DELIBERATELY ABSENT from this list. It is crew
// time spent collecting and returning a truck the CUSTOMER rented — a labor
// add-on that happens to involve a truck. Blocking it would refuse a service
// labor-only customers actually buy.

export type ChargeViolation = { field: string; label: string; cents: number }

export type LaborChargeInput = {
  /** CENTS. Truck operations fees (damage, extra day, drop charge). */
  additionalTruckFees?: number | null
  /** CENTS. A larger COMPANY truck — impossible without a company truck. */
  truckSizeUpgradeAmount?: number | null
  /** CENTS. Per-mile transportation of the customer's goods in OUR truck. */
  transportationCharge?: number | null
  /** CENTS. Fuel for a company truck. */
  fuelCharge?: number | null
}

const TRUCK_COST_FIELDS: { field: keyof LaborChargeInput; label: string }[] = [
  { field: 'additionalTruckFees', label: 'Additional truck fees' },
  { field: 'truckSizeUpgradeAmount', label: 'Larger-truck upgrade' },
  { field: 'transportationCharge', label: 'Mileage / transportation charge' },
  { field: 'fuelCharge', label: 'Fuel charge' },
]

/**
 * Every truck-shaped amount sitting on a labor-only booking. Empty means the
 * booking is clean. Callers surface these as owner warnings and MUST NOT bill
 * them — see approval-guards.ts, which refuses confirmation while any remain.
 */
export function laborOnlyChargeViolations(b: ServiceShapeInput & LaborChargeInput): ChargeViolation[] {
  if (!isLaborOnly(b)) return []
  const out: ChargeViolation[] = []
  for (const { field, label } of TRUCK_COST_FIELDS) {
    const cents = b[field] ?? 0
    if (cents > 0) out.push({ field, label, cents })
  }
  return out
}
