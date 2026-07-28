// ════════════════════════════════════════════════════════════════════════
//  HEALTH-CHECK FRAMEWORK (owner spec 2026-07-27)
//  ---------------------------------------------------------------------
//  The vocabulary every deterministic check shares: how a finding is built,
//  how its fingerprint is computed, and where the grace periods live.
//
//  THE GRACE PERIODS ARE THE POINT OF THIS FILE. The difference between a
//  useful monitor and one the owner mutes in a week is whether it can tell
//  "in flight" from "stuck". Every threshold here is stated with the reason
//  it has the value it has, in terms of how the system actually behaves:
//  the campaign sweep runs every five minutes, batches are bounded, and a
//  recipient claim goes stale at fifteen. A run that is four minutes old is
//  not late; it is a snapshot of normal work.
// ════════════════════════════════════════════════════════════════════════

import crypto from 'node:crypto'
import type { AgentFinding, AgentToolName, FindingCategory, FindingSeverity } from '../types'
import type { AgentSettings } from '../settings'

// ── Grace periods and thresholds ────────────────────────────────────────

/**
 * A campaign whose scheduled time has passed by less than this is NOT missed —
 * the dispatch sweep runs every 5 minutes, so up to ~5 minutes of lateness is
 * the design, and 15 gives room for a slow batch or a restart.
 */
export const SCHEDULE_GRACE_MS = 15 * 60_000
/** Past this, the schedule was not merely late; nothing is picking it up. */
export const SCHEDULE_MISSED_CRITICAL_MS = 60 * 60_000

/**
 * A run in a transitional state younger than this is mid-flight. Recipient
 * claims go stale at EMAIL_CAMPAIGN_STALE_MS (15 min by default) and the sweep
 * re-opens them, so a run cannot be diagnosed as stuck before that machinery
 * has had its chance.
 */
export const RUN_MIDFLIGHT_GRACE_MS = 15 * 60_000
/** Warning: past the sweep's own recovery window but still plausibly working. */
export const RUN_STUCK_WARN_MS = 30 * 60_000
/** Critical: no bounded batch takes two hours. */
export const RUN_STUCK_CRITICAL_MS = 2 * 60 * 60_000
/** Preparation is seconds of work; this long means the process died. */
export const RUN_PREPARING_STUCK_MS = 15 * 60_000

/** A recipient claimed for sending longer than this has lost its worker. */
export const RECIPIENT_CLAIM_STALE_MS = 15 * 60_000
/** How long a send may sit mid-attempt before the outcome is unknown. */
export const SEND_INFLIGHT_STALE_MS = 15 * 60_000
/** A scheduled retry this far past due is not queued anywhere. */
export const RETRY_OVERDUE_MS = 30 * 60_000
/** Attempts beyond this on a non-terminal row means the retry loop is broken. */
export const MAX_SEND_ATTEMPTS = 5

/** Provider accepted it this long ago and still no delivery signal. */
export const DELIVERY_SILENCE_MS = 60 * 60_000
/** Webhook received this long after the provider says the event happened. */
export const WEBHOOK_DELAY_MS = 15 * 60_000
/** Side-effect attempts beyond this are a repeating failure, not bad luck. */
export const WEBHOOK_MAX_SIDE_EFFECT_ATTEMPTS = 3

/** Default analysis window. Long enough for a daily pattern, short enough to
 *  keep historical noise out of a live health verdict. */
export const DEFAULT_WINDOW_HOURS = 24
/** How far back the agent looks for structural problems that never expire
 *  (stranded rows, unreconciled counters). These do not heal with time. */
export const STRUCTURAL_WINDOW_DAYS = 90

/** Deliverability limits. Mailbox providers set these, not us. */
export const COMPLAINT_RATE_WARN = 0.001
export const COMPLAINT_RATE_CRITICAL = 0.003
export const BOUNCE_RATE_WARN = 0.02
export const BOUNCE_RATE_CRITICAL = 0.05
/** Below this many sends a rate is arithmetic, not a signal. */
export const RATE_MIN_SAMPLE = 20

/** Clock disagreement between the app process and Postgres. */
export const CLOCK_SKEW_WARN_MS = 60_000
export const CLOCK_SKEW_CRITICAL_MS = 5 * 60_000

/** Cap on rows any single check will name individually. */
export const EVIDENCE_ROW_CAP = 10

// ── Context ─────────────────────────────────────────────────────────────

