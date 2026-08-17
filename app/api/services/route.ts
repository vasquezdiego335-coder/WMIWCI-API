// ════════════════════════════════════════════════════════════════════════
//  GET /api/services — THE canonical service catalogue.
//
//  Move It Clear It sells two products, and this endpoint is the one place
//  that says what they are and what they cost:
//
//    full_service   our crew and our truck, flat package price ($550 for 1BR)
//    labor_only     the customer's truck, $150/hour for two movers, 2h minimum
//
//  WHY IT EXISTS. The booking form, the services page and the generated
//  browser pricing mirror each carried their own copy of these numbers. That
//  is how the form came to advertise "$150 per hour" while the server priced a
//  flat bedroom package — two truths, one booking, and the customer reading
//  the wrong one. Every SITE surface must originate here.
//
//  PUBLIC AND CACHEABLE. It contains published prices only — no customer data,
//  no secrets, no per-booking state. It is CORS-enabled because the marketing
//  site is served from a different origin than this API.
//
//  It is READ-ONLY and has no side effects.
// ════════════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server'
import { PRICING_VERSION, serviceCatalog } from '@/lib/product-catalog'
import { BOOKING_AUTHORIZATION } from '@/lib/pricing-config'

// The marketing site is cross-origin; the catalogue is public data.
const ALLOWED_ORIGINS = (
  process.env.CORS_ALLOWED_ORIGINS ??
  'http://localhost:3000,http://127.0.0.1:3000,http://localhost:8000,http://127.0.0.1:8000,https://www.wemoveitweclearit.com,https://wemoveitweclearit.com,https://www.moveitclearit.com,https://moveitclearit.com'
)
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean)

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
    // Published prices change rarely, but a stale price is a wrong quote, so
    // the window is short and revalidation is allowed while serving.
    'Cache-Control': 'public, max-age=300, stale-while-revalidate=3600',
  }
}

export async function OPTIONS(req: NextRequest): Promise<NextResponse> {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req.headers.get('origin')) })
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const services = serviceCatalog()

  const res = NextResponse.json({
    pricingVersion: PRICING_VERSION,
    /**
     * The $49 manual-capture authorization. Listed here so the SITE can never
     * describe it as a fee, a deposit or a truck charge: it is a hold, taken
     * on either product, captured only on owner approval, and applied toward
     * whichever total the customer accepted.
     */
    bookingAuthorization: {
      amountCents: BOOKING_AUTHORIZATION.amountCents,
      label: BOOKING_AUTHORIZATION.label,
      label_es: BOOKING_AUTHORIZATION.label_es,
      note: BOOKING_AUTHORIZATION.note,
      note_es: BOOKING_AUTHORIZATION.note_es,
      capturedOnApproval: true,
      appliedToTotal: true,
    },
    services,
  })
  for (const [k, v] of Object.entries(corsHeaders(req.headers.get('origin')))) res.headers.set(k, v)
  return res
}
