import { NextRequest, NextResponse } from 'next/server'
import { processStripeWebhook } from '@/lib/stripe-events'

// ── Force Node.js runtime (not Edge) — needed for Prisma, BullMQ, Buffer ─
export const runtime = 'nodejs'

// The verify → dedupe → handle logic lives in the shared, framework-agnostic
// core (src/lib/stripe-events.ts) so this API route and the Railway worker's
// /api/stripe/webhook run byte-for-byte the same path and can never drift.
export async function POST(req: NextRequest): Promise<NextResponse> {
  // req.text() returns the untouched raw body — exactly what signature
  // verification needs. Using req.json() would re-serialize and break the sig.
  const rawBody = await req.text()
  const signature = req.headers.get('stripe-signature')

  // ITEM B3 / R3 — the status code IS the retry contract, so it is passed
  // through UNCHANGED. 200 means the event was durably queued or genuinely
  // finished. A 500 means it was neither, and a 409 means another runner holds
  // a live lease so this delivery did nothing — in both of those cases Stripe's
  // own retry schedule is the only thing that can still deliver the event.
  // Never blanket-200 this route, and never collapse 409/500 into 200.
  const result = await processStripeWebhook(rawBody, signature)
  return NextResponse.json(result.body, { status: result.status })
}
