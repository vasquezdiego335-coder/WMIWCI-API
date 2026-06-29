import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { apiLogger } from '@/lib/logger'

// ════════════════════════════════════════════════════════════════════════
//  Twilio inbound-SMS webhook — TCPA opt-out / opt-in.
//  ----------------------------------------------------------------------
//  Point a Twilio number's "A MESSAGE COMES IN" webhook at POST /api/sms/inbound.
//  STOP-family keywords set Customer.marketingOptOut = true (Phase-3 follow-ups
//  are then suppressed); START-family keywords clear it. Twilio also enforces
//  STOP at the carrier level — this just keeps OUR state in sync so we never even
//  enqueue to an opted-out customer. Always replies 200 with empty TwiML so
//  Twilio doesn't retry. Matches the sender by the last 10 digits of the number.
// ════════════════════════════════════════════════════════════════════════

const STOP_WORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'stop all', 'optout', 'opt-out'])
const START_WORDS = new Set(['start', 'yes', 'unstop', 'optin', 'opt-in'])

const TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>'
const twiml = (): NextResponse => new NextResponse(TWIML, { status: 200, headers: { 'Content-Type': 'text/xml' } })

export async function POST(req: NextRequest): Promise<NextResponse> {
  let from = ''
  let bodyText = ''
  try {
    const form = await req.formData()
    from = String(form.get('From') ?? '')
    bodyText = String(form.get('Body') ?? '')
      .trim()
      .toLowerCase()
  } catch {
    return twiml() // malformed — ack and move on
  }

  const optOut = STOP_WORDS.has(bodyText)
  const optIn = START_WORDS.has(bodyText)
  if (!optOut && !optIn) return twiml() // not a keyword — nothing to do

  const last10 = from.replace(/\D/g, '').slice(-10)
  if (last10.length < 10) return twiml()

  try {
    // Match on the digits-only tail so stored formats like "(862) 555-0100"
    // and E.164 "+18625550100" both resolve to the same customer.
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM customers WHERE right(regexp_replace(phone, '\D', '', 'g'), 10) = ${last10} LIMIT 25
    `
    if (rows.length) {
      await prisma.customer.updateMany({
        where: { id: { in: rows.map((r) => r.id) } },
        data: { marketingOptOut: optOut },
      })
      apiLogger.info({ count: rows.length, optOut }, 'inbound SMS opt-out state updated')
    }
  } catch (err) {
    apiLogger.error({ err: err instanceof Error ? err.message : String(err) }, 'inbound SMS opt-out update failed (non-fatal)')
  }

  return twiml()
}
