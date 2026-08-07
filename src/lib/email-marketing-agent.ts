// ════════════════════════════════════════════════════════════════════════
//  AI MARKETING AGENT — campaign discovery, drafting, and the Discord ask
//  (owner spec 2026-08-07)
//  ---------------------------------------------------------------------
//  WHAT THIS IS. The counterpart to the email OPERATIONS agent
//  (src/lib/email-agent/**, which watches delivery health): this one watches
//  the REACTIVATION POOL. On a schedule it asks the deterministic audience
//  layer "is there a meaningful group of people we may market to?", and when
//  there is, it drafts a campaign, saves it as a DRAFT in the existing
//  campaign system, and posts an aggregate-only notice to the owner's Discord
//  marketing channel.
//
//  WHAT IT IS NOT. It is not a sender, and it cannot become one:
//    • it creates campaigns exclusively in DRAFT — dispatch requires the
//      existing validate → approve → start chain in the admin, each step
//      permission-checked server-side;
//    • WHO qualifies is decided by email-audience.ts (deterministic SQL +
//      the shared consent/suppression/lifecycle exclusions), never by the
//      model — the AI receives AGGREGATE COUNTS and business facts only, no
//      names, no addresses, no per-customer anything;
//    • the final recipient list is recomputed at dispatch time
//      (resolveAudienceForDispatch), so someone who books, unsubscribes or
//      re-enters a lifecycle between draft and approval is dropped;
//    • every actual send still passes guardedSend.
//
//  THE AI's ONLY JOB is copy: subject, preview line, a rationale sentence,
//  and whether to lead with the 10% first-time offer. A deterministic draft
//  exists for every opportunity FIRST; the model may improve it, and any
//  provider failure, malformed reply, or missing API key silently keeps the
//  deterministic version. Discovery therefore works with zero AI configured.
//
//  BOUNDED BY CONSTRUCTION: one sweep per day (cron), at most ONE campaign
//  drafted per sweep, one AI call per drafted campaign, a minimum audience
//  size below which nothing happens, and a per-segment cooldown so the same
//  suggestion is never re-posted day after day.
//
//  FLAG-GATED OFF. EMAIL_MARKETING_AGENT_ENABLED must be 'true' or the sweep
//  returns immediately — deploying this code changes nothing until the owner
//  turns it on.
// ════════════════════════════════════════════════════════════════════════

import { z } from 'zod'
import { prisma } from './db'
import { queueLogger } from './logger'
import { previewAudience, type AudiencePreview, type SegmentKey } from './email-audience'
import { DISCOUNT_POLICY } from './pricing-config'
import { extractJson } from './email-agent/providers'

const log = queueLogger.child({ mod: 'email-marketing-agent' })

// ── Flags + knobs ───────────────────────────────────────────────────────

export const marketingAgentEnabled = (): boolean => process.env.EMAIL_MARKETING_AGENT_ENABLED === 'true'

/** Below this many eligible people, an opportunity is not worth the owner's
 *  attention (owner: "1–2 eligible people → probably no campaign"). */
export const MIN_AUDIENCE = Math.max(1, Number(process.env.EMAIL_MARKETING_AGENT_MIN_AUDIENCE) || 5)

/** Days before the SAME segment may be suggested again. Also the shield
 *  against re-mailing a segment that just received a campaign: the cooldown
 *  is keyed on campaign creation, and a sent campaign was created. */
export const SUGGESTION_COOLDOWN_DAYS = Math.max(1, Number(process.env.EMAIL_MARKETING_AGENT_COOLDOWN_DAYS) || 14)

/** The Discord channel campaign opportunities are posted to. Env-overridable;
 *  the default is the marketing channel the owner designated. */
export const MARKETING_CHANNEL_ID = () =>
  process.env.DISCORD_CHANNEL_MARKETING?.trim() || '1514630043605925938'

// ── The playbook: what a discovered opportunity looks like per segment ──
//  Each entry pairs a reactivation segment with the ONE template that is
//  honest for it (mirrors email-recipient-context.templateAllowsSegment) and
//  a deterministic draft. `suggestDiscount` marks the audiences cold enough
//  that leading with the 10% first-time offer is worth the margin — a fresh
//  high-intent lead gets the normal lifecycle first, at full price.
export type PlaybookEntry = {
  segment: SegmentKey
  campaignName: string
  template: string
  suggestDiscount: boolean
  draft: { subject: string; previewText: string; rationale: string }
}

