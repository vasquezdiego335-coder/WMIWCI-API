import { CampaignStatus } from '@prisma/client'

// Pure rules for the marketing write path. Routes and tests both call these, so
// the rule that ships is the rule that was tested.
//
// THE JOIN HAZARD this module exists to contain: marketing spend is matched to
// revenue by an exact string compare between MarketingCampaign.sourceKey and
// the value resolveAttribution() pulls off a Booking. resolveAttribution only
// TRIMS — it does not upper-case. So a campaign keyed 'DOOR_HANGER' and a
// booking carrying 'door_hanger' land in two different buckets: the spend is
// orphaned (cost with no revenue) and the revenue looks free (profit with no
// cost). Both halves of Profit ROAS are then wrong, in opposite directions,
// with nothing on screen saying so.
//
// We cannot retroactively rewrite historical Booking.source values, so instead
// we canonicalize every sourceKey on write and make a non-joining key LOUD at
// the moment it is created.

/**
 * Canonical form of a campaign source key: UPPER_SNAKE, no punctuation runs.
 *
 * 'Door Hanger #3' -> 'DOOR_HANGER_3'; ' google-ads ' -> 'GOOGLE_ADS'.
 */
export function normalizeSourceKey(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 100)
}

/** True when two source strings mean the same campaign under canonicalization. */
export function sourceKeysMatch(a: string, b: string): boolean {
  return normalizeSourceKey(a) === normalizeSourceKey(b)
}

export type JoinCheck = {
  /** Bookings whose stored source matches EXACTLY — these already aggregate. */
  exact: number
  /** Bookings that match only after canonicalization — these will NOT aggregate. */
  canonicalOnly: string[]
  warning: string | null
}

/**
 * Does this key actually join to recorded attribution?
 *
 * `observed` is the distinct set of source strings currently on bookings. A key
 * that matches nothing is not an error — a brand-new campaign legitimately has
 * no bookings yet — but a key that matches only after canonicalization is a
 * real problem the owner should see immediately, because the report will show
 * the spend and the revenue as two unrelated rows.
 */
export function checkSourceKeyJoin(sourceKey: string, observed: string[]): JoinCheck {
  const key = normalizeSourceKey(sourceKey)
  let exact = 0
  const canonicalOnly: string[] = []
  for (const o of observed) {
    if (o === key) exact++
    else if (normalizeSourceKey(o) === key) canonicalOnly.push(o)
  }
  const warning = canonicalOnly.length
    ? `Existing bookings record this source as ${canonicalOnly.map((s) => `"${s}"`).join(', ')}, which will NOT aggregate with "${key}". Spend and revenue would appear as separate rows. Correct those bookings' source, or create the campaign with the exact existing spelling.`
    : null
  return { exact, canonicalOnly, warning }
}

export type SpendDecision =
  | { allow: true; warnings: string[] }
  | { allow: false; error: string; status: number }

export type SpendInput = {
  campaignStatus: CampaignStatus
  amountCents: number
  incurredOn: Date
  campaignStart: Date | null
  campaignEnd: Date | null
  now?: Date
}

/**
 * May this spend row be recorded?
 *
 * Refusals are limited to things that are definitely wrong (archived campaign,
 * non-positive amount, a date in the future). Spend that falls outside the
 * campaign's own start/end window is ALLOWED but warned about: real invoices
 * arrive late and print bills land before a campaign starts, and silently
 * refusing them would push the owner to fake the date — which corrupts the
 * period-bounded spend totals the marketing report depends on.
 */
export function evaluateSpend(input: SpendInput): SpendDecision {
  const now = input.now ?? new Date()

  if (input.campaignStatus === CampaignStatus.ARCHIVED) {
    return { allow: false, error: 'Campaign is archived. Reactivate it before recording spend.', status: 409 }
  }
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    return { allow: false, error: 'Spend amount must be a positive whole number of cents.', status: 422 }
  }
  if (input.incurredOn.getTime() > now.getTime() + 24 * 60 * 60 * 1000) {
    return { allow: false, error: 'Spend cannot be dated in the future.', status: 422 }
  }

  const warnings: string[] = []
  if (input.campaignStart && input.incurredOn < input.campaignStart) {
    warnings.push('Spend is dated before the campaign start date. It will count in the period it was incurred, not the campaign window.')
  }
  if (input.campaignEnd && input.incurredOn > input.campaignEnd) {
    warnings.push('Spend is dated after the campaign end date. It will count in the period it was incurred, not the campaign window.')
  }
  if (input.campaignStatus === CampaignStatus.DRAFT) {
    warnings.push('Campaign is still a DRAFT, so this spend is excluded from the marketing report until the campaign is ACTIVE, PAUSED or COMPLETED.')
  }
  return { allow: true, warnings }
}

/**
 * Budget check — advisory only. Going over budget is a fact to surface, never a
 * reason to refuse recording money that was genuinely spent.
 */
export function budgetStatus(spentCents: number, budgetCents: number | null): { overBudget: boolean; remainingCents: number | null; usedBp: number | null } {
  if (budgetCents == null || budgetCents <= 0) return { overBudget: false, remainingCents: null, usedBp: null }
  return {
    overBudget: spentCents > budgetCents,
    remainingCents: budgetCents - spentCents,
    usedBp: Math.round((spentCents / budgetCents) * 10_000),
  }
}
