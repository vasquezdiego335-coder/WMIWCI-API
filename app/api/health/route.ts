import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { checkEnv } from '@/lib/env'

export const revalidate = 0

// Captured once at module load, so `uptimeSince` reflects this process instance.
const STARTED_AT = new Date().toISOString()

// Build identity — lets ops confirm WHICH commit is actually running in prod.
// Railway injects RAILWAY_GIT_* for GitHub deploys; the others are optional
// fallbacks you can set in the build. A commit SHA is not a secret.
const BUILD = {
  commit:
    process.env.RAILWAY_GIT_COMMIT_SHA ??
    process.env.GIT_COMMIT_SHA ??
    process.env.APP_VERSION ??
    'unknown',
  branch: process.env.RAILWAY_GIT_BRANCH ?? null,
  buildTime: process.env.BUILD_TIME ?? null,
  startedAt: STARTED_AT,
} as const

// GET /api/health — liveness + readiness probe.
// Returns 200 when the DB is reachable AND all required env vars are present;
// 503 otherwise. Only env-var PRESENCE is reported, never secret values.
export async function GET(): Promise<NextResponse> {
  const env = checkEnv()
  const timestamp = new Date().toISOString()

  let db: 'connected' | 'unreachable' = 'unreachable'
  try {
    await prisma.$queryRaw`SELECT 1`
    db = 'connected'
  } catch {
    db = 'unreachable'
  }

  const ok = db === 'connected' && env.ok
  return NextResponse.json(
    {
      status: ok ? 'ok' : 'degraded',
      db,
      version: BUILD,
      env: {
        ok: env.ok,
        missingRequired: env.missingRequired,
        groups: env.groups,
      },
      timestamp,
    },
    { status: ok ? 200 : 503 }
  )
}
