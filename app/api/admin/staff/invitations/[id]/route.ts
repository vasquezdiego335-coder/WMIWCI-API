import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { invitationExpiry } from '@/lib/invitation-service'
import { z } from 'zod'

// ════════════════════════════════════════════════════════════════════════════
//  Resend / cancel one crew invitation (Stage 5). Owner only. Idempotent:
//  cancelling an already-cancelled invite, or resending a non-pending one, is a
//  no-op with a clear message rather than a duplicate side effect.
// ════════════════════════════════════════════════════════════════════════════

const Schema = z.object({ action: z.enum(['RESEND', 'CANCEL']) })

export async function POST(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  if (session.role !== 'OWNER') return NextResponse.json({ error: 'Owner only' }, { status: 403 })

  const parsed = Schema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 422 })

  const inv = await prisma.crewInvitation.findUnique({ where: { id: params.id } })
  if (!inv) return NextResponse.json({ error: 'Invitation not found' }, { status: 404 })

  if (parsed.data.action === 'CANCEL') {
    if (inv.status !== 'PENDING') return NextResponse.json({ error: `This invitation is already ${inv.status.toLowerCase()}.` }, { status: 409 })
    await prisma.$transaction([
      prisma.crewInvitation.update({ where: { id: params.id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledById: session.userId } }),
      prisma.auditLog.create({ data: { action: 'INVITATION_CANCELLED', userId: session.userId, details: { invitationId: params.id, email: inv.email, by: session.name } as never } }),
    ])
    return NextResponse.json({ ok: true })
  }

  // RESEND — refresh expiry, bump the counter.
  if (inv.status !== 'PENDING') return NextResponse.json({ error: `Only a pending invitation can be resent (this one is ${inv.status.toLowerCase()}).` }, { status: 409 })
  await prisma.$transaction([
    prisma.crewInvitation.update({ where: { id: params.id }, data: { resentAt: new Date(), resendCount: { increment: 1 }, expiresAt: invitationExpiry() } }),
    prisma.auditLog.create({ data: { action: 'INVITATION_RESENT', userId: session.userId, details: { invitationId: params.id, email: inv.email, by: session.name } as never } }),
  ])
  return NextResponse.json({ ok: true })
}
