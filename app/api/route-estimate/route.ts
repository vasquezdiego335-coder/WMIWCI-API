// ════════════════════════════════════════════════════════════════════════
//  POST /api/route-estimate — live routed mileage for the booking form.
//
//  Full-service transportation is $3 per ROUTED mile, so the form has to be
//  able to show the customer a real number as soon as their addresses are in.
//  The browser has no routing engine and a straight-line distance would
//  undercharge every job, so it asks here.
//
//  ADVISORY ONLY. This endpoint exists so the form can DISPLAY a live figure.
//  /api/bookings re-measures the route server-side and stores that result —
//  a mileage sent by the browser is never trusted, exactly like the travel fee
//  before it.
//
//  LABOR-ONLY NEVER CALLS THIS. There is no transportation to price, so those
//  addresses are never sent to a routing provider at all.
// ════════════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { computeRouteDistance } from '@/lib/route-distance'
import { mileageChargeForMiles, TRANSPORTATION_MILEAGE, COPY } from '@/lib/pricing-config'
import { rateLimit, tooManyRequests, LIMITS, clientIp } from '@/lib/rate-limit'
import { apiLogger } from '@/lib/logger'

// Same cross-origin story as /api/bookings and /api/service-area/check: the
// static marketing site calls this from the browser. One shared allowlist.
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

const line = z.string().max(300)

const RequestSchema = z.object({
  origin: line,
  destination: line,
  stops: z.array(line).max(10).optional().default([]),
})

export async function POST(req: NextRequest): Promise<NextResponse> {
  const cors = corsHeaders(req.headers.get('origin'))

  // Routing calls cost money per request, so this is rate-limited like booking.
  const rl = await rateLimit(LIMITS.booking, [clientIp(req)])
  if (!rl.ok) {
    const res = tooManyRequests(rl)
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v)
    return res
  }

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

  const result = await computeRouteDistance(parsed.data)
  const charge = mileageChargeForMiles(result.miles)

  // Log the OUTCOME, never the addresses — this is a customer's home address
  // and it has no business in an application log.
  apiLogger.info(
    { status: result.status, billableMiles: charge.billableMiles, waypoints: result.waypointCount },
    'route estimate',
  )

  return NextResponse.json(
    {
      status: result.status,
      // Unrounded driving miles, for display ("about 30.4 mi").
      miles: result.miles == null ? null : Math.round(result.miles * 100) / 100,
      // What we would actually bill — rounded UP to the whole mile.
      billableMiles: charge.billableMiles,
      ratePerMile: TRANSPORTATION_MILEAGE.ratePerMile,
      fuelIncluded: true,
      // DOLLARS. null when the route could not be measured — NEVER 0, which
      // would read as free transportation.
      amount: charge.kind === 'fixed' ? charge.amount ?? null : null,
      durationMinutes: result.durationMinutes,
      requiresManualReview: result.requiresManualReview,
      message: result.requiresManualReview ? COPY.route_failed.en : COPY.route_may_change.en,
      message_es: result.requiresManualReview ? COPY.route_failed.es : COPY.route_may_change.es,
    },
    { status: 200, headers: cors },
  )
}
