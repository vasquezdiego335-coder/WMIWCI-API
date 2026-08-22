// ════════════════════════════════════════════════════════════════════════
//  partial-lead-pricing.ts — what a PARTIAL lead capture may record about
//  money, decided on the server and nowhere else.
//
//  WHY THIS IS ITS OWN MODULE. The rule used to live inline in
//  app/api/leads/partial/route.ts, where the only way to test it was to match
//  the route's source text with a regex — which proves the code was written,
//  not that it behaves. A Next.js route file also may not export arbitrary
//  helpers (the build rejects it), so the decision could not simply be
//  exported from there. It lives here instead: pure, offline, and directly
//  testable with real inputs and real outputs.
//
//  THE RULE. `estimateTotal` arrives from the BROWSER. It is never stored.
//  Lead.estimatedValue feeds the Discord card, the customer email, the admin
//  list, lifecycle automation and the booking hand-over, so a forged or stale
//  figure would propagate into all of them. The server prices the submission
//  from the canonical price book, or records no money at all.
//
//  ── SERVICE TYPE DECIDES WHICH BOOK APPLIES (fix 2026-08-22) ───────────
//  This module used to price from `moveSize` alone. A labor-only submission
//  that also carried `moveSize: '1br'` therefore banked the FULL-SERVICE $550
//  flat rate on a job that is billed hourly and includes no truck — an
//  inflated number on the owner's card, in the customer's inbox, and in every
//  lifecycle decision downstream.
//
//  A package price may now only be derived when the service is known to be
//  FULL SERVICE. Labor-only is priced from structured crew and time or not at
//  all, and an UNKNOWN service is never assumed to be full service: the
//  cheapest correct answer to "which product is this?" is silence.
// ════════════════════════════════════════════════════════════════════════
import { quoteEstimate } from './quote-estimate'
import { isRetiredPackage } from './product-catalog'
import {
  PRICE_BOOK_VERSION,
  laborOnlyQuoteCents,
  normalizeLaborService,
  isServiceTypeKey,
  type ServiceTypeKey,
} from './pricing-config'

export type PartialLeadPricingInput = {
  /** The package key the browser submitted, e.g. '2br'. Full-service only. */
  moveSize?: string | null
  /** The browser's displayed dollars. DIAGNOSTIC ONLY — never stored. */
  estimateTotal?: number | null
  /** An explicit product: 'full_service' | 'labor_only'. Trusted over inference. */
  serviceType?: string | null
  /** Free-text service the visitor picked, e.g. 'loading_and_unloading'. */
  serviceInterest?: string | null
  /** Structured labor-only inputs. Both required before an hourly figure exists. */
  laborWorkers?: number | null
  laborMinutes?: number | null
}

/** What the server concluded the product is. `unknown` is a real answer. */
export type ResolvedServiceType = ServiceTypeKey | 'unknown'

export type PartialLeadQuoteSnapshot = {
  baseCents: number
  truckCents: number
  totalCents: number
  includedTruck: string | null
  mileageStatus: 'pending' | 'calculated'
  priceBookVersion: string
}

export type PartialLeadPricing = {
  /** CENTS to store on the lead, or null to store nothing. Always server-computed. */
  estimateCents: number | null
  /** The CANONICAL package key to persist — lower-cased and trimmed by the
   *  price book, never the raw submitted string. `undefined` stores nothing. */
  moveSizeToStore: string | undefined
  /** What the server decided the product is. */
  serviceType: ResolvedServiceType
  /** True when the submitted key was withdrawn or unrecognised. */
  refusedSize: boolean
  /** Why it was refused — for the log, never for the customer. */
  refusedReason: 'retired_package' | 'unknown_package' | null
  /** The structured record, for a full-service subtotal only. */
  snapshot: PartialLeadQuoteSnapshot | null
  /** Server-calculated review requirement, with reasons. */
  requiresReview: boolean
  reviewReasons: string[]
  /** Set when the browser's figure disagreed with the server's. Log-only. */
  mismatch: { serverDollars: number; clientDollars: number; deltaDollars: number } | null
}

const NOTHING = (
  serviceType: ResolvedServiceType,
  moveSizeToStore: string | undefined = undefined,
  refused: PartialLeadPricing['refusedReason'] = null,
): PartialLeadPricing => ({
  estimateCents: null,
  moveSizeToStore,
  serviceType,
  refusedSize: refused !== null,
  refusedReason: refused,
  snapshot: null,
  requiresReview: false,
  reviewReasons: [],
  mismatch: null,
})

