import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { can, type Role } from '@/lib/permissions'
import { loadSchedulingBoard } from '@/lib/scheduling-service'

// ════════════════════════════════════════════════════════════════════════════
//  Scheduling board data (Stage 5). GET ?start=YYYY-MM-DD&end=YYYY-MM-DD
//  Returns per-job staffing summaries for the board views. Read-only.
// ════════════════════════════════════════════════════════════════════════════

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  if (!can(session.role as Role, 'schedule.view')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const startStr = req.nextUrl.searchParams.get('start')
  const endStr = req.nextUrl.searchParams.get('end')
  const start = startStr ? new Date(`${startStr}T00:00:00Z`) : new Date()
  const end = endStr ? new Date(`${endStr}T23:59:59Z`) : new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return NextResponse.json({ error: 'Invalid date range' }, { status: 422 })
  }

  const board = await loadSchedulingBoard({ start, end })
  return NextResponse.json(board)
}