export type CheckContext = {
  /** One `now` for the whole cycle, so two checks can never disagree about it. */
  now: Date
  settings: AgentSettings
  windowHours: number
  /** Row counts examined, accumulated across checks for the coverage report. */
  inspected: Record<string, number>
  /** True in dry-run: checks must not write, and none of them do anyway. */
  dryRun: boolean
}

export const countInspected = (ctx: CheckContext, key: string, n: number): void => {
  ctx.inspected[key] = (ctx.inspected[key] ?? 0) + n
}

export const since = (ctx: CheckContext, ms: number): Date => new Date(ctx.now.getTime() - ms)
export const windowStart = (ctx: CheckContext): Date => since(ctx, ctx.windowHours * 3600_000)
export const ageMs = (ctx: CheckContext, d: Date | null | undefined): number =>
  d ? ctx.now.getTime() - d.getTime() : 0
export const minutes = (ms: number): number => Math.round(ms / 60_000)
export const hours = (ms: number): string => (ms / 3600_000).toFixed(1)
export const pct = (r: number): string => `${(r * 100).toFixed(2)}%`
export const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many)

// ── Fingerprints ────────────────────────────────────────────────────────

/**
 * The identity of a PROBLEM.
 *
 * Two properties matter and they pull against each other:
 *   STABLE  — the same problem in consecutive cycles must produce the same
 *             fingerprint, or every cycle opens a new incident and the owner
 *             gets paged forever.
 *   SPECIFIC— two different stuck runs must NOT share one, or fixing the first
 *             would silently close the incident covering the second.
 *
 * So the subject parts are the entity ids, never counts, timestamps or
 * messages: "run X has bad counters" keeps its identity while the counters
 * change, and a second bad run gets its own.
 */
export function fingerprint(checkId: string, ...subjectParts: Array<string | number | null | undefined>): string {
  const subject = subjectParts
    .filter((p) => p !== null && p !== undefined && p !== '')
    .map((p) => String(p))
    .join('|')
  const hash = crypto.createHash('sha1').update(`${checkId}::${subject}`).digest('hex').slice(0, 16)
  return `${checkId}:${hash}`
}

// ── Finding construction ────────────────────────────────────────────────

export type FindingInput = {
  checkId: string
  severity: FindingSeverity
  category: FindingCategory
  title: string
  description: string
  evidence?: Record<string, unknown>
  campaignId?: string | null
  runRefId?: string | null
  sendId?: string | null
  webhookEventId?: string | null
  suggestedActions?: AgentToolName[]
  /** Extra identity parts. Defaults to the entity ids present. */
  fingerprintParts?: Array<string | number | null | undefined>
}

export function makeFinding(ctx: CheckContext, input: FindingInput): AgentFinding {
  const parts =
    input.fingerprintParts ?? [input.campaignId, input.runRefId, input.sendId, input.webhookEventId]
  return {
    checkId: input.checkId,
    fingerprint: fingerprint(input.checkId, ...parts),
    severity: input.severity,
    category: input.category,
    title: input.title,
    description: input.description,
    evidence: input.evidence ?? {},
    campaignId: input.campaignId ?? undefined,
    runRefId: input.runRefId ?? undefined,
    sendId: input.sendId ?? undefined,
    webhookEventId: input.webhookEventId ?? undefined,
    suggestedActions: input.suggestedActions ?? [],
    detectedAt: ctx.now,
  }
}

// ── Check registry types ────────────────────────────────────────────────

export type CheckFn = (ctx: CheckContext) => Promise<AgentFinding[]>

export type CheckDefinition = {
  /** Stable id used in findings, memory retrieval and the admin. */
  id: string
  category: FindingCategory
  /** One line: what this check would catch, in the owner's language. */
  intent: string
  /**
   * Every checkId this definition can actually put on a finding.
   *
   * A single query often distinguishes two DIFFERENT problems that deserve
   * their own incidents — "no audience attached" and "audience over the Stage 2
   * limit" come from one pass over the campaigns but must never be merged.
   * Declaring them keeps the catalogue honest: `CHECK_IDS` is then the set of
   * ids that can appear in a finding, which is what memory retrieval and the
   * admin filter on. Omit when the definition only ever emits its own `id`.
   */
  emits?: string[]
  run: CheckFn
}

/** Every checkId a definition can produce, defaulting to its own id. */
export const emittedIds = (def: CheckDefinition): string[] => def.emits ?? [def.id]
