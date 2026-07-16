import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { can } from '@/lib/permissions'
import { LeadStatus, LeadLostReason, AuditAction, Prisma } from '@prisma/client'

export const runtime = 'nodejs'

// PATCH /api/admin/leads/[id] — owner/manager lead management. Every change is
// audit-logged (who/what/prev/new). Leads are soft-archived, never deleted.
const PatchSchema = z.object({
  status: z.nativeEnum(LeadStatus).optional(),
  lostReason: z.nativeEnum(LeadLostReason).nullable().optional(),
  assignedTo: z.string().trim().max(80).nullable().optional(),
  followUpAt: z.string().datetime().nullable().optional(),
  appendNote: z.string().trim().max(2000).optional(),
  archived: z.boolean().optional(),
  convertedBookingId: z.string().trim().max(40).nullable().optional(),
})

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!can(session.role, 'leads.manage')) {
    return NextResponse.json({ error: 'Only an owner or manager can manage leads.' }, { status: 403 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 })
  }
  const parsed = PatchSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'validation failed', details: parsed.error.flatten() }, { status: 422 })
  }
  const p = parsed.data

  const existing = await prisma.lead.findUnique({ where: { id: params.id } })
  if (!existing) return NextResponse.json({ error: 'lead not found' }, { status: 404 })

  const now = new Date()
  const data: Prisma.LeadUpdateInput = { lastActivityAt: now }
  const changes: { field: string; from: unknown; to: unknown }[] = []

  if (p.status && p.status !== existing.status) {
    data.status = p.status
    changes.push({ field: 'status', from: existing.status, to: p.status })
    if (p.status === 'CONTACTED' && !existing.contactedAt) data.contactedAt = now
    if (p.status === 'QUOTE_SENT' && !existing.quotedAt) data.quotedAt = now
    if (p.status === 'BOOKED' && !existing.bookedAt) data.bookedAt = now
    if ((p.status === 'LOST' || p.status === 'SPAM') && !existing.lostAt) data.lostAt = now
  }
  if (p.lostReason !== undefined && p.lostReason !== existing.lostReason) {
    data.lostReason = p.lostReason
    changes.push({ field: 'lostReason', from: existing.lostReason, to: p.lostReason })
  }
  if (p.assignedTo !== undefined && (p.assignedTo || null) !== existing.assignedTo) {
    data.assignedTo = p.assignedTo || null
    changes.push({ field: 'assignedTo', from: existing.assignedTo, to: p.assignedTo || null })
  }
  if (p.followUpAt !== undefined) {
    const next = p.followUpAt ? new Date(p.followUpAt) : null
    data.followUpAt = next
    changes.push({ field: 'followUpAt', from: existing.followUpAt, to: next })
  }
  if (p.convertedBookingId !== undefined && (p.convertedBookingId || null) !== existing.convertedBookingId) {
    data.convertedBookingId = p.convertedBookingId || null
    changes.push({ field: 'convertedBookingId', from: existing.convertedBookingId, to: p.convertedBookingId || null })
  }
  if (p.archived !== undefined && p.archived !== Boolean(existing.archivedAt)) {
    data.archivedAt = p.archived ? now : null
    changes.push({ field: 'archived', from: Boolean(existing.archivedAt), to: p.archived })
  }
  if (p.appendNote) {
    const stamp = `[${now.toISOString().slice(0, 10)} ${session.name}] ${p.appendNote}`
    data.notes = [existing.notes, stamp].filter(Boolean).join('\n')
    changes.push({ field: 'note', from: null, to: p.appendNote.slice(0, 120) })
  }

  if (changes.length === 0) return NextResponse.json({ ok: true, unchanged: true })

  const updated = await prisma.lead.update({ where: { id: params.id }, data })

  // Audit trail — LEAD_STATUS_CHANGED carries the full change set in details.
  await prisma.auditLog.create({
    data: {
      action: AuditAction.LEAD_STATUS_CHANGED,
      userId: session.userId,
      details: { leadId: params.id, actor: session.name, changes } as unknown as Prisma.InputJsonValue,
    },
  })

  return NextResponse.json({ ok: true, lead: { id: updated.id, status: updated.status, archived: Boolean(updated.archivedAt) } })
}
