// ════════════════════════════════════════════════════════════════════════
//  quote-snapshot.ts — THE frozen record of what a quote actually said.
//
//  WHY IT IS ITS OWN MODULE. Three things were being kept in step by hand and
//  drifting apart every round:
//
//    • what the pricing layer produces,
//    • what gets written to the `leads.quote_*` columns,
//    • what the notifications read back out.
//
//  Each had its own inline shape, so review state reached the columns from one
//  path and not another, and the Discord fallback was only ever exercised with
//  a hand-built ideal object. There is now ONE type, ONE way to build it, ONE
//  way to write it and ONE way to read it — and the notification mapping is a
//  pure function that production and the tests both call.
//
//  ── MILEAGE IS A DISCRIMINATED UNION, NOT A FLAG ──────────────────────
//  The previous shape allowed `mileageStatus: 'calculated'` with null cents
//  and null miles: a total claiming to contain a drive, with nothing to show
//  for it. `calculated` now REQUIRES the money and the miles, and `pending`
//  forbids them. An impossible combination cannot be constructed.
// ════════════════════════════════════════════════════════════════════════
import { TRANSPORTATION_MILEAGE } from './pricing-config'

/** Fields every snapshot carries, whatever its mileage state. */
type SnapshotCore = {
  /** CENTS. The package price alone, before any truck line or mileage. */
  baseCents: number
  /** CENTS. An APPROVED larger-truck upgrade; 0 for the included truck. */
  truckCents: number
  /** The truck the package price already covers ('10ft' | '15ft' | '26ft'). */
  includedTruck: string | null
  /** The price book that produced these numbers, e.g. '2026-08-22.3'. */
  priceBookVersion: string
  /** Server-calculated: this quote may not be auto-confirmed. */
  requiresReview: boolean
  /** WHY, in the owner's words. Empty iff requiresReview is false. */
  reviewReasons: string[]
}

export type QuoteSnapshot =
  | (SnapshotCore & {
      /** The drive is NOT priced. The total is a package subtotal and every
       *  surface must say so. */
      mileageStatus: 'pending'
      /** CENTS. base + truck. NOT a final price while mileage is pending. */
      totalCents: number
      mileageCents?: undefined
      billableMiles?: undefined
    })
  | (SnapshotCore & {
      /** A real routed figure is INSIDE totalCents, and both the money and the
       *  miles behind it are recorded so the total can explain itself. */
      mileageStatus: 'calculated'
      totalCents: number
      mileageCents: number
      billableMiles: number
    })

export type SnapshotResult =
  | { ok: true; snapshot: QuoteSnapshot }
  | { ok: false; reason: string }

/**
 * A subtotal whose drive is not measured yet — every quick quote, because the
 * page collects ZIP codes and a routed mile needs real addresses.
 */
export function pendingSnapshot(core: SnapshotCore & { totalCents: number }): SnapshotResult {
  const base = validateCore(core)
  if (base) return { ok: false, reason: base }
  if (core.totalCents !== core.baseCents + core.truckCents) {
    return { ok: false, reason: `totalCents ${core.totalCents} != base ${core.baseCents} + truck ${core.truckCents}` }
  }
  return {
    ok: true,
    snapshot: {
      baseCents: core.baseCents,
      truckCents: core.truckCents,
      totalCents: core.totalCents,
      includedTruck: core.includedTruck,
      priceBookVersion: core.priceBookVersion,
      requiresReview: core.requiresReview,
      reviewReasons: core.reviewReasons,
      mileageStatus: 'pending',
    },
  }
}

/**
 * A total that CONTAINS the drive. Refuses anything it could not explain:
 * the miles must be a positive whole number, the money must match the
 * published per-mile rate, and the total must be the sum of its parts.
 *
 * Nothing writes this yet — the quick quote cannot measure a route. It exists
 * so that when something does, it cannot produce a total whose mileage is
 * unaccounted for.
 */
