// Send-ledger admin API (owner spec 2026-07-21).
//
// GET  — send history, including refusals, with each reason in plain English.
// POST — deliberately re-open ONE non-delivered send for another attempt.
//
// The retry is the sharp edge here, so it is narrow on purpose:
//   • it CANNOT re-send something already delivered (reopenForRetry refuses),
//   • it does NOT bypass suppression, eligibility or validation — it only moves
//     the row back to `retry_pending`; the next attempt runs the FULL guard,
//   • an `ambiguous` row can be re-driven, because that is exactly the case a
//     human is meant to resolve after checking the provider dashboard.

import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { apiLogger } from '@/lib/logger'
import { denyReason, type Role } from '@/lib/permissions'
import { listSends, parseRange, explainSend, maskEmail } from '@/lib/email-admin'
import { reopenForRetry } from '@/lib/email-guard'
import { z } from 'zod'

const log = apiLogger.child({ route: 'admin/email-marketing/sends' })

export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await getSession()
  const deny = denyReason(session?.role as Role, 'email.view')
  if (deny) return NextResponse.json({ error: deny }, { status: 403 })

  const url = new URL(req.url)
  const { rows, total, error } = await listSends({
    range: parseRange(url.searchParams.get('range')),
    status: url.searchParams.get('status') ?? undefined,
    template: url.searchParams.get('template') ?? undefined,
    journey: url.searchParams.get('journey') ?? undefined,
    email: url.searchParams.get('email') ?? undefined,
    bookingId: url.searchParams.get('bookingId') ?? undefined,
    blockedOnly: url.searchParams.get('blocked') === '1',
    take: Number(url.searchParams.get('take')) || 100,
  })
  if (error) return NextResponse.json({ error }, { status: 503 })

  const maySeeFull = denyReason(session?.role as Role, 'email.view_recipients') === null

  return NextResponse.json({
    total,
    sends: rows.map((r) => ({
      id: r.id,
      email: maySeeFull ? r.email : maskEmail(r.email),
      template: r.template,
      emailClass: r.emailClass,
      journey: r.journey,
      status: r.status,
      outcomeClass: r.outcomeClass,
      blockedReason: r.blockedReason,
      explanation: explainSend(r.status, r.blockedReason, r.nextAttemptAt),
      attempts: r.attempts,
      providerId: r.providerId,
      bookingId: r.bookingId,
      leadId: r.leadId,
      createdAt: r.createdAt,
      sentAt: r.sentAt,
      nextAttemptAt: r.nextAttemptAt,
      events: r.events,
    })),
  })
}

const RetrySchema = z.object({ id: z.string().trim().min(1).max(60) })

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await getSession()
  const deny = denyReason(session?.role as Role, 'email.retry_send')
  if (deny) return NextResponse.json({ error: deny }, { status: 403 })

  const parsed = RetrySchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'A send id is required.' }, { status: 400 })

  const row = await prisma.emailSend.findUnique({
    where: { id: parsed.data.id },
    select: { idempotencyKey: true, status: true, template: true, email: true },
  })
  if (!row) return NextResponse.json({ error: 'That send record does not exist.' }, { status: 404 })

  const result = await reopenForRetry(row.idempotencyKey)

  if (result === 'refused_delivered') {
    return NextResponse.json(
      { error: 'That email was already delivered to the customer. Re-sending it is not something this button will do.' },
      { status: 409 }
    )
  }
  if (result === 'not_found') {
    return NextResponse.json({ error: 'The send record could not be re-opened.' }, { status: 404 })
  }

  await prisma.auditLog
    .create({
      data: {
        action: 'EMAIL_SEND_RETRIED',
        userId: session?.userId ?? null,
        details: { sendId: parsed.data.id, template: row.template, previousStatus: row.status },
      },
    })
    .catch((err) => log.warn({ err: String(err) }, 'audit write failed (retry still applied)'))

  log.info({ sendId: parsed.data.id, previousStatus: row.status, by: session?.userId }, 'send re-opened for retry')
  return NextResponse.json({
    ok: true,
    note: 'Re-opened. The next attempt runs the full send guard — suppression, live state and validation all apply again.',
  })
}
