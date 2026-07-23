import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { type Role } from '@/lib/permissions'
import { canInviteCrew } from '@/lib/scheduling-guards'
import { evaluateInvite, newInvitationToken, invitationExpiry } from '@/lib/invitation-service'
import { z } from 'zod'

// ════════════════════════════════════════════════════════════════════════════
//  Crew invitations (Stage 5). Owner only.
//   GET  list pending / recent invitations
//   POST create an invitation (never grants OWNER; duplicate-protected)
// ════════════════════════════════════════════════════════════════════════════

export async function GET(): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  if (session.role !== 'OWNER') return NextResponse.json({ error: 'Owner only' }, { status: 403 })
  // The token is the acceptance credential — it is never returned in a list.
  const invitations = await prisma.crewInvitation.findMany({
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: {
      id: true, email: true, name: true, phone: true, role: true, workerType: true,
      initialRateCents: true, initialSkills: true, canDrive: true, status: true,
      expiresAt: true, invitedById: true, acceptedByUserId: true, acceptedAt: true,
      cancelledAt: true, cancelledById: true, resentAt: true, resendCount: true, createdAt: true,
    },
  })
  return NextResponse.json({ invitations })
}

const SKILLS = ['PACKING', 'FURNITURE_PROTECTION', 'ASSEMBLY', 'HEAVY_ITEMS', 'STAIR_CARRY', 'DRIVING', 'LEAD', 'LOADING', 'UNLOADING'] as const

const Schema = z.object({
  email: z.string().email(),
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().max(40).nullable().optional(),
  role: z.enum(['MANAGER', 'CREW']).default('CREW'),
  workerType: z.enum(['EMPLOYEE', 'CONTRACTOR', 'TEMP_HELPER']).default('EMPLOYEE'),
  initialRateCents: z.number().int().min(0).max(1_000_00).nullable().optional(),
  initialSkills: z.array(z.enum(SKILLS)).default([]),
  canDrive: z.boolean().default(false),
})

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  const role = session.role as Role

  const parsed = Schema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request', issues: parsed.error.flatten() }, { status: 422 })
  const d = parsed.data
  const email = d.email.toLowerCase().trim()

  const gate = canInviteCrew({ role, targetRole: d.role })
  if (!gate.allow) return NextResponse.json({ error: gate.error }, { status: gate.status })

  const [existingUser, pending] = await Promise.all([
    prisma.user.findUnique({ where: { email }, select: { id: true } }),
    prisma.crewInvitation.findFirst({ where: { email, status: 'PENDING' }, select: { id: true } }),
  ])
  const decision = evaluateInvite({ existingUser: !!existingUser, activePendingInvite: !!pending, role: d.role })
  if (!decision.allow) return NextResponse.json({ error: decision.error }, { status: decision.status })

  const invitation = await prisma.crewInvitation.create({
    data: {
      email, name: d.name, phone: d.phone ?? null, role: d.role as never, workerType: d.workerType as never,
      initialRateCents: d.initialRateCents ?? null, initialSkills: d.initialSkills as never, canDrive: d.canDrive,
      token: newInvitationToken(), status: 'PENDING', expiresAt: invitationExpiry(), invitedById: session.userId,
    },
  })
  await prisma.auditLog.create({ data: { action: 'STAFF_INVITED', userId: session.userId, details: { invitationId: invitation.id, email, role: d.role, by: session.name } as never } })

  // Account creation from an accepted invitation depends on the auth onboarding
  // flow (documented in stage5-crew-management.md); the token is the credential.
  return NextResponse.json({ ok: true, invitation: { id: invitation.id, email, status: invitation.status, expiresAt: invitation.expiresAt } })
}
