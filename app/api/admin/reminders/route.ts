import { NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { syncReminders } from '@/lib/reminder-sync'
import { apiLogger } from '@/lib/logger'

// Action Center manual rescan (increment 2). The Action Center page also syncs
// on load; this endpoint backs the "Rescan" button. Deterministic rules only —
// no AI. Dedupe keys make concurrent scans safe.

export async function POST(): Promise<NextResponse> {
  const session = await getSession()
  if (!session || !['OWNER', 'MANAGER'].includes(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  try {
    const result = await syncReminders()
    apiLogger.info(result, 'Reminder scan complete')
    return NextResponse.json(result)
  } catch (err) {
    apiLogger.error({ err: err instanceof Error ? err.message : String(err) }, 'Reminder scan failed')
    return NextResponse.json({ error: 'Scan failed' }, { status: 500 })
  }
}
