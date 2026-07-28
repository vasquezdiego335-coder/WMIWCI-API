// ════════════════════════════════════════════════════════════════════════
//  CAMPAIGN CHECKS (owner spec 2026-07-27)
//  ---------------------------------------------------------------------
//  The failure this family exists for is SILENT NON-DELIVERY: a campaign the
//  owner believes is scheduled, showing a healthy badge, that the dispatch
//  sweep refuses every five minutes forever. It has happened here (bugs #2
//  and #8), and it is invisible from the campaign card alone.
//
//  The strongest check in the file is `campaign.cannot_dispatch`, and it is
//  strong because it does not reimplement anything: it calls the REAL
//  `preflightCampaign()` — the same pure function the dispatcher calls a
//  microsecond before claiming recipients. Whatever would refuse this campaign
//  at send time is what the owner is told now, in the same words. A
//  reimplementation would drift, and a monitor that disagrees with the thing
//  it monitors is worse than none.
// ════════════════════════════════════════════════════════════════════════

import type { CampaignStatus } from '@prisma/client'
import { prisma } from '../../db'
import { preflightCampaign } from '../../email-campaign-dispatch'
import { needsReapproval } from '../../email-campaign-approval'
import { maskEmail } from '../redact'
import type { AgentFinding } from '../types'
import {
  EVIDENCE_ROW_CAP,
  SCHEDULE_GRACE_MS,
  SCHEDULE_MISSED_CRITICAL_MS,
  ageMs,
  countInspected,
  makeFinding,
  minutes,
  plural,
  type CheckContext,
  type CheckDefinition,
} from './shared'

/** States in which a campaign is expected to reach recipients. */
const LIVE_CAMPAIGN_STATES: CampaignStatus[] = ['READY', 'SCHEDULED', 'ACTIVE']

/**
 * The full campaign + email config, loaded once per check.
 *
 * The `include` shape is inline rather than extracted to a constant because
 * Prisma derives the result type from the literal at the call site; hoisting it
 * erases `emailConfig` from the inferred type.
 */
async function loadLiveCampaigns(ctx: CheckContext) {
  const rows = await prisma.marketingCampaign.findMany({
    where: { channel: 'EMAIL', status: { in: LIVE_CAMPAIGN_STATES } },
    include: { emailConfig: { include: { audience: true } } },
    take: 200,
  })
  countInspected(ctx, 'campaigns', rows.length)
  return rows
}

type LoadedCampaign = Awaited<ReturnType<typeof loadLiveCampaigns>>[number]

// ── 1. Scheduled time passed with no run ────────────────────────────────

/**
 * THE headline check. Distinguishes three cases the owner experiences very
 * differently: not late, late but a sweep will get it, and nothing is coming.
 */
const scheduleMissed: CheckDefinition = {
  id: 'campaign.schedule_missed',
  category: 'campaign',
  intent: 'A campaign whose send time has passed and for which no run was ever created.',
  run: async (ctx) => {
    const campaigns = await loadLiveCampaigns(ctx)
    const findings: AgentFinding[] = []

    for (const c of campaigns) {
      const cfg = c.emailConfig
      if (!cfg?.scheduledAt || c.status !== 'SCHEDULED') continue
      const late = ageMs(ctx, cfg.scheduledAt)
      // WITHIN GRACE = NORMAL. The sweep runs every 5 minutes; being 3 minutes
      // past the scheduled minute is the design working, not a fault.
      if (late < SCHEDULE_GRACE_MS) continue

      const runs = await prisma.emailCampaignRun.count({
        where: { campaignId: c.id, startedAt: { gte: cfg.scheduledAt } },
      })
      if (runs > 0) continue // it did dispatch; lateness is already history

      const critical = late >= SCHEDULE_MISSED_CRITICAL_MS
      findings.push(
        makeFinding(ctx, {
          checkId: 'campaign.schedule_missed',
          severity: critical ? 'critical' : 'warning',
          category: 'campaign',
          campaignId: c.id,
          title: `Campaign "${c.name}" missed its send time`,
          description:
            `"${c.name}" was scheduled for ${cfg.scheduledAt.toISOString()} — ${minutes(late)} minutes ago — and still shows SCHEDULED with no run. ` +
            (cfg.statusNote
              ? `The dispatch sweep recorded why it was refused: ${cfg.statusNote}`
              : 'Nothing has attempted it, which usually means the dispatch sweep is not running at all.'),
          evidence: {
            campaignName: c.name,
            scheduledAt: cfg.scheduledAt.toISOString(),
            minutesLate: minutes(late),
            statusNote: cfg.statusNote,
            template: cfg.template,
            runsSinceScheduled: runs,
          },
          suggestedActions: ['inspectCampaign', 'createApprovalRequest'],
        })
      )
    }
    return findings
  },
}

