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
  { key: 'DISCORD_CHANNEL_SCHEDULING', required: false, note: 'approval cards land here' },
  { key: 'DISCORD_CHANNEL_ALERTS', required: false },
]

const OPTIONAL_NOTIFY: EnvVar[] = [
  { key: 'RESEND_API_KEY', required: false, note: 'transactional email' },
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

  for (const [group, vars] of Object.entries(GROUPS)) {
    groups[group] = vars.map((v) => {
      const isPresent = present(process.env[v.key])
      if (v.required && !isPresent) missingRequired.push(v.key)
      return { key: v.key, present: isPresent, required: v.required, note: v.note }
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
