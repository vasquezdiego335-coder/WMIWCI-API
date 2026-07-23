// Suppression admin API (owner spec 2026-07-21).
//
// GET    — the do-not-send list.
// DELETE — lift a RESTORABLE suppression, with a required reason.
//
// WHAT THIS ROUTE WILL NOT DO: lift a HARD_BOUNCE or a SPAM_COMPLAINT. A
// complaint is the recipient telling a mailbox provider we are spam, and
// re-mailing them damages the sending domain for every other customer. A hard
// bounce means the mailbox does not exist, so the fix is correcting the address
// on the customer record — not removing the block. Both refusals are enforced
// server-side, not by hiding a button.

import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { apiLogger } from '@/lib/logger'
import { denyReason, type Role } from '@/lib/permissions'
import { listSuppressions, canRestoreSuppression, maskEmail } from '@/lib/email-admin'
import { normalizeEmail } from '@/lib/email-tokens'
import { z } from 'zod'

const log = apiLogger.child({ route: 'admin/email-marketing/suppressions' })

export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await getSession()
  const deny = denyReason(session?.role as Role, 'email.view')
  if (deny) return NextResponse.json({ error: deny }, { status: 403 })

  const url = new URL(req.url)
  const { rows, total, error } = await listSuppressions({
    reason: url.searchParams.get('reason') ?? undefined,
    email: url.searchParams.get('email') ?? undefined,
  })
  if (error) return NextResponse.json({ error }, { status: 503 })

  // Addresses are masked unless the caller may see them — the same rule the
  // pages apply, enforced again here so the API is not a way around it.
  const maySeeFull = denyReason(session?.role as Role, 'email.view_recipients') === null
  return NextResponse.json({
    total,
    suppressions: rows.map((r) => ({ ...r, email: maySeeFull ? r.email : maskEmail(r.email) })),
  })
}

const RestoreSchema = z.object({
  email: z.string().trim().email().max(254),
  /** Why this is being lifted. Recorded in the audit log. */
  reason: z.string().trim().min(3).max(500),
})

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const session = await getSession()
  const deny = denyReason(session?.role as Role, 'email.manage_suppression')
  if (deny) return NextResponse.json({ error: deny }, { status: 403 })

  const parsed = RestoreSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'An email address and a reason are required.' }, { status: 400 })
  }

  const email = normalizeEmail(parsed.data.email)
  const existing = await prisma.emailSuppression.findUnique({ where: { email }, select: { reason: true, scope: true } })
  if (!existing) return NextResponse.json({ error: 'That address is not suppressed.' }, { status: 404 })

  const verdict = canRestoreSuppression(existing.reason)
  if (!verdict.allow) return NextResponse.json({ error: verdict.why }, { status: 409 })

  // CONDITIONAL delete — the `reason` filter is the race guard. If a hard bounce
  // or complaint lands between the check above and this statement, the row's
  // reason has changed, this does not match, and the stronger block survives.
  const { count } = await prisma.emailSuppression.deleteMany({
    where: { email, reason: existing.reason },
  })
  if (count === 0) {
    return NextResponse.json(
      { error: 'The suppression changed while you were looking at it and was not lifted. Reload and check the current reason.' },
      { status: 409 }
    )
  }

  await prisma.auditLog
    .create({
      data: {
        action: 'EMAIL_SUPPRESSION_RESTORED',
        userId: session?.userId ?? null,
        details: { email, previousReason: existing.reason, previousScope: existing.scope, reason: parsed.data.reason },
      },
    })
    .catch((err) => log.warn({ err: String(err) }, 'audit write failed (restore still applied)'))

  log.info({ previousReason: existing.reason, by: session?.userId }, 'suppression restored by an operator')
  return NextResponse.json({ ok: true, restored: existing.reason })
}
