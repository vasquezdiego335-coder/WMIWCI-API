// ════════════════════════════════════════════════════════════════════════
//  DeepSeek adapter (owner spec 2026-07-27)
//  ---------------------------------------------------------------------
//  DeepSeek exposes an OpenAI-compatible chat-completions endpoint, so this is
//  the shared transport pointed at a different host with a different key.
//
//  `deepseek-chat` supports JSON output mode; `deepseek-reasoner` does not, and
//  sending `response_format` to it is rejected outright. The adapter therefore
//  declares JSON mode per MODEL rather than per provider — the alternative is
//  an agent that silently stops investigating the day somebody switches model
//  in an environment variable.
// ════════════════════════════════════════════════════════════════════════

import type { AgentAnalysisInput, AgentProviderResult, EmailAgentModelProvider } from '../types'
import { PROVIDER_DEFAULT_MODELS, callOpenAiCompatible } from './index'

const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1'

/**
 * Models that reject `response_format: json_object`.
 *
 * VERIFIED LIVE 2026-07-28: both `deepseek-v4-flash` and `deepseek-v4-pro`
 * accept JSON mode. The legacy `deepseek-reasoner` alias does not, and it is
 * still reachable, so the guard stays — an operator pinning EMAIL_AGENT_MODEL
 * to the old name must not silently lose the investigator.
 */
const NO_JSON_MODE = /reasoner/i

export class DeepSeekProvider implements EmailAgentModelProvider {
  readonly name = 'deepseek'
  readonly model: string
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly timeoutMs?: number

  constructor(options: { apiKey: string; model?: string | null; baseUrl?: string; timeoutMs?: number }) {
    this.apiKey = options.apiKey
    this.model = options.model?.trim() || PROVIDER_DEFAULT_MODELS.deepseek
    this.baseUrl = (options.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.timeoutMs = options.timeoutMs
  }

  analyze(input: AgentAnalysisInput): Promise<AgentProviderResult> {
    return callOpenAiCompatible(
      {
        name: 'deepseek',
        baseUrl: this.baseUrl,
        apiKey: this.apiKey,
        model: this.model,
        timeoutMs: this.timeoutMs,
        supportsJsonObjectMode: !NO_JSON_MODE.test(this.model),
      },
      input
    )
  }
}

export { NO_JSON_MODE }
