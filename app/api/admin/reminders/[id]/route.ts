import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { apiLogger } from '@/lib/logger'
import { can, type Role } from '@/lib/permissions'
import { TaskOwner } from '@prisma/client'
import { z } from 'zod'

// Reminder actions (increment 2, hardened 2.1). Lifecycle: acknowledge / start /
// claim / assign / unassign / resolve / snooze / note / dismiss (scoped) /
// restore / reopen. Permissions come from the matrix (permanent dismissal +
// restore are owner-only). Every state change + its audit log commit in ONE
// transaction — an audit row can never disagree with the reminder state.

const Schema = z.object({
  action: z.enum(['acknowledge', 'start', 'claim', 'assign', 'unassign', 'resolve', 'dismiss', 'restore', 'reopen', 'snooze', 'note']),
  snoozedUntil: z.string().optional(),
  assignedOwner: z.nativeEnum(TaskOwner).nullable().optional(),
  scope: z.enum(['OCCURRENCE', 'UNTIL_ENTITY_CHANGES', 'PERMANENT_RULE_ENTITY']).optional(),
  note: z.string().trim().max(1000).optional(),
})

// Which permission each action needs.
function actionPermission(action: string, scope?: string) {
  switch (action) {
    case 'assign': return 'reminder.assign' as const
    case 'claim': case 'unassign': return 'reminder.claim' as const
    case 'snooze': return 'reminder.snooze' as const
    case 'note': return 'reminder.note' as const
    case 'restore': return 'reminder.restore' as const
    case 'dismiss': return scope === 'PERMANENT_RULE_ENTITY' ? 'reminder.dismiss_permanent' as const : 'reminder.dismiss_occurrence' as const
    default: return 'reminder.resolve' as const // acknowledge/start/resolve/reopen = operational
  }
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })

  const existing = await prisma.reminder.findUnique({ where: { id: params.id } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const parsed = Schema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request', issues: parsed.error.flatten() }, { status: 422 })
  const d = parsed.data
  const now = new Date()

  // Server-side authorization (frontend hiding is not the gate).
  const perm = actionPermission(d.action, d.scope)
  if (!can(session.role as Role, perm)) {
    const msg = d.action === 'dismiss' && d.scope === 'PERMANENT_RULE_ENTITY'
      ? 'Only an owner can permanently dismiss this warning.'
      : 'You do not have permission for this action.'
    return NextResponse.json({ error: msg }, { status: 403 })
  }

  const data: Record<string, unknown> = {}
  let auditAction: 'REMINDER_UPDATED' | 'REMINDER_DISMISSED' | 'REMINDER_RESTORED' = 'REMINDER_UPDATED'

  switch (d.action) {
    case 'acknowledge':
      data.status = 'ACKNOWLEDGED'; data.acknowledgedAt = now
      break
    case 'start':
      data.status = 'IN_PROGRESS'; data.startedAt = now
      break
    case 'claim':
      data.claimedById = session.userId; data.claimedByName = session.name; data.claimedAt = now
      if (existing.status === 'OPEN') data.status = 'ACKNOWLEDGED'
      break
    case 'assign':
      data.assignedOwner = d.assignedOwner ?? null; data.assignedAt = d.assignedOwner ? now : null; data.assignedByName = d.assignedOwner ? session.name : null
      break
    case 'unassign':
      data.assignedOwner = null; data.assignedAt = null; data.assignedByName = null; data.claimedById = null; data.claimedByName = null; data.claimedAt = null
      break
    case 'resolve':
      data.status = 'RESOLVED'; data.resolvedAt = now; data.completedById = session.userId; data.completedByName = session.name
      data.resolutionNote = d.note || `Resolved by ${session.name}`
      break
    case 'dismiss': {
      const scope = d.scope ?? 'OCCURRENCE'
      if (scope === 'PERMANENT_RULE_ENTITY' && !d.note) {
        return NextResponse.json({ error: 'A reason is required to permanently dismiss a reminder.' }, { status: 422 })
      }
      data.status = 'DISMISSED'; data.dismissedAt = now; data.dismissalScope = scope
      data.dismissedById = session.userId; data.dismissedByName = session.name
      data.resolutionNote = d.note || `Dismissed (${scope.toLowerCase().replace(/_/g, ' ')}) by ${session.name}`
      auditAction = 'REMINDER_DISMISSED'
      break
    }
    case 'restore':
      data.status = 'OPEN'; data.dismissedAt = null; data.dismissalScope = null; data.dismissedById = null; data.dismissedByName = null; data.resolvedAt = null
      data.resolutionNote = `Restored by ${session.name}`
      auditAction = 'REMINDER_RESTORED'
      break
    case 'reopen':
      data.status = 'OPEN'; data.resolvedAt = null; data.dismissedAt = null; data.dismissalScope = null
      break
    case 'snooze': {
      const until = d.snoozedUntil ? new Date(d.snoozedUntil) : null
      if (!until || Number.isNaN(until.getTime()) || until.getTime() <= now.getTime()) {
        return NextResponse.json({ error: 'Snooze needs a future date/time' }, { status: 422 })
      }
      data.status = 'SNOOZED'; data.snoozedUntil = until
      break
    }
    case 'note':
      if (!d.note) return NextResponse.json({ error: 'Note text required' }, { status: 422 })
      data.internalNote = d.note
      break
  }

  // Business write + audit in one transaction: both commit or neither does.
  const [updated] = await prisma.$transaction([
    prisma.reminder.update({ where: { id: params.id }, data }),
    prisma.auditLog.create({
      data: {
        action: auditAction,
        userId: session.userId,
        details: {
          reminderId: existing.id, reminderType: existing.reminderType, actionTaken: d.action,
          scope: d.scope, from: { status: existing.status, assignedOwner: existing.assignedOwner },
          reason: d.note ?? undefined, by: session.name,
        },
      },
    }),
  ])

  apiLogger.info({ reminderId: existing.id, action: d.action, scope: d.scope }, 'Reminder updated')
  return NextResponse.json(updated)
}
