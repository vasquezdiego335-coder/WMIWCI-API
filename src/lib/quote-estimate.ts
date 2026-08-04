// ════════════════════════════════════════════════════════════════════════
//  quote-estimate.ts — THE server's answer to "what does this quote cost?"
//
//  WHY THIS EXISTS. The public quick-quote endpoint used to store whatever
//  number the browser sent it:
//
//      estimateTotal: z.number().nonnegative().max(1_000_000).optional()
//
//  so `curl -d '{"moveSize":"2br","estimateTotal":1}'` produced a lead, an
//  email and a Discord card all claiming a $1 move. The browser total is now
//  DIAGNOSTIC ONLY — it is compared and logged, never stored.
//
//  IT DOES NOT DUPLICATE PRICING. Every number comes from computeEstimate()
//  in ./estimate.ts, the same function the booking API and the admin use, which
//  reads ./pricing-config.ts — the same source scripts/gen-pricing-config.ts
//  generates the browser mirror from. A second formula here is exactly the
//  drift this module exists to prevent, so there is deliberately no arithmetic
//  below: only key validation, unit conversion and shaping.
//
//  UNKNOWN KEYS ARE REJECTED, NOT DEFAULTED. Silently falling back to a price
//  when the customer picked something we do not sell is how a wrong number
//  reaches a customer's inbox. `ok:false` is returned and the route answers 422.
//
//  PURE + OFFLINE: no prisma, no env, no network — so it is fully unit-tested.
// ════════════════════════════════════════════════════════════════════════
import { computeEstimate, MOVE_SIZES, SELECTABLE_MOVE_SIZES } from './estimate'

/** What the quick quote can tell us. Deliberately narrow: the quote page asks
 *  three questions, so anything richer belongs to the booking form's estimate. */
export type QuoteEstimateInput = {
  /** Package key from the quote page radio group: '1br'…'5br'. */
  moveSize?: string | null
}

export type QuoteEstimateResult =
  | {
      ok: true
      packageKey: string
      /** Human label for the email / Discord card, e.g. "2 Bedrooms". Never
       *  the internal key — a customer should not read "2br" in their inbox. */
      packageLabel: string
      /** DOLLARS, server-computed. */
      totalDollars: number
      /** CENTS — what Lead.estimatedValue stores. */
      totalCents: number
      /** True when the package price is a floor ("Starting at $X"), so no
       *  surface may present it as a settled flat rate. */
      isStarting: boolean
      /** The truck bundled into this package ('10ft' | '15ft' | …). */
      includedTruck: string | null
      /** Blocks automatic confirmation (floor price, review line, NY job). */
      requiresReview: boolean
    }
  | {
      ok: false
      /** `unknown_package`  — not a key we sell (or a retired one).
       *  `no_package`       — nothing selected; a lead is still worth saving,
       *                       it simply carries no estimate. */
      reason: 'unknown_package' | 'no_package'
      /** Present for a retired key so the caller can log something useful. */
      packageKey?: string
    }

/**
 * Price a quick-quote submission from TRUSTED inputs only.
 *
 * The quote page sells FULL-SERVICE packages exclusively (crew + truck), which
 * is why `serviceTypeKey` is pinned rather than inferred: letting it be
 * inferred would allow a crafted payload to route into the labor-only branch
 * and produce an hourly total for a package job.
 */
export function quoteEstimate(input: QuoteEstimateInput): QuoteEstimateResult {
  const key = (input.moveSize ?? '').trim().toLowerCase()
  if (!key) return { ok: false, reason: 'no_package' }

  // SELECTABLE, not MOVE_SIZES: a retired package still resolves in MOVE_SIZES
  // so historical rows render, but it must not be quotable on a new lead.
  const pkg = SELECTABLE_MOVE_SIZES[key]
  if (!pkg) {
    return {
      ok: false,
      reason: 'unknown_package',
      // Echo the key ONLY when it is a known-but-retired package; an arbitrary
      // attacker-supplied string is never reflected back.
      ...(MOVE_SIZES[key] ? { packageKey: key } : {}),
    }
  }

  // 'not-sure' is a real answer on the booking form ("I need a quote"), but it
  // is not a price. The quote page never offers it; reject it explicitly so a
  // hand-crafted payload cannot reach computeEstimate with it.
  if (key === 'not-sure') return { ok: false, reason: 'unknown_package', packageKey: key }

  const est = computeEstimate({ serviceTypeKey: 'full_service', serviceType: key })

  // Transportation is billed per routed mile and is NOT known at quote time —
  // the quote page says so in its own copy. estimatedTotal is therefore the
  // package price, which is exactly what the page displays and what a
  // "preliminary estimate" means here. Adding an unmeasured travel figure
  // would quote a drive we have not calculated.
  const totalDollars = est.base

  return {
    ok: true,
    packageKey: key,
    packageLabel: pkg.label,
    totalDollars,
    totalCents: Math.round(totalDollars * 100),
    isStarting: est.baseIsStarting,
    includedTruck: est.includedTruck,
    requiresReview: est.requiresReview,
  }
}

/**
 * Compare the browser's displayed total against the server's.
 *
 * Returns a SANITIZED record safe to log: two numbers and a boolean. It never
 * echoes the payload, and the caller must not return the delta to the browser
 * — a mismatch is either a stale cached price book (our problem to fix) or
 * someone probing the endpoint (whom we should not help calibrate).
 */
export function compareClientTotal(
  serverDollars: number,
  clientDollars?: number | null
): { matched: boolean; serverDollars: number; clientDollars: number | null; deltaDollars: number | null } {
  if (typeof clientDollars !== 'number' || !Number.isFinite(clientDollars)) {
    return { matched: true, serverDollars, clientDollars: null, deltaDollars: null }
  }
  // Whole dollars: the browser formats with toLocaleString and the price book
  // is integral, so a sub-dollar difference would only ever be float noise.
  const delta = Math.round(clientDollars - serverDollars)
  return { matched: delta === 0, serverDollars, clientDollars, deltaDollars: delta }
}
