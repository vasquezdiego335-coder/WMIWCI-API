// ============================================================================
// marketing-profitability.ts — does a campaign make MONEY? (Stage 3, owner spec
// 2026-07-20).
//
// THE RULE: a campaign is judged by PROFIT ROAS, not by scans, clicks, leads or
// gross revenue. A door hanger that produced $10,000 of revenue on moves that
// cost $10,500 to run lost money, and no impression count changes that.
//
//   Profit ROAS = attributed FINALIZED company net profit ÷ marketing spend
//
// Attributed profit uses FINALIZED snapshots only. Provisional moves are
// counted and reported separately so a campaign is never credited with profit
// that has not been closed out.
//
// Pure functions, integer cents, offline-tested.
// ============================================================================

export type AttributionModel = 'FIRST_TOUCH' | 'LAST_TOUCH' | 'BOOKING'

/** Sources that are honest about not knowing. Never invent attribution. */
export const UNKNOWN_SOURCES = ['UNKNOWN', 'DIRECT', 'OWNER_ASSIGNED'] as const

export interface FunnelCounts {
  impressions?: number | null
  scans?: number | null
  sessions?: number | null
  leads: number
  qualifiedLeads?: number | null
  quotes: number
  bookings: number
  completedMoves: number
  finalizedMoves: number
}

export interface AttributedMoney {
  /** Net collected revenue on attributed moves (finalized + provisional). */
  netCollectedRevenueCents: number
  /** FINALIZED company net profit — the only profit a campaign is credited. */
  finalizedNetProfitCents: number
  /** Profit on attributed moves that are NOT yet finalized. Reported, never
   *  folded into ROAS. */
  provisionalNetProfitCents: number
  directCostCents: number
}

export interface CampaignSpend {
  /** Everything spent: print + distribution + ad spend + adjustments. */
  totalSpendCents: number
}

export interface MarketingResult {
  sourceKey: string
  spendCents: number
  funnel: FunnelCounts
  money: AttributedMoney
  // ── Efficiency ──
  costPerLeadCents: number | null
  costPerQuoteCents: number | null
  costPerBookingCents: number | null
  costPerCompletedMoveCents: number | null
  averageBookingValueCents: number | null
  averageProfitPerMoveCents: number | null
  // ── Conversion, in basis points ──
  leadToQuoteBp: number | null
  quoteToBookingBp: number | null
  bookingToCompletedBp: number | null
  leadToBookingBp: number | null
  // ── The verdict ──
  /** Revenue ÷ spend, in basis points. 10000bp = 1.0x. */
  revenueRoasBp: number | null
  /** FINALIZED profit ÷ spend, in basis points. THE metric. */
  profitRoasBp: number | null
  /** finalized profit − spend. Negative means the campaign lost money. */
  netOfSpendCents: number
  profitable: boolean | null
  /** Why a verdict could not be given (no spend, nothing finalized yet). */
  caveat: string | null
}

const div = (num: number, den: number): number | null => (den > 0 ? Math.round(num / den) : null)
/** Cost per X is meaningless with no spend — null, never a misleading $0.00. */
const costPer = (spend: number, count: number): number | null => (spend > 0 && count > 0 ? Math.round(spend / count) : null)
const bp = (num: number, den: number): number | null => (den > 0 ? Math.round((num / den) * 10_000) : null)

/**
 * Score one marketing source or campaign.
 *
 * Deliberate choices:
 *  • ROAS is null, not 0 or Infinity, when there is no spend — an organic source
 *    has no return on advertising spend, and printing "∞x" is nonsense.
 *  • `profitable` is null until at least one attributed move is FINALIZED. A
 *    campaign with only provisional moves has not proven anything yet.
 */
export function scoreMarketingSource(input: {
  sourceKey: string
  spend: CampaignSpend
  funnel: FunnelCounts
  money: AttributedMoney
}): MarketingResult {
  const spendCents = Math.max(0, Math.round(input.spend.totalSpendCents))
  const f = input.funnel
  const m = input.money

  const profitRoasBp = bp(m.finalizedNetProfitCents, spendCents)
  const revenueRoasBp = bp(m.netCollectedRevenueCents, spendCents)

  let caveat: string | null = null
  let profitable: boolean | null = null
  if (spendCents === 0) {
    caveat = 'No marketing spend recorded — return on ad spend does not apply.'
    profitable = m.finalizedNetProfitCents > 0 ? true : m.finalizedNetProfitCents < 0 ? false : null
  } else if (f.finalizedMoves === 0) {
    caveat = f.completedMoves > 0
      ? `${f.completedMoves} attributed move${f.completedMoves === 1 ? '' : 's'} completed but none are financially finalized, so profit is not yet proven.`
      : 'No attributed moves have been finalized yet.'
  } else {
    profitable = m.finalizedNetProfitCents > spendCents
  }

  return {
    sourceKey: input.sourceKey,
    spendCents,
    funnel: f,
    money: m,
    costPerLeadCents: costPer(spendCents, f.leads),
    costPerQuoteCents: costPer(spendCents, f.quotes),
    costPerBookingCents: costPer(spendCents, f.bookings),
    costPerCompletedMoveCents: costPer(spendCents, f.completedMoves),
    averageBookingValueCents: div(m.netCollectedRevenueCents, f.completedMoves),
    averageProfitPerMoveCents: div(m.finalizedNetProfitCents, f.finalizedMoves),
    leadToQuoteBp: bp(f.quotes, f.leads),
    quoteToBookingBp: bp(f.bookings, f.quotes),
    bookingToCompletedBp: bp(f.completedMoves, f.bookings),
    leadToBookingBp: bp(f.bookings, f.leads),
    revenueRoasBp,
    profitRoasBp,
    netOfSpendCents: m.finalizedNetProfitCents - spendCents,
    profitable,
    caveat,
  }
}

