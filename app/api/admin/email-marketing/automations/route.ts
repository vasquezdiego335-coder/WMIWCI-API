// AUTOMATION API (owner spec 2026-07-21).
//
// GET   — automations with their active definition and the approved vocabulary.
// POST  — create an automation, or save a NEW VERSION of one.
// PATCH — change state (validate → test → active → paused → archived).
//
// A definition is never edited in place. Saving writes a new immutable version
// row, because a run already in flight must stay traceable to the exact rules
// that scheduled it.

import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { apiLogger } from '@/lib/logger'
import { denyReason, type Role } from '@/lib/permissions'
import {
  validateAutomationDefinition,
  canTransitionAutomation,
  canActivate,
  isAutomationState,
  APPROVED_TRIGGERS,
  describeAutomation,
  type AutomationState,
} from '@/lib/email-automation'
import { STOP_RULES, LOCKED_STOP_RULES, MIN_DELAY_MS, MAX_DELAY_MS, MAX_STAGES } from '@/lib/email-journey-config'
import { SEGMENTS } from '@/lib/email-audience'
import { promotionsEnabled } from '@/lib/email-campaign-run'
import { z } from 'zod'

const log = apiLogger.child({ route: 'admin/email-marketing/automations' })

export async function GET(): Promise<NextResponse> {
  const session = await getSession()
  const deny = denyReason(session?.role as Role, 'email.view')
  if (deny) return NextResponse.json({ error: deny }, { status: 403 })

  try {
    const rows = await prisma.emailAutomation.findMany({
      orderBy: { updatedAt: 'desc' },
      include: { versions: { orderBy: { version: 'desc' }, take: 10 } },
    })

    // Runtime truth: enrollment counts per automation + upcoming steps, so
    // "ACTIVE" is shown with evidence of what is actually enrolled/running.
    const enrollmentGroups = await prisma.emailAutomationEnrollment.groupBy({
      by: ['automationId', 'status'],
      _count: { _all: true },
    })
    const enrollmentsByAutomation = new Map<string, Record<string, number>>()
    for (const g of enrollmentGroups) {
      const entry = enrollmentsByAutomation.get(g.automationId) ?? {}
      entry[g.status] = g._count._all
      enrollmentsByAutomation.set(g.automationId, entry)
    }
    const upcoming = await prisma.emailAutomationEnrollment.findMany({
      where: { status: 'ACTIVE', nextRunAt: { not: null } },
      orderBy: { nextRunAt: 'asc' },
      take: 25,
      select: { automationId: true, email: true, currentStage: true, nextRunAt: true, stopReason: true },
    })
    const stops = await prisma.emailAutomationEnrollment.groupBy({
      by: ['automationId', 'stopReason'],
      where: { status: 'STOPPED', stopReason: { not: null } },
      _count: { _all: true },
    })

    const automations = rows.map((a) => {
      const active = a.versions.find((v) => v.version === a.activeVersion) ?? a.versions[0] ?? null
      // Stored definitions are validated on READ. One that became invalid is
      // reported as such rather than described as if it would run.
      const validated = active ? validateAutomationDefinition(active.definition) : null
      return {
        id: a.id,
        name: a.name,
        description: a.description,
        status: a.status,
        activeVersion: a.activeVersion,
        versionCount: a.versions.length,
        updatedAt: a.updatedAt,
        createdByName: a.createdByName,
        definition: validated?.ok ? validated.definition : null,
        summary: validated?.ok ? describeAutomation(validated.definition) : null,
        invalidReason: validated && !validated.ok ? validated.errors.join(' ') : null,
        versions: a.versions.map((v) => ({ version: v.version, createdAt: v.createdAt, createdByName: v.createdByName })),
        enrollments: enrollmentsByAutomation.get(a.id) ?? {},
        upcomingSteps: upcoming.filter((u) => u.automationId === a.id).slice(0, 5),
        stopReasons: stops
          .filter((s) => s.automationId === a.id)
          .map((s) => ({ reason: s.stopReason, count: s._count._all })),
      }
    })

    return NextResponse.json({
      automations,
      // The HONEST runtime indicator: an automation only actually sends when
      // the master promotional switch is on AND the worker process is running.
      runtime: { promotionsEnabled: promotionsEnabled() },
      vocabulary: {
        triggers: APPROVED_TRIGGERS,
        segments: SEGMENTS,
        stopRules: STOP_RULES,
        lockedStopRules: LOCKED_STOP_RULES,
        minDelayMs: MIN_DELAY_MS,
        maxDelayMs: MAX_DELAY_MS,
        maxStages: MAX_STAGES,
      },
    })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 503 })
  }
}

