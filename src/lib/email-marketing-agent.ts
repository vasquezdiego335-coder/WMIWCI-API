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
import { previewAudience, SEGMENTS, type AudiencePreview, type SegmentKey } from './email-audience'
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

// ── Owner-language audience descriptions ────────────────────────────────
//  The admin and the Discord notice both speak BUSINESS, not SQL. The
//  technical segment key may appear underneath; this is the sentence the
//  owner actually reads.

const SEGMENT_DESCRIPTIONS: Partial<Record<SegmentKey, string>> = {
  quick_quote_reactivation:
    'People who requested a moving estimate at least 14 days ago, agreed to marketing, never booked, and are no longer receiving automatic quote follow-ups.',
  contact_lead_reactivation:
    'People who contacted us at least 14 days ago, agreed to marketing, never received a quote and never booked, and are no longer in an active follow-up sequence.',
  quoted_leads_no_booking: 'People with a real quote on file who have not booked.',
  new_leads_no_booking: 'Leads with no quote and no booking yet.',
  abandoned_booking: 'People who started a real booking and never paid the deposit.',
  completed_customers: 'Customers whose move is complete.',
  repeat_customers: 'Customers who have completed more than one move with us.',
  first_time_customers: 'Customers who have completed exactly one move with us.',
  review_eligible: 'Completed moves with no review recorded yet.',
  referral_eligible: 'Happy reviewers who have not been asked for a referral.',
  reengagement_eligible: 'Past contacts with no recent activity.',
}

/** The owner-facing sentence for a segment. Falls back to the admin label. */
export function describeSegment(segment: SegmentKey): string {
  return SEGMENT_DESCRIPTIONS[segment] ?? SEGMENTS[segment]
}

// ── Discord notice (aggregate counts only — never a customer identity) ──

export type OpportunityNotice = {
  campaignName: string
  campaignId: string
  segment: SegmentKey
  rationale: string
  subject: string
  eligible: number
  excluded: AudiencePreview['excluded']
  useDiscount: boolean
}

/** The exact message body. Exported PURE so the tests can assert on the real
 *  content — the thing that reaches Discord, not a paraphrase of it. */
export function buildOpportunityMessage(input: OpportunityNotice): string {
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

  return [
    `📣 **EMAIL CAMPAIGN READY — waiting for your approval**`,
    `**Campaign:** ${input.campaignName}`,
    `**Opportunity:** ${input.eligible} eligible ${input.eligible === 1 ? 'person' : 'people'}.`,
    `**Why:** ${describeSegment(input.segment)}`,
    `**Rationale:** ${input.rationale}`,
    exclusions.length ? `**Excluded:** ${exclusions.join(', ')}` : null,
    `**Offer:** ${input.useDiscount ? `${DISCOUNT_POLICY.maxPublicPercent}% first-time discount (applied automatically at booking — no code needed)` : 'none'}`,
    `**Suggested subject:** ${input.subject}`,
    `**Status:** DRAFT — nothing sends until you approve it.`,
    `**Campaign ID:** ${input.campaignId}`,
    adminBase ? `**Action:** ${adminBase}/admin/email-marketing/campaigns` : null,
    `Every recipient is re-checked at send time (consent, unsubscribe, suppression, bookings, active lifecycles, frequency caps).`,
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, 1900)
}

async function postCampaignOpportunity(input: OpportunityNotice): Promise<boolean> {
  const token = process.env.DISCORD_BOT_TOKEN?.trim()
  const channelId = MARKETING_CHANNEL_ID()
  if (!token || !channelId) {
    log.warn('Discord not configured — campaign opportunity recorded but not announced')
    return false
  }
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)
    const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: buildOpportunityMessage(input) }),
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

// ════════════════════════════════════════════════════════════════════════
//  THE INJECTABLE EDGE — same pattern as JourneyDeps/QuoteCaptureDeps.
//  Everything that leaves the process goes through DiscoveryDeps, so the
//  whole opportunity flow — eligibility → draft → notice → ledger → retry —
//  is provable offline. `defaultDiscoveryDeps` is a literal transcription of
//  the prisma/fetch calls; no order or predicate changed when it was added.
// ════════════════════════════════════════════════════════════════════════