export const PLAYBOOK: readonly PlaybookEntry[] = [
  {
    segment: 'quick_quote_reactivation',
    campaignName: 'Quick quote reactivation',
    template: 'quote-followup-final',
    suggestDiscount: true,
    draft: {
      subject: 'Still planning your move?',
      previewText: 'Your quote is ready when you are — and first-time customers save 10%.',
      rationale:
        'These people asked for a real price, received one, finished the follow-up sequence 14+ days ago, and never booked. A single, honest check-in with the first-time discount is the standard play for this group.',
    },
  },
  {
    segment: 'contact_lead_reactivation',
    campaignName: 'Contact lead reactivation',
    template: 'lead-nurture-final',
    suggestDiscount: false,
    draft: {
      subject: 'Do you still need moving help?',
      previewText: 'Get a real price in about a minute — no visit needed.',
      rationale:
        'These people wrote to us, opted in, never got a quote, and have been quiet for 14+ days. The honest ask is the estimate itself, so the draft points at the quick-quote page rather than a discount.',
    },
  },
]

// ── AI copy pass (optional, aggregate-only, fails soft) ─────────────────

const CopySchema = z
  .object({
    subject: z.string().min(4).max(80),
    previewText: z.string().min(4).max(140),
    rationale: z.string().min(10).max(500),
    useDiscount: z.boolean(),
  })
  .strict()

export type CampaignCopy = z.infer<typeof CopySchema>

/**
 * Ask the configured model to improve the deterministic draft. AGGREGATE data
 * only: nothing about any individual person enters the prompt. Every failure
 * path — no key, HTTP error, timeout, malformed JSON, schema mismatch —
 * returns null and the caller keeps the deterministic draft.
 */
export async function draftCampaignCopy(
  entry: PlaybookEntry,
  preview: Pick<AudiencePreview, 'eligible' | 'excluded'>,
  env: NodeJS.ProcessEnv = process.env
): Promise<CampaignCopy | null> {
  const key = env.DEEPSEEK_API_KEY?.trim() || env.OPENAI_API_KEY?.trim()
  if (!key) return null
  const isDeepseek = Boolean(env.DEEPSEEK_API_KEY?.trim())
  const baseUrl = (isDeepseek ? env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/v1' : env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/+$/, '')
  const model = isDeepseek ? env.EMAIL_AGENT_MODEL ?? 'deepseek-v4-flash' : env.EMAIL_AGENT_FALLBACK_MODEL ?? 'gpt-5.4-nano'

  const prompt = [
    'You write short, honest marketing email copy for Move It Clear It, a moving-labor company in New Jersey.',
    'Improve the draft below. Rules: no invented facts, no fake urgency, no all-caps, no "act now", no claims about the customer you cannot know.',
    `Audience (aggregate only): ${preview.eligible} eligible people in the segment "${entry.campaignName}".`,
    `Discount available: ${entry.suggestDiscount ? `a ${DISCOUNT_POLICY.maxPublicPercent}% first-time discount, applied automatically at booking` : 'none for this audience'}.`,
    `Current draft subject: ${entry.draft.subject}`,
    `Current draft preview text: ${entry.draft.previewText}`,
    'Reply with ONLY a JSON object: {"subject": string (max 80 chars), "previewText": string (max 140), "rationale": string (one or two sentences on why this campaign makes sense now), "useDiscount": boolean}.',
  ].join('\n')

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30_000)
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        max_tokens: 600,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer))
    if (!res.ok) {
      log.warn({ status: res.status, model }, 'copy draft call rejected — keeping the deterministic draft')
      return null
    }
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const content = body.choices?.[0]?.message?.content
    if (!content) return null
    const parsed = CopySchema.safeParse(extractJson(content))
    if (!parsed.success) {
      log.warn({ model }, 'copy draft failed validation — keeping the deterministic draft')
      return null
    }
    // The model may not grant a discount the playbook did not offer.
    if (parsed.data.useDiscount && !entry.suggestDiscount) parsed.data.useDiscount = false
    return parsed.data
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'copy draft errored — keeping the deterministic draft')
    return null
  }
}

