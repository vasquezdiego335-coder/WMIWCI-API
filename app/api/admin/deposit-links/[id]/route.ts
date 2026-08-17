import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { can, type Role } from '@/lib/permissions'
import { cancelDepositRequest } from '@/lib/deposit-service'
import { z } from 'zod'

// PATCH /api/admin/deposit-links/[id] — cancel (or expire) an UNPAID link.
//
// There is no edit here on purpose. Changing the amount of a link a customer
// may already be looking at is how someone pays a number nobody agreed to;
// cancel it and mint a new one instead.

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Schema = z.object({ action: z.enum(['cancel', 'expire']) })

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  if (!can(session.role as Role, 'deposit.cancel')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const parsed = Schema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 422 })

  // 'expire' and 'cancel' both mean "this link must stop working now"; they are
  // one state so the list cannot show two flavours of dead.
  const result = await cancelDepositRequest(params.id, { userId: session.userId, name: session.name })
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json({ ok: true, status: 'CANCELED' })
}
