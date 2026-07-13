import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { apiLogger } from '@/lib/logger'
import { TaskOwner } from '@prisma/client'
import { z } from 'zod'

// Reminder actions (increment 2): acknowledge / start / resolve / dismiss /
// reopen / snooze / assign / note. Every state change is audited (who, what,
// when, from → to). Reminders are NEVER hard-deleted through owner actions —
// resolved and dismissed rows stay in history.

const Schema = z.object({
  action: z.enum(['acknowledge', 'start', 'resolve', 'dismiss', 'reopen', 'snooze', 'assign', 'note']),
  snoozedUntil: z.string().optional(), // ISO date/time, required for snooze
  assignedOwner: z.nativeEnum(TaskOwner).nullable().optional(), // for assign
  note: z.string().trim().max(1000).optional(), // resolution/dismissal/internal note
})

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const session = await getSession()
  if (!session || !['OWNER', 'MANAGER'].includes(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const existing = await prisma.reminder.findUnique({ where: { id: params.id } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const parsed = Schema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request', issues: parsed.error.flatten() }, { status: 422 })
  const d = parsed.data
  const now = new Date()

  const data: Record<string, unknown> = {}
  switch (d.action) {
    case 'acknowledge':
      data.status = 'ACKNOWLEDGED'
      data.acknowledgedAt = now
      break
    case 'start':
      data.status = 'IN_PROGRESS'
      data.startedAt = now
      break
    case 'resolve':
      data.status = 'RESOLVED'
      data.resolvedAt = now
      data.resolutionNote = d.note || `Resolved by ${session.name}`
      break
    case 'dismiss':
      data.status = 'DISMISSED'
      data.dismissedAt = now
      data.resolutionNote = d.note || `Dismissed by ${session.name}`
      break
    case 'reopen':
      data.status = 'OPEN'
      data.resolvedAt = null
      data.dismissedAt = null
      break
    case 'snooze': {
      const until = d.snoozedUntil ? new Date(d.snoozedUntil) : null
      if (!until || Number.isNaN(until.getTime()) || until.getTime() <= now.getTime()) {
        return NextResponse.json({ error: 'Snooze needs a future date/time' }, { status: 422 })
      }
      data.status = 'SNOOZED'
      data.snoozedUntil = until
      break
    }
    case 'assign':
      data.assignedOwner = d.assignedOwner ?? null
      break
    case 'note':
      if (!d.note) return NextResponse.json({ error: 'Note text required' }, { status: 422 })
      data.internalNote = d.note
      break
  }

  const updated = await prisma.reminder.update({ where: { id: params.id }, data })

  await prisma.auditLog.create({
    data: {
      action: 'REMINDER_UPDATED',
      userId: session.userId,
      details: {
        reminderId: existing.id,
        reminderType: existing.reminderType,
        actionTaken: d.action,
        from: { status: existing.status, assignedOwner: existing.assignedOwner },
        to: { status: updated.status, assignedOwner: updated.assignedOwner, snoozedUntil: updated.snoozedUntil },
        by: session.name,
      },
    },
  })

  apiLogger.info({ reminderId: existing.id, action: d.action }, 'Reminder updated')
  return NextResponse.json(updated)
}
