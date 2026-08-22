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
//  WHAT THIS ENDPOINT CAN HONESTLY PRICE. It receives a package key and
//  nothing else — no truck, no stairs, no heavy items, no mileage. So the
//  figure it can vouch for is the PACKAGE SUBTOTAL. Anything richer is settled
//  later by /api/bookings, which has the full picture.
// ════════════════════════════════════════════════════════════════════════
import { quoteEstimate } from './quote-estimate'
import { isRetiredPackage } from './product-catalog'

export type PartialLeadPricingInput = {
  /** The package key the browser submitted, e.g. '2br'. */
  moveSize?: string | null
  /** The browser's displayed dollars. DIAGNOSTIC ONLY — never stored. */
  estimateTotal?: number | null
}

export type PartialLeadPricing = {
  /** CENTS to store on the lead, or null to store nothing. Always server-computed. */
  estimateCents: number | null
  /** The move size to persist. `undefined` when the submitted key was refused,
   *  so no NEW lead can carry a withdrawn package as its official service. */
  moveSizeToStore: string | undefined
  /** True when the submitted key was withdrawn or unrecognised. */
  refusedSize: boolean
  /** Why it was refused — for the log, never for the customer. */
  refusedReason: 'retired_package' | 'unknown_package' | null
  /** Set when the browser's figure disagreed with the server's. Log-only. */
  mismatch: { serverDollars: number; clientDollars: number; deltaDollars: number } | null
}

/**
 * Decide what a partial capture may record. Pure: no prisma, no env, no clock.
 */
export function pricePartialLead(input: PartialLeadPricingInput): PartialLeadPricing {
  const submitted = (input.moveSize ?? '').trim().toLowerCase()
  const raw = (input.moveSize ?? '').trim()

  // Nothing selected. A contact-only capture is the common case (the booking
  // form pings this route the moment an email is typed) and is not an error.
  if (!submitted) {
    return {
      estimateCents: null,
      moveSizeToStore: undefined,
      refusedSize: false,
      refusedReason: null,
      mismatch: null,
    }
  }

  const priced = quoteEstimate({ moveSize: submitted })

  if (!priced.ok) {
    const refused = priced.reason === 'retired_package' || priced.reason === 'unknown_package'
    return {
      estimateCents: null,
      // 'manual_plan' (5BR) and 'no_package' are REAL selections we simply do
      // not auto-price, so the size is still worth recording. A withdrawn or
      // invented key is not.
      moveSizeToStore: refused ? undefined : raw,
      refusedSize: refused,
      refusedReason: refused
        ? (isRetiredPackage(submitted) ? 'retired_package' : 'unknown_package')
        : null,
      mismatch: null,
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
    moveSizeToStore: raw,
    refusedSize: false,
    refusedReason: null,
    mismatch,
  }
}
