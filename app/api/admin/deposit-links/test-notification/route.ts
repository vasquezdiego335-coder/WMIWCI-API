import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { can, type Role } from '@/lib/permissions'
import { buildTestEmbed, sendPaymentEmbed, depositNotifyConfig } from '@/lib/discord-payments'

// ════════════════════════════════════════════════════════════════════════════
//  POST /api/admin/deposit-links/test-notification
//  ------------------------------------------------------------------------
//  Proves the Discord destination works, end to end, without money.
//
//  IT TOUCHES NO PAYMENT RECORD. There is no prisma import in this file at all
//  — not "we are careful not to write", but "there is nothing here that could".
//  The card says TEST in its title, its body and its footer, so nobody reading
//  Discord can mistake it for a real deposit.
// ════════════════════════════════════════════════════════════════════════════

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(_req: NextRequest): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  if (!can(session.role as Role, 'deposit.notify_test')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const cfg = depositNotifyConfig()
  if (!cfg.configured) {
    return NextResponse.json(
      { error: 'Discord notifications are not configured.', detail: cfg.reason, notifications: cfg },
      { status: 409 }
    )
  }

  const result = await sendPaymentEmbed(buildTestEmbed(session.name))
  if (!result.delivered) {
    return NextResponse.json({ error: result.error ?? 'Delivery failed', notifications: cfg }, { status: 502 })
  }
  return NextResponse.json({ ok: true, transport: result.transport, channelId: cfg.channelId, attempts: result.attempts })
}
