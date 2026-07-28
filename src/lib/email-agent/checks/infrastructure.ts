// ════════════════════════════════════════════════════════════════════════
//  INFRASTRUCTURE CHECKS (owner spec 2026-07-27)
//  ---------------------------------------------------------------------
//  The things the email system stands on, and the agent's own foundations.
//
//  ONE RULE ABOVE ALL OTHERS HERE: this file reports the PRESENCE of
//  configuration, never its value. `RESEND_API_KEY: present` is useful.
//  `RESEND_API_KEY: re_abc123…` in an incident that is rendered in a browser,
//  posted to Discord and sent to a third-party model is a credential leak with
//  three separate exit routes. Every evidence object below is names and
//  booleans.
//
//  Two of these checks are about the agent itself. An operations agent that
//  cannot tell you its own migration is missing, or that its own settings are
//  unreadable, is exactly the kind of quietly-broken monitor it exists to
//  prevent elsewhere.
// ════════════════════════════════════════════════════════════════════════

import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { prisma } from '../../db'
import { emailRequired } from '../../env'
import { CANONICAL_SITE_URL, isRetiredDomain } from '../../site-urls'
import { safeErrorMessage } from '../redact'
import type { AgentFinding } from '../types'
import { makeFinding, plural, type CheckContext, type CheckDefinition } from './shared'

/**
 * Is this value REALLY configured?
 *
 * Placeholder-aware. A literal `PASTE_ALERTS_CHANNEL_ID` was previously treated
 * as a real channel id, so the alert path reported itself configured and
 * Discord answered `400 Invalid Form Body`. Unconfigured must LOOK
 * unconfigured, not broken.
 */
const configured = (v?: string): boolean => {
  const t = v?.trim()
  if (!t) return false
  return !/^(REPLACE|PASTE|PUT|ADD|SET|INSERT|YOUR|CHANGE|EXAMPLE|SAMPLE|TODO|XXX)([_-]|$)/i.test(t) && !t.includes('REPLACE')
}

/** Variables the email system genuinely cannot work without. */
const EMAIL_REQUIRED_VARS = [
  'RESEND_API_KEY',
  'RESEND_WEBHOOK_SECRET',
  'EMAIL_FROM',
  'BUSINESS_POSTAL_ADDRESS',
  'MARKETING_SITE_URL',
] as const

// ── 1. Required configuration ───────────────────────────────────────────

const requiredEnv: CheckDefinition = {
  id: 'infrastructure.required_env_missing',
  category: 'infrastructure',
  intent: 'A variable the email system cannot work without is not set on this deployment.',
  run: async (ctx) => {
    // Only meaningful when this deployment is expected to send at all.
    if (!emailRequired()) return []
    const missing = EMAIL_REQUIRED_VARS.filter((k) => !configured(process.env[k]))
    if (missing.length === 0) return []

    // The webhook secret has its own dedicated check with a fuller explanation;
    // this one is about the group, so it does not repeat that story.
    const consequences: Record<string, string> = {
      RESEND_API_KEY: 'no email leaves at all',
      RESEND_WEBHOOK_SECRET: 'bounces and complaints are never suppressed',
      EMAIL_FROM: 'the provider rejects every message',
      BUSINESS_POSTAL_ADDRESS: 'every promotional send is blocked by the compliance gate',
      MARKETING_SITE_URL: 'the link guard blocks sends mid-run',
    }
    return [
      makeFinding(ctx, {
        checkId: 'infrastructure.required_env_missing',
        severity: 'critical',
        category: 'infrastructure',
        fingerprintParts: ['required_env', ...missing].sort(),
        title: `${missing.length} required email ${plural(missing.length, 'setting is', 'settings are')} missing`,
        description:
          `This deployment is configured to send email but ${missing.join(', ')} ${plural(missing.length, 'is', 'are')} not set. ` +
          `${missing.map((m) => `Without ${m}, ${consequences[m]}`).join('. ')}.`,
        evidence: {
          missingVariables: [...missing],
          present: EMAIL_REQUIRED_VARS.filter((k) => configured(process.env[k])),
          note: 'Presence only. Values are never recorded, logged, or sent to a model.',
        },
        suggestedActions: ['sendDiscordIncidentAlert'],
      }),
    ]
  },
}

// ── 2. Migrations the database has not applied ──────────────────────────

