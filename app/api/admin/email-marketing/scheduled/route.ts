// Scheduled-send admin API (owner spec 2026-07-21).
//
// GET    — what is queued but not yet sent.
// DELETE — cancel one queued send.
//
// Permission is enforced HERE, on the server. The page hides the cancel button
// for roles that lack `email.cancel_scheduled`, but hiding a button is not a
// control — this route is the control.

import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { apiLogger } from '@/lib/logger'
import { can, denyReason, type Role } from '@/lib/permissions'
import { listScheduled, cancelScheduled } from '@/lib/email-admin'
import { z } from 'zod'

const log = apiLogger.child({ route: 'admin/email-marketing/scheduled' })

export async function GET(): Promise<NextResponse> {
  const session = await getSession()
  const deny = denyReason(session?.role as Role, 'email.view')
  if (deny) return NextResponse.json({ error: deny }, { status: 403 })

  const { rows, error } = await listScheduled(300)
  // A queue we could not read is NOT an empty queue. 503 so a caller cannot
  // mistake "unavailable" for "nothing scheduled".
  if (error) return NextResponse.json({ error, scheduled: null }, { status: 503 })
  return NextResponse.json({ scheduled: rows })
}

const CancelSchema = z.object({ jobId: z.string().trim().min(1).max(300) })

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const session = await getSession()
  const deny = denyReason(session?.role as Role, 'email.cancel_scheduled')
  if (deny) return NextResponse.json({ error: deny }, { status: 403 })

  const parsed = CancelSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'A jobId is required.' }, { status: 400 })

  const { jobId } = parsed.data
  const result = await cancelScheduled(jobId)

  if (!result.ok) {
    const status = result.reason === 'not_found' ? 404 : result.reason === 'already_running' ? 409 : 500
    const message =
      result.reason === 'not_found'
        ? 'That scheduled send no longer exists — it may have already fired.'
        : result.reason === 'already_running'
        ? 'That send is already running and cannot be cancelled. Its send-time eligibility check is what will stop it if it is no longer valid.'
        : `Could not cancel: ${result.reason}`
    return NextResponse.json({ error: message }, { status })
  }

  await prisma.auditLog
    .create({
      data: {
        action: 'EMAIL_SCHEDULED_CANCELLED',
        userId: session?.userId ?? null,
        details: { jobId },
      },
    })
    .catch((err) => log.warn({ err: String(err), jobId }, 'audit write failed (cancel still applied)'))

  log.info({ jobId, by: session?.userId }, 'scheduled email cancelled')
  return NextResponse.json({ ok: true, jobId })
}
