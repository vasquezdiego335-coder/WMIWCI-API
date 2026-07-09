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

  const result = await processStripeWebhook(rawBody, signature)
  return NextResponse.json(result.body, { status: result.status })
}
