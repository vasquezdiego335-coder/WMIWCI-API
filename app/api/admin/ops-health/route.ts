import { NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { getScanStatus } from '@/lib/reminder-sync'
import { can, type Role } from '@/lib/permissions'

export const revalidate = 0

// Admin-operations health (increment 2.1). Protected (OWNER/MANAGER via
// middleware + an explicit check) — it reports operational health, not secrets.
// Extends the public /api/health, which stays a plain liveness probe.
export async function GET(): Promise<NextResponse> {
  const session = await getSession()
  if (!session || !can(session.role as Role, 'action_center.view')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  let db: 'connected' | 'unreachable' = 'unreachable'
  try {
    await prisma.$queryRaw`SELECT 1`
    db = 'connected'
  } catch {
    db = 'unreachable'
  }

  const scan = await getScanStatus().catch(() => null)

  // Sanitized operational counts (no customer PII, no amounts).
  const [openReminders, criticalOpen] = await Promise.all([
    prisma.reminder.count({ where: { status: { in: ['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS'] } } }).catch(() => null),
    prisma.reminder.count({ where: { status: { in: ['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS'] }, severity: 'CRITICAL' } }).catch(() => null),
  ])

  const ok = db === 'connected'
  return NextResponse.json(
    {
      status: ok ? 'ok' : 'degraded',
      db,
      scan: scan
        ? { running: scan.running, lastSuccessAt: scan.lastSuccessAt, lastFailureAt: scan.lastFailureAt, lastError: scan.lastError }
        : null,
      reminders: { open: openReminders, critical: criticalOpen },
      timestamp: new Date().toISOString(),
    },
    { status: ok ? 200 : 503 },
  )
}
