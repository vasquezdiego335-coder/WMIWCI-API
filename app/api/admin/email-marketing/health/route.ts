// ════════════════════════════════════════════════════════════════════════
//  EMAIL SYSTEM HEALTH  —  GET /api/admin/email-marketing/health
//  ---------------------------------------------------------------------
//  The operator-facing view of the monitoring checks the cron runs every ten
//  minutes (audit E-04). Same functions, same thresholds — a dashboard that
//  computed its own numbers would eventually disagree with the alerts, and the
//  owner would have to guess which one was lying.
//
//  READ-ONLY by construction: `runEmailMonitoring()` mutates nothing.
// ════════════════════════════════════════════════════════════════════════

import { NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { denyReason, type Role } from '@/lib/permissions'
import { runEmailMonitoring } from '@/lib/email-monitoring'

export const dynamic = 'force-dynamic'

export async function GET(): Promise<NextResponse> {
  const session = await getSession()
  const deny = denyReason(session?.role as Role, 'email.view')
  if (deny) return NextResponse.json({ error: deny }, { status: 403 })

  try {
    const report = await runEmailMonitoring()
    // 200 regardless of severity: the REPORT succeeded. A non-200 here would
    // make a healthy-but-warning system look like a broken endpoint.
    return NextResponse.json(report)
  } catch (err) {
    return NextResponse.json(
      { severity: 'critical', error: err instanceof Error ? err.message : String(err), checks: [], errors: [] },
      { status: 503 }
    )
  }
}