const pendingMigrations: CheckDefinition = {
  id: 'infrastructure.migrations_pending',
  category: 'infrastructure',
  intent: 'A migration exists in the repository that the connected database has never applied.',
  emits: ['infrastructure.migrations_pending', 'infrastructure.migration_state_unknown'],
  run: async (ctx) => {
    let onDisk: string[]
    try {
      onDisk = readdirSync(resolve(process.cwd(), 'prisma/migrations'), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
    } catch {
      // Running from a bundle with no migrations directory is normal in some
      // deployments and is not evidence of anything.
      return []
    }
    if (onDisk.length === 0) return []

    let applied: string[]
    try {
      const rows = await prisma.$queryRaw<Array<{ migration_name: string; finished_at: Date | null }>>`
        SELECT migration_name, finished_at FROM _prisma_migrations
      `
      applied = rows.filter((r) => r.finished_at !== null).map((r) => r.migration_name)
    } catch (err) {
      return [
        makeFinding(ctx, {
          checkId: 'infrastructure.migration_state_unknown',
          severity: 'info',
          category: 'infrastructure',
          fingerprintParts: ['migration_state_unknown'],
          title: 'Migration state could not be read',
          description: `The _prisma_migrations table could not be queried (${safeErrorMessage(err, 120)}), so the agent cannot say whether the schema is current.`,
          evidence: { error: safeErrorMessage(err, 200) },
          suggestedActions: [],
        }),
      ]
    }

    const appliedSet = new Set(applied)
    const pending = onDisk.filter((m) => !appliedSet.has(m))
    if (pending.length === 0) return []

    // The agent's own migration being pending is a specific, actionable thing
    // and deserves to be named rather than buried in a list.
    const agentMigrationPending = pending.some((m) => m.includes('email_ops_agent'))
    return [
      makeFinding(ctx, {
        checkId: 'infrastructure.migrations_pending',
        severity: agentMigrationPending ? 'critical' : 'warning',
        category: 'infrastructure',
        fingerprintParts: ['migrations_pending', ...pending].sort(),
        title: `${pending.length} ${plural(pending.length, 'migration has', 'migrations have')} not been applied to this database`,
        description:
          `The repository contains ${pending.length} ${plural(pending.length, 'migration', 'migrations')} the connected database has never run: ${pending.join(', ')}. ` +
          (agentMigrationPending
            ? 'One of them creates the operations agent\'s own tables, so the agent cannot record findings, incidents or actions until it is applied.'
            : 'Code that expects those columns will fail at runtime rather than at deploy time.'),
        evidence: { pending, appliedCount: applied.length, onDiskCount: onDisk.length },
        suggestedActions: ['sendDiscordIncidentAlert'],
      }),
    ]
  },
}

// ── 3. Alerting has nowhere to go ───────────────────────────────────────

const alertingUnconfigured: CheckDefinition = {
  id: 'infrastructure.alerting_unconfigured',
  category: 'infrastructure',
  intent: 'No Discord destination is configured, so critical alerts have nowhere to be delivered.',
  run: async (ctx) => {
    if (!ctx.settings.alertsEnabled) return [] // deliberately off; not a fault
    const hasToken = configured(process.env.DISCORD_BOT_TOKEN)
    const hasChannel = configured(process.env.DISCORD_CHANNEL_ALERTS) || configured(process.env.DISCORD_CHANNEL_OPERATIONS)
    if (hasToken && hasChannel) return []
    return [
      makeFinding(ctx, {
        checkId: 'infrastructure.alerting_unconfigured',
        severity: 'warning',
        category: 'infrastructure',
        fingerprintParts: ['alerting_unconfigured'],
        title: 'Critical alerts have nowhere to be delivered',
        description:
          `Alerting is enabled but ${!hasToken ? 'no Discord bot token is configured' : 'no alerts or operations channel is configured'}. ` +
          `Findings are still recorded and visible in the admin, but nothing will reach a phone — which defeats the purpose of an agent that watches while nobody is looking.`,
        evidence: { discordTokenConfigured: hasToken, alertChannelConfigured: hasChannel, note: 'Presence only.' },
        suggestedActions: [],
      }),
    ]
  },
}

// ── 4. The AI leg ───────────────────────────────────────────────────────

const aiProviderConfig: CheckDefinition = {
  id: 'infrastructure.ai_provider_unconfigured',
  category: 'infrastructure',
  intent: 'The agent is set to call a model and has no key for it — investigation will be skipped every cycle.',
  run: async (ctx) => {
    if (!ctx.settings.aiEnabled) return []
    const provider = (ctx.settings.provider ?? 'openai').toLowerCase()
    const key = provider === 'deepseek' ? process.env.DEEPSEEK_API_KEY : process.env.OPENAI_API_KEY
    if (configured(key)) return []
    return [
      makeFinding(ctx, {
        checkId: 'infrastructure.ai_provider_unconfigured',
        severity: 'info',
        category: 'infrastructure',
        fingerprintParts: ['ai_provider_unconfigured', provider],
        title: `AI investigation is on but ${provider} has no key`,
        description:
          `The agent is configured to use ${provider} and its API key is not set, so the investigation step is skipped every cycle. ` +
          `The deterministic checks, incidents and alerts all continue to work — the only thing missing is the written explanation and the recommendation.`,
        evidence: { provider, keyVariable: provider === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'OPENAI_API_KEY', present: false },
        suggestedActions: [],
      }),
    ]
  },
}

// ── 5. The agent's own settings ─────────────────────────────────────────

const settingsDegraded: CheckDefinition = {
  id: 'infrastructure.agent_settings_unreadable',
  category: 'infrastructure',
  intent: 'The agent could not read its own settings, so its kill switches are not being honoured.',
  run: async (ctx) => {
    if (!ctx.settings.degraded) return []
    return [
      makeFinding(ctx, {
        checkId: 'infrastructure.agent_settings_unreadable',
        severity: 'critical',
        category: 'infrastructure',
        fingerprintParts: ['agent_settings_unreadable'],
        title: 'The agent cannot read its own settings',
        description:
          `The agent settings row could not be read (${ctx.settings.degradedReason ?? 'unknown reason'}), so it is running on environment defaults. ` +
          `The marketing dispatch pause is stored in that row: while it cannot be read, dispatch is treated as NOT paused. If the owner paused sending, that pause is currently not in force.`,
        evidence: { reason: ctx.settings.degradedReason ?? null, effectiveMode: ctx.settings.mode },
        suggestedActions: ['sendDiscordIncidentAlert'],
      }),
    ]
  },
}

// ── 6. States worth stating plainly ─────────────────────────────────────

const operationalPosture: CheckDefinition = {
  id: 'infrastructure.posture',
  category: 'infrastructure',
  intent: 'Report deliberate global states — paused dispatch, promotions off — so they are never mistaken for faults.',
  emits: ['infrastructure.dispatch_paused', 'infrastructure.promotions_disabled'],
  run: async (ctx) => {
    const findings: AgentFinding[] = []

    if (ctx.settings.marketingDispatchPaused) {
      findings.push(
        makeFinding(ctx, {
          checkId: 'infrastructure.dispatch_paused',
          severity: 'info',
          category: 'infrastructure',
          fingerprintParts: ['dispatch_paused'],
          title: 'Marketing dispatch is paused',
          description:
            `The global marketing kill switch is ON${ctx.settings.pausedBy ? ` (set by ${ctx.settings.pausedBy})` : ''}${ctx.settings.pausedAt ? ` at ${ctx.settings.pausedAt.toISOString()}` : ''}. ` +
            `No campaign will dispatch while it is on. ${ctx.settings.pausedReason ? `Reason recorded: ${ctx.settings.pausedReason}` : 'No reason was recorded.'} ` +
            `This is reported every cycle so a pause set during an incident is never forgotten about.`,
          evidence: { pausedAt: ctx.settings.pausedAt?.toISOString() ?? null, pausedBy: ctx.settings.pausedBy, reason: ctx.settings.pausedReason },
          suggestedActions: ['createApprovalRequest'],
        })
      )
    }

    // Promotions being off is the deployment's own decision. It becomes worth
    // saying only when a campaign is actually waiting on it.
    if (process.env.EMAIL_PROMOTIONS_ENABLED !== 'true') {
      const waiting = await prisma.marketingCampaign.count({
        where: { channel: 'EMAIL', status: 'SCHEDULED', emailConfig: { is: { approvedAt: { not: null } } } },
      })
      if (waiting > 0) {
        findings.push(
          makeFinding(ctx, {
            checkId: 'infrastructure.promotions_disabled',
            severity: 'warning',
            category: 'infrastructure',
            fingerprintParts: ['promotions_disabled'],
            title: 'Approved campaigns are scheduled but promotional sending is switched off',
            description:
              `${waiting} approved ${plural(waiting, 'campaign is', 'campaigns are')} scheduled, but EMAIL_PROMOTIONS_ENABLED is not "true", so dispatch refuses every one of them. ` +
              `Nothing is broken — this is the master switch doing its job — but the campaigns will keep showing as scheduled and will never send until it is turned on.`,
            evidence: { scheduledApprovedCampaigns: waiting, variable: 'EMAIL_PROMOTIONS_ENABLED', enabled: false },
            suggestedActions: ['inspectCampaign'],
          })
        )
      }
    }

    return findings
  },
}

/**
 * LINK DOMAINS MUST RESOLVE (owner report 2026-07-28).
 *
 * THE GAP THIS CLOSES, found the hard way: the customer portal was rendering
 * links to `wemoveitweclearit.com` — the retired brand domain, which has no DNS
 * at all — because NEXT_PUBLIC_MARKETING_SITE_URL was unset and the code fell
 * back to it. Nothing looked broken. The page rendered, the link was blue, and
 * it went nowhere.
 *
 * The agent already checked the SENDING domain's authentication. It never
 * checked that the domains it puts in front of customers actually exist, which
 * is why this hid. An email full of dead links is worse than an unsent one:
 * the customer sees an intact message and concludes the business is broken.
 */
const linkDomainsResolve: CheckDefinition = {
  id: 'infrastructure.link_domain_unresolvable',
  category: 'infrastructure',
  intent: 'A domain used to build customer-facing links does not resolve, so every link built from it is dead.',
  emits: ['infrastructure.link_domain_unresolvable', 'infrastructure.link_domain_retired'],
  run: async (ctx) => {
    const dns = await import('node:dns/promises')
    const findings: AgentFinding[] = []

    // Only the variables that BUILD LINKS. A misconfigured one here reaches a
    // customer; the sending domain is covered by provider.dns_authentication.
    const configured: Array<{ key: string; url: string }> = []
    for (const key of ['MARKETING_SITE_URL', 'NEXT_PUBLIC_MARKETING_SITE_URL', 'APP_URL']) {
      const raw = process.env[key]?.trim()
      if (raw) configured.push({ key, url: raw })
    }
    if (configured.length === 0) return []

    for (const { key, url } of configured) {
      let host: string
      try {
        host = new URL(url).hostname
      } catch {
        findings.push(
          makeFinding(ctx, {
            checkId: 'infrastructure.link_domain_unresolvable',
            severity: 'critical',
            category: 'infrastructure',
            fingerprintParts: ['link_domain_unparseable', key],
            title: `${key} is not a valid URL`,
            description: `${key} cannot be parsed as a URL, so every customer-facing link built from it is malformed.`,
            evidence: { variable: key, parseable: false },
            suggestedActions: ['sendDiscordIncidentAlert'],
          })
        )
        continue
      }

      if (isRetiredDomain(url)) {
        findings.push(
          makeFinding(ctx, {
            checkId: 'infrastructure.link_domain_retired',
            severity: 'critical',
            category: 'infrastructure',
            fingerprintParts: ['link_domain_retired', key, host],
            title: `${key} points at the retired ${host}`,
            description:
              `${key} is set to a domain the business no longer uses. Every link built from it — in emails and in the customer portal — ` +
              `goes to a domain that is not ours. Set it to ${CANONICAL_SITE_URL}.`,
            evidence: { variable: key, host, canonical: CANONICAL_SITE_URL },
            suggestedActions: ['sendDiscordIncidentAlert'],
          })
        )
        continue
      }

      // Localhost is a developer machine, not a fault.
      if (/^(localhost|127\.0\.0\.1|::1)$/.test(host)) continue

      try {
        await dns.resolve4(host)
      } catch {
        try {
          await dns.resolveCname(host)
        } catch (err) {
          findings.push(
            makeFinding(ctx, {
              checkId: 'infrastructure.link_domain_unresolvable',
              severity: 'critical',
              category: 'infrastructure',
              fingerprintParts: ['link_domain_unresolvable', host],
              title: `${host} does not resolve, and customer links point at it`,
              description:
                `${key} is set to ${host}, which has no DNS record. Every link built from it is dead — the page renders, the link looks ` +
                `normal, and it goes nowhere. A customer seeing that concludes the business is broken, not that a variable is wrong.`,
              evidence: { variable: key, host, resolves: false, error: safeErrorMessage(err, 120) },
              suggestedActions: ['sendDiscordIncidentAlert'],
            })
          )
        }
      }
    }
    return findings
  },
}

export const infrastructureChecks: CheckDefinition[] = [
  requiredEnv,
  pendingMigrations,
  alertingUnconfigured,
  aiProviderConfig,
  settingsDegraded,
  operationalPosture,
  linkDomainsResolve,
]
