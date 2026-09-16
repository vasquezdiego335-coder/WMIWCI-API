// ════════════════════════════════════════════════════════════════════════
//  Regenerates docs/env-ownership.json from src/lib/env-ownership-scan.ts.
//
//  Run:  npx tsx scripts/gen-env-ownership.ts
//  Then READ THE DIFF. A variable that gains "worker" is a real change to the
//  deploy checklist for the Railway service "discord workers", not noise.
// ════════════════════════════════════════════════════════════════════════
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { scanEnvOwnership, SCAN_PATTERNS_VERSION } from '../src/lib/env-ownership-scan'

const SECRET = /(KEY|SECRET|TOKEN|PASSWORD|DSN|AUTH_TOKEN|WEBHOOK_URL|DATABASE_URL|REDIS_URL|SID|HASH)$/

// ── Variables whose VALUE must be identical on every service that reads it ──
//  Two SEPARATE Railway projects, so there are no shared or reference
//  variables: every one of these is typed twice, by hand, and can drift.
const MUST_MATCH = new Set([
  // Shared infrastructure — a different value means a different database or queue.
  'DATABASE_URL', 'REDIS_URL', 'APP_URL',
  // Stripe: the API verifies webhooks, the worker fulfils them.
  'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET',
  // Provider and sender identity — the same mail must come from the same place.
  'RESEND_API_KEY', 'RESEND_WEBHOOK_SECRET', 'EMAIL_FROM', 'EMAIL_REPLY_TO', 'EMAIL_TOKEN_SECRET',
  'BUSINESS_POSTAL_ADDRESS', 'MARKETING_SITE_URL', 'TIMEZONE',
  // Feature flags: BOTH services gate on these, and the admin card reads the API's copy.
  'EMAIL_SENDING_ENABLED', 'EMAIL_JOURNEYS_ENABLED', 'EMAIL_PROMOTIONS_ENABLED', 'MARKETING_FOLLOWUPS_ENABLED',
  'OUTBOX_ENABLED', 'REFERRAL_PROGRAM_ENABLED', 'EMAIL_MARKETING_AGENT_ENABLED', 'EMAIL_PROMOTIONAL_ALLOWLIST',
  // Send-guard policy. guardedSend runs on BOTH (API inline sends via src/lib/notify.ts,
  // worker via email.worker), so different caps or quiet hours mean different
  // customers get different timing depending on which service happened to send.
  'EMAIL_CAP_PER_DAY', 'EMAIL_CAP_PER_WEEK', 'EMAIL_CAP_PER_MONTH',
  'EMAIL_QUIET_START_HOUR', 'EMAIL_QUIET_END_HOUR', 'EMAIL_TRANSACTIONAL_GAP_MINUTES',
])

// ── readBy ["none"] is a claim that NOTHING runs this variable ──────────
//  It is allowed only where that is genuinely true, with the reason written
//  down. src/lib/__tests__/env-ownership.test.ts fails on any other "none".
const READ_BY_NONE_ALLOWED: Record<string, string> = {
  SHADOW_DATABASE_URL:
    'Read only by the Prisma migrate CLI (datasource shadowDatabaseUrl in prisma/schema.prisma). No application code ever reads it, and neither Railway service needs it — CI sets it for `prisma validate` / `migrate diff`.',
}

