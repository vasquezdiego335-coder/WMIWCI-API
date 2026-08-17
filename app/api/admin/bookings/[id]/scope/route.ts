// ════════════════════════════════════════════════════════════════════════
//  PATCH /api/admin/bookings/[id]/scope
//
//  THE OWNER'S CORRECTION PATH (owner spec 2026-08-14, booking WMIC-1019).
//
//  The customer selected 1 Bedroom and disclosed a two-bedroom load. Before
//  this route the only way to fix that was to cancel and have the customer
//  create an entirely new booking — losing the $49 authorization, the
//  agreement acceptance, the attribution and the history with it. An owner
//  can now change:
//
//      1 Bedroom → 2 Bedroom
//
//  in place, and the customer does nothing.
//
//  TWO RULES THIS ROUTE ENFORCES:
//
//  1. PRICING NEVER MOVES SILENTLY. Changing the size changes the flat rate.
//     The first call REFUSES with 409 and returns the exact before/after
//     figures; the owner re-sends with `approvePriceChange: true`, which is
//     recorded (who, when) on the booking and in the audit log. There is no
//     path through this route that alters a customer's total without an owner
//     having read the new number.
//
//  2. THE SIZE IS NOT THE TRUCK. Correcting the size never touches
//     service_type_key or truck_provider. A 2-bedroom labor-only job is still
//     labor-only — that was the whole confusion this change set exists to end.
// ════════════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { apiLogger } from '@/lib/logger'
import { PACKAGES } from '@/lib/pricing-config'
import { customerBalance, JOB_MONEY_PAYMENT_SELECT, type BookingMoneyShape } from '@/lib/job-money'
import { describePriceChange, isPriceChange } from '@/lib/approval-guards'
import { resolveBookingScope, type ScopeInput } from '@/lib/booking-scope'

