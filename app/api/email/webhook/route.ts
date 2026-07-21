import { NextRequest, NextResponse } from 'next/server'
import { processEmailWebhook } from '@/lib/email-events'

// ════════════════════════════════════════════════════════════════════════
//  RESEND WEBHOOK  —  POST /api/email/webhook
//  ----------------------------------------------------------------------
//  Receives delivery / bounce / complaint / open / click events and turns the
//  destructive ones into suppression-list entries. Before this route existed,
//  provider feedback was discarded and the system would keep mailing dead and
//  complaining addresses forever.
//
//  Configure in the Resend dashboard → Webhooks:
//    endpoint  {APP_URL}/api/email/webhook
//    events    email.sent, email.delivered, email.delivery_delayed,
//              email.bounced, email.complained, email.opened, email.clicked
//    secret    → RESEND_WEBHOOK_SECRET  (starts with `whsec_`)
//
//  Verification, dedupe, and handling live in the shared core
//  (src/lib/email-events.ts) so this route and any worker cannot drift.
// ════════════════════════════════════════════════════════════════════════

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Raw body — re-serializing via req.json() would break the signature.
  const rawBody = await req.text()

  const result = await processEmailWebhook(rawBody, {
    id: req.headers.get('svix-id'),
    timestamp: req.headers.get('svix-timestamp'),
    signature: req.headers.get('svix-signature'),
  })

  return NextResponse.json(result.body, { status: result.status })
}