/** "2.4x" / "—" for a basis-point ROAS. */
export function formatRoas(roasBp: number | null): string {
  if (roasBp == null) return '—'
  return `${(roasBp / 10_000).toFixed(2)}x`
}

/**
 * Rank sources by what actually matters. Sources with no proven finalized
 * profit sort last regardless of how many leads they generated — a ranking that
 * rewards unproven volume is the exact mistake this module exists to prevent.
 */
export function rankByProfit(results: MarketingResult[]): MarketingResult[] {
  return [...results].sort((a, b) => {
    const aProven = a.funnel.finalizedMoves > 0
    const bProven = b.funnel.finalizedMoves > 0
    if (aProven !== bProven) return aProven ? -1 : 1
    return b.netOfSpendCents - a.netOfSpendCents
  })
}

// ── Attribution ─────────────────────────────────────────────────────────────

export interface AttributionRecord {
  firstTouchSource?: string | null
  firstTouchCampaign?: string | null
  lastTouchSource?: string | null
  lastTouchCampaign?: string | null
  bookingSource?: string | null
  bookingCampaign?: string | null
  ownerAssignedSource?: string | null
}

/**
 * Which source a move counts toward, under a given model.
 *
 * An owner-assigned source always wins for BOOKING attribution — a human
 * deciding "this came from the door hanger" is better evidence than a UTM that
 * was lost on the third click. Nothing is ever guessed: an absent source
 * resolves to `UNKNOWN`, never to the nearest plausible campaign.
 */
export function resolveAttribution(rec: AttributionRecord, model: AttributionModel): { source: string; campaign: string | null; inferred: boolean } {
  const clean = (s?: string | null) => (s && s.trim() ? s.trim() : null)

  if (model === 'FIRST_TOUCH') {
    const s = clean(rec.firstTouchSource)
    return { source: s ?? 'UNKNOWN', campaign: clean(rec.firstTouchCampaign), inferred: !s }
  }
  if (model === 'LAST_TOUCH') {
    const s = clean(rec.lastTouchSource) ?? clean(rec.firstTouchSource)
    return { source: s ?? 'UNKNOWN', campaign: clean(rec.lastTouchCampaign) ?? clean(rec.firstTouchCampaign), inferred: !clean(rec.lastTouchSource) && !!s }
  }
  // BOOKING
  const owner = clean(rec.ownerAssignedSource)
  if (owner) return { source: owner, campaign: clean(rec.bookingCampaign), inferred: false }
  const s = clean(rec.bookingSource) ?? clean(rec.lastTouchSource) ?? clean(rec.firstTouchSource)
  return {
    source: s ?? 'UNKNOWN',
    campaign: clean(rec.bookingCampaign) ?? clean(rec.lastTouchCampaign) ?? clean(rec.firstTouchCampaign),
    inferred: !clean(rec.bookingSource) && !!s,
  }
}

export const isUnknownSource = (source: string): boolean =>
  (UNKNOWN_SOURCES as readonly string[]).includes(source.toUpperCase())

/**
 * Is an attribution CORRECTION allowed? First-touch is immutable by design —
 * it records what actually happened first, and overwriting it destroys the only
 * evidence of where a customer originally came from.
 */
export function canCorrectAttribution(field: keyof AttributionRecord, reason?: string): { allow: true } | { allow: false; error: string } {
  if (field === 'firstTouchSource' || field === 'firstTouchCampaign') {
    return { allow: false, error: 'First-touch attribution records how the customer originally found the business and cannot be overwritten. Set an owner-assigned source instead.' }
  }
  if (!reason?.trim()) {
    return { allow: false, error: 'A reason is required to change attribution — it is recorded in the audit log.' }
  }
  return { allow: true }
}
