// ════════════════════════════════════════════════════════════════════════
//  MODEL PROVIDERS (owner spec 2026-07-27)
//  ---------------------------------------------------------------------
//  One interface, two adapters, no vendor name anywhere else in the agent.
//
//  WHY PLAIN `fetch` AND NOT AN SDK: neither the OpenAI nor the DeepSeek SDK
//  is installed in this project, and both APIs are the same chat-completions
//  shape over HTTPS. Adding a dependency to send one JSON body would be a new
//  supply-chain surface, a new bundle in the Next.js build, and a new thing to
//  keep updated — for no capability we need. If an SDK is added later for
//  another reason, these adapters can move onto it without anything else in
//  the agent changing, which is the point of the interface.
//
//  EVERY ADAPTER OBEYS THE SAME FOUR RULES:
//    1. It never throws. A provider outage returns a result object, because
//       the deterministic half of the agent must keep working when the AI
//       cannot be reached.
//    2. It enforces its own timeout with AbortController. A hung request must
//       not hold a five-minute cycle open.
//    3. It validates the reply against `agentDecisionSchema` before returning
//       it. An unparseable or non-conforming answer is `invalid_output`, not
//       a decision.
//    4. It returns usage and a request id when the provider gives them, so
//       cost is visible rather than mysterious.
// ════════════════════════════════════════════════════════════════════════

import {
  agentDecisionSchema,
  type AgentAnalysisInput,
  type AgentProviderResult,
  type EmailAgentModelProvider,
} from '../types'
import { safeErrorMessage } from '../redact'
import { buildMessages } from './prompt'

export const DEFAULT_TIMEOUT_MS = Number(process.env.EMAIL_AGENT_TIMEOUT_MS) || 45_000

/**
 * Provider defaults. Overridable with EMAIL_AGENT_MODEL.
 *
 * CHOSEN ON COST, VERIFIED LIVE 2026-07-28.
 *
 * `deepseek-v4-flash` is the cheapest model that passes the schema and
 * decision-quality checks, at roughly a third of the cheapest OpenAI option
 * per investigation. DeepSeek's /models endpoint now lists ONLY the V4 family;
 * `deepseek-chat` still answers as an alias but is delisted, so pinning to it
 * is borrowing time.
 *
 * `gpt-5.4-nano` is the fallback: it answers without reasoning-token overhead,
 * where `gpt-5-mini` spent 20 reasoning tokens on a 20-token reply — billed as
 * output, at 1.6x the output rate, for a task that is classification.
 */
export const PROVIDER_DEFAULT_MODELS: Record<string, string> = {
  openai: 'gpt-5.4-nano',
  deepseek: 'deepseek-v4-flash',
}

export type OpenAiCompatibleConfig = {
  name: string
  baseUrl: string
  apiKey: string
  model: string
  timeoutMs?: number
  /** Some providers reject response_format; adapters declare their support. */
  supportsJsonObjectMode?: boolean
  /** Hard ceiling on answer tokens. Output is the expensive half of the bill. */
  maxOutputTokens?: number
}

type ChatResponse = {
  id?: string
  choices?: Array<{ message?: { content?: string | null } }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    /** OpenAI shape. */
    prompt_tokens_details?: { cached_tokens?: number }
    completion_tokens_details?: { reasoning_tokens?: number }
    /** DeepSeek shape — the same facts under different names. */
    prompt_cache_hit_tokens?: number
    prompt_cache_miss_tokens?: number
  }
  error?: { message?: string; type?: string }
}

/**
 * Normalise the two providers' usage shapes into one.
 *
 * Both report cache hits and reasoning tokens; they disagree about the field
 * names. Reading only OpenAI's names would silently cost every DeepSeek cached
 * call at the full input rate.
 */
export function readUsage(usage: ChatResponse['usage']): {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  cachedInputTokens?: number
  reasoningTokens?: number
} {
  if (!usage) return {}
  const cached = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens
  return {
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
    cachedInputTokens: typeof cached === 'number' ? cached : undefined,
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens,
  }
}

/**
 * Pull the JSON object out of a model reply.
 *
 * Models wrap JSON in prose or fences even when told not to, so this reaches
 * for the outermost balanced object rather than trusting the whole string.
 * If nothing parses, the caller reports `invalid_output` — it does NOT guess.
 */
export function extractJson(raw: string): unknown {
  const trimmed = raw.trim()
  const direct = tryParse(trimmed)
  if (direct !== undefined) return direct

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) {
    const parsed = tryParse(fenced[1].trim())
    if (parsed !== undefined) return parsed
  }

  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start !== -1 && end > start) {
    const parsed = tryParse(trimmed.slice(start, end + 1))
    if (parsed !== undefined) return parsed
  }
  return undefined
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * Models that reject `max_tokens` and require `max_completion_tokens`.
 *
 * VERIFIED LIVE 2026-07-28, and this is not a theoretical compatibility note:
 * the adapter previously sent `max_tokens` unconditionally, and every GPT-5
 * model answered
 *
 *   400 Unsupported parameter: 'max_tokens' is not supported with this model.
 *
 * so the entire OpenAI fallback path was dead on arrival for exactly the cheap
 * models the budget wants to use. The failure was invisible because the
 * fallback had never been exercised.
 */
