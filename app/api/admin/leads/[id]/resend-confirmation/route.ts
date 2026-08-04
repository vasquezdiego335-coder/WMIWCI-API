import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { apiLogger } from '@/lib/logger'
import { can, type Role } from '@/lib/permissions'
import { resendQuoteConfirmation } from '@/lib/quote-capture'

// ════════════════════════════════════════════════════════════════════════
//  POST /api/admin/leads/[id]/resend-confirmation
//
//  WHY A MANUAL RESEND EXISTS (owner spec 2026-08-03). The "we received your
//  moving estimate request" email is sent exactly once, automatically, and the
//  whole capture path is built to make a SECOND copy impossible: an atomic DB
//  claim stops a duplicate enqueue, and guardedSend's EmailSend.idempotencyKey
//  stops a duplicate send. That is correct for machines and wrong for people —
//  a customer who mistyped their address, filtered us to spam, or simply says
//  "I never got anything" has a legitimate need the automatic path REFUSES to
//  serve, because from the system's point of view the mail already went.
//  This route is the human override for exactly that case, and nothing else.
//
//  IT DELIBERATELY BUMPS THE VERSION. resendQuoteConfirmation() forces the
//  claim and increments Lead.quoteRequestConfirmationCount, which is the `vN`
//  segment of the businessEventKey
//  (`lead:<id>:quote-request-received:v<count>`). A new version = a new
//  idempotency key = a send the email guard treats as a genuinely new business
//  event rather than a refused duplicate. That is the ONLY sanctioned way past
//  the guard: nothing here weakens the guard, it asks it a different question.
//
//  Every resend therefore puts a real second email in a real inbox, so it is
//  audited (LEAD_QUOTE_CONFIRMATION_RESENT) with who did it — a deliberate
//  human act with a name on it, never an automatic retry.
// ════════════════════════════════════════════════════════════════════════

// PERMISSION CHOICE — 'marketing.manage_campaign'.
//   Working the lead inbox (call the lead, re-send the estimate confirmation)
//   is OPERATIONS, and the owner spec's policy line is that a MANAGER runs
//   operations. There is no lead.* action in the matrix, so the closest
//   existing MANAGER-allowed mutating action in the same domain is the
//   marketing one — leads ARE the marketing surface, and re-sending a
//   transactional confirmation carries none of the owner-financial authority
//   (profit, pay, capture) that defines the OWNER_ONLY set.
//   NOT an email.* action: every one of them — including 'email.retry_send',
//   which otherwise reads like the perfect fit — is in OWNER_ONLY while Email
//   Marketing is in owner-only Beta (EMAIL_MARKETING_BETA), so using one would
//   lock out the very manager who works this inbox. 'email.manage_journey' is
//   additionally the wrong shape: it pauses/resumes a whole lifecycle journey,
//   a business decision, not a single-customer operational fix.
const ACTION = 'marketing.manage_campaign' as const

export async function POST(_req: NextRequest, ctx: { params: { id: string } }): Promise<NextResponse> {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  if (!can(session.role as Role, ACTION)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const leadId = ctx.params.id
  const result = await resendQuoteConfirmation(leadId)

  if (!result.ok) {
    // 'lead_not_found' is a bad id; 'lead_has_no_email' is a lead we simply
    // cannot mail (a phone-only lead) — both are the caller's problem. Anything
    // else ('enqueue_failed', 'error') is Redis/DB being unavailable, which is
    // ours: say so with a 502 rather than pretending the owner did wrong.
    const status =
      result.reason === 'lead_not_found' ? 404 : result.reason === 'lead_has_no_email' ? 400 : 502
    return NextResponse.json({ ok: false, reason: result.reason }, { status })
  }

  // House rule: an audit write never fails the request it describes. The email
  // is already queued at this point — throwing here would tell the owner the
  // resend failed while a second copy is on its way to the customer.
  await prisma.auditLog
    .create({
      data: {
        action: 'LEAD_QUOTE_CONFIRMATION_RESENT',
        userId: session.userId,
        details: { leadId, version: result.version, by: session.name },
      },
    })
    .catch(() => undefined)

  apiLogger.info({ leadId, version: result.version, by: session.name }, 'Quote confirmation resent')
  return NextResponse.json({ ok: true, version: result.version })
}
