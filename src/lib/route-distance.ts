// ════════════════════════════════════════════════════════════════════════
//  route-distance.ts — the DRIVING distance of a full-service move.
//
//  Full-service transportation is $3 per ROUTED mile (TRANSPORTATION_MILEAGE),
//  so this module answers exactly one question: how many miles does the truck
//  actually drive, from the first pickup, through every requested stop in
//  order, to the final drop-off?
//
//  WHY A ROUTING PROVIDER AND NOT A FORMULA
//  service-area.ts is a pure ZIP classifier — it says so itself: it "cannot
//  measure a route". A straight-line (haversine) distance is typically 20-35%
//  short of the real drive in northern New Jersey, because the road network
//  bends around the Watchungs, the Passaic river crossings and the Turnpike
//  interchanges. Billing a straight line at $3/mile would undercharge every
//  job, and "fixing" it with a fudge factor would be a number we could not
//  explain to a customer holding their own map app. So: a real routing call,
//  or an honest "we could not measure this".
//
//  DEGRADE-SAFE, NEVER GUESSES (owner rule: routing failure → manual review)
//    • no GOOGLE_MAPS_SERVER_KEY  → { miles: null, status: 'skipped' }
//    • timeout / network / non-200 → { miles: null, status: 'failed' }
//    • an address that will not geocode → { miles: null, status: 'failed' }
//  A null distance NEVER becomes zero. `mileageChargeForMiles(null)` returns a
//  review-gated charge, so the booking says "confirmed during review" rather
//  than quoting a free trip.
//
//  NO CENTROIDS. Every waypoint is the customer's own address string. The
//  owner rule forbids computing from county or ZIP-code centre points, so
//  there is deliberately no ZIP→coordinate table in this file to fall back to.
//
//  PRIVACY. Addresses go to the routing provider (that is the whole job) and
//  NOWHERE else. `summarize()` exists so callers can log/persist a route
//  WITHOUT the address strings — see Booking.routeSummary.
//
//  Routes API v2 request shape (validated against the official docs):
//  POST https://routes.googleapis.com/directions/v2:computeRoutes
//    header X-Goog-FieldMask: routes.distanceMeters,routes.duration
//    { origin:{address}, destination:{address}, intermediates:[{address}],
//      travelMode:'DRIVE', units:'IMPERIAL' }
// ════════════════════════════════════════════════════════════════════════

/** Metres in one statute mile. Exact by definition. */
const METERS_PER_MILE = 1609.344

export type RouteStatus =
  /** A real driving distance came back. */
  | 'ok'
  /** No provider key configured — routing was never attempted. */
  | 'skipped'
  /** Provider was called and could not answer (timeout, HTTP error, no route). */
  | 'failed'
  /** Not enough addresses to form a route (need an origin AND a destination). */
  | 'insufficient_addresses'

export type RouteResult = {
  status: RouteStatus
  /** Driving miles for the WHOLE route, unrounded. null unless status==='ok'.
   *  Rounding up to the billable mile is pricing-config's job, not this file's. */
  miles: number | null
  /** Estimated driving time in minutes, when the provider supplies it. */
  durationMinutes: number | null
  /** How many waypoints the route covered (origin + stops + destination). */
  waypointCount: number
  /** Machine-readable detail for logs. Never contains an address. */
  reason?: string
  /** True when a human must confirm transportation before approval. */
  requiresManualReview: boolean
}

export type RouteInput = {
  /** First pickup — where the truck starts loading. */
  origin: string
  /** Final drop-off — where the truck finishes. */
  destination: string
  /** Every additional customer-requested stop, IN ROUTE ORDER. */
  stops?: string[]
}

const clean = (s: string | null | undefined): string => (s ?? '').trim()

/**
 * PURE. Builds the ordered waypoint list for a move, or null when the move does
 * not describe a route. Exported so the ordering rule is unit-tested offline
 * without touching the network.
 *
 * Order is the contract: first pickup → stops as given → final drop-off. We do
 * NOT let the provider optimise the order — the crew drives the sequence the
 * customer agreed to, and a re-ordered route would quote a distance the job
 * does not actually drive.
 */
