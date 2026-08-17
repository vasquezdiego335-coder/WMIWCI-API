// ════════════════════════════════════════════════════════════════════════
//  Environment validation
//  ----------------------------------------------------------------------
//  Two entry points:
//    • checkEnv()  → non-throwing report (used by GET /api/health). Never
//                    leaks secret VALUES — only presence (✓/✗) and which
//                    group a missing var belongs to.
//    • assertEnv() → throws on missing REQUIRED vars (call at worker boot so
//                    a misconfigured deploy fails loudly instead of silently
//                    dropping jobs).
//
//  "Optional" groups (Twilio, Cloudinary, marketing) are feature-gated — they
//  only matter when their *_ENABLED flag is set, so they never block startup.
// ════════════════════════════════════════════════════════════════════════

type EnvVar = { key: string; required: boolean; note?: string }

const REQUIRED_CORE: EnvVar[] = [
  { key: 'DATABASE_URL', required: true, note: 'Postgres connection string' },
  { key: 'REDIS_URL', required: true, note: 'Upstash/Redis for BullMQ queues' },
  { key: 'APP_URL', required: true, note: 'Public base URL of this backend' },
]

const REQUIRED_STRIPE: EnvVar[] = [
  { key: 'STRIPE_SECRET_KEY', required: true },
  { key: 'STRIPE_WEBHOOK_SECRET', required: true, note: 'whsec_… from `stripe listen` or dashboard' },
]

const REQUIRED_DISCORD: EnvVar[] = [
  { key: 'DISCORD_BOT_TOKEN', required: true },
  { key: 'DISCORD_PUBLIC_KEY', required: true, note: 'verifies interaction signatures' },
  { key: 'DISCORD_APPLICATION_ID', required: true },
  { key: 'DISCORD_GUILD_ID', required: false, note: 'owner actions are scoped to this server' },
  { key: 'DISCORD_CHANNEL_SCHEDULING', required: false, note: 'approval cards land here' },
  { key: 'DISCORD_CHANNEL_ALERTS', required: false },
  { key: 'DISCORD_OWNER_USER_IDS', required: false, note: 'comma-list of owner user IDs (or use the role below / legacy staff IDs)' },
  { key: 'DISCORD_OWNER_ROLE_ID', required: false, note: 'role that grants owner powers' },
  // ── Deposit-link payment notifications (owner spec 2026-08-15) ──
  // NOT required: a missing Discord destination must never stop a customer
  // paying. It IS reported, because "configured" and "working" are different
  // claims and the admin page states which one is true.
  {
    key: 'DISCORD_PAYMENTS_WEBHOOK_URL',
    required: false,
    note: 'SECRET. Incoming webhook created INSIDE the payments channel. Preferred transport; falls back to the bot token.',
  },
  {
    key: 'DISCORD_PAYMENTS_CHANNEL_ID',
    required: false,
    note: 'destination for confirmed deposit payments (defaults to 1524853745064869990). Used by the BOT transport; with a webhook the URL selects the channel.',
  },
]

// ── EMAIL (audit E-01, 2026-07-26) ──────────────────────────────────────
// These were absent or optional, and `assertEnv()` was never called, so a
// deploy missing any of them started CLEANLY and failed silently later:
//
//   RESEND_API_KEY          missing -> every send fails at runtime
//   RESEND_WEBHOOK_SECRET   missing -> /api/email/webhook answers 503, Resend
//                           retries then gives up, and BOUNCES AND COMPLAINTS
//                           ARE NEVER SUPPRESSED. Nothing alerts. The system
//                           keeps mailing dead and complaining addresses and
//                           the sending domain degrades silently.
//   BUSINESS_POSTAL_ADDRESS missing -> every promotional send is blocked by the
//                           compliance gate (campaign validation catches this,
//                           but journeys and automations do not)
//   EMAIL_FROM              missing -> provider rejects every message
//   MARKETING_SITE_URL      missing -> link guard blocks sends mid-run
//
// They are REQUIRED WHEN EMAIL IS ON rather than always, so a developer running
// the booking flow without email configured is not blocked. `emailRequired()`
// decides; see checkEnv().
const REQUIRED_EMAIL: EnvVar[] = [
  { key: 'RESEND_API_KEY', required: true, note: 'provider API key — no email leaves without it' },
  { key: 'RESEND_WEBHOOK_SECRET', required: true, note: 'whsec_… — WITHOUT THIS, BOUNCES AND COMPLAINTS ARE NEVER SUPPRESSED' },
  { key: 'EMAIL_FROM', required: true, note: 'verified sender address' },
  { key: 'BUSINESS_POSTAL_ADDRESS', required: true, note: 'CAN-SPAM footer — promotional sends are blocked without it' },
  { key: 'MARKETING_SITE_URL', required: true, note: 'public site base URL used in email links' },
]