export function calculatedSnapshot(
  core: SnapshotCore & { mileageCents: number; billableMiles: number },
): SnapshotResult {
  const base = validateCore(core)
  if (base) return { ok: false, reason: base }
  if (!Number.isInteger(core.billableMiles) || core.billableMiles <= 0) {
    return { ok: false, reason: `billableMiles must be a positive whole number, got ${core.billableMiles}` }
  }
  if (!Number.isInteger(core.mileageCents) || core.mileageCents < 0) {
    return { ok: false, reason: `mileageCents must be a non-negative integer, got ${core.mileageCents}` }
  }
  const expected = core.billableMiles * TRANSPORTATION_MILEAGE.ratePerMileCents
  if (core.mileageCents !== expected) {
    return {
      ok: false,
      reason:
        `mileageCents ${core.mileageCents} does not match ${core.billableMiles} miles at ` +
        `${TRANSPORTATION_MILEAGE.ratePerMileCents}c/mile (expected ${expected})`,
    }
  }
  const totalCents = core.baseCents + core.truckCents + core.mileageCents
  return {
    ok: true,
    snapshot: {
      baseCents: core.baseCents,
      truckCents: core.truckCents,
      totalCents,
      includedTruck: core.includedTruck,
      priceBookVersion: core.priceBookVersion,
      requiresReview: core.requiresReview,
      reviewReasons: core.reviewReasons,
      mileageStatus: 'calculated',
      mileageCents: core.mileageCents,
      billableMiles: core.billableMiles,
    },
  }
}

function validateCore(c: SnapshotCore): string | null {
  if (!Number.isInteger(c.baseCents) || c.baseCents < 0) return `baseCents must be a non-negative integer, got ${c.baseCents}`
  if (!Number.isInteger(c.truckCents) || c.truckCents < 0) return `truckCents must be a non-negative integer, got ${c.truckCents}`
  if (!c.priceBookVersion) return 'priceBookVersion is required'
  if (c.requiresReview && c.reviewReasons.length === 0) return 'requiresReview needs at least one reason'
  if (!c.requiresReview && c.reviewReasons.length > 0) return 'reviewReasons without requiresReview'
  return null
}

// ════════════════════════════════════════════════════════════════════════
//  PERSISTENCE
// ════════════════════════════════════════════════════════════════════════

/** The exact `leads.quote_*` columns for a snapshot. The ONE writer. */
export function snapshotColumns(s: QuoteSnapshot): Record<string, unknown> {
  return {
    quoteBaseCents: s.baseCents,
    quoteTruckCents: s.truckCents,
    quoteTotalCents: s.totalCents,
    quoteIncludedTruck: s.includedTruck,
    quoteMileageStatus: s.mileageStatus,
    quotePriceBookVersion: s.priceBookVersion,
    // NULL while pending — a pending snapshot must not carry calculated values.
    quoteMileageCents: s.mileageStatus === 'calculated' ? s.mileageCents : null,
    quoteBillableMiles: s.mileageStatus === 'calculated' ? s.billableMiles : null,
    quoteRequiresReview: s.requiresReview,
    quoteReviewReasons: s.reviewReasons.length ? s.reviewReasons.join('\n') : null,
  }
}

/**
 * The columns for review state ALONE, when there is no numeric quote.
 *
 * An in-person request and a 5BR manual plan both need a human, and both
 * deliberately have NO total. Review state was previously carried only inside
 * the snapshot, so exactly the leads most needing attention recorded none —
 * and inventing a total merely to have somewhere to put the flag would be
 * worse than losing it.
 */
export function reviewOnlyColumns(reasons: string[]): Record<string, unknown> {
  return {
    quoteRequiresReview: reasons.length > 0,
    quoteReviewReasons: reasons.length ? reasons.join('\n') : null,
  }
}

// ════════════════════════════════════════════════════════════════════════
//  READING IT BACK — the ONE mapping every notification uses
// ════════════════════════════════════════════════════════════════════════

/** The `leads` row shape these mappers need. All nullable: a lead captured
 *  before the snapshot columns existed reads null for every one. */
export type LeadSnapshotRow = {
  estimatedValue?: number | null
  quoteBaseCents?: number | null
  quoteTruckCents?: number | null
  quoteTotalCents?: number | null
  quoteIncludedTruck?: string | null
  quoteMileageStatus?: string | null
  quotePriceBookVersion?: string | null
  quoteMileageCents?: number | null
  quoteBillableMiles?: number | null
  quoteRequiresReview?: boolean | null
  quoteReviewReasons?: string | null
}