const NOTES: Record<string, string> = {
  DATABASE_URL:
    'SHARED. Read by PrismaClient on both services through prisma/schema.prisma `url = env("DATABASE_URL")`. Both point at the SAME Neon database through the PgBouncer pooler. `prisma migrate deploy` is run by the owner against the Neon DIRECT (non "-pooler") host, because PgBouncer transaction mode breaks the migration advisory lock.',
  REDIS_URL:
    'SHARED. One Railway Redis holds every BullMQ queue: the API PRODUCES jobs, the worker CONSUMES them. A different value on either side means jobs are enqueued where nothing is listening, and nothing reports an error. In production src/lib/redis.ts refuses to fall back to localhost.',
  RESEND_API_KEY: 'SHARED. Both services send: the API inline (lead acknowledgements via src/lib/notify.ts), the worker through the email queue.',
  RESEND_WEBHOOK_SECRET:
    'Verifying the Resend webhook is the API\'s job, but checkEnv() REQUIRES it on both whenever email is on, so the worker halts without it. WITHOUT IT BOUNCES AND COMPLAINTS ARE NEVER SUPPRESSED.',
  EMAIL_FROM: 'SHARED. Sender identity. A mismatch means customers get mail from two different addresses depending on which service sent it.',
  EMAIL_REPLY_TO: 'SHARED. Falls back to EMAIL_FROM when unset — so an unset value on one service silently changes where replies go.',
  EMAIL_SENDING_ENABLED: 'KILL SWITCH. "false" stops sending AND makes the whole Email group optional (src/lib/env.ts emailRequired). Set it on BOTH or one service keeps sending.',
  OUTBOX_ENABLED: 'The transactional outbox drains on the WORKER (scheduled queue). The API copy only decides whether routes write outbox rows. Both must agree or rows are written and never drained, or drained and never written.',
  OUTBOX_EMAIL_DRYRUN: 'WORKER behaviour: HOLDS outbox email rows (never marks them sent). Never set true in production. The API copy is reported on /api/health for comparison only.',
  EMAIL_JOURNEYS_ENABLED: 'Journeys are ENQUEUED by the API and RUN on the worker. Both copies must agree.',
  MARKETING_FOLLOWUPS_ENABLED: 'Review, referral and repeat follow-ups. Enqueued on either service, sent on the worker.',
  EMAIL_PROMOTIONS_ENABLED: 'Promotional sending. Also forces the whole Email group to be required (src/lib/env.ts emailRequired), even outside production.',
  EMAIL_MARKETING_AGENT_ENABLED:
    'Discovery RUNS on the worker (scheduled marketing-discovery cron). The API copy only drives the admin card. Must match on both, or the card and reality disagree (incident 2026-09-14). The agent stays DRAFT-ONLY whatever this is set to.',
  REFERRAL_PROGRAM_ENABLED: 'Gates the referral templates in the email registry, which both services consult.',
  EMAIL_CAMPAIGN_TRANSIENT_MAX_ATTEMPTS:
    'Optional (default 6). Consecutive transient read failures a campaign recipient may have before it is FAILED. The campaign runner is on the worker; set it there.',
  EMAIL_AUTOMATION_TRANSIENT_MAX_ATTEMPTS: 'Optional (default 6). Same budget for one automation stage. Worker.',
  DISCORD_CHANNEL_MARKETING: 'Read by the discovery sweep on the worker; falls back to a hard-coded channel id when unset.',
  DISCORD_PUBLIC_KEY:
    'Only the API verifies interaction signatures — but checkEnv() lists it as REQUIRED, and the worker runs checkEnv() at startup, so a worker without it HALTS and exits 1 after WORKER_CONFIG_FAILURE_EXIT_MS. Set it on both.',
  DISCORD_APPLICATION_ID: 'Same as DISCORD_PUBLIC_KEY: required by checkEnv() on both services, so the worker halts without it even though nothing on the worker uses it.',
  STRIPE_SECRET_KEY: 'Required by checkEnv() on BOTH services; the worker halts without it. It is also genuinely used there — webhook-retry fulfilment calls Stripe.',
  STRIPE_WEBHOOK_SECRET: 'The API verifies Stripe signatures; the worker host exposes a fallback webhook route. Required by checkEnv() on both.',
  DEPOSIT_LINK_BASE_URL: 'Read only by API routes (deposit links). The worker loads the module for formatters but never builds a deposit URL.',
  WORKER_CONFIG_FAILURE_EXIT_MS: 'WORKER only. Grace window a worker with missing required configuration serves 503 before exiting non-zero. Keep it below the Railway healthcheck timeout.',
  SHADOW_DATABASE_URL: READ_BY_NONE_ALLOWED.SHADOW_DATABASE_URL,
}

export type EnvManifestEntry = {
  readBy: string[]
  secret: boolean
  mustMatch?: true
  requiredBy?: string[]
  requiredWhenEmailOn?: true
  checkedBy?: string[]
  note?: string
}

/** Every key a manifest entry may carry. The test pins this list. */
export const MANIFEST_ENTRY_KEYS = ['readBy', 'secret', 'mustMatch', 'requiredBy', 'requiredWhenEmailOn', 'checkedBy', 'note'] as const

/**
 * Build the manifest WITHOUT writing it, so the test can compare the committed
 * file against a fresh scan byte for byte. A manifest that drifts from the code
 * is worse than no manifest: it is a deploy checklist someone will follow.
 */
