import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { apiLogger } from '@/lib/logger'

// ════════════════════════════════════════════════════════════════════════
//  Inbound-SMS webhook (Twilio shape) — TCPA opt-out / opt-in, RECORD ONLY.
//  ----------------------------------------------------------------------
//  THIS APP SENDS NO SMS (owner decision 2026-09-15: the Twilio worker, the
//  `sms` queue and every customer text were deleted). This route survives so a
//  STOP sent to the business number is still honoured in OUR state. It writes a
//  flag and replies with empty TwiML; it never sends anything, and it is not an
//  active messaging channel.
//
//  If a number is still pointed here, its "A MESSAGE COMES IN" webhook is
//  POST /api/sms/inbound.
//  STOP-family keywords set Customer.marketingOptOut = true (Phase-3 follow-ups
//  are then suppressed). Twilio also enforces STOP at the carrier level — this
//  just keeps OUR state in sync so we never even enqueue to an opted-out
//  customer. Always replies 200 with empty TwiML so Twilio doesn't retry.
//  Matches the sender by the last 10 digits of the number.
//
//  START DOES NOTHING (DESIGN-v2 §8, 2026-09-16). START-family keywords used to
//  CLEAR marketingOptOut — and that flag is the opt-out every EMAIL marketing
//  gate honours. This route has no Twilio signature check and matches every
//  customer sharing a number's last 10 digits, so one unauthenticated POST
//  saying "yes" could re-open email marketing to people who had opted out. An
//  opt-out may only be withdrawn by the person, through a confirmed email flow.
//  START is acknowledged and ignored; it never writes.
// ════════════════════════════════════════════════════════════════════════

const STOP_WORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'stop all', 'optout', 'opt-out'])

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

  // Only a STOP writes. START, YES and every other message are acknowledged
  // and change nothing (see the header): the only write this route can make
  // is the safe direction.
  if (!STOP_WORDS.has(bodyText)) return twiml()

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
        data: { marketingOptOut: true },
      })
      apiLogger.info({ count: rows.length }, 'inbound SMS STOP recorded as a marketing opt-out')
    }
  } catch (err) {
    apiLogger.error({ err: err instanceof Error ? err.message : String(err) }, 'inbound SMS opt-out update failed (non-fatal)')
  }

  return twiml()
}