// ── 2. Approved, but the approval no longer describes this campaign ─────

const approvalStale: CheckDefinition = {
  id: 'campaign.approval_invalidated',
  category: 'campaign',
  intent: 'A campaign was edited after approval, so its approval no longer authorises anything.',
  run: async (ctx) => {
    const campaigns = await loadLiveCampaigns(ctx)
    const findings: AgentFinding[] = []
    for (const c of campaigns) {
      const cfg = c.emailConfig
      if (!cfg?.approvedAt) continue
      // The SAME function the dispatcher uses. Approval invalidation is a
      // send-affecting-config hash comparison, not a timestamp guess.
      if (!needsReapproval(cfg as never)) continue

      findings.push(
        makeFinding(ctx, {
          checkId: 'campaign.approval_invalidated',
          severity: c.status === 'SCHEDULED' ? 'critical' : 'warning',
          category: 'campaign',
          campaignId: c.id,
          title: `Campaign "${c.name}" was edited after approval`,
          description:
            `"${c.name}" is ${c.status} and carries an approval from ${cfg.approvedAt.toISOString()}, but its send-affecting configuration has changed since. ` +
            `Dispatch will refuse it every time until somebody re-validates and re-approves it` +
            (c.status === 'SCHEDULED' ? ' — and it is scheduled, so this is a campaign that will never send.' : '.'),
          evidence: {
            campaignName: c.name,
            status: c.status,
            approvedAt: cfg.approvedAt.toISOString(),
            hasApprovalHash: cfg.approvedConfigHash !== null,
            scheduledAt: cfg.scheduledAt?.toISOString() ?? null,
          },
          suggestedActions: ['inspectCampaign', 'createApprovalRequest'],
        })
      )
    }
    return findings
  },
}

// ── 3. The umbrella: approved but technically or legally undispatchable ──

const cannotDispatch: CheckDefinition = {
  id: 'campaign.cannot_dispatch',
  category: 'campaign',
  intent: 'A campaign in a sending state that the real dispatch preflight would refuse right now.',
  run: async (ctx) => {
    const campaigns = await loadLiveCampaigns(ctx)
    const findings: AgentFinding[] = []
    for (const c of campaigns) {
      if (c.status !== 'SCHEDULED' && c.status !== 'READY') continue
      const cfg = c.emailConfig
      if (!cfg?.approvedAt) continue

      // Run the production preflight. It is pure, so this costs nothing and
      // cannot mutate anything.
      const verdict = preflightCampaign(c as never, ctx.now)
      if (verdict.ok) continue

      // `approval_invalidated` and `schedule_missed` already name their own
      // cases in the owner's terms; this check must not duplicate them into a
      // second incident about the same campaign.
      if (/edited after it was approved/i.test(verdict.error)) continue

      // Promotions being globally disabled is a deployment state, not a
      // per-campaign fault — it belongs to the provider/infrastructure family.
      const isGlobalGate = /Promotional sending is disabled/i.test(verdict.error)
      if (isGlobalGate) continue

      findings.push(
        makeFinding(ctx, {
          checkId: 'campaign.cannot_dispatch',
          severity: c.status === 'SCHEDULED' ? 'critical' : 'warning',
          category: 'campaign',
          campaignId: c.id,
          title: `Campaign "${c.name}" cannot dispatch`,
          description:
            `"${c.name}" is ${c.status} and approved, but the dispatch preflight refuses it: ${verdict.error} ` +
            `Until that is fixed no recipient will receive it, and the campaign card will keep showing a sending state.`,
          evidence: {
            campaignName: c.name,
            status: c.status,
            preflightError: verdict.error,
            template: cfg.template,
            audienceId: cfg.audienceId,
            scheduledAt: cfg.scheduledAt?.toISOString() ?? null,
          },
          suggestedActions: ['inspectCampaign', 'createApprovalRequest'],
        })
      )
    }
    return findings
  },
}