export function buildWaypoints(input: RouteInput): string[] | null {
  const origin = clean(input.origin)
  const destination = clean(input.destination)
  if (!origin || !destination) return null
  const stops = (input.stops ?? []).map(clean).filter(Boolean)
  return [origin, ...stops, destination]
}

/** PURE. Metres → miles. */
export function metersToMiles(meters: number): number {
  return meters / METERS_PER_MILE
}

/**
 * PURE. Turns a provider response into our RouteResult. Split out from the
 * fetch so every branch (no route, zero distance, missing field) is testable
 * without a network or an API key.
 */
export function interpretRouteResponse(
  data: { routes?: { distanceMeters?: number; duration?: string }[] } | null | undefined,
  waypointCount: number
): RouteResult {
  const route = data?.routes?.[0]
  const meters = route?.distanceMeters
  if (typeof meters !== 'number' || !Number.isFinite(meters) || meters <= 0) {
    return {
      status: 'failed',
      miles: null,
      durationMinutes: null,
      waypointCount,
      reason: 'no_route_returned',
      requiresManualReview: true,
    }
  }
  // duration arrives as a protobuf duration string, e.g. "1234s".
  const durationSeconds = route?.duration ? parseInt(String(route.duration).replace(/[^0-9]/g, ''), 10) : NaN
  return {
    status: 'ok',
    miles: metersToMiles(meters),
    durationMinutes: Number.isFinite(durationSeconds) ? Math.round(durationSeconds / 60) : null,
    waypointCount,
    requiresManualReview: false,
  }
}

/** The result returned whenever we could not measure — always review-gated. */
function unmeasured(status: RouteStatus, reason: string, waypointCount: number): RouteResult {
  return { status, miles: null, durationMinutes: null, waypointCount, reason, requiresManualReview: true }
}

/**
 * Measure the driving distance of a move. Best-effort; NEVER throws, never
 * guesses, never returns 0 for "unknown".
 */
export async function computeRouteDistance(
  input: RouteInput,
  opts?: { timeoutMs?: number }
): Promise<RouteResult> {
  const waypoints = buildWaypoints(input)
  if (!waypoints) return unmeasured('insufficient_addresses', 'missing_origin_or_destination', 0)

  const key = process.env.GOOGLE_MAPS_SERVER_KEY
  if (!key) return unmeasured('skipped', 'no_provider_key', waypoints.length)

  const origin = waypoints[0]
  const destination = waypoints[waypoints.length - 1]
  const intermediates = waypoints.slice(1, -1)

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts?.timeoutMs ?? 6000)
  try {
    const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration',
      },
      body: JSON.stringify({
        origin: { address: origin },
        destination: { address: destination },
        ...(intermediates.length ? { intermediates: intermediates.map((a) => ({ address: a })) } : {}),
        travelMode: 'DRIVE',
        units: 'IMPERIAL',
        // Deliberately NOT optimizeWaypointOrder — see buildWaypoints.
      }),
      signal: ctrl.signal,
    })
    if (!res.ok) return unmeasured('failed', `provider_http_${res.status}`, waypoints.length)
    const data = (await res.json()) as { routes?: { distanceMeters?: number; duration?: string }[] }
    return interpretRouteResponse(data, waypoints.length)
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError'
    return unmeasured('failed', aborted ? 'provider_timeout' : 'provider_error', waypoints.length)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * A PERSISTABLE, PII-FREE description of the route we priced.
 *
 * Booking.routeSummary stores this so an owner can later see WHAT was measured
 * (how many stops, how far, by which provider, at what time) and reproduce the
 * charge — without duplicating the customer's addresses into a second column,
 * and without ever putting an address somewhere analytics could reach.
 */
export function summarize(result: RouteResult, at: Date = new Date()): Record<string, unknown> {
  return {
    status: result.status,
    miles: result.miles == null ? null : Math.round(result.miles * 100) / 100,
    billableMiles: result.miles == null ? null : Math.ceil(result.miles),
    durationMinutes: result.durationMinutes,
    waypointCount: result.waypointCount,
    reason: result.reason ?? null,
    provider: 'google_routes_v2',
    measuredAt: at.toISOString(),
  }
}
