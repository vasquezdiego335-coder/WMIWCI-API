// ════════════════════════════════════════════════════════════════════════
//  ENVIRONMENT + WRITE BOUNDARY (owner spec 2026-07-28)
//  ---------------------------------------------------------------------
//  THE INCIDENT THIS FILE EXISTS TO PREVENT, WHICH ALREADY HAPPENED ONCE:
//  a dry run executed on a developer laptop, against the PRODUCTION database,
//  with a local .env missing RESEND_WEBHOOK_SECRET and BUSINESS_POSTAL_ADDRESS.
//  The health engine did its job perfectly and reported two critical problems.
//  They were not production problems. They were artefacts of a laptop — and
//  they became production incidents, a production approval request, and would
//  have become a 3 a.m. Discord alert.
//
//  A monitoring system that reports the state of the machine it is running on
//  as though it were the state of production is worse than no monitoring,
//  because every one of its findings becomes untrustworthy.
//
//  WHY NODE_ENV CANNOT BE THE SIGNAL HERE. This repository sets
//  NODE_ENV=production in the local .env — the pino logs on a laptop say
//  `"env":"production"`. Any guard keyed on NODE_ENV would have passed happily
//  during the exact incident it is meant to stop. So the runtime signal is
//  RAILWAY_* , which the platform injects and a laptop cannot fake by accident.
//
//  THE RULE, in one sentence: writing agent records requires that the RUNTIME
//  and the DATABASE agree about being production. Anything else needs a
//  deliberate, loudly-named override.
// ════════════════════════════════════════════════════════════════════════

/** Where the code is running. */
export type AgentEnvironment = 'production' | 'staging' | 'development' | 'test'

/** Which process is running it. */
export type AgentService = 'worker' | 'web' | 'cli' | 'test'

/** Why this cycle happened. */
export type AgentSource = 'scheduled' | 'manual' | 'dry_run' | 'test' | 'api'

const trimmed = (v?: string): string | null => {
  const t = v?.trim()
  return t && t !== '' ? t : null
}

/**
 * Is this process running on the deployment platform?
 *
 * Railway injects RAILWAY_ENVIRONMENT / RAILWAY_SERVICE_NAME into every
 * container. Their ABSENCE is the reliable "this is not a deployed process"
 * signal, and unlike NODE_ENV it cannot be set by copying a .env file.
 */
export function isPlatformRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(trimmed(env.RAILWAY_ENVIRONMENT) || trimmed(env.RAILWAY_SERVICE_ID) || trimmed(env.RAILWAY_PROJECT_ID))
}

/**
 * The environment this PROCESS believes it is.
 *
 * Order: explicit override → test runner → platform → development. The
 * explicit override exists so a staging deployment can name itself without
 * inventing a second convention.
 */
export function detectEnvironment(env: NodeJS.ProcessEnv = process.env): AgentEnvironment {
  const explicit = trimmed(env.EMAIL_AGENT_ENVIRONMENT)?.toLowerCase()
  if (explicit === 'production' || explicit === 'staging' || explicit === 'development' || explicit === 'test') {
    return explicit
  }
  // A test run is a test run wherever it happens, and must never be mistaken
  // for the environment whose database it might be pointed at.
  if (trimmed(env.NODE_ENV) === 'test' || trimmed(env.EMAIL_AGENT_TEST_MODE) === 'true') return 'test'

  if (isPlatformRuntime(env)) {
    const railway = trimmed(env.RAILWAY_ENVIRONMENT)?.toLowerCase()
    if (railway === 'production') return 'production'
    if (railway) return 'staging'
    return 'production'
  }
  return 'development'
}

/** Which process wrote a record — worker cycles and admin clicks are different. */
export function detectService(env: NodeJS.ProcessEnv = process.env): AgentService {
  const explicit = trimmed(env.EMAIL_AGENT_SERVICE)?.toLowerCase()
  if (explicit === 'worker' || explicit === 'web' || explicit === 'cli' || explicit === 'test') return explicit
  if (trimmed(env.NODE_ENV) === 'test' || trimmed(env.EMAIL_AGENT_TEST_MODE) === 'true') return 'test'

  const name = trimmed(env.RAILWAY_SERVICE_NAME)?.toLowerCase() ?? ''
  if (/worker|bot|cron|scheduled/.test(name)) return 'worker'
  if (/web|api|app|next/.test(name)) return 'web'
  // Next.js populates this in a server runtime; a plain tsx script does not.
  if (trimmed(env.NEXT_RUNTIME)) return 'web'
  return 'cli'
}