// ── 4. Audience: missing, or above the Stage 2 ceiling ──────────────────

const audienceProblems: CheckDefinition = {
  id: 'campaign.audience',
  category: 'campaign',
  intent: 'A live campaign with no audience, or an audience larger than the Stage 2 recipient limit.',
  emits: ['campaign.no_audience', 'campaign.audience_over_stage_limit'],
  run: async (ctx) => {
    const campaigns = await loadLiveCampaigns(ctx)
    const findings: AgentFinding[] = []
    const limit = ctx.settings.stageRecipientLimit

    for (const c of campaigns) {
      const cfg = c.emailConfig
      if (!cfg) continue

      if (!cfg.audienceId) {
        findings.push(
          makeFinding(ctx, {
            checkId: 'campaign.no_audience',
            severity: c.status === 'SCHEDULED' ? 'critical' : 'warning',
            category: 'campaign',
            campaignId: c.id,
            title: `Campaign "${c.name}" has no audience`,
            description: `"${c.name}" is ${c.status} but no audience is attached, so there is nobody to send it to. Dispatch will refuse it.`,
            evidence: { campaignName: c.name, status: c.status, template: cfg.template },
            suggestedActions: ['inspectCampaign'],
          })
        )
        continue
      }

      // Preview counts are advisory (the audience is recomputed at dispatch),
      // so an over-limit preview is a WARNING about what is coming, while an
      // over-limit RUN is a critical fact about what already happened.
      const preview = cfg.audience?.lastPreviewCount ?? null
      if (preview !== null && preview > limit) {
        findings.push(
          makeFinding(ctx, {
            checkId: 'campaign.audience_over_stage_limit',
            severity: 'warning',
            category: 'campaign',
            campaignId: c.id,
            title: `Campaign "${c.name}" targets more than the Stage 2 limit`,
            description:
              `The audience "${cfg.audience?.name ?? cfg.audienceId}" last previewed at ${preview} recipients, above the Stage 2 ceiling of ${limit}. ` +
              `Stage 2 is a deliberate volume cap while the sending domain builds reputation; raising it is an owner decision, not an automatic one.`,
            evidence: {
              campaignName: c.name,
              audienceName: cfg.audience?.name ?? null,
              previewCount: preview,
              previewedAt: cfg.audience?.lastPreviewAt?.toISOString() ?? null,
              stageLimit: limit,
            },
            suggestedActions: ['inspectCampaign', 'createApprovalRequest'],
          })
        )
      }
    }
    return findings
  },
}

// ── 5. A run that actually exceeded the Stage 2 limit ───────────────────

const runOverStageLimit: CheckDefinition = {
  id: 'campaign.run_over_stage_limit',
  category: 'campaign',
  intent: 'A dispatch already claimed more recipients than the Stage 2 limit allows.',
  run: async (ctx) => {
    const limit = ctx.settings.stageRecipientLimit
    const runs = await prisma.emailCampaignRun.findMany({
      where: { totalRecipients: { gt: limit } },
      select: { id: true, campaignId: true, totalRecipients: true, status: true, startedAt: true },
      orderBy: { startedAt: 'desc' },
      take: EVIDENCE_ROW_CAP,
    })
    countInspected(ctx, 'runs_over_limit', runs.length)
    return runs.map((r) =>
      makeFinding(ctx, {
        checkId: 'campaign.run_over_stage_limit',
        severity: 'critical',
        category: 'campaign',
        campaignId: r.campaignId,
        runRefId: r.id,
        title: 'A dispatch exceeded the Stage 2 recipient limit',
        description:
          `Run ${r.id} claimed ${r.totalRecipients} recipients — the Stage 2 ceiling is ${limit}. ` +
          `Sending above the agreed volume while the domain is young is what causes throttling that takes weeks to undo.`,
        evidence: { totalRecipients: r.totalRecipients, stageLimit: limit, runStatus: r.status, startedAt: r.startedAt.toISOString() },
        suggestedActions: ['inspectCampaignRun', 'pauseMarketingDispatch', 'createApprovalRequest'],
      })
    )
  },
}

