// ════════════════════════════════════════════════════════════════════════
//  WHEN TO SPEND A MODEL CALL (owner spec 2026-07-28)
//  ---------------------------------------------------------------------
//  THE BUG THIS FIXES, MEASURED: the agent investigated every open incident
//  on every cycle. At a five-minute cadence that is 288 model calls per day
//  per incident, re-reading identical evidence and producing an identical
//  paragraph. Six open incidents would have been ~1,700 calls a day for no new
//  information — the single largest avoidable cost in the system, and the
//  reason the first live cycle cost 3,677 tokens for findings that had not
//  changed since the cycle before.
//
//  THE FIX IS A HASH, NOT A TIMER. `detectionCount` going up is NOT a reason
//  to re-investigate: it means "still true", which the owner already knows.
//  What earns a model call is a MATERIAL change — different checks firing,
//  a different severity, different affected resources, or different evidence.
//
//  WHAT IS DELIBERATELY EXCLUDED FROM THE HASH: detection counts, timestamps,
//  "N minutes ago" phrasing inside descriptions, and anything else that
//  changes on its own. Including them would make every cycle look "changed"
//  and put the bill straight back where it was.
//
//  Everything here is PURE, so the whole policy is testable without a
//  database, a clock, or a provider.
// ════════════════════════════════════════════════════════════════════════

import crypto from 'node:crypto'
import type { AgentFinding, FindingSeverity } from './types'

/**
 * Stable identity of an incident's MATERIAL evidence.
 *
 * Sorted, so the order findings arrive in cannot change the hash. Evidence is
 * canonicalised through `stableStringify` for the same reason: JSON key order
 * is not guaranteed and a re-ordered object is not a changed object.
 */
export function evidenceHash(findings: AgentFinding[]): string {
  const material = findings
    .map((f) => ({
      checkId: f.checkId,
      fingerprint: f.fingerprint,
      severity: f.severity,
      campaignId: f.campaignId ?? null,
      runRefId: f.runRefId ?? null,
      sendId: f.sendId ?? null,
      webhookEventId: f.webhookEventId ?? null,
      evidence: normaliseEvidence(f.evidence),
    }))
    .sort((a, b) => (a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0))

  return crypto.createHash('sha256').update(stableStringify(material)).digest('hex').slice(0, 32)
}

/**
 * Keys whose values move on their own and must not count as a change.
 *
 * "This run has been stuck for 47 minutes" becomes 48 minutes a minute later.
 * That is the same problem, and hashing it would buy a model call every cycle
 * for the rest of the incident's life.
 */
const VOLATILE_KEY = /^(minutes|seconds|hours|days|age|elapsed|oldest|worst|since|at|time|timestamp|checked|detected|updated|last|next|due)/i
const VOLATILE_SUFFIX = /(Minutes|Seconds|Hours|Days|At|Ago|Age|Elapsed|Overdue|Idle|SinceStart)$/

function normaliseEvidence(evidence: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(evidence ?? {})) {
    if (VOLATILE_KEY.test(k) || VOLATILE_SUFFIX.test(k)) continue
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) continue // ISO timestamp
    if (v && typeof v === 'object') {
      out[k] = Array.isArray(v)
        ? v.slice(0, 10).map((item) => (item && typeof item === 'object' ? normaliseEvidence(item as Record<string, unknown>) : item))
        : normaliseEvidence(v as Record<string, unknown>)
      continue
    }
    out[k] = v
  }
  return out
}

/** JSON with sorted keys, so an equal object always produces an equal string. */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

// ── The decision ────────────────────────────────────────────────────────

export type InvestigationTrigger =
  | 'new_incident'
  | 'reopened'
  | 'severity_changed'
  | 'evidence_changed'
  | 'manual_request'
  | 'cooldown_expired'

export type InvestigationDecision =
  | { investigate: true; trigger: InvestigationTrigger; reason: string }
  | { investigate: false; reason: string }

export type IncidentInvestigationState = {
  /** True when this cycle created the incident. */
  created: boolean
  /** True when a resolved incident came back. */
  reopened: boolean
  /** Severity now vs at the last investigation. */
  severity: FindingSeverity
  previousSeverity: FindingSeverity | null
  /** Material evidence hash now. */
  currentEvidenceHash: string
  /** Hash at the last investigation, null if never investigated. */
  investigatedEvidenceHash: string | null
  lastInvestigatedAt: Date | null
  reinvestigateRequestedAt: Date | null
}

