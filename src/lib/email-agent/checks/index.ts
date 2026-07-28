// ════════════════════════════════════════════════════════════════════════
//  THE DETERMINISTIC HEALTH ENGINE (owner spec 2026-07-27)
//  ---------------------------------------------------------------------
//  THIS IS THE SOURCE OF TRUTH. Every finding in the system is produced here,
//  by SQL and comparisons. No model contributes a finding, changes a severity,
//  or removes one. The AI reads this output; it never writes it.
//
//  TWO PROPERTIES MATTER MORE THAN COVERAGE.
//
//  1. A CHECK THAT THROWS IS ITSELF AN ALERT. A monitor that returns "healthy"
//     because its query failed is worse than no monitor, because it converts an
//     unknown into a reassurance. Failures are collected, counted, and force
//     the overall verdict to critical.
//
//  2. ONE FAILING CHECK MUST NOT SILENCE THE OTHERS. Each runs independently,
//     so a bad DNS lookup cannot stop the complaint-rate check from firing.
//
//  The engine is READ-ONLY by construction: nothing in this directory writes to
//  the email system. Persistence belongs to the runner, which is the only part
//  that can be told to run in dry-run mode — and in dry-run mode there is
//  nothing to disable here, because there is nothing here that writes.
// ════════════════════════════════════════════════════════════════════════

import { queueLogger } from '../../logger'
import { safeErrorMessage } from '../redact'
import { type AgentSettings, envDefaults } from '../settings'
import {
  type AgentFinding,
  type CheckError,
  type HealthReport,
  statusForSeverity,
  worstSeverity,
} from '../types'
import { DEFAULT_WINDOW_HOURS, emittedIds, type CheckContext, type CheckDefinition } from './shared'
import { campaignChecks } from './campaign'
import { runChecks } from './run'
import { sendChecks } from './send'
import { consentChecks } from './consent'
import { webhookChecks } from './webhook'
import { providerChecks } from './provider'
import { schedulerChecks } from './scheduler'
import { infrastructureChecks } from './infrastructure'

const log = queueLogger.child({ mod: 'email-agent-checks' })

/**
 * Every check, in the order they run.
 *
 * Infrastructure is FIRST on purpose: if the required configuration is missing
 * or a migration is unapplied, the rest of the report should be read in that
 * light, and putting it first means the owner reads it first too.
 */
export const ALL_CHECKS: CheckDefinition[] = [
  ...infrastructureChecks,
  ...schedulerChecks,
  ...providerChecks,
  ...webhookChecks,
  ...consentChecks,
  ...campaignChecks,
  ...runChecks,
  ...sendChecks,
]

/**
 * Every checkId that can appear on a finding — not every DEFINITION id.
 *
 * Several definitions run one query and distinguish two different problems
 * from it (no audience vs audience over the limit; a stuck run vs an abandoned
 * preparation). Memory retrieval and the admin filter on the id a finding
 * actually carries, so this must be the emitted set or both would silently
 * miss half the checks.
 */
export const CHECK_IDS: string[] = Array.from(new Set(ALL_CHECKS.flatMap((c) => emittedIds(c))))

/** The catalogue, for the admin and for the dry-run report. */
export const checkCatalogue = (): Array<{ id: string; category: string; intent: string; emits: string[] }> =>
  ALL_CHECKS.map((c) => ({ id: c.id, category: c.category, intent: c.intent, emits: emittedIds(c) }))

export type RunChecksOptions = {
  settings?: AgentSettings
  now?: Date
  windowHours?: number
  dryRun?: boolean
  /** Restrict to a subset — used by the dry-run tool and by tests. */
  only?: string[]
}

/**
 * Run the whole deterministic suite and return a normalized report.
 *
 * Never throws. A total failure produces a report whose `errors` explain it,
 * because "the health engine could not run" must be reportable in the same
 * shape as any other problem.
 */
export async function runHealthChecks(options: RunChecksOptions = {}): Promise<HealthReport> {
  const now = options.now ?? new Date()
  const settings = options.settings ?? envDefaults()
  const ctx: CheckContext = {
    now,
    settings,
    windowHours: options.windowHours ?? DEFAULT_WINDOW_HOURS,
    inspected: {},
    dryRun: options.dryRun ?? false,
  }

  const selected = options.only ? ALL_CHECKS.filter((c) => options.only!.includes(c.id)) : ALL_CHECKS

  const findings: AgentFinding[] = []
  const errors: CheckError[] = []

  for (const check of selected) {
    try {
      const produced = await check.run(ctx)
      for (const f of produced) findings.push(f)
    } catch (err) {
      // A check that cannot run is a finding about the check, not a pass.
      errors.push({ checkId: check.id, error: safeErrorMessage(err) })
      log.error({ check: check.id, err: safeErrorMessage(err) }, 'email agent check FAILED to run')
    }
  }

  // Deduplicate defensively: two checks may legitimately notice the same thing
  // (a stuck run is also a campaign that cannot dispatch), and the incident
  // manager keys on fingerprint, so a duplicate here would double-count.
  const seen = new Set<string>()
  const unique = findings.filter((f) => {
    if (seen.has(f.fingerprint)) return false
    seen.add(f.fingerprint)
    return true
  })

  const severity = worstSeverity(unique.map((f) => f.severity))
  // An unrunnable check forces critical. We do not know that the system is
  // healthy; we know that we cannot tell, and those are different answers.
  const overallStatus = errors.length > 0 ? 'critical' : statusForSeverity(severity)

  return {
    overallStatus,
    findings: unique,
    errors,
    checksRun: selected.length,
    checkedAt: now,
    inspected: ctx.inspected,
  }
}

export * from './shared'
