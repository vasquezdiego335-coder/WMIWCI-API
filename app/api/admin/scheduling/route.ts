import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { easternDayStart, easternDayEndExclusive } from '@/lib/move-date'
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
  //  A calendar day is an EASTERN wall-clock span, not a UTC one: with
  //  `T00:00:00Z` the window ended at 8 PM Eastern, so an evening job on the
  //  last day of the range was missing from the schedule it belonged to. The
  //  bounds are also validated now — an unreadable one falls back to the
  //  default window instead of putting an Invalid Date into a Prisma filter.
  const start = easternDayStart(startStr) ?? new Date()
  const end = easternDayEndExclusive(endStr) ?? new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return NextResponse.json({ error: 'Invalid date range' }, { status: 422 })
  }

  const board = await loadSchedulingBoard({ start, end })
  return NextResponse.json(board)
}
