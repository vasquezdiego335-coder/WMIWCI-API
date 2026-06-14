import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { checkEnv } from '@/lib/env'

export const revalidate = 0

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

  // Temporary Redis diagnostic — shows the host (never the password) so you
  // can confirm which REDIS_URL the running deployment actually loaded.
  const redisUrl = process.env.REDIS_URL
  let redisDiag: { set: boolean; host?: string; protocol?: string } = { set: false }
  if (redisUrl) {
    try {
      const u = new URL(redisUrl)
      redisDiag = { set: true, host: u.hostname, protocol: u.protocol }
    } catch {
      redisDiag = { set: true, host: '(unparseable URL)' }
    }
  }

  const ok = db === 'connected' && env.ok
  return NextResponse.json(
    {
      status: ok ? 'ok' : 'degraded',
      db,
      env: {
        ok: env.ok,
        missingRequired: env.missingRequired,
        groups: env.groups,
      },
      redisDiag,
      timestamp,
    },
    { status: ok ? 200 : 503 }
  )
}
