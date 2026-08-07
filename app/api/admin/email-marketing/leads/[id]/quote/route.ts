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
// time, so the follow-up CLOCK is anchored once and re-marking never restarts it.
// A closed lead (BOOKED/LOST) is refused.
//
// RE-MARKING NOW RE-ENSURES THE SEQUENCE (owner spec 2026-08-07). The old rule —
// "fire onQuoteCreated only on the first stamp" — meant the journey got exactly
// one attempt ever, so a lead whose enrolment was refused for a temporary reason
// (rollout allowlist, Redis stall, consent recorded later) stayed quoted forever
// with no follow-up and no way back. Clicking again now calls
// ensureQuoteJourney, which re-runs the full eligibility matrix and re-creates
// only the stages that are genuinely missing. The `quote_created` automation
// trigger still fires exactly once, on the real transition.

import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { apiLogger } from '@/lib/logger'
import { denyReason, type Role } from '@/lib/permissions'
import { markLeadQuoted } from '@/lib/leads'
import { ensureQuoteJourney, onQuoteCreated } from '@/lib/journeys'
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

  // Both paths re-read the lead and refuse to schedule anything that is not
  // genuinely open with a live quote, so this is safe even under a race. The
  // first stamp ALSO fires the one-per-event automation trigger; a re-mark only
  // ensures the stages exist.
  const enrolment = await (result.newlyQuoted ? onQuoteCreated(result.leadId) : ensureQuoteJourney(result.leadId)).catch(
    (err) => {
      apiLogger.error(
        { err: err instanceof Error ? err.message : String(err), leadId: result.leadId },
        'quote journey enrolment failed (non-fatal)'
      )
      return null
    }
  )
  const followupScheduled = enrolment?.scheduled === true
  const followupReason = enrolment && !enrolment.scheduled ? enrolment.reason : undefined

  await prisma.auditLog
    .create({
      data: {
        action: 'EMAIL_LEAD_QUOTED',
        userId: session?.userId ?? null,
        details: {
          event: 'lead_quoted',
          leadId: result.leadId,
          newlyQuoted: result.newlyQuoted,
          // What the lifecycle actually did, not what we hoped it did. A
          // `followupStarted: true` that was really a silent refusal is exactly
          // how the stranded-lead bug stayed invisible for weeks.
          followupScheduled,
          followupReason: followupReason ?? null,
          estimatedValueCents: parsed.data.estimatedValueCents ?? null,
          by: session?.name ?? null,
        },
      },
    })
    .catch(() => undefined)

  return NextResponse.json({
    ok: true,
    leadId: result.leadId,
    newlyQuoted: result.newlyQuoted,
    followupStarted: followupScheduled,
    followupReason: followupReason ?? null,
  })
}