// ── The durable ledger ──────────────────────────────────────────────────
//  AuditLog.action is a CLOSED Prisma enum, and adding values needs an
//  ALTER TYPE migration — the one migration shape this repo has been burned
//  by, in a codebase where migrations are applied by hand. So the ledger
//  rides an EXISTING value (EMAIL_CAMPAIGN_UPDATED) with a `details.event`
//  discriminator instead: zero migrations, deployable everywhere, and the
//  rows are still precisely queryable via the JSON path filter below.
export const LEDGER_ACTION = 'EMAIL_CAMPAIGN_UPDATED' as const
export const DISCOVERY_SWEEP_EVENT = 'discovery_sweep'
export const NOTIFY_EVENT = 'discord_notification'

export type AgentCampaignRow = { id: string; name: string; status: string; createdAt: Date }

export interface DiscoveryDeps {
  now(): Date
  preview(def: { segment: SegmentKey; filters: Record<string, never> }): Promise<AudiencePreview>
  /** Newest agent-created campaign for this segment since `since`, any state. */
  recentAgentCampaign(segment: SegmentKey, since: Date): Promise<AgentCampaignRow | null>
  /** Did the newest notification attempt for this campaign succeed? Null = never attempted. */
  lastNotification(campaignId: string): Promise<{ delivered: boolean } | null>
  draftCopy(entry: PlaybookEntry, preview: AudiencePreview): Promise<CampaignCopy | null>
  createDraft(input: {
    entry: PlaybookEntry
    copy: CampaignCopy
    preview: AudiencePreview
    sourceKey: string
    now: Date
  }): Promise<{ id: string; name: string }>
  postDiscord(input: OpportunityNotice): Promise<boolean>
  recordNotification(campaignId: string, delivered: boolean): Promise<void>
  recordSweep(report: DiscoveryReport): Promise<void>
}

let _deps: DiscoveryDeps | undefined
export function defaultDiscoveryDeps(): DiscoveryDeps {
  if (_deps) return _deps
  _deps = {
    now: () => new Date(),
    preview: (def) => previewAudience(def),
    async recentAgentCampaign(segment, since) {
      return prisma.marketingCampaign.findFirst({
        where: { sourceKey: { startsWith: `agent-${segment}` }, createdAt: { gte: since } },
        orderBy: { createdAt: 'desc' },
        select: { id: true, name: true, status: true, createdAt: true },
      })
    },
    async lastNotification(campaignId) {
      // NOT caught: if the ledger cannot be read, the caller must know —
      // treating a read failure as "never notified" would re-post the same
      // campaign to Discord every day, which is the exact spam this ledger
      // exists to prevent.
      const rows = await prisma.auditLog.findMany({
        where: { action: LEDGER_ACTION, details: { path: ['campaignId'], equals: campaignId } },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { details: true },
      })
      const notice = rows.find((r) => (r.details as { event?: string } | null)?.event === NOTIFY_EVENT)
      if (!notice) return null
      return { delivered: (notice.details as { delivered?: boolean }).delivered === true }
    },
    draftCopy: (entry, preview) => draftCampaignCopy(entry, preview),
    async createDraft({ entry, copy, preview, sourceKey, now }) {
      const audienceName = `Agent: ${entry.campaignName}`
      return prisma.$transaction(async (tx) => {
        const audience = await tx.emailAudience.upsert({
          where: { name: audienceName },
          update: { definition: { segment: entry.segment, filters: {} } },
          create: {
            name: audienceName,
            description: `Maintained by the marketing discovery agent. ${describeSegment(entry.segment)}`,
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
              `Drafted automatically by the marketing discovery agent.`,
              `Audience: ${describeSegment(entry.segment)}`,
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
            },
          },
        })
        return { id: campaign.id, name: campaign.name }
      })
    },
    postDiscord: (input) => postCampaignOpportunity(input),
    async recordNotification(campaignId, delivered) {
      await prisma.auditLog
        .create({
          data: {
            action: LEDGER_ACTION,
            details: { event: NOTIFY_EVENT, campaignId, delivered, channelId: MARKETING_CHANNEL_ID() },
          },
        })
        .catch((err) => log.warn({ err: String(err), campaignId }, 'notification ledger write failed (non-fatal)'))
    },
    async recordSweep(report) {
      await prisma.auditLog
        .create({ data: { action: LEDGER_ACTION, details: { event: DISCOVERY_SWEEP_EVENT, ...report } as never } })
        .catch((err) => log.warn({ err: String(err) }, 'sweep ledger write failed (non-fatal)'))
    },
  }
  return _deps
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
 * campaign drafted, one optional AI call, one Discord post.
 *
 * IDEMPOTENT AND SELF-HEALING:
 *   • the per-segment cooldown means re-running it (restart, manual trigger,
 *     retried cron) cannot create a second campaign or a second notice;
 *   • a campaign whose Discord notice FAILED is retried — once per sweep, so
 *     a dead channel costs one attempt a day, never a flood — and the retry
 *     happens INSTEAD of new discovery for that segment, so the owner is
 *     never behind on a campaign they were never told about.
 */
