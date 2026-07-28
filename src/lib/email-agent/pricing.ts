// ════════════════════════════════════════════════════════════════════════
//  MODEL PRICING (owner spec 2026-07-28)
//  ---------------------------------------------------------------------
//  What a model call costs, so spend is visible without waiting for a bill.
//
//  THIS TABLE IS AN ESTIMATE AND SAYS SO EVERYWHERE. The provider invoice is
//  authoritative. What this gives us is a number BEFORE the invoice, which is
//  the only kind of number that can stop overspending.
//
//  THREE RULES THAT MATTER MORE THAN THE NUMBERS.
//
//  1. AN UNKNOWN MODEL FAILS CLOSED. If somebody sets EMAIL_AGENT_MODEL to
//     something not priced here, the call is costed at the most expensive rate
//     in the table, not at zero. A model with no price must never look free —
//     that is how a budget silently stops working.
//
//  2. REASONING TOKENS ARE OUTPUT TOKENS. DeepSeek V4 and GPT-5 both emit
//     reasoning tokens, they are billed as output, and on a reasoning model
//     they routinely exceed the visible answer. Verified live: a 20-token
//     reply from deepseek-v4-flash was 18 reasoning tokens. Costing only the
//     visible answer would understate the bill several-fold.
//
//  3. CACHED INPUT IS CHEAPER, NOT FREE. Both providers report cache hits
//     separately; they are billed at a reduced input rate.
//
//  PRICES ARE PER 1,000,000 TOKENS, IN USD, and each row carries the date the
//  price was recorded so an old call is never retroactively re-priced.
// ════════════════════════════════════════════════════════════════════════

export type ModelPrice = {
  provider: 'openai' | 'deepseek'
  model: string
  /** USD per 1M input tokens that MISSED the prompt cache. */
  inputPerMillion: number
  /** USD per 1M input tokens served from the cache. */
  cachedInputPerMillion: number
  /** USD per 1M output tokens (reasoning tokens included). */
  outputPerMillion: number
  /** When this row was recorded, so a re-priced table cannot rewrite history. */
  effectiveFrom: string
  /** provider-listed | estimated */
  basis: 'provider-listed' | 'estimated'
}

/** Bump when any rate below changes. Stamped onto every costed call. */
export const PRICING_VERSION = '2026-07-28'

/**
 * Verified against the providers' published rates on 2026-07-28. The model
 * IDs were verified LIVE against both APIs on the same date: DeepSeek's
 * /models lists only the V4 family, and every OpenAI id below answered 200.
 */
export const MODEL_PRICES: ModelPrice[] = [
  // ── DeepSeek V4 ──
  {
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    inputPerMillion: 0.14,
    // DeepSeek's cache-hit rate is roughly a tenth of cache-miss input.
    cachedInputPerMillion: 0.014,
    outputPerMillion: 0.28,
    effectiveFrom: '2026-07-28',
    basis: 'provider-listed',
  },
  {
    provider: 'deepseek',
    model: 'deepseek-v4-pro',
    inputPerMillion: 0.435,
    cachedInputPerMillion: 0.0435,
    outputPerMillion: 0.87,
    effectiveFrom: '2026-07-28',
    basis: 'provider-listed',
  },
  // ── DeepSeek legacy aliases. Delisted from /models in July 2026 but still
  //    answering, so a deployment pinned to one keeps working AND keeps being
  //    costed. Priced at the V4 Flash rate they now resolve to.
  {
    provider: 'deepseek',
    model: 'deepseek-chat',
    inputPerMillion: 0.14,
    cachedInputPerMillion: 0.014,
    outputPerMillion: 0.28,
    effectiveFrom: '2026-07-28',
    basis: 'estimated',
  },
  {
    provider: 'deepseek',
    model: 'deepseek-reasoner',
    inputPerMillion: 0.435,
    cachedInputPerMillion: 0.0435,
    outputPerMillion: 0.87,
    effectiveFrom: '2026-07-28',
    basis: 'estimated',
  },
  // ── OpenAI ──
  {
    provider: 'openai',
    model: 'gpt-5.4-nano',
    inputPerMillion: 0.2,
    cachedInputPerMillion: 0.02,
    outputPerMillion: 1.25,
    effectiveFrom: '2026-07-28',
    basis: 'provider-listed',
  },
  {
    provider: 'openai',
    model: 'gpt-5-mini',
    inputPerMillion: 0.25,
    cachedInputPerMillion: 0.025,
    outputPerMillion: 2.0,
    effectiveFrom: '2026-07-28',
    basis: 'provider-listed',
  },
  {
    provider: 'openai',
    model: 'gpt-5.6-luna',
    inputPerMillion: 1.0,
    cachedInputPerMillion: 0.1,
    outputPerMillion: 6.0,
    effectiveFrom: '2026-07-28',
    basis: 'provider-listed',
  },
  {
    provider: 'openai',
    model: 'gpt-4o-mini',
    inputPerMillion: 0.15,
    cachedInputPerMillion: 0.075,
    outputPerMillion: 0.6,
    effectiveFrom: '2026-07-28',
    basis: 'estimated',
  },
]