/** Best available deployment identifier, for attributing a record to a release. */
export function deploymentId(env: NodeJS.ProcessEnv = process.env): string | null {
  return (
    trimmed(env.RAILWAY_DEPLOYMENT_ID) ??
    trimmed(env.RAILWAY_GIT_COMMIT_SHA)?.slice(0, 12) ??
    trimmed(env.VERCEL_GIT_COMMIT_SHA)?.slice(0, 12) ??
    trimmed(env.GIT_COMMIT_SHA)?.slice(0, 12) ??
    null
  )
}

/**
 * Does the connection string point at the production database?
 *
 * Host-based, and deliberately conservative: anything that is not obviously a
 * local or branch database is TREATED AS PRODUCTION. Being wrong in that
 * direction costs a developer one environment variable. Being wrong in the
 * other direction is the incident this file exists to prevent.
 */
export function databaseLooksProduction(env: NodeJS.ProcessEnv = process.env): boolean {
  const url = trimmed(env.DATABASE_URL)
  if (!url) return false
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return true // unparseable — assume the dangerous case
  }
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === 'db' || host === 'postgres') return false
  // Neon branch naming: a branch database carries its branch in the host.
  if (/(^|[-.])(dev|development|test|testing|staging|preview|shadow|local|branch)([-.]|$)/.test(host)) return false
  return true
}

// ── The guard ───────────────────────────────────────────────────────────

export type WriteDecision =
  | { allowed: true; reason: string; overridden: boolean }
  | { allowed: false; reason: string; overridden: false }

/** The deliberately ugly variable name that permits a dangerous write. */
export const PRODUCTION_WRITE_OVERRIDE = 'ALLOW_EMAIL_AGENT_PRODUCTION_WRITES'

/**
 * May this process write agent records to this database?
 *
 * Pure, so the whole boundary is testable without a database or a platform.
 *
 * FOUR CASES:
 *   production runtime + production db   → yes, this is the real thing
 *   development runtime + local db       → yes, it is your own database
 *   development runtime + PRODUCTION db  → NO, unless the override is set
 *   test runtime + production db         → NO, and the override does NOT help
 *
 * A test run can never be granted production write access, whatever the
 * environment says. A test that can write to production is not a test.
 */
export function canWriteAgentRecords(env: NodeJS.ProcessEnv = process.env): WriteDecision {
  const environment = detectEnvironment(env)
  const productionDb = databaseLooksProduction(env)
  const override = trimmed(env[PRODUCTION_WRITE_OVERRIDE])?.toLowerCase() === 'true'

  if (environment === 'test') {
    if (!productionDb) return { allowed: true, reason: 'Test runtime against a non-production database.', overridden: false }
    // NOT overridable. Deliberately the one branch with no escape hatch.
    return {
      allowed: false,
      reason:
        'Refusing to write agent records: this is a TEST runtime pointed at what looks like the production database. ' +
        `This cannot be overridden — not by ${PRODUCTION_WRITE_OVERRIDE}, not by anything. Point DATABASE_URL at a test database.`,
      overridden: false,
    }
  }

  if (environment === 'production' || environment === 'staging') {
    return { allowed: true, reason: `Deployed ${environment} runtime.`, overridden: false }
  }

  // development
  if (!productionDb) return { allowed: true, reason: 'Local runtime against a local database.', overridden: false }
  if (override) {
    return {
      allowed: true,
      reason: `Local runtime writing to the PRODUCTION database because ${PRODUCTION_WRITE_OVERRIDE}=true was set deliberately.`,
      overridden: true,
    }
  }
  return {
    allowed: false,
    reason:
      'Refusing to write agent records: this is a LOCAL runtime pointed at the production database. ' +
      'Findings produced here describe THIS MACHINE, not production — a laptop missing RESEND_WEBHOOK_SECRET would raise a production compliance incident. ' +
      `Run with --dry-run to see the findings without writing, or set ${PRODUCTION_WRITE_OVERRIDE}=true if you genuinely mean to write to production.`,
    overridden: false,
  }
}

/** The provenance stamped onto every agent record. */
export type AgentProvenance = {
  environment: AgentEnvironment
  service: AgentService
  source: AgentSource
  deploymentId: string | null
}

export function provenance(source: AgentSource, env: NodeJS.ProcessEnv = process.env): AgentProvenance {
  return {
    environment: detectEnvironment(env),
    service: detectService(env),
    source,
    deploymentId: deploymentId(env),
  }
}

/**
 * One line describing where this process is, for logs and the admin.
 * Contains no secrets — only names and booleans.
 */
export function describeRuntime(env: NodeJS.ProcessEnv = process.env): string {
  const p = provenance('scheduled', env)
  const db = databaseLooksProduction(env) ? 'production-like' : 'local/branch'
  return `${p.environment}/${p.service}${p.deploymentId ? `@${p.deploymentId}` : ''} → ${db} database`
}
