// ════════════════════════════════════════════════════════════════════════
//  tracker.ts — push PAID bookings to the marketing-tracker revenue funnel.
//  ----------------------------------------------------------------------
//  One call: ingestBookingToTracker(...) POSTs to the Flask tracker's
//  POST /api/ingest/booking, Bearer-authed and IDEMPOTENT on
//  external_ref = "booking:<id>" (the tracker upserts a job keyed by it, so a
//  Stripe webhook + success-redirect double call records revenue exactly once).
//
//  Fire-and-forget + 5s timeout: a tracker outage must never affect checkout.
//  No-op until TRACKER_URL + TRACKER_INGEST_TOKEN are both set. Never throws.
// ════════════════════════════════════════════════════════════════════════
import { webhookLogger } from './logger'

const log = webhookLogger.child({ mod: 'tracker' })

const TRACKER_URL = (process.env.TRACKER_URL ?? '').replace(/\/+$/, '')
const TRACKER_INGEST_TOKEN = process.env.TRACKER_INGEST_TOKEN ?? ''

export type TrackerBookingIngest = {
  bookingId: string
  source?: string | null
  foundUs?: string | null
  name?: string | null
  phone?: string | null
  email?: string | null
  revenueCents: number
  status?: string
  scheduledDate?: string | null // YYYY-MM-DD
  completedDate?: string | null // YYYY-MM-DD
  notes?: string | null
}

/**
 * Best-effort revenue ingest into the marketing-tracker. Never throws; resolves
 * quickly even if the tracker is unreachable. No-op when unconfigured.
 */
export async function ingestBookingToTracker(input: TrackerBookingIngest): Promise<void> {
  if (!TRACKER_URL || !TRACKER_INGEST_TOKEN) return

  const body = {
    external_ref: `booking:${input.bookingId}`,
    source_code: input.source ?? null,
    found_us: input.foundUs ?? null,
    name: input.name ?? null,
    phone: input.phone ?? null,
    email: input.email ?? null,
    revenue_cents: Math.max(0, Math.round(input.revenueCents || 0)),
    status: input.status ?? 'scheduled',
    scheduled_date: input.scheduledDate ?? null,
    completed_date: input.completedDate ?? null,
    notes: input.notes ?? null,
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
  try {
    const res = await fetch(`${TRACKER_URL}/api/ingest/booking`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TRACKER_INGEST_TOKEN}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!res.ok) {
      log.warn({ status: res.status, bookingId: input.bookingId }, 'tracker ingest non-200 (non-fatal)')
    } else {
      log.debug({ bookingId: input.bookingId }, 'tracker ingest ok')
    }
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), bookingId: input.bookingId },
      'tracker ingest failed/timed out (non-fatal)'
    )
  } finally {
    clearTimeout(timer)
  }
}
