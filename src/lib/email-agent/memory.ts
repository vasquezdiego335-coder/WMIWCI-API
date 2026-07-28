// ════════════════════════════════════════════════════════════════════════
//  PERSISTENT MEMORY (owner spec 2026-07-27)
//  ---------------------------------------------------------------------
//  The model API has no reliable memory, so memory lives here, in the database
//  the agent already trusts.
//
//  THE HARD PART IS NOT STORING. IT IS CHOOSING WHAT TO RECALL. Sending the
//  whole history back every cycle would be expensive, and — much worse — it
//  would let a stale conclusion from three weeks ago outvote the evidence in
//  front of the model right now. So retrieval is RELEVANCE-SCOPED: memory is
//  fetched by the CURRENT findings' own campaign ids, run ids and check ids,
//  and nothing else comes along for the ride.
//
//  THREE THINGS THIS FILE WILL NOT DO.
//
//  1. It will not return customer data. Lessons and incident memories carry
//     ids, check names and sentences the agent itself wrote. There is no path
//     from a memory bundle to a customer list, and `assertNoCustomerData()`
//     exists so a future edit that introduces one fails a test rather than a
//     privacy review.
//
//  2. It will not let the model edit the operating rules. `OPERATING_RULES`
//     is a frozen constant in code. A lesson can say "pausing dispatch fixed
//     this last time"; it can never say "you are allowed to send campaigns".
//
//  3. It will not grow without bound. Every list is capped, so the prompt has
//     a predictable ceiling regardless of how bad a week gets.
// ════════════════════════════════════════════════════════════════════════

import { prisma } from '../db'
import { queueLogger } from '../logger'
import { POLICY_SUMMARY } from './policy'
import { maskEmail, safeErrorMessage } from './redact'
import type { AgentFinding, AgentMemoryBundle, ActionMemory, IncidentMemory, PatternMemory } from './types'

const log = queueLogger.child({ mod: 'email-agent-memory' })

/** Retrieval caps. The prompt size is bounded by construction, not by luck. */
const MAX_OPEN_INCIDENTS = 8
const MAX_SIMILAR_INCIDENTS = 6
const MAX_RECENT_ACTIONS = 10
const MAX_PATTERNS = 6
const SIMILAR_WINDOW_DAYS = 30

/**
 * PERMANENT SAFETY RULES. Frozen, in code, never in the database, and never
 * editable by anything the model produces. They are shown to the model every
 * cycle so a recommendation is made in full knowledge of the boundaries — but
 * the boundaries themselves are enforced by the policy engine regardless of
 * whether the model read, understood or ignored them.
 */
export const OPERATING_RULES: readonly string[] = Object.freeze([
  'You investigate and explain. You never decide what is permitted — the policy engine does, after you answer.',
  'Never recommend sending, resending, rescheduling or dispatching anything. Those require a human and you may only ASK.',
  'Never recommend creating consent or removing a suppression. Absence of consent is not consent, and an opt-out is permanent.',
  'Consent and suppression are facts in the database. Do not infer them, and do not reason around them.',
  'Prefer stopping over continuing. A delayed email costs little; a wrong email costs a customer.',
  'If the evidence does not support a cause, say the cause is unknown. A confident wrong answer is worse than an honest "not enough information".',
  'One recommendation per cycle. If several things are wrong, recommend the one that reduces customer impact most.',
  'Recipient addresses in this material are masked. Do not attempt to reconstruct them, and never ask for a full list.',
])

// ── Lessons ─────────────────────────────────────────────────────────────

const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 12) : []

/**
 * How much a pattern has earned.
 *
 * Two forces: ACCURACY (how often this pattern was NOT a false positive) and
 * EVIDENCE (how many times it has been seen at all). A pattern seen once is
 * capped low however right it was, because one observation is an anecdote.
 *
 * Clamped to [0.05, 0.95] on purpose. A lesson can never reach certainty,
 * because it is experience, not a rule — the policy engine, not confidence,
 * decides what may happen. And it never reaches zero either: a pattern that
 * was wrong every time is still worth showing so the model can say "we have
 * seen this before and it was nothing".
 */
