// ════════════════════════════════════════════════════════════════════════
//  AGENT HEARTBEAT — GET /api/email/agent-heartbeat
//  ---------------------------------------------------------------------
//  THE DEAD-MAN SWITCH. The agent cannot report its own death: a worker that
//  has stopped writes nothing, including "I have stopped". Every other check
//  in this system is written from inside the process being checked, so this
//  one endpoint exists to be polled from OUTSIDE the deployment by an uptime
//  monitor. Its job is to answer one question honestly — is the thing that
//  watches the email system still alive?
//
//  ALERT CONDITION FOR THE EXTERNAL MONITOR:
//      non-2xx response, OR no response at all.
//  The endpoint returns 503 when the state is `stale` or `failing`, so a plain
//  HTTP uptime check with no JSON parsing is enough to catch a dead worker.
//
//  WHY IT IS NOT UNDER /api/admin: an external monitor has no admin session.
//  It authenticates with a single shared token instead, and the token is
//  compared in CONSTANT TIME so the endpoint cannot be used as an oracle.
//
//  WHAT IT DELIBERATELY DOES NOT RETURN: findings, incident titles, campaign
//  names, customer data, configuration values, or anything else that would
//  matter if the token leaked. State, timings and counts only.
// ════════════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server'
import crypto from 'node:crypto'
import { loadSettings } from '@/lib/email-agent/settings'
import { effectiveStatus, readHeartbeat } from '@/lib/email-agent/status'
import { safeErrorMessage } from '@/lib/email-agent/redact'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Constant-time compare, so a wrong token cannot be found byte by byte. */
function tokenMatches(provided: string | null, expected: string): boolean {
  if (!provided) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const expected = process.env.EMAIL_AGENT_HEARTBEAT_TOKEN?.trim()

  // FAIL CLOSED. With no token configured the endpoint is unavailable rather
  // than public — an unauthenticated status endpoint is a free reconnaissance
  // signal about when nobody is watching.
  if (!expected || expected.length < 16) {
    return NextResponse.json(
      { state: 'unconfigured', message: 'EMAIL_AGENT_HEARTBEAT_TOKEN is not set (minimum 16 characters). The heartbeat endpoint is disabled.' },
      { status: 503 }
    )
  }

  const provided =
    req.headers.get('x-agent-heartbeat-token') ??
    req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
    req.nextUrl.searchParams.get('token')

  if (!tokenMatches(provided, expected)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  try {
    const settings = await loadSettings()
    const [heartbeat, status] = [await readHeartbeat(settings), effectiveStatus(settings)]

    // 503 on the states an external monitor must page for. A monitor that only
    // understands HTTP status codes is enough.
    const failing = heartbeat.state === 'stale' || heartbeat.state === 'failing'
    const httpStatus = failing ? 503 : 200

    return NextResponse.json(
      {
        state: heartbeat.state,
        message: heartbeat.message,
        effectiveMode: status.effectiveMode,
        requestedMode: status.requestedMode,
        environment: heartbeat.environment,
        service: heartbeat.service,
        deploymentId: heartbeat.deploymentId,
        lastRunAt: heartbeat.lastRunAt,
        lastSuccessAt: heartbeat.lastSuccessAt,
        lastChecksCompletedAt: heartbeat.lastChecksCompletedAt,
        ageSeconds: heartbeat.ageSeconds,
        expectedIntervalSeconds: heartbeat.expectedIntervalSeconds,
        lastStatus: heartbeat.lastStatus,
        lastDurationMs: heartbeat.lastDurationMs,
        consecutiveFailures: heartbeat.consecutiveFailures,
        // Booleans only. Never a value, never a key, never a finding.
        aiEnabled: status.aiEnabled,
        alertsConfigured: status.alertsConfigured,
        dispatchPaused: status.dispatchPaused,
        safeAutoActive: status.safeAutoActive,
        checkedAt: new Date().toISOString(),
      },
      { status: httpStatus, headers: { 'Cache-Control': 'no-store' } }
    )
  } catch (err) {
    // A heartbeat that cannot be computed is a FAILING heartbeat. Answering
    // 200 here would tell the monitor everything is fine because the thing
    // that checks whether everything is fine is broken.
    return NextResponse.json(
      { state: 'stale', message: `The heartbeat could not be computed: ${safeErrorMessage(err, 160)}`, checkedAt: new Date().toISOString() },
      { status: 503 }
    )
  }
}
