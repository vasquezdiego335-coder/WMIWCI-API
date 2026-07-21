// Email marketing overview API (owner spec 2026-07-21).
//
// One call that answers the owner's questions as JSON: what exists, what fired,
// what was delivered, what was refused, and — for owners — what it produced.
// Used by the admin pages' clients and available for scripted checks during
// staging verification.

import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { denyReason, type Role } from '@/lib/permissions'
import { getOverview, parseRange, webhookHealth } from '@/lib/email-admin'
import { templateRegistry, journeyRegistry } from '@/lib/email-registry'
import { attributionByJourney } from '@/lib/email-attribution'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await getSession()
  const deny = denyReason(session?.role as Role, 'email.view')
  if (deny) return NextResponse.json({ error: deny }, { status: 403 })

  const url = new URL(req.url)
  const range = parseRange(url.searchParams.get('range'))
  const maySeeMoney = denyReason(session?.role as Role, 'email.view_attribution') === null

  const [overview, health, attribution] = await Promise.all([
    getOverview(range),
    webhookHealth(),
    maySeeMoney ? attributionByJourney(range) : Promise.resolve({ rows: [], error: null }),
  ])

  return NextResponse.json({
    range,
    overview,
    provider: health,
    templates: templateRegistry(),
    journeys: journeyRegistry(),
    // Absent rather than zeroed for a role that may not see it — a 0 would read
    // as "this campaign earned nothing", which is a different claim.
    attribution: maySeeMoney ? attribution.rows : null,
  })
}