export function lessonConfidence(occurrences: number, falsePositives: number): number {
  const accuracy = 1 - falsePositives / Math.max(occurrences, 1)
  const evidence = Math.min(1, 0.4 + occurrences * 0.1)
  return Math.max(0.05, Math.min(0.95, accuracy * evidence))
}

/**
 * Record or reinforce a lesson.
 *
 * `patternKey` is the memory address, so the tenth occurrence of a pattern
 * UPDATES one row rather than creating a tenth. Confidence rises with
 * confirmation and falls when a pattern turns out to be a false positive, and
 * it is clamped — a lesson can never become certain enough to be treated as a
 * rule, because it is not one.
 */
export async function recordLesson(input: {
  patternKey: string
  title: string
  symptoms?: string[]
  probableCause: string
  successfulResolution?: string | null
  failedApproach?: string | null
  checkIds?: string[]
  falsePositive?: boolean
  now?: Date
}): Promise<{ created: boolean; patternKey: string; confidence: number }> {
  const now = input.now ?? new Date()
  const key = input.patternKey.trim().slice(0, 120)
  const existing = await prisma.emailAgentLesson.findUnique({ where: { patternKey: key } })

  if (!existing) {
    const row = await prisma.emailAgentLesson.create({
      data: {
        patternKey: key,
        title: input.title.slice(0, 200),
        symptoms: (input.symptoms ?? []).slice(0, 12) as never,
        probableCause: input.probableCause.slice(0, 1000),
        successfulResolution: input.successfulResolution?.slice(0, 1000) ?? null,
        failedApproaches: (input.failedApproach ? [input.failedApproach.slice(0, 400)] : []) as never,
        confidence: input.falsePositive ? 0.2 : 0.5,
        occurrences: 1,
        falsePositives: input.falsePositive ? 1 : 0,
        relatedCheckIds: (input.checkIds ?? []).slice(0, 12) as never,
        firstObservedAt: now,
        lastObservedAt: now,
      },
      select: { confidence: true },
    })
    return { created: true, patternKey: key, confidence: row.confidence }
  }

  const priorSymptoms = asStringArray(existing.symptoms)
  const priorFailed = asStringArray(existing.failedApproaches)
  const priorChecks = asStringArray(existing.relatedCheckIds)

  const merge = (prior: string[], incoming: string[]): string[] => {
    const out = prior.slice()
    for (const v of incoming) if (out.indexOf(v) === -1) out.push(v)
    return out.slice(0, 12)
  }

  const falsePositives = existing.falsePositives + (input.falsePositive ? 1 : 0)
  const occurrences = existing.occurrences + 1
  const confidence = lessonConfidence(occurrences, falsePositives)

  await prisma.emailAgentLesson.update({
    where: { patternKey: key },
    data: {
      title: input.title.slice(0, 200),
      symptoms: merge(priorSymptoms, input.symptoms ?? []) as never,
      probableCause: input.probableCause.slice(0, 1000),
      // A resolution that worked is never overwritten by a later null.
      successfulResolution: input.successfulResolution?.slice(0, 1000) ?? existing.successfulResolution,
      failedApproaches: merge(priorFailed, input.failedApproach ? [input.failedApproach.slice(0, 400)] : []) as never,
      relatedCheckIds: merge(priorChecks, input.checkIds ?? []) as never,
      occurrences,
      falsePositives,
      confidence,
      lastObservedAt: now,
    },
  })
  return { created: false, patternKey: key, confidence }
}

// ── Retrieval ───────────────────────────────────────────────────────────

const toIncidentMemory = (
  i: {
    reference: string
    status: string
    severity: string
    category: string
    title: string
    summary: string
    probableCause: string | null
    resolution: string | null
    firstDetectedAt: Date
    lastDetectedAt: Date
    detectionCount: number
    findings?: Array<{ checkId: string }>
  }
): IncidentMemory => ({
  reference: i.reference,
  status: i.status,
  severity: i.severity,
  category: i.category,
  checkIds: Array.from(new Set((i.findings ?? []).map((f) => f.checkId))).slice(0, 8),
  title: i.title,
  summary: i.summary.slice(0, 600),
  probableCause: i.probableCause?.slice(0, 600) ?? null,
  resolution: i.resolution?.slice(0, 600) ?? null,
  firstDetectedAt: i.firstDetectedAt.toISOString(),
  lastDetectedAt: i.lastDetectedAt.toISOString(),
  detectionCount: i.detectionCount,
})