// ── 6. Duplicate active schedules ───────────────────────────────────────

const duplicateSchedules: CheckDefinition = {
  id: 'campaign.duplicate_schedule',
  category: 'campaign',
  intent: 'Two live campaigns aimed at the same audience with the same template at the same time.',
  run: async (ctx) => {
    const campaigns = await loadLiveCampaigns(ctx)
    const scheduled = campaigns.filter((c) => c.status === 'SCHEDULED' && c.emailConfig?.scheduledAt)
    const buckets = new Map<string, LoadedCampaign[]>()
    for (const c of scheduled) {
      const cfg = c.emailConfig
      if (!cfg?.scheduledAt) continue
      // Same template + same audience within the same hour is a duplicate
      // schedule in every practical sense: the same people get two copies.
      const hour = new Date(cfg.scheduledAt).toISOString().slice(0, 13)
      const key = `${cfg.template}|${cfg.audienceId ?? 'none'}|${hour}`
      buckets.set(key, [...(buckets.get(key) ?? []), c])
    }
    const findings: AgentFinding[] = []
    for (const [key, group] of Array.from(buckets.entries())) {
      if (group.length < 2) continue
      const ids = group.map((g) => g.id).sort()
      findings.push(
        makeFinding(ctx, {
          checkId: 'campaign.duplicate_schedule',
          severity: 'critical',
          category: 'campaign',
          campaignId: ids[0],
          fingerprintParts: ids,
          title: 'Two campaigns are scheduled to send the same email to the same audience',
          description:
            `${group.length} campaigns (${group.map((g) => `"${g.name}"`).join(', ')}) share a template, an audience and a send hour. ` +
            `If both dispatch, the same people receive the same message twice, which is the fastest route to a spam complaint.`,
          evidence: { key, campaigns: group.map((g) => ({ id: g.id, name: g.name, scheduledAt: g.emailConfig?.scheduledAt?.toISOString() })) },
          suggestedActions: ['inspectCampaign', 'pauseCampaign', 'createApprovalRequest'],
        })
      )
    }
    return findings
  },
}

// ── 7. Schedule that contradicts itself ─────────────────────────────────

const inconsistentSchedule: CheckDefinition = {
  id: 'campaign.schedule_inconsistent',
  category: 'campaign',
  intent: 'A schedule that cannot be right: set before the campaign existed, or approved after it was due.',
  run: async (ctx) => {
    const campaigns = await loadLiveCampaigns(ctx)
    const findings: AgentFinding[] = []
    for (const c of campaigns) {
      const cfg = c.emailConfig
      if (!cfg?.scheduledAt) continue
      const problems: string[] = []
      if (cfg.scheduledAt < c.createdAt) {
        problems.push(`the send time (${cfg.scheduledAt.toISOString()}) is before the campaign was created (${c.createdAt.toISOString()})`)
      }
      if (cfg.approvedAt && cfg.scheduledAt < cfg.approvedAt && c.status === 'SCHEDULED') {
        problems.push(`it was approved (${cfg.approvedAt.toISOString()}) after the moment it was due to send (${cfg.scheduledAt.toISOString()})`)
      }
      if (problems.length === 0) continue
      findings.push(
        makeFinding(ctx, {
          checkId: 'campaign.schedule_inconsistent',
          severity: 'warning',
          category: 'campaign',
          campaignId: c.id,
          title: `Campaign "${c.name}" has a contradictory schedule`,
          description:
            `"${c.name}" carries schedule information that cannot be right: ${problems.join('; ')}. ` +
            `A campaign scheduled into the past dispatches on the very next sweep rather than when the owner intended.`,
          evidence: {
            campaignName: c.name,
            scheduledAt: cfg.scheduledAt.toISOString(),
            approvedAt: cfg.approvedAt?.toISOString() ?? null,
            createdAt: c.createdAt.toISOString(),
            problems,
          },
          suggestedActions: ['inspectCampaign', 'createApprovalRequest'],
        })
      )
    }
    return findings
  },
}

