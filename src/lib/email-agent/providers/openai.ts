// ════════════════════════════════════════════════════════════════════════
//  OpenAI adapter (owner spec 2026-07-27)
//  ---------------------------------------------------------------------
//  Chat Completions with `response_format: json_object`, which OpenAI honours,
//  so the reply is JSON before our own extraction ever has to work at it.
//  Everything else is the shared transport.
// ════════════════════════════════════════════════════════════════════════

import type { AgentAnalysisInput, AgentProviderResult, EmailAgentModelProvider } from '../types'
import { PROVIDER_DEFAULT_MODELS, callOpenAiCompatible } from './index'

const DEFAULT_BASE_URL = 'https://api.openai.com/v1'

export class OpenAiProvider implements EmailAgentModelProvider {
  readonly name = 'openai'
  readonly model: string
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly timeoutMs?: number

  constructor(options: { apiKey: string; model?: string | null; baseUrl?: string; timeoutMs?: number }) {
    this.apiKey = options.apiKey
    this.model = options.model?.trim() || PROVIDER_DEFAULT_MODELS.openai
    this.baseUrl = (options.baseUrl ?? process.env.OPENAI_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.timeoutMs = options.timeoutMs
  }

  analyze(input: AgentAnalysisInput): Promise<AgentProviderResult> {
    return callOpenAiCompatible(
      {
        name: 'openai',
        baseUrl: this.baseUrl,
        apiKey: this.apiKey,
        model: this.model,
        timeoutMs: this.timeoutMs,
        supportsJsonObjectMode: true,
      },
      input
    )
  }
}