// ── Discord notice (aggregate counts only — never a customer identity) ──

async function postCampaignOpportunity(input: {
  campaignName: string
  campaignId: string
  segmentLabel: string
  rationale: string
  subject: string
  eligible: number
  excluded: AudiencePreview['excluded']
  useDiscount: boolean
}): Promise<boolean> {
  const token = process.env.DISCORD_BOT_TOKEN?.trim()
  const channelId = MARKETING_CHANNEL_ID()
  if (!token || !channelId) {
    log.warn('Discord not configured — campaign opportunity recorded but not announced')
    return false
  }
  const adminBase = (process.env.APP_URL ?? '').replace(/\/+$/, '')
  const ex = input.excluded
  const exclusions = [
    ex.activeLifecycle ? `${ex.activeLifecycle} in an active lifecycle` : null,
    ex.noConsent ? `${ex.noConsent} without consent` : null,
    ex.unsubscribed ? `${ex.unsubscribed} unsubscribed` : null,
    ex.hardBounce + ex.complaint + ex.otherSuppression
      ? `${ex.hardBounce + ex.complaint + ex.otherSuppression} suppressed`
      : null,
    ex.duplicate ? `${ex.duplicate} duplicates` : null,
  ].filter(Boolean)

  const content = [
    `📣 **EMAIL CAMPAIGN READY — waiting for your approval**`,
    `**Campaign:** ${input.campaignName}`,
    `**Why:** ${input.rationale}`,
    `**Eligible recipients:** ${input.eligible}`,
    exclusions.length ? `**Excluded:** ${exclusions.join(', ')}` : null,
    `**Offer:** ${input.useDiscount ? `${DISCOUNT_POLICY.maxPublicPercent}% first-time discount (applied automatically at booking)` : 'none'}`,
    `**Suggested subject:** ${input.subject}`,
    `**Status:** DRAFT — nothing sends until you approve it.`,
    adminBase ? `Review + approve: ${adminBase}/admin/email-marketing/campaigns` : null,
    `Every recipient is re-checked at send time (consent, unsubscribe, suppression, bookings, active lifecycles, frequency caps).`,
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, 1900)

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)
    const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer))
    if (!res.ok) {
      log.error({ status: res.status, channelId }, 'campaign opportunity notice REJECTED by Discord')
      return false
    }
    return true
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'campaign opportunity notice failed')
    return false
  }
}

// ── The sweep ───────────────────────────────────────────────────────────

export type DiscoveryReport = {
  ran: boolean
  reason?: string
  considered: Array<{ segment: string; outcome: string; eligible?: number }>
  created: { campaignId: string; name: string; eligible: number; discordPosted: boolean } | null
}

/**
 * The daily discovery sweep. Deterministic audience math first, at most ONE
 * campaign drafted, one optional AI call, one Discord post. Idempotent at the
 * day level: the per-segment cooldown means re-running it is a cheap no-op.
 */