const OPTIONAL_NOTIFY: EnvVar[] = [
  { key: 'EMAIL_REPLY_TO', required: false, note: 'reply-to address (falls back to EMAIL_FROM)' },
  { key: 'TWILIO_ACCOUNT_SID', required: false, note: 'SMS — only if TWILIO_ENABLED=true' },
  { key: 'TWILIO_AUTH_TOKEN', required: false },
  { key: 'TWILIO_PHONE_NUMBER', required: false },
]

const PLACEHOLDERS = new Set(['', 'REPLACE_ME', 'placeholder', 'placeholder_public_key', 'sk_test_xxx'])
const present = (v?: string): boolean => !!v && !PLACEHOLDERS.has(v) && !v.includes('REPLACE_ME')

const GROUPS: Record<string, EnvVar[]> = {
  Core: REQUIRED_CORE,
  Stripe: REQUIRED_STRIPE,
  Discord: REQUIRED_DISCORD,
  Notifications: OPTIONAL_NOTIFY,
  Email: REQUIRED_EMAIL,
}

/**
 * Is this deployment expected to send email?
 *
 * True when any email-sending switch is on. A deployment with all of them off
 * genuinely does not need Resend configured, and blocking its startup would be
 * noise. The moment ANY of them is on, the whole email group becomes required —
 * including the webhook secret, because sending without processing bounces is
 * the failure mode that damages a sending domain.
 */
export function emailRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.EMAIL_SENDING_ENABLED === 'false') return false // deliberate kill switch
  return (
    env.EMAIL_PROMOTIONS_ENABLED === 'true' ||
    env.EMAIL_JOURNEYS_ENABLED === 'true' ||
    env.NODE_ENV === 'production'
  )
}

export type EnvReport = {
  ok: boolean
  missingRequired: string[]
  groups: Record<string, { key: string; present: boolean; required: boolean; note?: string }[]>
}

// Non-throwing — safe to expose presence (never values) on /api/health.
export function checkEnv(): EnvReport {
  const groups: EnvReport['groups'] = {}
  const missingRequired: string[] = []

  const emailOn = emailRequired()

  for (const [group, vars] of Object.entries(GROUPS)) {
    groups[group] = vars.map((v) => {
      const isPresent = present(process.env[v.key])
      // The Email group is required only when this deployment actually sends.
      const required = group === 'Email' ? v.required && emailOn : v.required
      if (required && !isPresent) missingRequired.push(v.key)
      return { key: v.key, present: isPresent, required, note: v.note }
    })
  }

  // If Twilio is enabled, its three vars become effectively required.
  if (process.env.TWILIO_ENABLED === 'true') {
    for (const k of ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER']) {
      if (!present(process.env[k])) missingRequired.push(`${k} (TWILIO_ENABLED=true)`)
    }
  }

  return { ok: missingRequired.length === 0, missingRequired, groups }
}

// Throwing — call once at worker/bot startup so a bad deploy fails loudly.
export function assertEnv(): void {
  const report = checkEnv()
  if (!report.ok) {
    const lines = [
      '╔══════════════════════════════════════════════════════════════╗',
      '║  ❌ STARTUP ABORTED — missing required environment variables  ║',
      '╚══════════════════════════════════════════════════════════════╝',
      ...report.missingRequired.map((k) => `   ✗ ${k}`),
      '',
      '   Set these in your environment (.env.local locally, Vercel/host',
      '   dashboard in production) and restart.',
      '',
    ].join('\n')
    // eslint-disable-next-line no-console
    console.error(lines)
    throw new Error(`Missing required env vars: ${report.missingRequired.join(', ')}`)
  }
}