const ScopeSchema = z.object({
  /** New package key — '2br' etc. The SIZE only; never a truck claim. */
  moveSizeKey: z.enum(Object.keys(PACKAGES) as [string, ...string[]]).optional(),
  /** Why. Required with a size change so the record explains itself later. */
  reason: z.string().trim().min(3).max(300).optional(),
  /** The owner has read the new total and agrees to charge it. */
  approvePriceChange: z.boolean().optional(),

  /** Correct labor-only vs full-service (e.g. the customer called to say
   *  they rented a truck after all). */
  serviceTypeKey: z.enum(['labor_only', 'full_service']).optional(),
  truckProvider: z.string().trim().max(80).optional(),

  /** Assembly scope, once the customer has been asked what it actually is. */
  assemblyItems: z.string().trim().max(500).optional(),
  disassemblyItems: z.string().trim().max(500).optional(),
  needsAssembly: z.boolean().optional(),
  needsDisassembly: z.boolean().optional(),
  /** CENTS. An additional assembly fee, which is itself a price change. */
  assemblyFee: z.number().int().min(0).max(500_000).optional(),
  disassemblyFee: z.number().int().min(0).max(500_000).optional(),

  /** COI answers, once a building has actually been asked. */
  coiRequiredOrigin: z.enum(['yes', 'no', 'unknown']).optional(),
  coiRequiredDest: z.enum(['yes', 'no', 'unknown']).optional(),
  coiNotes: z.string().trim().max(500).optional(),

  /** Units, when the customer's address had one buried inside it. */
  originUnit: z.string().trim().max(40).optional(),
  destUnit: z.string().trim().max(40).optional(),

  /** The owner looked at the oversized-inventory flag and accepted it. */
  clearInventoryReview: z.boolean().optional(),
})

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const session = await getSession()
  if (!session || !['OWNER', 'MANAGER'].includes(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const booking = await prisma.booking.findUnique({
    where: { id: params.id },
    include: { payments: { select: JOB_MONEY_PAYMENT_SELECT } },
  })
  if (!booking) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const parsed = ScopeSchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 422 })
  }
  const body = parsed.data

  const data: Record<string, unknown> = {}
  const changed: string[] = []

  // ── The size, and the money it implies ──────────────────────────────────
  const currentTotalCents = customerBalance(booking as never).finalBilledCents
  let nextTotalCents = currentTotalCents

  if (body.moveSizeKey && body.moveSizeKey !== booking.moveSizeKey) {
    const pkg = PACKAGES[body.moveSizeKey as keyof typeof PACKAGES]
    if (!body.reason) {
      return NextResponse.json(
        { error: 'A reason is required when changing the move size.' },
        { status: 422 },
      )
    }
    const newBase = pkg.price.amount ?? null
    if (newBase == null) {
      // "Need a Quote" has no price; assigning it would blank the total.
      return NextResponse.json(
        { error: `${pkg.label} has no flat price — set the amount manually instead.` },
        { status: 422 },
      )
    }
    // The stored quote is base + access add-ons + travel. Swapping the base
    // keeps the add-ons and travel the customer already agreed to.
    const addonsAndTravel = Math.round(((booking.totalEstimate ?? booking.baseRate ?? 0) - (booking.baseRate ?? 0)) * 100)
    const nextQuoteCents = Math.round(newBase * 100) + Math.max(0, addonsAndTravel)
    nextTotalCents = customerBalance({
      ...(booking as unknown as BookingMoneyShape),
      baseRate: newBase,
      totalEstimate: nextQuoteCents / 100,
    }).finalBilledCents

    if (isPriceChange(currentTotalCents, nextTotalCents) && !body.approvePriceChange) {
      // REFUSED, deliberately, with everything the owner needs to decide.
      return NextResponse.json(
        {
          error: 'price_change_requires_approval',
          message: describePriceChange(currentTotalCents, nextTotalCents),
          currentTotalCents,
          nextTotalCents,
          from: booking.moveSizeKey ?? null,
          to: body.moveSizeKey,
        },
        { status: 409 },
      )
    }

    data.moveSizeKey = body.moveSizeKey
    data.baseRate = newBase
    data.totalEstimate = nextQuoteCents / 100
    data.moveSizeChangedAt = new Date()
    data.moveSizeChangedById = session.userId
    data.moveSizeChangeReason = body.reason
    // The size is now the owner's deliberate answer, so the size flag is spent.
    data.inventoryReviewRequired = false
    changed.push('moveSizeKey', 'baseRate', 'totalEstimate')
  }

  // Assembly fees are money too, and go through the same gate.
  for (const key of ['assemblyFee', 'disassemblyFee'] as const) {
    if (body[key] != null && body[key] !== (booking[key] ?? 0)) {
      const delta = body[key]! - (booking[key] ?? 0)
      if (delta !== 0 && !body.approvePriceChange) {
        return NextResponse.json(
          {
            error: 'price_change_requires_approval',
            message: describePriceChange(currentTotalCents, currentTotalCents + delta),
            currentTotalCents,
            nextTotalCents: currentTotalCents + delta,
          },
          { status: 409 },
        )
      }
      data[key] = body[key]
      nextTotalCents += delta
      changed.push(key)
    }
  }

  if (body.approvePriceChange && isPriceChange(currentTotalCents, nextTotalCents)) {
    data.priceChangeApprovedAt = new Date()
    data.priceChangeApprovedById = session.userId
  }

  // ── Everything that is NOT money ────────────────────────────────────────
  //    Note what is absent: changing the size never writes serviceTypeKey or
  //    truckProvider. Those move only when an owner says so explicitly.
  for (const key of ['serviceTypeKey', 'truckProvider', 'assemblyItems', 'disassemblyItems',
                     'needsAssembly', 'needsDisassembly', 'coiRequiredOrigin', 'coiRequiredDest',
                     'coiNotes', 'originUnit', 'destUnit'] as const) {
    if (body[key] !== undefined) {
      data[key] = body[key]
      changed.push(key)
    }
  }
  if (body.assemblyItems !== undefined || body.disassemblyItems !== undefined) {
    // Naming the furniture IS the scope becoming known.
    data.assemblyScopeKnown = !!(body.assemblyItems?.trim() || body.disassemblyItems?.trim() ||
      booking.assemblyItems?.trim() || booking.disassemblyItems?.trim())
    data.assemblyApprovalRequired = !data.assemblyScopeKnown
  }
  if (body.clearInventoryReview) {
    data.inventoryReviewRequired = false
    changed.push('inventoryReviewRequired')
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: 'No recognized fields to update' }, { status: 422 })
  }

  const updated = await prisma.booking.update({ where: { id: params.id }, data })

  // ── The record. A price move without an audit row is a price move nobody
  //    can explain three weeks later. ──
  const auditWrites: Promise<unknown>[] = []
  if (data.moveSizeKey) {
    auditWrites.push(
      prisma.auditLog.create({
        data: {
          action: 'MOVE_SIZE_CHANGED',
          userId: session.userId,
          bookingId: params.id,
          details: {
            from: booking.moveSizeKey ?? null,
            to: data.moveSizeKey,
            reason: body.reason,
            previousTotalCents: currentTotalCents,
            newTotalCents: nextTotalCents,
            changedBy: session.name,
          },
        },
      }),
    )
  }
  if (data.priceChangeApprovedAt) {
    auditWrites.push(
      prisma.auditLog.create({
        data: {
          action: 'PRICE_CHANGE_APPROVED',
          userId: session.userId,
          bookingId: params.id,
          details: { previousTotalCents: currentTotalCents, newTotalCents: nextTotalCents, approvedBy: session.name, reason: body.reason ?? null },
        },
      }),
    )
  }
  if (body.clearInventoryReview) {
    auditWrites.push(
      prisma.auditLog.create({
        data: {
          action: 'INVENTORY_REVIEW_CLEARED',
          userId: session.userId,
          bookingId: params.id,
          details: { clearedBy: session.name, reason: body.reason ?? null },
        },
      }),
    )
  }
  if (body.serviceTypeKey && body.serviceTypeKey !== booking.serviceTypeKey) {
    auditWrites.push(
      prisma.auditLog.create({
        data: {
          action: 'SERVICE_TYPE_CORRECTED',
          userId: session.userId,
          bookingId: params.id,
          details: { from: booking.serviceTypeKey ?? null, to: body.serviceTypeKey, changedBy: session.name },
        },
      }),
    )
  }
  // Audit writes are non-fatal: the correction has already been made, and
  // failing the request now would tell the owner it did not happen.
  await Promise.all(auditWrites).catch((err) =>
    apiLogger.error({ err: err instanceof Error ? err.message : String(err), bookingId: params.id }, 'scope audit write failed (non-fatal)'),
  )

  // Re-derive the scope from the SAVED row so the response describes what is
  // now stored, not what the caller asked for.
  const savedBalance = customerBalance({ ...(updated as unknown as BookingMoneyShape), payments: booking.payments as never })
  const scope = resolveBookingScope({
    ...(updated as unknown as ScopeInput),
    additionalCents: savedBalance.additionalChargeCents,
    collectedCents: savedBalance.collectedCents,
    authorizedNotCapturedCents: savedBalance.authorizedNotCapturedCents,
  })

  return NextResponse.json({
    ok: true,
    changed,
    booking: updated,
    priceChanged: isPriceChange(currentTotalCents, nextTotalCents),
    previousTotalCents: currentTotalCents,
    finalTotalCents: scope.quote.finalTotalCents,
    summary: scope.summary,
    flags: scope.flags,
  })
}