/**
 * Decide the product.
 *
 * An explicit `serviceType` wins. Otherwise a `serviceInterest` that names a
 * real labor service (loading_only, storage_unit_help, …) proves labor-only.
 * Everything else is UNKNOWN — deliberately not "probably full service".
 */
export function resolveServiceType(input: PartialLeadPricingInput): ResolvedServiceType {
  const explicit = (input.serviceType ?? '').trim().toLowerCase()
  if (isServiceTypeKey(explicit)) return explicit
  if (normalizeLaborService(input.serviceInterest)) return 'labor_only'
  const interest = (input.serviceInterest ?? '').trim().toLowerCase()
  if (interest === 'labor_only' || interest === 'labor-only') return 'labor_only'
  if (interest === 'full_service' || interest === 'full-service') return 'full_service'
  return 'unknown'
}

/**
 * Decide what a partial capture may record. Pure: no prisma, no env, no clock.
 */
export function pricePartialLead(input: PartialLeadPricingInput): PartialLeadPricing {
  const serviceType = resolveServiceType(input)
  const submitted = (input.moveSize ?? '').trim().toLowerCase()

  // ── LABOR-ONLY: hourly, or nothing ────────────────────────────────────
  //  A package key is meaningless here and must never become a price. The
  //  REFUSING quote helper is the right one at intake: below the published
  //  two-hour minimum we record nothing rather than silently billing it up.
  if (serviceType === 'labor_only') {
    const labor = laborOnlyQuoteCents(input.laborMinutes, input.laborWorkers)
    if (!labor.ok) return NOTHING('labor_only')
    return {
      ...NOTHING('labor_only'),
      estimateCents: labor.subtotalCents,
    }
  }

  // ── UNKNOWN PRODUCT: never assume the more expensive one ───────────────
  if (serviceType === 'unknown') {
    if (!submitted) return NOTHING('unknown')
    // The key can still be REFUSED (a withdrawn tier must not be recorded as a
    // service), but a recognised one is only canonicalised, never priced.
    const probe = quoteEstimate({ moveSize: submitted })
    if (!probe.ok && (probe.reason === 'retired_package' || probe.reason === 'unknown_package')) {
      return NOTHING('unknown', undefined, isRetiredPackage(submitted) ? 'retired_package' : 'unknown_package')
    }
    return NOTHING('unknown', probe.ok ? probe.packageKey : submitted)
  }

  // ── FULL SERVICE ───────────────────────────────────────────────────────
  if (!submitted) return NOTHING('full_service')

  const priced = quoteEstimate({ moveSize: submitted })

  if (!priced.ok) {
    const refused = priced.reason === 'retired_package' || priced.reason === 'unknown_package'
    // 'manual_plan' (5BR) and 'no_package' are REAL selections we simply do not
    // auto-price, so the size is still worth recording. A withdrawn or invented
    // key is not.
    if (refused) {
      return NOTHING(
        'full_service',
        undefined,
        isRetiredPackage(submitted) ? 'retired_package' : 'unknown_package',
      )
    }
    return {
      ...NOTHING('full_service', submitted),
      requiresReview: priced.reason === 'manual_plan',
      reviewReasons: priced.reason === 'manual_plan'
        ? ['5+ bedrooms needs a manual truck plan — it may take several trucks or trips.']
        : [],
    }
  }

  const client = input.estimateTotal
  const mismatch =
    typeof client === 'number' && Number.isFinite(client) && Math.round(client - priced.totalDollars) !== 0
      ? {
          serverDollars: priced.totalDollars,
          clientDollars: client,
          deltaDollars: Math.round(client - priced.totalDollars),
        }
      : null

  return {
    estimateCents: priced.totalCents,
    // CANONICAL, from the price book — so '2BR' and ' 2br ' both store '2br'.
    moveSizeToStore: priced.packageKey,
    serviceType: 'full_service',
    refusedSize: false,
    refusedReason: null,
    snapshot: {
      baseCents: Math.round(priced.baseDollars * 100),
      truckCents: Math.round(priced.truckUpgrade * 100),
      totalCents: priced.totalCents,
      includedTruck: priced.includedTruck,
      // A partial capture never has full addresses either, so the drive is
      // unmeasured here for the same reason it is on the quick quote.
      mileageStatus: 'pending',
      priceBookVersion: PRICE_BOOK_VERSION,
    },
    requiresReview: priced.requiresReview,
    reviewReasons: priced.reviewReasons,
    mismatch,
  }
}