// ── 8. Referral campaign with no destination ────────────────────────────

const referralConfig: CheckDefinition = {
  id: 'campaign.referral_url_missing',
  category: 'campaign',
  intent: 'A referral campaign is live but REFERRAL_URL is not configured, so its link goes nowhere.',
  run: async (ctx) => {
    const campaigns = await loadLiveCampaigns(ctx)
    const referral = campaigns.filter((c) => /referral/i.test(c.emailConfig?.template ?? '') || /referral/i.test(c.sourceKey ?? ''))
    if (referral.length === 0) return []
    const url = process.env.REFERRAL_URL?.trim()
    if (url && !url.includes('REPLACE')) return []
    return [
      makeFinding(ctx, {
        checkId: 'campaign.referral_url_missing',
        severity: 'critical',
        category: 'campaign',
        campaignId: referral[0].id,
        fingerprintParts: ['REFERRAL_URL'],
        title: 'A referral campaign is live but REFERRAL_URL is not set',
        description:
          `${referral.length} referral ${plural(referral.length, 'campaign is', 'campaigns are')} in a sending state, but REFERRAL_URL is not configured. ` +
          `The referral link in the message has no destination, so every recipient who clicks it reaches nothing.`,
        // Presence only. The value of an environment variable is never stored.
        evidence: {
          variable: 'REFERRAL_URL',
          present: false,
          campaigns: referral.slice(0, EVIDENCE_ROW_CAP).map((c) => ({ id: c.id, name: c.name, template: c.emailConfig?.template })),
        },
        suggestedActions: ['pauseCampaign', 'createApprovalRequest'],
      }),
    ]
  },
}

// ── 9. Automations enabled without a complete definition ────────────────

const automationIncomplete: CheckDefinition = {
  id: 'campaign.automation_incomplete',
  category: 'campaign',
  intent: 'An ACTIVE automation with no usable version — it will enroll people and then do nothing.',
  run: async (ctx) => {
    const automations = await prisma.emailAutomation.findMany({
      where: { status: { in: ['ACTIVE', 'TEST'] } },
      select: { id: true, name: true, status: true, activeVersion: true, versions: { select: { version: true }, take: 50 } },
      take: 100,
    })
    countInspected(ctx, 'automations', automations.length)
    const findings: AgentFinding[] = []
    for (const a of automations) {
      const versions = a.versions.map((v) => v.version)
      const missing = a.activeVersion === null || !versions.includes(a.activeVersion)
      if (!missing) continue
      findings.push(
        makeFinding(ctx, {
          checkId: 'campaign.automation_incomplete',
          severity: 'critical',
          category: 'campaign',
          fingerprintParts: [a.id],
          title: `Automation "${a.name}" is ${a.status} without a usable definition`,
          description:
            `"${a.name}" is ${a.status} but its active version is ${a.activeVersion === null ? 'not set' : `${a.activeVersion}, which does not exist`}. ` +
            `Subjects can be enrolled and no stage will ever execute, so people silently drop out of the journey.`,
          evidence: { automationId: a.id, name: a.name, status: a.status, activeVersion: a.activeVersion, availableVersions: versions },
          suggestedActions: ['createApprovalRequest'],
        })
      )
    }
    return findings
  },
}

// ── 10. Recipients who should never have been in a campaign ─────────────