const SaveSchema = z.object({
  /** Omit to create a new automation. */
  id: z.string().trim().optional(),
  name: z.string().trim().min(2).max(120).optional(),
  description: z.string().trim().max(500).optional(),
  definition: z.unknown(),
})

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await getSession()
  const deny = denyReason(session?.role as Role, 'email.manage_journey')
  if (deny) return NextResponse.json({ error: deny }, { status: 403 })

  const parsed = SaveSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 })

  const validated = validateAutomationDefinition(parsed.data.definition)
  if (!validated.ok) {
    return NextResponse.json({ error: 'The automation definition was rejected.', errors: validated.errors }, { status: 400 })
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      let automation = parsed.data.id
        ? await tx.emailAutomation.findUnique({ where: { id: parsed.data.id } })
        : null

      if (!automation) {
        const name = parsed.data.name?.trim()
        if (!name) throw new Error('A new automation needs a name.')
        automation = await tx.emailAutomation.create({
          data: {
            name,
            description: parsed.data.description ?? null,
            // Always DRAFT. An automation cannot be born active.
            status: 'DRAFT',
            createdById: session?.userId ?? null,
            createdByName: session?.name ?? null,
          },
        })
      }

      const latest = await tx.emailAutomationVersion.findFirst({
        where: { automationId: automation.id },
        orderBy: { version: 'desc' },
        select: { version: true },
      })
      const nextVersion = (latest?.version ?? 0) + 1

      const version = await tx.emailAutomationVersion.create({
        data: {
          automationId: automation.id,
          version: nextVersion,
          definition: validated.definition as never,
          createdById: session?.userId ?? null,
          createdByName: session?.name ?? null,
        },
      })

      // Saving a new definition takes the automation OUT of ACTIVE. Editing the
      // rules of something currently mailing customers, and having the change
      // take effect silently, is the failure this prevents — the owner must
      // deliberately re-activate.
      const nextStatus = automation.status === 'ACTIVE' ? 'PAUSED' : automation.status
      await tx.emailAutomation.update({
        where: { id: automation.id },
        data: {
          activeVersion: nextVersion,
          status: nextStatus,
          ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
        },
      })

      await tx.auditLog.create({
        data: {
          action: 'EMAIL_AUTOMATION_SAVED',
          userId: session?.userId ?? null,
          details: {
            automationId: automation.id,
            name: automation.name,
            version: nextVersion,
            trigger: validated.definition.trigger,
            pausedByEdit: automation.status === 'ACTIVE',
          },
        },
      })

      return { automation, version, pausedByEdit: automation.status === 'ACTIVE' }
    })

    log.info({ automationId: result.automation.id, version: result.version.version, by: session?.userId }, 'automation version saved')
    return NextResponse.json(
      {
        automation: result.automation,
        version: result.version.version,
        warnings: validated.warnings,
        note: result.pausedByEdit
          ? 'The automation was ACTIVE, so it has been PAUSED. Re-activate it deliberately once you have reviewed the new version.'
          : null,
      },
      { status: 201 }
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const conflict = /Unique constraint/i.test(msg)
    return NextResponse.json({ error: conflict ? 'An automation with that name already exists.' : msg }, { status: conflict ? 409 : 500 })
  }
}

const PatchSchema = z.object({ id: z.string().trim().min(1), status: z.string().trim() })

export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const session = await getSession()
  const deny = denyReason(session?.role as Role, 'email.manage_journey')
  if (deny) return NextResponse.json({ error: deny }, { status: 403 })

  const parsed = PatchSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'An id and status are required.' }, { status: 400 })

  const automation = await prisma.emailAutomation.findUnique({
    where: { id: parsed.data.id },
    include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
  })
  if (!automation) return NextResponse.json({ error: 'That automation does not exist.' }, { status: 404 })

  const target = parsed.data.status
  if (!isAutomationState(target)) return NextResponse.json({ error: `Unknown state "${target}".` }, { status: 400 })

  const from = automation.status as AutomationState
  const verdict = canTransitionAutomation(from, target)
  if (!verdict.ok) return NextResponse.json({ error: verdict.error }, { status: 409 })

  // ACTIVE is the state where real customers get mail. It gets the extra check.
  if (target === 'ACTIVE') {
    const activation = canActivate({
      state: from,
      activeVersion: automation.activeVersion,
      definition: automation.versions[0]?.definition ?? null,
    })
    if (!activation.ok) return NextResponse.json({ error: activation.error }, { status: 409 })
  }

  await prisma.$transaction([
    prisma.emailAutomation.update({ where: { id: automation.id }, data: { status: target } }),
    prisma.auditLog.create({
      data: {
        action: 'EMAIL_AUTOMATION_STATE_CHANGED',
        userId: session?.userId ?? null,
        details: { automationId: automation.id, name: automation.name, from, to: target, version: automation.activeVersion },
      },
    }),
  ])

  log.info({ automationId: automation.id, from, to: target, by: session?.userId }, 'automation state changed')
  return NextResponse.json({ ok: true, status: target })
}