export async function discoverCampaignOpportunities(
  deps: DiscoveryDeps = defaultDiscoveryDeps()
): Promise<DiscoveryReport> {
  const report: DiscoveryReport = { ran: false, considered: [], created: null }
  if (!marketingAgentEnabled()) {
    report.reason = 'disabled'
    return report
  }
  report.ran = true
  const now = deps.now()
  const cooldownCutoff = new Date(now.getTime() - SUGGESTION_COOLDOWN_DAYS * 24 * 60 * 60 * 1000)

  for (const entry of PLAYBOOK) {
    const recent = await deps.recentAgentCampaign(entry.segment, cooldownCutoff)
    if (recent) {
      // ── NOTIFICATION SELF-HEAL ────────────────────────────────────────
      // A DRAFT the owner was never successfully told about is the failure
      // mode this feature exists to prevent: a campaign system nobody sees is
      // no campaign system. Retry the notice — never re-create the campaign.
      if (recent.status === 'DRAFT') {
        let lastNotice: { delivered: boolean } | null
        try {
          lastNotice = await deps.lastNotification(recent.id)
        } catch (err) {
          // The ledger is unreadable, so "was the owner told?" is unknowable.
          // FAIL SAFE: do not re-post. A missed retry costs a day; a blind
          // retry loop is the daily-spam failure this ledger exists to stop.
          log.warn({ err: err instanceof Error ? err.message : String(err), campaignId: recent.id }, 'notification ledger unreadable — skipping retry')
          report.considered.push({ segment: entry.segment, outcome: 'ledger_unreadable' })
          continue
        }
        if (!lastNotice || !lastNotice.delivered) {
          const preview = await deps.preview({ segment: entry.segment, filters: {} })
          const delivered = await deps.postDiscord({
            campaignName: recent.name,
            campaignId: recent.id,
            segment: entry.segment,
            rationale: entry.draft.rationale,
            subject: entry.draft.subject,
            eligible: preview.eligible,
            excluded: preview.excluded,
            useDiscount: entry.suggestDiscount,
          })
          await deps.recordNotification(recent.id, delivered)
          report.considered.push({
            segment: entry.segment,
            outcome: delivered ? 'notification_retried' : 'notification_retry_failed',
          })
          continue
        }
      }
      report.considered.push({ segment: entry.segment, outcome: 'cooldown' })
      continue
    }

    const preview = await deps.preview({ segment: entry.segment, filters: {} })
    if (preview.error) {
      report.considered.push({ segment: entry.segment, outcome: `preview_error:${preview.error.slice(0, 80)}` })
      continue
    }
    if (preview.eligible < MIN_AUDIENCE) {
      report.considered.push({ segment: entry.segment, outcome: 'audience_too_small', eligible: preview.eligible })
      continue
    }

    // ── A real opportunity. Draft it (deterministic first, AI may improve). ──
    const ai = await deps.draftCopy(entry, preview)
    const copy: CampaignCopy = ai ?? { ...entry.draft, useDiscount: entry.suggestDiscount }
    const dayKey = now.toISOString().slice(0, 10).replace(/-/g, '')
    const sourceKey = `agent-${entry.segment}-${dayKey}`

    const created = await deps.createDraft({ entry, copy, preview, sourceKey, now })

    // The notice is OUTSIDE the transaction on purpose: a Discord outage must
    // never roll back a legitimate draft. The ledger records the failure, the
    // next sweep retries it, the ops agent alerts on it, and the admin shows
    // the campaign prominently regardless.
    const discordPosted = await deps.postDiscord({
      campaignName: created.name,
      campaignId: created.id,
      segment: entry.segment,
      rationale: copy.rationale,
      subject: copy.subject,
      eligible: preview.eligible,
      excluded: preview.excluded,
      useDiscount: copy.useDiscount,
    })
    await deps.recordNotification(created.id, discordPosted)

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

  await deps.recordSweep(report)
  return report
}

// ════════════════════════════════════════════════════════════════════════
//  STATUS — what the admin shows so the owner KNOWS the agent is alive.
// ════════════════════════════════════════════════════════════════════════

export type DiscoveryStatus = {
  enabled: boolean
  disabledReason: string | null
  minAudience: number
  cooldownDays: number
  channelId: string
  discordConfigured: boolean
  /** Cron truth: daily at 10:05 America/New_York. */
  schedule: string
  nextCheckAt: Date
  lastSweep: { at: Date; created: boolean; considered: number } | null
  lastNotification: { at: Date; delivered: boolean } | null
  awaitingApproval: number
  /** Live pool counts, only when asked for (two audience queries). */
  pool?: Array<{ segment: SegmentKey; label: string; eligible: number }>
}

/** Next 10:05 America/New_York after `from`. Mirrors the cron in
 *  scheduled.worker.ts — if the cron changes, change this with it. */
export function nextDiscoveryCheck(from: Date = new Date()): Date {
  const et = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(from)
  const [h, m] = et.split(':').map(Number)
  const past = h > 10 || (h === 10 && m >= 5)
  // Walk to 10:05 ET by adding whole minutes — DST-safe enough for a status
  // line, because the distance is computed in ET wall-clock terms.
  const minutesNowEt = h * 60 + m
  const target = 10 * 60 + 5
  const deltaMin = past ? 24 * 60 - minutesNowEt + target : target - minutesNowEt
  return new Date(from.getTime() + deltaMin * 60_000)
}

export async function discoveryStatus(opts: { includePool?: boolean } = {}): Promise<DiscoveryStatus> {
  const enabled = marketingAgentEnabled()
  const [lastSweepRow, lastNoticeRow, awaitingApproval] = await Promise.all([
    prisma.auditLog
      .findFirst({
        where: { action: LEDGER_ACTION, details: { path: ['event'], equals: DISCOVERY_SWEEP_EVENT } },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true, details: true },
      })
      .catch(() => null),
    prisma.auditLog
      .findFirst({
        where: { action: LEDGER_ACTION, details: { path: ['event'], equals: NOTIFY_EVENT } },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true, details: true },
      })
      .catch(() => null),
    prisma.marketingCampaign
      .count({ where: { channel: 'EMAIL', status: { in: ['DRAFT', 'READY'] } } })
      .catch(() => 0),
  ])

  const status: DiscoveryStatus = {
    enabled,
    disabledReason: enabled ? null : 'EMAIL_MARKETING_AGENT_ENABLED is not set to true',
    minAudience: MIN_AUDIENCE,
    cooldownDays: SUGGESTION_COOLDOWN_DAYS,
    channelId: MARKETING_CHANNEL_ID(),
    discordConfigured: Boolean(process.env.DISCORD_BOT_TOKEN?.trim()),
    schedule: 'Daily at 10:05 AM Eastern',
    nextCheckAt: nextDiscoveryCheck(),
    lastSweep: lastSweepRow
      ? {
          at: lastSweepRow.createdAt,
          created: Boolean((lastSweepRow.details as { created?: unknown } | null)?.created),
          considered: Array.isArray((lastSweepRow.details as { considered?: unknown[] } | null)?.considered)
            ? (lastSweepRow.details as { considered: unknown[] }).considered.length
            : 0,
        }
      : null,
    lastNotification: lastNoticeRow
      ? { at: lastNoticeRow.createdAt, delivered: (lastNoticeRow.details as { delivered?: boolean } | null)?.delivered === true }
      : null,
    awaitingApproval,
  }

  if (opts.includePool) {
    status.pool = []
    for (const entry of PLAYBOOK) {
      const p = await previewAudience({ segment: entry.segment, filters: {} }).catch(() => null)
      status.pool.push({ segment: entry.segment, label: entry.campaignName, eligible: p?.eligible ?? 0 })
    }
  }
  return status
}
