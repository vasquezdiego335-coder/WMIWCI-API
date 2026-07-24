// TEST SEND API (owner spec 2026-07-21).
//
// GET  — the synthetic payload, rendered HTML, plain text and subject for a
//        template, so the owner can PREVIEW before sending anything.
// POST — actually send it, through the canonical guard.
//
// The render happens here rather than in the page because the React Email
// templates and `render()` are server-only. The same render feeds both the
// preview and the send, so what an owner approves is what leaves the building.

import { NextRequest, NextResponse } from 'next/server'
import { render } from '@react-email/render'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { apiLogger } from '@/lib/logger'
import { denyReason, type Role } from '@/lib/permissions'
import { templateByKey } from '@/lib/email-registry'
import {
  checkTestRecipient,
  syntheticPayload,
  checkRequiredVariables,
  sendTestEmail,
  configuredTestRecipient,
  testMarketingContext,
  applyMarketingContext,
  TEST_SUBJECT_PREFIX,
} from '@/lib/email-test-send'
import { explainSend } from '@/lib/email-admin'
import { renderTemplate } from '@/lib/email-render'
import { z } from 'zod'

const log = apiLogger.child({ route: 'admin/email-marketing/test-send' })

function appUrl(): string {
  return process.env.APP_URL?.trim() || 'https://www.moveitclearit.com'
}

/** Build the payload + rendered output for a template. Shared by GET and POST. */
async function build(template: string, recipient: string, overrides: Record<string, unknown> = {}) {
  const entry = templateByKey(template)
  if (!entry) return { error: `"${template}" is not a registered template.` as const }

  let payload = { ...syntheticPayload(template, appUrl()), ...overrides }

  // A promotional template must carry the unsubscribe link and postal address,
  // exactly as a real promotional send would. If that context is unavailable,
  // the preview says so rather than rendering a non-compliant email that the
  // guard would then refuse.
  let complianceMissing: string[] = []
  if (entry.emailClass === 'promotional') {
    const ctx = testMarketingContext(recipient, template)
    if (ctx.ok) payload = applyMarketingContext(payload, ctx.context)
    else complianceMissing = ctx.missing
  }

  const rendered = await renderTemplate(template, payload)
  if ('error' in rendered) return { error: rendered.error }

  const { missing, required } = checkRequiredVariables(template, payload)

  return {
    entry,
    payload,
    html: rendered.html,
    text: rendered.text,
    subject: `${TEST_SUBJECT_PREFIX} ${entry.subject}`,
    required,
    missing,
    complianceMissing,
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await getSession()
  const deny = denyReason(session?.role as Role, 'email.send_test')
  if (deny) return NextResponse.json({ error: deny }, { status: 403 })

  const url = new URL(req.url)
  const template = url.searchParams.get('template') ?? ''
  const recipient = configuredTestRecipient() ?? 'preview@example.com'

  const built = await build(template, recipient)
  if ('error' in built) return NextResponse.json({ error: built.error }, { status: 400 })

  return NextResponse.json({
    template,
    name: built.entry.name,
    emailClass: built.entry.emailClass,
    subject: built.subject,
    html: built.html,
    text: built.text,
    payload: built.payload,
    requiredVariables: built.required,
    missingVariables: built.missing,
    complianceMissing: built.complianceMissing,
    configuredRecipient: configuredTestRecipient(),
  })
}

const SendSchema = z.object({
  template: z.string().trim().min(1).max(80),
  to: z.string().trim().email().max(254).optional(),
  /** Explicit acknowledgement required to use a non-configured address. */
  overrideRecipient: z.boolean().optional(),
  /** Safe scalar overrides for the synthetic payload. */
  variables: z.record(z.union([z.string().max(300), z.number(), z.boolean()])).optional(),
})

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await getSession()
  const deny = denyReason(session?.role as Role, 'email.send_test')
  if (deny) return NextResponse.json({ error: deny }, { status: 403 })

  const parsed = SendSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'A template is required.', detail: parsed.error.issues.map((i) => i.message) }, { status: 400 })
  }
  const { template, to, overrideRecipient, variables } = parsed.data

  const recipient = checkTestRecipient(to, overrideRecipient === true)
  if (!recipient.ok) return NextResponse.json({ error: recipient.error }, { status: 400 })

  const built = await build(template, recipient.email, variables ?? {})
  if ('error' in built) return NextResponse.json({ error: built.error }, { status: 400 })

  if (built.missing.length > 0) {
    return NextResponse.json(
      { error: `Missing required variables: ${built.missing.join(', ')}.`, missingVariables: built.missing },
      { status: 400 }
    )
  }

  // guardedSend THROWS on a provider rejection (by design — that makes BullMQ
  // retry it in the worker context). Here we call it inline in the request, so
  // an uncaught throw becomes an empty 500 the browser reports as "Unexpected
  // end of JSON input". Catch it and return the ACTUAL reason as JSON.
  let result: Awaited<ReturnType<typeof sendTestEmail>>
  try {
    result = await sendTestEmail({
      template,
      to: recipient.email,
      subject: built.subject,
      html: built.html,
      text: built.text,
      payload: built.payload,
      isOverride: recipient.isOverride,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error({ err: message, template, recipient: recipient.email }, 'test send failed (provider rejection or transport error)')
    return NextResponse.json(
      { sent: false, error: message || 'The email provider rejected the send.' },
      { status: 502 }
    )
  }

  // Show the owner the LEDGER ROW, not just the provider answer. "It said sent"
  // and "the system recorded it as delivered" are different claims, and the
  // second is the one the rest of the admin will show.
  const ledger = result.outcome.emailSendId
    ? await prisma.emailSend
        .findUnique({
          where: { id: result.outcome.emailSendId },
          select: { id: true, status: true, blockedReason: true, providerId: true, isTest: true, attempts: true, nextAttemptAt: true, createdAt: true },
        })
        .catch(() => null)
    : null

  await prisma.auditLog
    .create({
      data: {
        action: 'EMAIL_TEST_SENT',
        userId: session?.userId ?? null,
        details: {
          template,
          recipient: recipient.email,
          override: recipient.isOverride,
          sent: result.outcome.sent,
          reason: result.outcome.sent ? null : result.outcome.reason,
        },
      },
    })
    .catch((err) => log.warn({ err: String(err) }, 'audit write failed (test send still happened)'))

  log.info({ template, sent: result.outcome.sent, override: recipient.isOverride, by: session?.userId }, 'admin test send')

  return NextResponse.json({
    sent: result.outcome.sent,
    subject: result.subject,
    recipient: recipient.email,
    isOverride: recipient.isOverride,
    provider: result.outcome.sent ? { id: result.outcome.providerId } : null,
    reason: result.outcome.sent ? null : result.outcome.reason,
    explanation: ledger ? explainSend(ledger.status, ledger.blockedReason, ledger.nextAttemptAt) : null,
    ledger,
  })
}
