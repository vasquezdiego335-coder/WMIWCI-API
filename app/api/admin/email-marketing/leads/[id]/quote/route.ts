// MARK LEAD QUOTED — the owner trigger site for quote-recovery (owner spec 2026-07-21).
//
// The quote follow-up journey (journeys.onQuoteCreated → quote-followup-1/2/final)
// was implemented and tested but could never fire, because NOTHING in the system
// wrote Lead.quotedAt. This is the missing trigger the registry called out: an
// authorized owner records that a real quote was given, which stamps quotedAt and
// starts the sequence. It never invents a quote — that is the whole point of the
// "no quote sequence without a real quote" rule.
//
// Idempotent by design: markLeadQuoted only reports newlyQuoted=true the first
// time, and onQuoteCreated is fired ONLY on that first stamp, so re-marking a lead
// cannot restart the follow-up clock. A closed lead (BOOKED/LOST) is refused.

import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { apiLogger } from '@/lib/logger'
import { denyReason, type Role } from '@/lib/permissions'
import { markLeadQuoted } from '@/lib/leads'
import { onQuoteCreated } from '@/lib/journeys'
import { z } from 'zod'

// A real estimate is optional — a quote can be given verbally — but if supplied
// it must be a sane positive amount in cents (≤ $100,000, well above any move).
const Schema = z.object({
  estimatedValueCents: z.number().int().positive().max(10_000_000).optional(),
})

export async function POST(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const session = await getSession()
  const deny = denyReason(session?.role as Role, 'email.manage_journey')
  if (deny) return NextResponse.json({ error: deny }, { status: 403 })

  const parsed = Schema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) return NextResponse.json({ error: 'estimatedValueCents must be a positive whole number of cents.' }, { status: 400 })

  const result = await markLeadQuoted(params.id, { estimatedValueCents: parsed.data.estimatedValueCents ?? null })
  if (!result) {
    return NextResponse.json({ error: 'That lead does not exist, or it is already booked or lost.' }, { status: 404 })
  }

  // Start the recovery sequence ONLY when this call newly recorded the quote.
  // onQuoteCreated re-reads the lead and refuses to schedule if it is not
  // genuinely open with a quote, so this is safe even under a race.
  if (result.newlyQuoted) {
    await onQuoteCreated(result.leadId).catch((err) =>
      apiLogger.error({ err: err instanceof Error ? err.message : String(err), leadId: result.leadId }, 'onQuoteCreated failed (non-fatal)')
    )
  }

  await prisma.auditLog
    .create({
      data: {
        action: 'LEAD_STATUS_CHANGED',
        userId: session?.userId ?? null,
        details: {
          event: 'lead_quoted',
          leadId: result.leadId,
          newlyQuoted: result.newlyQuoted,
          estimatedValueCents: parsed.data.estimatedValueCents ?? null,
          by: session?.name ?? null,
        },
      },
    })
    .catch(() => undefined)

  return NextResponse.json({ ok: true, leadId: result.leadId, newlyQuoted: result.newlyQuoted, followupStarted: result.newlyQuoted })
}
