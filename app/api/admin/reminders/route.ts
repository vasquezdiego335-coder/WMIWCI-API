import { NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { runScan } from '@/lib/reminder-sync'
import { can, type Role } from '@/lib/permissions'
import { apiLogger } from '@/lib/logger'

// Action Center manual rescan (increment 2, hardened 2.1). Owner/manager force
// a scan; the advisory lock + cooldown live in runScan. A blocked scan returns
// 200 with a clear reason (not an error) so the button gives friendly feedback.
// Deterministic rules only — no AI.

export async function POST(): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  if (!can(session.role as Role, 'reminder.scan')) {
    return NextResponse.json({ error: 'You do not have permission to run a scan.' }, { status: 403 })
  }

  try {
    const outcome = await runScan({ trigger: 'MANUAL', userId: session.userId, userName: session.name, force: true })
    if (!outcome.ran) {
      const message = outcome.reason === 'already_running'
        ? 'A reminder scan is already running.'
        : 'A scan just ran a moment ago — please wait before scanning again.'
      return NextResponse.json({ ran: false, reason: outcome.reason, message }, { status: 200 })
    }
    return NextResponse.json({ ran: true, ...outcome.result })
  } catch (err) {
    apiLogger.error({ err: err instanceof Error ? err.message : String(err) }, 'Manual reminder scan failed')
    return NextResponse.json({ error: 'The scan failed. Existing reminders are still available.' }, { status: 500 })
  }
}