/**
 * Should a model be spent on this incident right now?
 *
 * Ordered by strength of signal, and the ordering is the point: a manual
 * request beats everything, real change beats a timer, and a timer is the
 * last resort rather than the default.
 */
export function shouldInvestigate(
  state: IncidentInvestigationState,
  options: { now: Date; cooldownHours: number }
): InvestigationDecision {
  // 1. A human asked. Always honoured — this is the escape hatch that makes
  //    aggressive deduplication safe to run.
  if (state.reinvestigateRequestedAt) {
    return { investigate: true, trigger: 'manual_request', reason: 'An operator asked for a fresh investigation.' }
  }

  // 2. Never looked at before. A new incident always earns one call.
  if (state.lastInvestigatedAt === null) {
    return {
      investigate: true,
      trigger: state.created ? 'new_incident' : 'evidence_changed',
      reason: state.created ? 'A new incident was opened.' : 'This incident has never been investigated.',
    }
  }

  // 3. It came back from the dead. A recurrence is a different story from a
  //    first occurrence and deserves its own explanation.
  if (state.reopened) {
    return { investigate: true, trigger: 'reopened', reason: 'The incident reopened after being resolved.' }
  }

  // 4. Severity moved in EITHER direction. Getting worse obviously matters;
  //    getting better matters too, because the owner should be told the thing
  //    they were alerted about has eased.
  if (state.previousSeverity !== null && state.previousSeverity !== state.severity) {
    return {
      investigate: true,
      trigger: 'severity_changed',
      reason: `Severity changed from ${state.previousSeverity} to ${state.severity}.`,
    }
  }

  // 5. The evidence itself is materially different.
  if (state.investigatedEvidenceHash !== state.currentEvidenceHash) {
    return { investigate: true, trigger: 'evidence_changed', reason: 'The underlying evidence changed since the last investigation.' }
  }

  // 6. Nothing changed — but a long-lived incident is worth a fresh look
  //    occasionally, because the surrounding system may have moved even when
  //    this incident's own evidence did not.
  const ageMs = options.now.getTime() - state.lastInvestigatedAt.getTime()
  const cooldownMs = Math.max(1, options.cooldownHours) * 3600_000
  if (ageMs >= cooldownMs) {
    return {
      investigate: true,
      trigger: 'cooldown_expired',
      reason: `Unchanged, but not investigated for ${Math.round(ageMs / 3600_000)} hours (cooldown ${options.cooldownHours}h).`,
    }
  }

  // 7. THE COMMON CASE, and the whole point of this file.
  const hoursLeft = Math.max(0, (cooldownMs - ageMs) / 3600_000)
  return {
    investigate: false,
    reason: `Unchanged since the last investigation ${Math.round(ageMs / 60_000)} minutes ago. Detection count rising is not a change. Next look in ${hoursLeft.toFixed(1)}h unless something moves.`,
  }
}

/**
 * Pick the ONE incident worth a model call this cycle.
 *
 * The budget allows very few calls, so spending them well matters more than
 * spending them fairly: worst severity first, then the incident that has gone
 * longest without a look. Callers slice to their remaining budget.
 */
export function rankForInvestigation<T extends { severity: FindingSeverity; lastInvestigatedAt: Date | null; trigger: InvestigationTrigger }>(
  candidates: T[]
): T[] {
  const severityRank: Record<FindingSeverity, number> = { critical: 3, warning: 2, info: 1 }
  const triggerRank: Record<InvestigationTrigger, number> = {
    manual_request: 6,
    new_incident: 5,
    reopened: 4,
    severity_changed: 3,
    evidence_changed: 2,
    cooldown_expired: 1,
  }
  return candidates.slice().sort((a, b) => {
    const t = triggerRank[b.trigger] - triggerRank[a.trigger]
    if (t !== 0) return t
    const s = severityRank[b.severity] - severityRank[a.severity]
    if (s !== 0) return s
    const at = a.lastInvestigatedAt?.getTime() ?? 0
    const bt = b.lastInvestigatedAt?.getTime() ?? 0
    return at - bt // longest un-investigated first
  })
}