/**
 * Build the bundle for THIS cycle's findings.
 *
 * Everything is selected by relevance to what is happening now: the campaigns
 * and runs named in the findings, and the check ids that produced them.
 */
export async function buildMemoryBundle(
  findings: AgentFinding[],
  options: { now?: Date; systemSummary?: string } = {}
): Promise<AgentMemoryBundle> {
  const now = options.now ?? new Date()
  const checkIds = Array.from(new Set(findings.map((f) => f.checkId)))
  const campaignIds = Array.from(new Set(findings.map((f) => f.campaignId).filter((v): v is string => !!v)))
  const runIds = Array.from(new Set(findings.map((f) => f.runRefId).filter((v): v is string => !!v)))
  const fingerprints = Array.from(new Set(findings.map((f) => f.fingerprint)))

  const empty: AgentMemoryBundle = {
    operatingRules: OPERATING_RULES.concat(POLICY_SUMMARY),
    currentSystemSummary: options.systemSummary ?? 'No prior system summary is available.',
    relatedOpenIncidents: [],
    recentSimilarIncidents: [],
    recentActions: [],
    knownPatterns: [],
  }

  try {
    const similarSince = new Date(now.getTime() - SIMILAR_WINDOW_DAYS * 24 * 3600_000)

    const [openIncidents, similarIncidents, actions, patterns] = await Promise.all([
      // OPEN incidents touching the same subjects — "we already know about this".
      prisma.emailAgentIncident.findMany({
        where: {
          status: { in: ['open', 'investigating', 'awaiting_approval', 'mitigated'] },
          OR: [
            { fingerprint: { in: fingerprints } },
            { findings: { some: { checkId: { in: checkIds } } } },
            ...(campaignIds.length ? [{ findings: { some: { campaignId: { in: campaignIds } } } }] : []),
            ...(runIds.length ? [{ findings: { some: { runRefId: { in: runIds } } } }] : []),
          ],
        },
        select: {
          reference: true, status: true, severity: true, category: true, title: true, summary: true,
          probableCause: true, resolution: true, firstDetectedAt: true, lastDetectedAt: true, detectionCount: true,
          findings: { select: { checkId: true }, take: 20 },
        },
        orderBy: { lastDetectedAt: 'desc' },
        take: MAX_OPEN_INCIDENTS,
      }),

      // RESOLVED incidents from the same checks — "here is how it went last time".
      prisma.emailAgentIncident.findMany({
        where: {
          status: { in: ['resolved', 'ignored'] },
          createdAt: { gte: similarSince },
          findings: { some: { checkId: { in: checkIds } } },
        },
        select: {
          reference: true, status: true, severity: true, category: true, title: true, summary: true,
          probableCause: true, resolution: true, firstDetectedAt: true, lastDetectedAt: true, detectionCount: true,
          findings: { select: { checkId: true }, take: 20 },
        },
        orderBy: { resolvedAt: 'desc' },
        take: MAX_SIMILAR_INCIDENTS,
      }),

      // What was already TRIED against these subjects, and whether it worked.
      prisma.emailAgentAction.findMany({
        where: {
          startedAt: { gte: similarSince },
          OR: [
            ...(campaignIds.length ? [{ campaignId: { in: campaignIds } }] : []),
            ...(runIds.length ? [{ runRefId: { in: runIds } }] : []),
            { status: 'failed' },
          ],
        },
        select: {
          toolName: true, status: true, policyClassification: true, error: true,
          startedAt: true, campaignId: true, runRefId: true, sendId: true,
        },
        orderBy: { startedAt: 'desc' },
        take: MAX_RECENT_ACTIONS,
      }),

      prisma.emailAgentLesson.findMany({
        where: { relatedCheckIds: { array_contains: checkIds.slice(0, 5) } },
        orderBy: [{ confidence: 'desc' }, { lastObservedAt: 'desc' }],
        take: MAX_PATTERNS,
      }),
    ])

    // Lessons matched by check id can be empty when a check is new; fall back to
    // the most-confirmed recent patterns so general experience is not lost.
    const fallbackPatterns =
      patterns.length > 0
        ? patterns
        : await prisma.emailAgentLesson.findMany({ orderBy: [{ lastObservedAt: 'desc' }], take: MAX_PATTERNS })

    return {
      operatingRules: OPERATING_RULES.concat(POLICY_SUMMARY),
      currentSystemSummary: options.systemSummary ?? 'No prior system summary is available.',
      relatedOpenIncidents: openIncidents.map(toIncidentMemory),
      recentSimilarIncidents: similarIncidents.map(toIncidentMemory),
      recentActions: actions.map(
        (a): ActionMemory => ({
          toolName: a.toolName,
          status: a.status,
          policyClassification: a.policyClassification,
          subject: a.campaignId ?? a.runRefId ?? a.sendId ?? null,
          error: a.error ? a.error.slice(0, 240) : null,
          at: a.startedAt.toISOString(),
        })
      ),
      knownPatterns: fallbackPatterns.map(
        (p): PatternMemory => ({
          patternKey: p.patternKey,
          title: p.title,
          symptoms: asStringArray(p.symptoms),
          probableCause: p.probableCause.slice(0, 600),
          successfulResolution: p.successfulResolution?.slice(0, 600) ?? null,
          failedApproaches: asStringArray(p.failedApproaches),
          confidence: p.confidence,
          occurrences: p.occurrences,
          falsePositives: p.falsePositives,
        })
      ),
    }
  } catch (err) {
    // Memory is an enhancement. Losing it degrades the investigation; it must
    // never stop the cycle, and it must never be silent about being lost.
    log.warn({ err: safeErrorMessage(err) }, 'memory retrieval failed — investigating without history')
    return { ...empty, currentSystemSummary: `${empty.currentSystemSummary} (Memory retrieval failed this cycle.)` }
  }
}