/** Reasons, split back out of the stored newline-joined text. */
export function reviewReasonsOf(row: LeadSnapshotRow): string[] {
  return (row.quoteReviewReasons ?? '').split('\n').map((r) => r.trim()).filter(Boolean)
}

/**
 * THE AMOUNT ANY NOTIFICATION MUST QUOTE.
 *
 * `estimatedValue` is a LIVE CRM value — a later capture may legitimately raise
 * it, and an admin can edit it — so it can never be the record of what was
 * quoted. `quoteTotalCents` is written once, at capture, and never moves. When
 * a snapshot exists it wins; `estimatedValue` remains the fallback for leads
 * captured before the snapshot columns existed.
 */
export function quotedCentsOf(row: LeadSnapshotRow): number | null {
  if (typeof row.quoteTotalCents === 'number' && row.quoteTotalCents > 0) return row.quoteTotalCents
  return typeof row.estimatedValue === 'number' && row.estimatedValue > 0 ? row.estimatedValue : null
}

/** Everything a notification needs, derived once from the stored row. */
export type NotificationQuote = {
  /** CENTS to display, or null when nothing may honestly be shown. */
  quotedCents: number | null
  /** True when the figure is a package subtotal with the drive unpriced. */
  mileagePending: boolean
  /** The stored mileage state, or null when a snapshot exists but its state is
   *  unreadable — the one case where an amount must be SUPPRESSED rather than
   *  captioned, because we can say neither "subtotal" nor "final" honestly. */
  mileageStatus: 'pending' | 'calculated' | null
  /** True when a snapshot exists at all (vs a pre-snapshot historical lead). */
  hasSnapshot: boolean
  baseCents: number | null
  truckCents: number | null
  includedTruck: string | null
  mileageCents: number | null
  billableMiles: number | null
  priceBookVersion: string | null
  requiresReview: boolean
  reviewReasons: string[]
}

/**
 * The ONE mapping from a stored lead row to what a notification may say.
 *
 * Production and the tests both call this. The previous round tested the
 * FORMATTER with a hand-assembled ideal object while production never supplied
 * those fields at all — the formatter was correct and the wiring was missing,
 * and the test could not tell the difference.
 */
export function notificationQuoteOf(row: LeadSnapshotRow): NotificationQuote {
  const hasSnapshot = typeof row.quoteTotalCents === 'number' && row.quoteTotalCents > 0
  const status = (row.quoteMileageStatus ?? '').trim().toLowerCase()
  const mileageStatus = status === 'pending' ? 'pending' : status === 'calculated' ? 'calculated' : null
  return {
    quotedCents: quotedCentsOf(row),
    mileagePending: hasSnapshot && mileageStatus === 'pending',
    mileageStatus: hasSnapshot ? mileageStatus : null,
    hasSnapshot,
    baseCents: hasSnapshot ? row.quoteBaseCents ?? null : null,
    truckCents: hasSnapshot ? row.quoteTruckCents ?? null : null,
    includedTruck: hasSnapshot ? row.quoteIncludedTruck ?? null : null,
    mileageCents: hasSnapshot && status === 'calculated' ? row.quoteMileageCents ?? null : null,
    billableMiles: hasSnapshot && status === 'calculated' ? row.quoteBillableMiles ?? null : null,
    priceBookVersion: row.quotePriceBookVersion ?? null,
    requiresReview: row.quoteRequiresReview === true,
    reviewReasons: reviewReasonsOf(row),
  }
}

/** The `leads.quote_*` columns a Prisma `select` must ask for. Exported so a
 *  projection cannot silently omit one and quietly disable a disclosure. */
export const QUOTE_SNAPSHOT_SELECT = {
  estimatedValue: true,
  quoteBaseCents: true,
  quoteTruckCents: true,
  quoteTotalCents: true,
  quoteIncludedTruck: true,
  quoteMileageStatus: true,
  quotePriceBookVersion: true,
  quoteMileageCents: true,
  quoteBillableMiles: true,
  quoteRequiresReview: true,
  quoteReviewReasons: true,
} as const
