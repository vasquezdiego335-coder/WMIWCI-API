import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { smsQueue } from '@/lib/queues'
import { apiLogger } from '@/lib/logger'

// ════════════════════════════════════════════════════════════════════════
//  POST /api/test/sms  — manual SMS enqueue for debugging.
//  Enqueues onto the SAME 'sms' queue the production flow uses, so it exercises
//  the real SMS worker + Twilio path end-to-end.
//
//  Body: { "to": "+15551234567", "message": "hello" }  → { ok: true, queued: true }
//
//  Guarded in production: this route can send real (billable) texts, so it is
//  disabled when NODE_ENV=production unless ALLOW_TEST_ENDPOINTS=true.
// ════════════════════════════════════════════════════════════════════════

export const runtime = 'nodejs'

const Body = z.object({
  to: z.string().trim().min(1, 'to is required'),
  message: z.string().trim().min(1, 'message is required').max(1600),
})

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Production safety gate.
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_TEST_ENDPOINTS !== 'true') {
    return NextResponse.json(
      { ok: false, error: 'Disabled in production. Set ALLOW_TEST_ENDPOINTS=true to enable.' },
      { status: 403 }
    )
  }

  let json: unknown
  try {
    json = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = Body.safeParse(json)
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: 'Validation failed', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const { to, message } = parsed.data

  // Timeout-guard the enqueue: BullMQ uses maxRetriesPerRequest:null, so an
  // unreachable Redis would otherwise hang this request forever.
  try {
    await Promise.race([
      smsQueue.add('test', { to, message }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('queue add timed out after 5s (Redis unreachable?)')), 5000)
      ),
    ])
  } catch (err) {
    apiLogger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'POST /api/test/sms — failed to enqueue SMS'
    )
    return NextResponse.json({ ok: false, error: 'Failed to enqueue SMS job' }, { status: 502 })
  }

  apiLogger.info({ to: `${to.slice(0, 2)}***${to.slice(-4)}` }, 'POST /api/test/sms — SMS job enqueued')
  return NextResponse.json({ ok: true, queued: true })
}

// Reject non-POST verbs explicitly (the spec is POST-only).
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ ok: false, error: 'Method not allowed — use POST' }, { status: 405 })
}