const campaignComplianceRisk: CheckDefinition = {
  id: 'campaign.recipient_compliance_risk',
  category: 'consent',
  intent: 'A live run still holding recipients who are suppressed or have withdrawn consent.',
  emits: ['campaign.pending_recipient_suppressed', 'campaign.pending_recipient_no_consent'],
  run: async (ctx) => {
    // Only OPEN runs matter: a finished run's recipients are history, and the
    // per-send consent recheck already refused anyone who slipped through.
    const runs = await prisma.emailCampaignRun.findMany({
      where: { status: { in: ['PREPARING', 'QUEUED', 'SENDING', 'PAUSED'] } },
      select: { id: true, campaignId: true, status: true },
      take: 20,
    })
    if (runs.length === 0) return []

    const findings: AgentFinding[] = []
    for (const run of runs) {
      const pending = await prisma.emailCampaignRecipient.findMany({
        where: { runId: run.id, status: { in: ['PENDING', 'DEFERRED'] } },
        select: { id: true, email: true },
        take: 500,
      })
      countInspected(ctx, 'recipients', pending.length)
      if (pending.length === 0) continue
      const emails = pending.map((p) => p.email)

      const [suppressed, consenting, consentingLeads] = await Promise.all([
        prisma.emailSuppression.findMany({ where: { email: { in: emails } }, select: { email: true, reason: true, scope: true } }),
        prisma.customer.findMany({ where: { email: { in: emails }, emailMarketingConsent: true }, select: { email: true } }),
        prisma.lead.findMany({ where: { email: { in: emails }, emailMarketingConsent: true }, select: { email: true } }),
      ])

      // Customer.email is required; Lead.email is optional. Normalised
      // separately so a null lead address can never become an empty-string key.
      const consentSet = new Set(
        consenting
          .map((c) => c.email.toLowerCase())
          .concat(consentingLeads.filter((l): l is { email: string } => !!l.email).map((l) => l.email.toLowerCase()))
      )
      const suppressedSet = new Map(suppressed.map((s) => [s.email.toLowerCase(), s]))

      const suppressedPending = pending.filter((p) => suppressedSet.has(p.email.toLowerCase()))
      const unconsented = pending.filter((p) => !consentSet.has(p.email.toLowerCase()))

      if (suppressedPending.length > 0) {
        findings.push(
          makeFinding(ctx, {
            checkId: 'campaign.pending_recipient_suppressed',
            severity: 'critical',
            category: 'suppression',
            campaignId: run.campaignId,
            runRefId: run.id,
            title: 'A live run still holds recipients who are on the suppression list',
            description:
              `Run ${run.id} has ${suppressedPending.length} ${plural(suppressedPending.length, 'recipient', 'recipients')} waiting to send whose ${plural(suppressedPending.length, 'address is', 'addresses are')} suppressed. ` +
              `The per-send guard will refuse them, but the audience was built from state that has since changed — which means the same audience could be reused and produce the same risk.`,
            evidence: {
              runStatus: run.status,
              suppressedPending: suppressedPending.length,
              examples: suppressedPending.slice(0, EVIDENCE_ROW_CAP).map((p) => ({
                recipientId: p.id,
                email: maskEmail(p.email),
                reason: suppressedSet.get(p.email.toLowerCase())?.reason,
              })),
            },
            suggestedActions: ['inspectCampaignRun', 'pauseCampaign', 'pauseMarketingDispatch'],
          })
        )
      }

      if (unconsented.length > 0) {
        findings.push(
          makeFinding(ctx, {
            checkId: 'campaign.pending_recipient_no_consent',
            severity: 'critical',
            category: 'consent',
            campaignId: run.campaignId,
            runRefId: run.id,
            title: 'A live run still holds recipients with no recorded marketing consent',
            description:
              `Run ${run.id} has ${unconsented.length} ${plural(unconsented.length, 'recipient', 'recipients')} waiting to send with no explicit email-marketing opt-in on either their customer or their lead record. ` +
              `Consent is rechecked immediately before each send and they will be refused — but a live run carrying them means the audience definition is producing people who never opted in.`,
            evidence: {
              runStatus: run.status,
              withoutConsent: unconsented.length,
              examples: unconsented.slice(0, EVIDENCE_ROW_CAP).map((p) => ({ recipientId: p.id, email: maskEmail(p.email) })),
            },
            suggestedActions: ['inspectCampaignRun', 'pauseCampaign'],
          })
        )
      }
    }
    return findings
  },
}

export const campaignChecks: CheckDefinition[] = [
  scheduleMissed,
  approvalStale,
  cannotDispatch,
  audienceProblems,
  runOverStageLimit,
  duplicateSchedules,
  inconsistentSchedule,
  referralConfig,
  automationIncomplete,
  campaignComplianceRisk,
]
