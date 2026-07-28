// ════════════════════════════════════════════════════════════════════════
//  EMAIL OPERATIONS AGENT — shared vocabulary (owner spec 2026-07-27)
//  ---------------------------------------------------------------------
//  Every type the agent's parts agree on, plus the Zod schemas that decide
//  what is allowed to cross the boundary from a language model into this
//  system. Nothing here does I/O.
//
//  THE ONE IDEA THIS FILE ENCODES: the tool NAME is a closed set. A model can
//  ask for `reconcileRunCounters`; it cannot ask for `runSql`, and it cannot
//  invent `deleteSuppression` — an unknown name fails Zod parsing before the
//  policy engine ever sees it, and the policy engine refuses unknown names
//  again anyway. Two independent gates, because one is a single point of
//  failure and this one guards real customers' inboxes.
// ════════════════════════════════════════════════════════════════════════

import { z } from 'zod'

// ── Modes ───────────────────────────────────────────────────────────────

/**
 * off        — nothing scheduled. Campaign infrastructure is unaffected.
 * read_only  — checks, incidents, memory, AI investigation, alerts. NO writes
 *              to the email system. This is the production default.
 * safe_auto  — read_only plus the narrow set of repairs the policy engine
 *              classifies `automatic`. Sending, rescheduling, audience and
 *              consent changes still require a human.
 */
export const AGENT_MODES = ['off', 'read_only', 'safe_auto'] as const
export type EmailAgentMode = (typeof AGENT_MODES)[number]

export const isAgentMode = (v: unknown): v is EmailAgentMode =>
  typeof v === 'string' && (AGENT_MODES as readonly string[]).includes(v)

// ── Findings ────────────────────────────────────────────────────────────

export const SEVERITIES = ['info', 'warning', 'critical'] as const
export type FindingSeverity = (typeof SEVERITIES)[number]

export const CATEGORIES = [
  'campaign',
  'run',
  'send',
  'consent',
  'suppression',
  'webhook',
  'provider',
  'scheduler',
  'infrastructure',
] as const
export type FindingCategory = (typeof CATEGORIES)[number]

/**
 * The output of one deterministic check about one subject.
 *
 * `fingerprint` is the identity of the PROBLEM, not of the observation: the
 * same stuck run seen in a hundred cycles produces a hundred findings with one
 * fingerprint, which is what lets the incident manager say "still happening,
 * 8 hours" instead of alerting a hundred times.
 */
export type AgentFinding = {
  checkId: string
  fingerprint: string
  severity: FindingSeverity
  category: FindingCategory
  title: string
  /** One sentence an owner can act on, with the number embedded. */
  description: string
  /** Structured, redacted. Never a secret value, never a customer list. */
  evidence: Record<string, unknown>
  campaignId?: string
  runRefId?: string
  sendId?: string
  webhookEventId?: string
  /** Tools this check considers relevant. Advisory only — never permission. */
  suggestedActions: AgentToolName[]
  detectedAt: Date
}

export type CheckError = { checkId: string; error: string }

/** What the deterministic engine returns, whether or not the AI ever runs. */
export type HealthReport = {
  overallStatus: 'healthy' | 'warning' | 'critical'
  findings: AgentFinding[]
  errors: CheckError[]
  checksRun: number
  checkedAt: Date
  /** Rows examined, for the dry-run report and for honesty about coverage. */
  inspected: Record<string, number>
}

export const severityRank: Record<FindingSeverity, number> = { info: 0, warning: 1, critical: 2 }

export const worstSeverity = (list: FindingSeverity[]): FindingSeverity =>
  list.reduce<FindingSeverity>((acc, s) => (severityRank[s] > severityRank[acc] ? s : acc), 'info')

export const statusForSeverity = (s: FindingSeverity): HealthReport['overallStatus'] =>
  s === 'critical' ? 'critical' : s === 'warning' ? 'warning' : 'healthy'

// ── Tools ───────────────────────────────────────────────────────────────

/**
 * THE ALLOWLIST. Every name the agent may ever utter.
 *
 * Read-only inspectors come first, then the narrow repairs, then the
 * bookkeeping tools, then the ones that exist only so a human can be asked.
 * Anything not on this list is not a tool — it is a rejected string.
 */
export const AGENT_TOOL_NAMES = [
  // ── Read-only inspection ──
  'inspectCampaign',
  'inspectCampaignRun',
  'inspectEmailSend',
  'inspectWebhookEvent',
  // ── Narrow, reversible repairs ──
  'reconcileRunCounters',
  'finalizeSettledRun',
  'releaseExpiredLock',
  'reprocessValidWebhookEvent',
  'retryTransientSendOnce',
  // ── Protective stops ──
  'pauseCampaign',
  'pauseMarketingDispatch',
  // ── Bookkeeping ──
  'createIncident',
  'updateIncident',
  'resolveIncident',
  'sendDiscordIncidentAlert',
  'recordLesson',
  'createApprovalRequest',
  // ── Human-only. Present so the agent can ASK; never executable alone. ──
  'resumeMarketingDispatch',
  'resumeCampaign',
  'rescheduleCampaign',
  'dispatchCampaignNow',
  'retryFailedRecipients',
  'removeSuppression',
  'raiseStageRecipientLimit',
  'enableSafeAutoMode',
] as const

export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number]

export const isAgentToolName = (v: unknown): v is AgentToolName =>
  typeof v === 'string' && (AGENT_TOOL_NAMES as readonly string[]).includes(v)

export const agentToolNameSchema = z.enum(AGENT_TOOL_NAMES)