export function buildEnvManifest(root: string) {
  const scan = scanEnvOwnership(root)

  // checkEnv() reads its whole declaration list, so every service that reaches
  // src/lib/env.ts both REQUIRES the required ones and REPORTS the optional ones.
  const envTs = scan.reaches('src/lib/env.ts')
  const checkEnvServices = [...(envTs.api ? ['api'] : []), ...(envTs.worker ? ['worker'] : [])]
  const declaredRequired = new Map(scan.declarations.filter((d) => d.required).map((d) => [d.key, d]))
  const declaredOptional = new Map(scan.declarations.filter((d) => !d.required).map((d) => [d.key, d]))

  const vars: Record<string, EnvManifestEntry> = {}
  for (const name of [...scan.readers.keys()].sort()) {
    const r = scan.readers.get(name)!
    const services = [...(r.api ? ['api'] : []), ...(r.worker ? ['worker'] : [])]
    const readBy = services.length ? services : r.script ? ['script'] : ['none']
    const required = declaredRequired.get(name)
    const optional = declaredOptional.get(name)
    vars[name] = {
      readBy,
      secret: SECRET.test(name),
      ...(MUST_MATCH.has(name) && r.api && r.worker ? { mustMatch: true as const } : {}),
      ...(required ? { requiredBy: checkEnvServices } : {}),
      ...(required && required.conditional === 'email' ? { requiredWhenEmailOn: true as const } : {}),
      ...(optional ? { checkedBy: checkEnvServices } : {}),
      ...(NOTES[name] ? { note: NOTES[name] } : {}),
    }
  }

  // Fail loudly rather than emit a manifest that quietly claims nothing reads a
  // variable. The test asserts the same thing, but a generator that can produce
  // an untrue file is a generator someone will run and commit.
  const unexplainedNone = Object.entries(vars)
    .filter(([n, e]) => e.readBy.length === 1 && e.readBy[0] === 'none' && !READ_BY_NONE_ALLOWED[n])
    .map(([n]) => n)
  if (unexplainedNone.length) {
    throw new Error(
      `${unexplainedNone.join(', ')} would be recorded as read by nothing. ` +
        'Either the scan cannot see the read (add a rule to DYNAMIC_ENV_RULES) or it is genuinely unused (add it to READ_BY_NONE_ALLOWED with the reason).',
    )
  }

  return { manifest: buildDocument(vars), scan }
}

export { READ_BY_NONE_ALLOWED, MUST_MATCH }

function buildDocument(vars: Record<string, EnvManifestEntry>) {
  return {
    $comment:
      'Which Railway service reads which environment variable. Generated by `npx tsx scripts/gen-env-ownership.ts` from the static import graph in src/lib/env-ownership-scan.ts, and verified by src/lib/__tests__/env-ownership.test.ts. Names and flags only; never values. A new variable read — literal OR computed — fails the test until it is listed here.',
    legend: {
      api: 'Railway service "wonderful-strength" — the Next.js API (app/**, middleware.ts).',
      worker:
        'Railway service "discord workers" — the combined worker host (src/worker-host.ts): BullMQ workers, the scheduled worker and the Discord bot.',
      script:
        'Read only by a file neither service reaches: scripts/ and dev-only entrypoints (src/workers/index.ts, src/workers/bull-board.ts). Not part of either deploy.',
      none: 'Read by no running code at all. Allowed only with a documented reason (see the note).',
      readBy:
        'Services whose import graph reaches a file that READS the value. Over-approximates: a reachable module may not call the reading function on that service.',
      requiredBy:
        'Services where src/lib/env.ts checkEnv() treats it as REQUIRED. A worker missing one of these prints STARTUP HALTED, serves 503 and exits 1 after WORKER_CONFIG_FAILURE_EXIT_MS.',
      requiredWhenEmailOn:
        'Required only when this deployment is expected to send email: NODE_ENV=production, or EMAIL_PROMOTIONS_ENABLED=true, or EMAIL_JOURNEYS_ENABLED=true — unless EMAIL_SENDING_ENABLED=false (src/lib/env.ts emailRequired).',
      checkedBy:
        'Services where checkEnv() only REPORTS presence. Not needed for startup; listed so /api/health and the admin page cannot surprise you.',
      mustMatch:
        'The VALUE must be identical on both services. The two Railway projects are separate, so nothing enforces this: every one is typed twice by hand. Compare names and hashes, never values.',
      secret: 'Name-shaped as a credential. Never print or copy the value anywhere but the Railway dashboard.',
    },
    version: 2,
    scanPatternsVersion: SCAN_PATTERNS_VERSION,
    vars,
  }
}

/** Exact bytes of the committed file, so the test can compare without writing. */
export function renderEnvManifest(root: string): string {
  return JSON.stringify(buildEnvManifest(root).manifest, null, 2) + '\n'
}

if (require.main === module) {
  const root = process.argv[2] ?? process.cwd()
  const { manifest, scan } = buildEnvManifest(root)
  writeFileSync(join(root, 'docs', 'env-ownership.json'), JSON.stringify(manifest, null, 2) + '\n')
  console.log(
    'vars', Object.keys(manifest.vars).length,
    'declarations', scan.declarations.length,
    'workerModules', scan.workerModules,
    'apiModules', scan.apiModules,
    'scriptModules', scan.scriptModules,
  )
}