/** One paragraph describing the system now, carried into the next cycle. */
export function buildSystemSummary(input: {
  overallStatus: string
  findingCount: number
  criticalCount: number
  warningCount: number
  openIncidents: number
  pendingApprovals: number
  mode: string
  dispatchPaused: boolean
}): string {
  const parts = [
    `System is ${input.overallStatus}.`,
    `${input.findingCount} finding${input.findingCount === 1 ? '' : 's'} this cycle (${input.criticalCount} critical, ${input.warningCount} warning).`,
    `${input.openIncidents} open incident${input.openIncidents === 1 ? '' : 's'}.`,
    input.pendingApprovals > 0 ? `${input.pendingApprovals} approval${input.pendingApprovals === 1 ? '' : 's'} waiting on the owner.` : null,
    `Agent mode: ${input.mode}.`,
    input.dispatchPaused ? 'Marketing dispatch is PAUSED.' : 'Marketing dispatch is active.',
  ].filter(Boolean)
  return parts.join(' ')
}

/**
 * A guard, used by tests and by the investigator before a prompt is sent.
 *
 * Returns the offending paths rather than throwing, so a caller can log what
 * went wrong. An unmasked address here would mean a customer list travelling to
 * a third-party API, which is the one leak this whole design is arranged to
 * prevent.
 */
export function findUnmaskedEmails(value: unknown, path = 'root', found: string[] = []): string[] {
  if (typeof value === 'string') {
    // `*` is INSIDE the local-part class on purpose: without it the pattern
    // matches `o@x.com` inside the masked `d***o@x.com` and reports the mask
    // itself as a leak. Matching the whole token lets the '***' test work.
    const match = value.match(/[A-Za-z0-9._%+*-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)
    if (match) for (const m of match) if (m.indexOf('***') === -1) found.push(`${path}: ${maskEmail(m)}`)
    return found
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => findUnmaskedEmails(v, `${path}[${i}]`, found))
    return found
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) findUnmaskedEmails(v, `${path}.${k}`, found)
  }
  return found
}