// ── Policy ──────────────────────────────────────────────────────────────

export type PolicyClassification = 'automatic' | 'approval_required' | 'forbidden'

export type PolicyDecision =
  | { classification: 'automatic'; reason: string }
  | { classification: 'approval_required'; reason: string }
  | { classification: 'forbidden'; reason: string }

// ── Memory ──────────────────────────────────────────────────────────────

export type IncidentMemory = {
  reference: string
  status: string
  severity: string
  category: string
  checkIds: string[]
  title: string
  summary: string
  probableCause: string | null
  resolution: string | null
  firstDetectedAt: string
  lastDetectedAt: string
  detectionCount: number
}

export type ActionMemory = {
  toolName: string
  status: string
  policyClassification: string
  /** What it touched, as ids only — never customer data. */
  subject: string | null
  error: string | null
  at: string
}

export type PatternMemory = {
  patternKey: string
  title: string
  symptoms: string[]
  probableCause: string
  successfulResolution: string | null
  failedApproaches: string[]
  confidence: number
  occurrences: number
  falsePositives: number
}

/**
 * Exactly what a model is allowed to remember. Assembled per cycle from
 * relevance, not from history — a full transcript is both expensive and, worse,
 * a way for stale conclusions to outvote current evidence.
 */
export type AgentMemoryBundle = {
  /** Permanent safety rules. The model cannot edit these; see memory.ts. */
  operatingRules: string[]
  currentSystemSummary: string
  relatedOpenIncidents: IncidentMemory[]
  recentSimilarIncidents: IncidentMemory[]
  recentActions: ActionMemory[]
  knownPatterns: PatternMemory[]
}

// ── AI input / output ───────────────────────────────────────────────────

export type AgentAnalysisInput = {
  mode: EmailAgentMode
  stageRecipientLimit: number
  /** Redacted findings — this is the model's whole view of the system. */
  findings: Array<{
    id: string
    checkId: string
    severity: FindingSeverity
    category: FindingCategory
    title: string
    description: string
    evidence: Record<string, unknown>
    campaignId?: string
    runRefId?: string
    sendId?: string
    firstDetectedAt: string
  }>
  availableTools: Array<{ name: AgentToolName; description: string; classification: PolicyClassification }>
  policySummary: string[]
  memory: AgentMemoryBundle
}

/**
 * The ONLY shape a model reply may take. Anything else is discarded — and
 * discarded once, not retried in a loop, because a model that cannot produce
 * valid JSON twice in a row will not produce it on the fifth attempt either
 * and every attempt costs money.
 */
export const agentDecisionSchema = z
  .object({
    overallStatus: z.enum(['healthy', 'warning', 'critical']),
    summary: z.string().min(1).max(1200),
    technicalExplanation: z.string().min(1).max(3000),
    probableCause: z.string().max(1200).optional(),
    confidence: z.number().min(0).max(1),
    relatedFindingIds: z.array(z.string().max(64)).max(200).default([]),
    recommendation: z.discriminatedUnion('type', [
      z.object({ type: z.literal('none') }),
      z.object({
        type: z.literal('tool'),
        toolName: agentToolNameSchema,
        arguments: z.record(z.unknown()).default({}),
        rationale: z.string().min(1).max(1200),
      }),
      z.object({
        type: z.literal('approval_request'),
        toolName: agentToolNameSchema,
        arguments: z.record(z.unknown()).default({}),
        rationale: z.string().min(1).max(1200),
        approvalQuestion: z.string().min(1).max(600),
      }),
    ]),
    memoryLessonCandidate: z
      .object({ patternKey: z.string().min(1).max(120), summary: z.string().min(1).max(800) })
      .optional(),
  })
  .strict()

export type AgentDecision = z.infer<typeof agentDecisionSchema>

/** The provider abstraction. Adapters implement exactly this and nothing more. */
export interface EmailAgentModelProvider {
  readonly name: string
  readonly model: string
  analyze(input: AgentAnalysisInput): Promise<AgentProviderResult>
}

export type AgentProviderResult =
  | {
      ok: true
      decision: AgentDecision
      requestId?: string
      usage?: {
        promptTokens?: number
        completionTokens?: number
        totalTokens?: number
        /** Served from the provider's prompt cache — billed far cheaper. */
        cachedInputTokens?: number
        /** Billed as OUTPUT, and on a reasoning model often most of it. */
        reasoningTokens?: number
      }
      latencyMs: number
    }
  | {
      ok: false
      /** invalid_output = it answered but not in the contract. error/timeout = it did not answer. */
      outcome: 'invalid_output' | 'error' | 'timeout' | 'disabled'
      error: string
      requestId?: string
      /**
       * Usage on a FAILED call.
       *
       * A model that answered with unparseable JSON still burned tokens and
       * still appears on the invoice. Recording those as free understates the
       * bill and lets the budget drift — the point of a cap is that it counts
       * what was actually spent, not what was usefully spent.
       */
      usage?: {
        promptTokens?: number
        completionTokens?: number
        totalTokens?: number
        cachedInputTokens?: number
        reasoningTokens?: number
      }
      latencyMs: number
    }

// ── Incidents ───────────────────────────────────────────────────────────

export const INCIDENT_STATUSES = [
  'open',
  'investigating',
  'awaiting_approval',
  'mitigated',
  'resolved',
  'ignored',
] as const
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number]

/** Statuses in which an incident is still a live problem. */
export const OPEN_INCIDENT_STATUSES: readonly IncidentStatus[] = [
  'open',
  'investigating',
  'awaiting_approval',
  'mitigated',
]
