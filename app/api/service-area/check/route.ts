import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { checkServiceArea, travelFeeDollars, type AddressInput } from '@/lib/service-area'
import { apiLogger } from '@/lib/logger'
import { guardSeasonalClosure } from '@/lib/seasonal-closure'

// ── CORS ─────────────────────────────────────────────────────────────
// Same cross-origin story as /api/bookings: the marketing site calls this from
// the browser. Reuse the same env-driven allowlist so both routes stay in sync.
const ALLOWED_ORIGINS = (
  process.env.CORS_ALLOWED_ORIGINS ??
  'http://localhost:3000,http://127.0.0.1:3000,http://localhost:8000,http://127.0.0.1:8000,https://www.wemoveitweclearit.com,https://wemoveitweclearit.com,https://www.moveitclearit.com,https://moveitclearit.com,https://wmiwci-backend.vercel.app'
)
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean)

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

export async function OPTIONS(req: NextRequest): Promise<NextResponse> {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req.headers.get('origin')) })
}

const clean = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined
  //  Control characters, written as ESCAPES. These were literal raw bytes —
  //  a NUL among them, which made this file BINARY to git: no diff, no review,
  //  and every tool that reads it as text silently truncating at the NUL. The
  //  class is byte-for-byte the same set it always matched.
  const s = v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  return s || undefined
}

const AddressSchema = z
  .object({
    street: z.string().max(200).optional(),
    city: z.string().max(120).optional(),
    state: z.string().max(40).optional(),
    zip: z.string().max(12).optional(),
    raw: z.string().max(300).optional(),
  })
  .transform((a): AddressInput => ({
    street: clean(a.street),
    city: clean(a.city),
    state: clean(a.state),
    zip: clean(a.zip),
    raw: clean(a.raw),
  }))

const RequestSchema = z.object({
  pickupAddresses: z.array(AddressSchema).max(10).optional().default([]),
  destinationAddress: AddressSchema,
})

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Winter mode: refuse before any database, Stripe or Google call.
  const closed = guardSeasonalClosure()
  if (closed) return closed
  const cors = corsHeaders(req.headers.get('origin'))

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: cors })
  }

  const parsed = RequestSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 422, headers: cors },
    )
  }

  const result = checkServiceArea(parsed.data.pickupAddresses, parsed.data.destinationAddress)

  apiLogger.info(
    { zone: result.zone, travelFeeCents: result.travelFeeCents, manualReview: result.manualReviewRequired },
    'service-area check',
  )

  // Public contract: travelFee in DOLLARS (null = pending review).
  return NextResponse.json(
    {
      serviceable: result.serviceable,
      zone: result.zone,
      travelFee: travelFeeDollars(result.travelFeeCents),
      manualReviewRequired: result.manualReviewRequired,
      message: result.message,
      distanceFromWestOrangeMiles: result.distanceFromWestOrangeMiles,
      estimatedDriveTimeMinutes: result.estimatedDriveTimeMinutes,
      evaluatedAddresses: result.evaluatedAddresses.map((e) => ({
        zone: e.zone,
        zip: e.zip,
        state: e.state,
        city: e.city,
        reason: e.reason,
      })),
    },
    { status: 200, headers: cors },
  )
}