/** The most expensive row, used to cost anything unrecognised. */
export const WORST_CASE_PRICE: ModelPrice = MODEL_PRICES.reduce((worst, p) =>
  p.outputPerMillion > worst.outputPerMillion ? p : worst
)

export function findPrice(provider: string, model: string): ModelPrice | null {
  const p = provider.trim().toLowerCase()
  const m = model.trim().toLowerCase()
  return MODEL_PRICES.find((row) => row.provider === p && row.model.toLowerCase() === m) ?? null
}

export type CostBreakdown = {
  usd: number
  pricingVersion: string
  /** True when the model was not in the table and the worst case was used. */
  unknownModel: boolean
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
}

/**
 * Cost one call.
 *
 * `promptTokens` from both providers INCLUDES the cached portion, so the
 * cached tokens are subtracted before applying the full input rate — billing
 * them twice would overstate every cached call.
 *
 * `completionTokens` already includes reasoning tokens on both providers, so
 * reasoning is NOT added again here. It is recorded separately for visibility.
 */
export function estimateCost(input: {
  provider: string
  model: string
  promptTokens?: number | null
  completionTokens?: number | null
  cachedInputTokens?: number | null
}): CostBreakdown {
  const price = findPrice(input.provider, input.model)
  const unknownModel = price === null
  // FAIL CLOSED. An unpriced model is costed at the worst rate in the table,
  // so it burns the budget faster rather than appearing free.
  const rate = price ?? WORST_CASE_PRICE

  const prompt = Math.max(0, input.promptTokens ?? 0)
  const cached = Math.min(Math.max(0, input.cachedInputTokens ?? 0), prompt)
  const freshInput = prompt - cached
  const output = Math.max(0, input.completionTokens ?? 0)

  const usd =
    (freshInput / 1_000_000) * rate.inputPerMillion +
    (cached / 1_000_000) * rate.cachedInputPerMillion +
    (output / 1_000_000) * rate.outputPerMillion

  return {
    // Rounded to a hundredth of a cent: below that the number is noise, and
    // floating-point sums of 288 tiny calls drift without it.
    usd: Math.round(usd * 1_000_000) / 1_000_000,
    pricingVersion: unknownModel ? `${PRICING_VERSION}:unknown-model-worst-case` : PRICING_VERSION,
    unknownModel,
    inputTokens: freshInput,
    cachedInputTokens: cached,
    outputTokens: output,
  }
}

/** Cost of one typical investigation, for the admin's projection. */
export function projectMonthlyCost(input: {
  provider: string
  model: string
  investigationsPerDay: number
  avgPromptTokens: number
  avgCompletionTokens: number
  avgCachedTokens?: number
}): { perCall: number; perDay: number; perMonth: number; unknownModel: boolean } {
  const call = estimateCost({
    provider: input.provider,
    model: input.model,
    promptTokens: input.avgPromptTokens,
    completionTokens: input.avgCompletionTokens,
    cachedInputTokens: input.avgCachedTokens ?? 0,
  })
  const perDay = call.usd * Math.max(0, input.investigationsPerDay)
  return {
    perCall: call.usd,
    perDay: Math.round(perDay * 10_000) / 10_000,
    perMonth: Math.round(perDay * 30 * 10_000) / 10_000,
    unknownModel: call.unknownModel,
  }
}

/** Human-readable table for the admin. Never includes a key. */
export const pricingCatalogue = (): Array<ModelPrice & { note: string }> =>
  MODEL_PRICES.map((p) => ({
    ...p,
    note:
      p.basis === 'provider-listed'
        ? 'Rate published by the provider.'
        : 'Rate inferred from the model this id resolves to; treat as approximate.',
  }))
