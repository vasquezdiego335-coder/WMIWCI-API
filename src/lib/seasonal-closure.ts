// ════════════════════════════════════════════════════════════════════════════
//  Seasonal closure ("winter mode").
//  ------------------------------------------------------------------------
//  One switch, SEASONAL_CLOSURE=true, set identically on the API and the worker
//  host. While it is on:
//    • every public endpoint that creates a booking, lead, quote, deposit or
//      payment answers 503 SEASONAL_CLOSURE before touching the database, Stripe
//      or Google (see guardSeasonalClosure, called first in each handler);
//    • the Stripe helpers that create Checkout Sessions refuse, so no code path
//      (admin or public) can open a new payment;
//    • customer email that is not strictly transactional is dropped for good
//      (never deferred), and the recurring sweeps that send or wake Neon skip.
//
//  What stays available: the Stripe and Resend webhooks, unsubscribe and
//  suppression, health checks, admin sign-in and read-only admin pages.
//
//  Turning it off restores normal behaviour with no data migration. Nothing in
//  this file writes to the database.
// ════════════════════════════════════════════════════════════════════════════
import { NextResponse } from 'next/server'

export const SEASONAL_CLOSURE_CODE = 'SEASONAL_CLOSURE'

export const SEASONAL_CLOSURE_MESSAGE =
  'Move It Clear It is closed for the winter season. We’ll be back soon! We are not accepting new bookings, quotes or payments right now.'

/** True when the switch is on. Read at call time so tests and restarts see the current value. */
export function isSeasonalClosure(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test((env.SEASONAL_CLOSURE ?? '').trim())
}

/** Error thrown by money-creating helpers while closed. */
export class SeasonalClosureError extends Error {
  readonly code = SEASONAL_CLOSURE_CODE
  constructor(what: string) {
    super(`${what} is disabled: ${SEASONAL_CLOSURE_MESSAGE}`)
    this.name = 'SeasonalClosureError'
  }
}

/** Throws when closed. Use inside any helper that would create a payment. */
export function assertOpenForPayments(what: string): void {
  if (isSeasonalClosure()) throw new SeasonalClosureError(what)
}

/**
 * The closure response. Readable from any origin: it carries no data, and a
 * browser on an old cached page should be able to show the message instead of
 * a CORS error.
 */
export function seasonalClosureResponse(): NextResponse {
  return NextResponse.json(
    { error: SEASONAL_CLOSURE_CODE, closed: true, message: SEASONAL_CLOSURE_MESSAGE },
    {
      status: 503,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Cache-Control': 'no-store',
      },
    },
  )
}

/** Call first in a handler: `const closed = guardSeasonalClosure(); if (closed) return closed`. */
export function guardSeasonalClosure(): NextResponse | null {
  return isSeasonalClosure() ? seasonalClosureResponse() : null
}

// ── Email ─────────────────────────────────────────────────────────────────
// Only these customer templates may still go out while closed: they answer
// something the customer did (or a payment Stripe settled) rather than market
// to them. Everything else is dropped with a terminal reason, so nothing piles
// up to be sent in spring.
const CLOSURE_ALLOWED_TEMPLATES = new Set<string>([
  'payment-receipt',
  'booking-cancellation',
  'booking-declined',
  'operational-alert',
])

export function seasonalClosureBlocksEmail(input: { emailClass?: string | null; template?: string | null }): boolean {
  if (!isSeasonalClosure()) return false
  if ((input.emailClass ?? '').toLowerCase() !== 'transactional') return true
  return !CLOSURE_ALLOWED_TEMPLATES.has((input.template ?? '').toLowerCase())
}

export const SEASONAL_CLOSURE_EMAIL_REASON = 'seasonal_closure'

// ── Recurring work ────────────────────────────────────────────────────────
// Schedules that send customer mail, call AI, post crew digests or otherwise
// wake the database are skipped while closed. Unknown names are skipped too:
// while closed, nothing should run that nobody listed here on purpose.
const CLOSURE_ALLOWED_SCHEDULES = new Set<string>([])

export function seasonalClosureSkipsSchedule(name: string): boolean {
  if (!isSeasonalClosure()) return false
  return !CLOSURE_ALLOWED_SCHEDULES.has(name)
}
