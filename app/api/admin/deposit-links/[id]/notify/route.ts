import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { can, type Role } from '@/lib/permissions'
import { deliverDepositNotification, depositNotifyConfig } from '@/lib/discord-payments'

// ════════════════════════════════════════════════════════════════════════════
//  POST /api/admin/deposit-links/[id]/notify — retry a FAILED Discord card.
//  ------------------------------------------------------------------------
//  SAFE BY CONSTRUCTION. It cannot create, alter or reverse a payment: it only
//  re-runs the delivery for a deposit that is ALREADY paid, and it goes through
//  the same exactly-once claim as the worker, so pressing it on a link that was
//  actually delivered posts nothing.
// ════════════════════════════════════════════════════════════════════════════

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(_req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  if (!can(session.role as Role, 'deposit.view')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const cfg = depositNotifyConfig()
  if (!cfg.configured) {
    return NextResponse.json({ error: `Discord notifications are not configured. ${cfg.reason}` }, { status: 409 })
  }

  const row = await prisma.depositRequest.findUnique({
    where: { id: params.id },
    select: { id: true, paidAt: true, discordStatus: true },
  })
  if (!row) return NextResponse.json({ error: 'Deposit link not found' }, { status: 404 })
  if (!row.paidAt) {
    return NextResponse.json({ error: 'This deposit has not been paid — there is nothing to announce.' }, { status: 409 })
  }

  const outcome = await deliverDepositNotification(params.id)
  if (outcome.delivered) return NextResponse.json({ ok: true, status: 'SENT' })
  if (outcome.skipped === 'already-sent' || outcome.skipped === 'already-sent-or-in-flight') {
    return NextResponse.json({ ok: true, status: 'SENT', note: 'Already delivered — nothing was posted twice.' })
  }
  return NextResponse.json({ error: outcome.error ?? 'Delivery failed', status: 'FAILED' }, { status: 502 })
}
