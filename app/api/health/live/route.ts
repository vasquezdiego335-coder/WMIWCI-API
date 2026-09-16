import { NextResponse } from 'next/server'

export const revalidate = 0
export const dynamic = 'force-dynamic'

// GET /api/health/live — pure LIVENESS: 200 whenever this process can serve a
// request. No database, Redis or queue I/O, so it can be polled freely and a
// dependency outage never reads as "the API process is dead". Readiness (DB,
// Redis, configuration, email-delivery workers) is GET /api/health.
export function GET(): NextResponse {
  return NextResponse.json(
    {
      status: 'alive',
      service: 'api',
      uptimeSeconds: Math.round(process.uptime()),
      commit: (process.env.RAILWAY_GIT_COMMIT_SHA ?? '').slice(0, 12) || null,
      timestamp: new Date().toISOString(),
    },
    { status: 200, headers: { 'cache-control': 'no-store' } }
  )
}