const REQUIRES_MAX_COMPLETION_TOKENS = /^(gpt-5|gpt-6|o[1-9])/i

/**
 * Ceiling on the answer.
 *
 * RAISED FROM 1200 AFTER LIVE EVIDENCE: 5 of 13 deepseek-v4-flash calls came
 * back `invalid_output`. REASONING TOKENS COME OUT OF THIS SAME BUDGET, and a
 * V4 reply routinely spends several hundred of them before writing a character
 * of JSON, so a 1200 ceiling truncated the answer mid-object. That failure is
 * expensive twice over: the truncated call is still billed, and it triggers
 * the paid fallback.
 *
 * 3000 is still small. At the DeepSeek Flash output rate a full 3000-token
 * answer costs $0.00084, so even 25 a day is under $0.65 a month.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = Number(process.env.EMAIL_AGENT_MAX_OUTPUT_TOKENS) || 3000

/**
 * Build the request body for one provider + model.
 *
 * Exported so a test can assert the parameter choice without a network call —
 * the previous bug would have been caught by exactly such a test.
 */
export function buildRequestBody(
  config: Pick<OpenAiCompatibleConfig, 'model' | 'supportsJsonObjectMode' | 'maxOutputTokens'>,
  messages: Array<{ role: string; content: string }>
): Record<string, unknown> {
  const limit = config.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    // Deterministic-as-possible: this is an operations judgement, not prose.
    temperature: 0,
  }
  if (REQUIRES_MAX_COMPLETION_TOKENS.test(config.model)) {
    body.max_completion_tokens = limit
  } else {
    body.max_tokens = limit
  }
  if (config.supportsJsonObjectMode !== false) {
    body.response_format = { type: 'json_object' }
  }
  return body
}

/**
 * The shared transport. Both adapters are this function with different
 * configuration, because both APIs are OpenAI-compatible chat completions.
 */
export async function callOpenAiCompatible(
  config: OpenAiCompatibleConfig,
  input: AgentAnalysisInput
): Promise<AgentProviderResult> {
  const started = Date.now()
  const controller = new AbortController()
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify(buildRequestBody(config, buildMessages(input))),
      signal: controller.signal,
    })

    const latencyMs = Date.now() - started

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      return {
        ok: false,
        outcome: 'error',
        // The body can echo request content; it is redacted like everything else.
        error: `${config.name} returned ${response.status}${detail ? `: ${safeErrorMessage(detail, 200)}` : ''}`,
        latencyMs,
      }
    }

    const body = (await response.json()) as ChatResponse
    if (body.error) {
      return { ok: false, outcome: 'error', error: `${config.name}: ${safeErrorMessage(body.error.message ?? 'unknown error', 200)}`, requestId: body.id, latencyMs }
    }

    const content = body.choices?.[0]?.message?.content
    if (!content || content.trim() === '') {
      return {
        ok: false,
        outcome: 'invalid_output',
        error: `${config.name} returned an empty message - usually the whole output budget went to reasoning tokens.`,
        requestId: body.id,
        usage: readUsage(body.usage),
        latencyMs,
      }
    }

    const json = extractJson(content)
    if (json === undefined) {
      return {
        ok: false,
        outcome: 'invalid_output',
        error: `${config.name} did not return parseable JSON (${content.length} chars). A truncated answer usually means the output ceiling was too low for the model's reasoning tokens.`,
        requestId: body.id,
        usage: readUsage(body.usage),
        latencyMs,
      }
    }

    // THE CONTRACT GATE. A reply that does not match is discarded whole — not
    // patched, not partially used. A half-understood recommendation about
    // customer email is worth less than none.
    const parsed = agentDecisionSchema.safeParse(json)
    if (!parsed.success) {
      return {
        ok: false,
        outcome: 'invalid_output',
        error: `${config.name} output failed validation: ${parsed.error.issues.slice(0, 4).map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`,
        requestId: body.id,
        // Billed even though it was useless. See AgentProviderResult.
        usage: readUsage(body.usage),
        latencyMs,
      }
    }

    return {
      ok: true,
      decision: parsed.data,
      requestId: body.id,
      usage: readUsage(body.usage),
      latencyMs,
    }
  } catch (err) {
    const latencyMs = Date.now() - started
    const aborted = err instanceof Error && (err.name === 'AbortError' || /abort/i.test(err.message))
    return {
      ok: false,
      outcome: aborted ? 'timeout' : 'error',
      error: aborted ? `${config.name} did not answer within ${timeoutMs}ms.` : `${config.name}: ${safeErrorMessage(err, 200)}`,
      latencyMs,
    }
  } finally {
    clearTimeout(timer)
  }
}

/** A provider that is present but switched off. Keeps the call sites uniform. */
export class DisabledProvider implements EmailAgentModelProvider {
  readonly name = 'disabled'
  readonly model = 'none'
  constructor(private readonly reason: string) {}
  async analyze(): Promise<AgentProviderResult> {
    return { ok: false, outcome: 'disabled', error: this.reason, latencyMs: 0 }
  }
}

export { buildMessages }
