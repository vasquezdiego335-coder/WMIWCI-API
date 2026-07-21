import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { apiLogger } from '@/lib/logger'
import { type Role } from '@/lib/permissions'
import { evaluateRateChange, buildRateAudit, type RatePatch, type RateProfile } from '@/lib/labor-rates'
import { z } from 'zod'

// ════════════════════════════════════════════════════════════════════════════
//  Labor-rate configuration for ONE staff profile (Stage 4, D6).
//  [id] is the USER id.
//
//  Separate from PATCH /api/admin/staff/[id] on purpose:
//   • that route refuses self-edits (you must not deactivate yourself); this
//     one MUST allow them, because Diego and Sebastian each configure their own
//     owner labor rate;
//   • rates are owner-financial authority, so this route asks for
//     `labor.set_owner_labor_value` rather than "is an owner" by hand.
//
//  WHAT THIS ROUTE DOES NOT DO: touch history. JobCrew rate snapshots are
//  frozen at assignment and are never re-read from a profile, so changing a
//  rate here cannot restate what a past move cost.
// ════════════════════════════════════════════════════════════════════════════

/** `null` clears a rate — an explicit "not decided yet", which is a valid
 *  configuration state and NOT the same as zero. */
const Schema = z.object({
  ownerEconomicRateCents: z.number().int().min(0).max(1_000_00).nullable().optional(),
  payRateCents: z.number().int().min(0).max(1_000_00).nullable().optional(),
  defaultFlatRateCents: z.number().int().min(0).max(10_000_00).nullable().optional(),
  defaultPayModel: z.enum(['HOURLY', 'FLAT', 'DAY_RATE']).nullable().optional(),
  rateEffectiveOn: z.string().nullable().optional(),
  rateNotes: z.string().trim().max(1000).nullable().optional(),
  active: z.boolean().optional(),
  canDrive: z.boolean().optional(),
  canLeadCrew: z.boolean().optional(),
  preferredRole: z.string().trim().max(60).nullable().optional(),
})

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  const role = session.role as Role

  const parsed = Schema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', issues: parsed.error.flatten() }, { status: 422 })
  }
  const patch = parsed.data as RatePatch

  // Permission + validation in ONE pure decision, so the API and any future
  // surface (a bulk editor, a script) cannot apply different rules.
  const decision = evaluateRateChange({ role, patch })
  if (!decision.allow) return NextResponse.json({ error: decision.error }, { status: decision.status })

  const before = await prisma.user.findUnique({
    where: { id: params.id },
    select: {
      id: true, name: true, role: true, active: true, workerType: true,
      ownerEconomicRateCents: true, payRate: true, defaultFlatRateCents: true,
      defaultPayModel: true, rateNotes: true, canDrive: true, canLeadCrew: true,
      preferredRole: true,
    },
  })
  if (!before) return NextResponse.json({ error: 'Staff member not found' }, { status: 404 })

  const profile: RateProfile = {
    id: before.id,
    name: before.name,
    role: before.role as RateProfile['role'],
    active: before.active,
    workerType: before.workerType,
    ownerEconomicRateCents: before.ownerEconomicRateCents,
    payRateCents: before.payRate,
    defaultFlatRateCents: before.defaultFlatRateCents,
    defaultPayModel: before.defaultPayModel as RateProfile['defaultPayModel'],
    rateNotes: before.rateNotes,
    canDrive: before.canDrive,
    canLeadCrew: before.canLeadCrew,
    preferredRole: before.preferredRole,
  }

  // Only fields the caller actually sent are written; `undefined` means "leave
  // alone", `null` means "clear it".
  const data: Record<string, unknown> = {}
  if (patch.ownerEconomicRateCents !== undefined) data.ownerEconomicRateCents = patch.ownerEconomicRateCents
  if (patch.payRateCents !== undefined) data.payRate = patch.payRateCents
  if (patch.defaultFlatRateCents !== undefined) data.defaultFlatRateCents = patch.defaultFlatRateCents
  if (patch.defaultPayModel !== undefined) data.defaultPayModel = patch.defaultPayModel
  if (patch.rateEffectiveOn !== undefined) {
    data.rateEffectiveOn = patch.rateEffectiveOn ? new Date(patch.rateEffectiveOn) : null
  }
  if (patch.rateNotes !== undefined) data.rateNotes = patch.rateNotes
  if (patch.active !== undefined) data.active = patch.active
  if (patch.canDrive !== undefined) data.canDrive = patch.canDrive
  if (patch.canLeadCrew !== undefined) data.canLeadCrew = patch.canLeadCrew
  if (patch.preferredRole !== undefined) data.preferredRole = patch.preferredRole
  data.rateUpdatedById = session.userId
  data.rateUpdatedAt = new Date()

  const updated = await prisma.user.update({ where: { id: params.id }, data })

  await prisma.auditLog.create({
    data: {
      action: 'LABOR_RATE_CONFIGURED',
      userId: session.userId,
      details: buildRateAudit({
        targetUserId: before.id,
        targetUserName: before.name,
        before: profile,
        patch,
        byName: session.name,
      }) as never,
    },
  }).catch((e) => apiLogger.error({ err: String(e) }, 'Rate-change audit write failed'))

  apiLogger.info({ targetUserId: params.id, fields: Object.keys(patch) }, 'Labor rates configured')

  return NextResponse.json({
    ok: true,
    user: {
      id: updated.id,
      name: updated.name,
      role: updated.role,
      active: updated.active,
      ownerEconomicRateCents: updated.ownerEconomicRateCents,
      payRateCents: updated.payRate,
      defaultFlatRateCents: updated.defaultFlatRateCents,
      defaultPayModel: updated.defaultPayModel,
      rateEffectiveOn: updated.rateEffectiveOn,
      rateNotes: updated.rateNotes,
      rateUpdatedAt: updated.rateUpdatedAt,
      canDrive: updated.canDrive,
      canLeadCrew: updated.canLeadCrew,
      preferredRole: updated.preferredRole,
    },
  })
}