export async function discoverCampaignOpportunities(now: Date = new Date()): Promise<DiscoveryReport> {
  const report: DiscoveryReport = { ran: false, considered: [], created: null }
  if (!marketingAgentEnabled()) {
    report.reason = 'disabled'
    return report
  }
  report.ran = true

  const cooldownCutoff = new Date(now.getTime() - SUGGESTION_COOLDOWN_DAYS * 24 * 60 * 60 * 1000)

  for (const entry of PLAYBOOK) {
    // COOLDOWN — keyed on campaign creation for this segment, whatever its
    // state. A draft the owner ignored is a decision, not a reminder queue;
    // a campaign that SENT was also created, so a just-mailed segment is
    // equally protected.
    const recent = await prisma.marketingCampaign.findFirst({
      where: { sourceKey: { startsWith: `agent-${entry.segment}` }, createdAt: { gte: cooldownCutoff } },
      select: { id: true, createdAt: true },
    })
    if (recent) {
      report.considered.push({ segment: entry.segment, outcome: 'cooldown' })
      continue
    }

    const preview = await previewAudience({ segment: entry.segment, filters: {} })
    if (preview.error) {
      report.considered.push({ segment: entry.segment, outcome: `preview_error:${preview.error.slice(0, 80)}` })
      continue
    }
    if (preview.eligible < MIN_AUDIENCE) {
      report.considered.push({ segment: entry.segment, outcome: 'audience_too_small', eligible: preview.eligible })
      continue
    }

    // ── A real opportunity. Draft it (deterministic first, AI may improve). ──
    const ai = await draftCampaignCopy(entry, preview)
    const copy: CampaignCopy = ai ?? { ...entry.draft, useDiscount: entry.suggestDiscount }

    const dayKey = now.toISOString().slice(0, 10).replace(/-/g, '')
    const sourceKey = `agent-${entry.segment}-${dayKey}`
    const audienceName = `Agent: ${entry.campaignName}`

    const created = await prisma.$transaction(async (tx) => {
      // One reusable audience row per segment — the definition is what
      // matters, and dispatch recomputes recipients from it every time.
      const audience = await tx.emailAudience.upsert({
        where: { name: audienceName },
        update: { definition: { segment: entry.segment, filters: {} } },
        create: {
          name: audienceName,
          description: `Maintained by the marketing discovery agent. ${preview.segmentLabel}.`,
          definition: { segment: entry.segment, filters: {} },
          createdByName: 'marketing-agent',
        },
      })
      const campaign = await tx.marketingCampaign.create({
        data: {
          name: `${entry.campaignName} — ${now.toISOString().slice(0, 10)}`,
          channel: 'EMAIL',
          sourceKey,
          // ALWAYS DRAFT. The agent has no path to any other state — approval
          // and dispatch belong to the human, through the admin state machine.
          status: 'DRAFT',
          notes: [
            `Drafted automatically by the marketing discovery agent${ai ? ` (copy refined by AI)` : ' (deterministic copy)'}.`,
            `Preview text: ${copy.previewText}`,
            `Rationale: ${copy.rationale}`,
            copy.useDiscount
              ? `Offer: mention the ${DISCOUNT_POLICY.maxPublicPercent}% first-time discount — it applies automatically at booking; no code needed.`
              : 'Offer: none.',
            `Eligible at draft time: ${preview.eligible}. The list is recomputed at dispatch.`,
          ].join('\n'),
          createdByName: 'marketing-agent',
        },
      })
      // NOTE: EmailCampaignConfig has no previewText column; the preview line
      // travels in the campaign notes so the owner still sees it. Adding a
      // column is a migration this feature does not need.
      await tx.emailCampaignConfig.create({
        data: {
          campaignId: campaign.id,
          template: entry.template,
          subject: copy.subject,
          audienceId: audience.id,
          utmSource: 'email',
          utmMedium: 'campaign',
          utmCampaign: sourceKey,
        },
      })
      await tx.auditLog.create({
        data: {
          action: 'EMAIL_CAMPAIGN_CREATED',
          details: {
            campaignId: campaign.id,
            name: campaign.name,
            template: entry.template,
            sourceKey,
            by: 'marketing-agent',
            eligibleAtDraft: preview.eligible,
            aiCopy: Boolean(ai),
          },
        },
      })
      return campaign
    })

    const discordPosted = await postCampaignOpportunity({
      campaignName: created.name,
      campaignId: created.id,
      segmentLabel: preview.segmentLabel,
      rationale: copy.rationale,
      subject: copy.subject,
      eligible: preview.eligible,
      excluded: preview.excluded,
      useDiscount: copy.useDiscount,
    })

    report.considered.push({ segment: entry.segment, outcome: 'drafted', eligible: preview.eligible })
    report.created = { campaignId: created.id, name: created.name, eligible: preview.eligible, discordPosted }
    log.info(
      { campaignId: created.id, segment: entry.segment, eligible: preview.eligible, discordPosted, aiCopy: Boolean(ai) },
      'campaign opportunity drafted — waiting for owner approval'
    )
    // ONE campaign per sweep. The next segment gets its turn tomorrow — the
    // owner should never wake up to a stack of decisions.
    break
  }

  return report
}
