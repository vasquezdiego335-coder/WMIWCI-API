import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { apiLogger } from '@/lib/logger'
import { can, type Role } from '@/lib/permissions'
import { recommendEstimate } from '@/lib/estimate-assistant'
import { computeEstimate } from '@/lib/estimate'
import { z } from 'zod'

// Moving OS Phase 1 — estimating assistant (owner spec 2026-08-11).
// POST body = the Book Move workspace's live inputs; response = {
//   recommendation: crew/truck/hours/trips/difficulty + WHY (advisory, never
//                   a price — see estimate-assistant.ts's contract),
//   quote:          computeEstimate() over the same inputs — the RECOMMENDED
//                   price shown next to the owner's price field.
// } Nothing is persisted; the workspace calls this on every debounced change.

const InventoryItemSchema = z.object({
  name: z.string().trim().min(1).max(200),
  quantity: z.number().int().min(1).max(99).default(1),
  isHeavy: z.boolean().optional(),
  needsDisassembly: z.boolean().optional(),
  recommendedMovers: z.number().int().min(1).max(10).nullish(),
})

const BodySchema = z.object({
  serviceType: z.string().trim().max(50).nullish(),
  bedrooms: z.number().int().min(0).max(20).nullish(),
  inventory: z.array(InventoryItemSchema).max(200).default([]),
  originStairFlights: z.number().int().min(0).max(20).nullish(),
  destStairFlights: z.number().int().min(0).max(20).nullish(),
  originHasElevator: z.boolean().nullish(),
  destHasElevator: z.boolean().nullish(),
  longCarry: z.boolean().nullish(),
  needsPacking: z.boolean().nullish(),
  needsAssembly: z.boolean().nullish(),
  needsDisassembly: z.boolean().nullish(),
  additionalStops: z.number().int().min(0).max(10).nullish(),
})

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  if (!can(session.role as Role, 'booking.create_admin')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const parsed = BodySchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', issues: parsed.error.flatten() }, { status: 422 })
  }
  const d = parsed.data

  try {
    const recommendation = recommendEstimate(d)

    // The recommended price: the SAME canonical calculation the public booking
    // form uses, fed the structured access fields this body carries. The
    // workspace's longCarry boolean maps to the legacy longWalk input (the
    // 100–250ft tier — computeEstimate documents that mapping); stops without
    // a known distance price at the published within-10-miles tier, which the
    // owner adjusts on review.
    const quote = computeEstimate({
      serviceType: d.serviceType ?? null,
      pickupStairFlights: d.originStairFlights ?? null,
      dropoffStairFlights: d.destStairFlights ?? null,
      longWalk: d.longCarry ?? null,
      additionalStops:
        d.additionalStops && d.additionalStops > 0
          ? Array.from({ length: d.additionalStops }, (_, n) => ({ label: `Additional stop ${n + 1}` }))
          : null,
    })

    return NextResponse.json({ recommendation, quote })
  } catch (err) {
    apiLogger.error({ err }, 'Estimate recommendation failed')
    return NextResponse.json({ error: 'Failed to compute recommendation' }, { status: 500 })
  }
}
