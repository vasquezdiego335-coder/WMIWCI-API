import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { scanEnvOwnership } from '../src/lib/env-ownership-scan'

const root = process.argv[2] ?? process.cwd()
const scan = scanEnvOwnership(root)

const SECRET = /(KEY|SECRET|TOKEN|PASSWORD|DSN|AUTH_TOKEN|WEBHOOK_URL|DATABASE_URL|REDIS_URL|SID|HASH)$/
// Variables whose VALUE must be identical on every service that reads it.
const MUST_MATCH = new Set([
  'DATABASE_URL', 'REDIS_URL', 'APP_URL', 'RESEND_API_KEY', 'EMAIL_FROM', 'EMAIL_REPLY_TO', 'EMAIL_TOKEN_SECRET',
  'EMAIL_SENDING_ENABLED', 'EMAIL_JOURNEYS_ENABLED', 'EMAIL_PROMOTIONS_ENABLED', 'MARKETING_FOLLOWUPS_ENABLED',
  'OUTBOX_ENABLED', 'STRIPE_SECRET_KEY', 'BUSINESS_POSTAL_ADDRESS', 'MARKETING_SITE_URL', 'REFERRAL_PROGRAM_ENABLED',
  'EMAIL_MARKETING_AGENT_ENABLED', 'EMAIL_PROMOTIONAL_ALLOWLIST', 'TIMEZONE',
])
const NOTES: Record<string, string> = {
  EMAIL_MARKETING_AGENT_ENABLED: 'Discovery RUNS on the worker (scheduled marketing-discovery cron). The API copy only drives the admin card. Must match on both, or the card and reality disagree (incident 2026-09-14).',
  DISCORD_CHANNEL_MARKETING: 'Read by the discovery sweep on the worker; falls back to a hard-coded channel id when unset.',
  DEPOSIT_LINK_BASE_URL: 'Read only by API routes (deposit links). The worker loads the module for formatters but never builds a deposit URL.',
  OUTBOX_EMAIL_DRYRUN: 'HOLDS outbox email rows (never marks them sent). Never set true in production.',
  WORKER_CONFIG_FAILURE_EXIT_MS: 'Grace window a worker with missing required configuration serves 503 before exiting non-zero.',
}

const vars: Record<string, unknown> = {}
for (const name of [...scan.readers.keys()].sort()) {
  const r = scan.readers.get(name)!
  const readBy = [...(r.api ? ['api'] : []), ...(r.worker ? ['worker'] : [])]
  vars[name] = {
    readBy: readBy.length ? readBy : ['none'],
    secret: SECRET.test(name),
    ...(MUST_MATCH.has(name) && r.api && r.worker ? { mustMatch: true } : {}),
    ...(NOTES[name] ? { note: NOTES[name] } : {}),
  }
}
const manifest = {
  $comment:
    'Which Railway service reads which environment variable. Generated from the static import graph by src/lib/env-ownership-scan.ts and verified by src/lib/__tests__/env-ownership.test.ts. api = wonderful-strength (Next.js), worker = discord workers (src/worker-host.ts). "none" = read only by modules neither entrypoint reaches (scripts/dev entrypoints). A new variable read fails the test until it is listed here. Names only; never values.',
  version: 1,
  vars,
}
writeFileSync(join(root, 'docs', 'env-ownership.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log('vars', Object.keys(vars).length, 'workerModules', scan.workerModules, 'apiModules', scan.apiModules)
