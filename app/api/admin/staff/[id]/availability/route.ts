import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { can, type Role } from '@/lib/permissions'
import { z } from 'zod'

// ════════════════════════════════════════════════════════════════════════════
//  Worker availability (Stage 5). [id] is the USER id.
//   GET  recurring rules + exceptions
//   POST create a recurring rule OR a date exception (discriminated by `type`)
// ════════════════════════════════════════════════════════════════════════════

export async function GET(_req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  if (!can(session.role as Role, 'schedule.view')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const [rules, exceptions] = await Promise.all([
    prisma.availabilityRule.findMany({ where: { userId: params.id }, orderBy: [{ dayOfWeek: 'asc' }, { startMinute: 'asc' }] }),
    prisma.availabilityException.findMany({ where: { userId: params.id }, orderBy: { date: 'asc' } }),
  ])
  return NextResponse.json({ rules, exceptions })
}

const RuleSchema = z.object({
  type: z.literal('rule'),
  dayOfWeek: z.number().int().min(0).max(6),
  startMinute: z.number().int().min(0).max(1440),
  endMinute: z.number().int().min(0).max(1440),
  timezone: z.string().max(64).default('America/New_York'),
  effectiveFrom: z.string().nullable().optional(),
  effectiveTo: z.string().nullable().optional(),
  notes: z.string().trim().max(300).nullable().optional(),
})
const ExceptionSchema = z.object({
  type: z.literal('exception'),
  kind: z.enum(['ADMIN_BLOCK', 'UNAVAILABLE_FULL', 'UNAVAILABLE_PARTIAL', 'AVAILABLE_OVERRIDE', 'VACATION', 'LEAVE']),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
  startMinute: z.number().int().min(0).max(1440).nullable().optional(),
  endMinute: z.number().int().min(0).max(1440).nullable().optional(),
  timezone: z.string().max(64).default('America/New_York'),
  reason: z.string().trim().max(300).nullable().optional(),
})
const Schema = z.discriminatedUnion('type', [RuleSchema, ExceptionSchema])

export async function POST(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  if (!can(session.role as Role, 'staff.manage_availability')) return NextResponse.json({ error: 'You do not have permission to manage availability.' }, { status: 403 })

  const parsed = Schema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request', issues: parsed.error.flatten() }, { status: 422 })
  const d = parsed.data

  if (d.type === 'rule') {
    if (d.endMinute <= d.startMinute) return NextResponse.json({ error: 'The end time must be after the start time.' }, { status: 422 })
    const row = await prisma.availabilityRule.create({
      data: {
        userId: params.id, dayOfWeek: d.dayOfWeek, startMinute: d.startMinute, endMinute: d.endMinute,
        timezone: d.timezone, effectiveFrom: d.effectiveFrom ? new Date(d.effectiveFrom) : null,
        effectiveTo: d.effectiveTo ? new Date(d.effectiveTo) : null, notes: d.notes ?? null, createdById: session.userId,
      },
    })
    await prisma.auditLog.create({ data: { action: 'AVAILABILITY_RULE_CREATED', userId: session.userId, details: { targetUserId: params.id, ruleId: row.id, dayOfWeek: d.dayOfWeek, by: session.name } as never } })
    return NextResponse.json({ ok: true, rule: row })
  }

  if ((d.kind === 'UNAVAILABLE_PARTIAL' || d.kind === 'AVAILABLE_OVERRIDE') && (d.startMinute == null || d.endMinute == null)) {
    return NextResponse.json({ error: 'A partial window needs a start and end time.' }, { status: 422 })
  }
  if (d.startMinute != null && d.endMinute != null && d.endMinute <= d.startMinute) {
    return NextResponse.json({ error: 'The end time must be after the start time.' }, { status: 422 })
  }
  if (Number.isNaN(new Date(`${d.date}T00:00:00Z`).getTime())) {
    return NextResponse.json({ error: 'The date is not a valid calendar date.' }, { status: 422 })
  }
  const row = await prisma.availabilityException.create({
    data: {
      userId: params.id, kind: d.kind as never, date: new Date(`${d.date}T00:00:00Z`),
      startMinute: d.startMinute ?? null, endMinute: d.endMinute ?? null, timezone: d.timezone,
      reason: d.reason ?? null, createdById: session.userId,
    },
  })
  await prisma.auditLog.create({ data: { action: 'AVAILABILITY_EXCEPTION_CREATED', userId: session.userId, details: { targetUserId: params.id, exceptionId: row.id, kind: d.kind, date: d.date, by: session.name } as never } })
  return NextResponse.json({ ok: true, exception: row })
}
