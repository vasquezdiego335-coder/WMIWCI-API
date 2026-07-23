// AUDIENCE API (owner spec 2026-07-21).
//
// GET    — saved audiences + the approved segment/filter vocabulary.
// POST   — preview an audience (action: 'preview') or save one (action: 'save').
// DELETE — remove a saved audience.
//
// PREVIEW IS NOT AUTHORIZATION. This route can tell an owner how many people a
// definition would reach; it cannot send to them. Dispatch recomputes the
// audience from scratch, and every individual message still passes the guard.

import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { apiLogger } from '@/lib/logger'
import { denyReason, type Role } from '@/lib/permissions'
import {
  validateAudienceDefinition,
  previewAudience,
  SEGMENTS,
  FILTERS,
  SERVICE_TYPES,
  SERVICE_AREA_ZONES,
  LOCALES,
  MAX_AUDIENCE,
} from '@/lib/email-audience'
import { maskEmail } from '@/lib/email-admin'
import { z } from 'zod'

const log = apiLogger.child({ route: 'admin/email-marketing/audiences' })

export async function GET(): Promise<NextResponse> {
  const session = await getSession()
  const deny = denyReason(session?.role as Role, 'email.view')
  if (deny) return NextResponse.json({ error: deny }, { status: 403 })

  let saved: unknown[] = []
  let error: string | null = null
  try {
    saved = await prisma.emailAudience.findMany({ orderBy: { updatedAt: 'desc' }, take: 100 })
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }

  return NextResponse.json({
    saved,
    error,
    // The vocabulary is served so the UI cannot offer a filter the server would
    // reject — one list, one source of truth.
    vocabulary: {
      segments: SEGMENTS,
      filters: Object.fromEntries(Object.entries(FILTERS).map(([k, v]) => [k, v.label])),
      serviceTypes: SERVICE_TYPES,
      serviceAreaZones: SERVICE_AREA_ZONES,
      locales: LOCALES,
      maxAudience: MAX_AUDIENCE,
    },
  })
}

const BodySchema = z.object({
  action: z.enum(['preview', 'save']),
  name: z.string().trim().min(2).max(120).optional(),
  description: z.string().trim().max(500).optional(),
  definition: z.unknown(),
})

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await getSession()
  // Previewing an audience exposes counts of real customers, and saving one
  // creates a send target. Both sit behind campaign management.
  const deny = denyReason(session?.role as Role, 'email.manage_campaign')
  if (deny) return NextResponse.json({ error: deny }, { status: 403 })

  const parsed = BodySchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 })

  const validated = validateAudienceDefinition(parsed.data.definition)
  if (!validated.ok) return NextResponse.json({ error: 'The audience definition was rejected.', errors: validated.errors }, { status: 400 })

  const preview = await previewAudience(validated.definition)
  if (preview.error) return NextResponse.json({ error: `Could not evaluate the audience: ${preview.error}` }, { status: 503 })

  const maySeeFull = denyReason(session?.role as Role, 'email.view_recipients') === null
  const safePreview = {
    ...preview,
    sample: preview.sample.map((s) => ({ ...s, email: maySeeFull ? s.email : maskEmail(s.email) })),
  }

  if (parsed.data.action === 'preview') {
    return NextResponse.json({ preview: safePreview, definition: validated.definition })
  }

  // ── save ──
  const name = parsed.data.name?.trim()
  if (!name) return NextResponse.json({ error: 'A saved audience needs a name.' }, { status: 400 })

  try {
    const row = await prisma.emailAudience.upsert({
      where: { name },
      create: {
        name,
        description: parsed.data.description ?? null,
        definition: validated.definition as never,
        lastPreviewCount: preview.eligible,
        lastPreviewAt: new Date(),
        createdById: session?.userId ?? null,
        createdByName: session?.name ?? null,
      },
      update: {
        description: parsed.data.description ?? null,
        definition: validated.definition as never,
        lastPreviewCount: preview.eligible,
        lastPreviewAt: new Date(),
      },
    })

    await prisma.auditLog
      .create({
        data: {
          action: 'EMAIL_AUDIENCE_SAVED',
          userId: session?.userId ?? null,
          details: { audienceId: row.id, name, segment: validated.definition.segment, eligible: preview.eligible },
        },
      })
      .catch((err) => log.warn({ err: String(err) }, 'audit write failed (audience saved)'))

    return NextResponse.json({ audience: row, preview: safePreview })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const session = await getSession()
  const deny = denyReason(session?.role as Role, 'email.manage_campaign')
  if (deny) return NextResponse.json({ error: deny }, { status: 403 })

  const parsed = z.object({ id: z.string().trim().min(1) }).safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'An audience id is required.' }, { status: 400 })

  try {
    const row = await prisma.emailAudience.findUnique({ where: { id: parsed.data.id }, select: { name: true } })
    if (!row) return NextResponse.json({ error: 'That audience does not exist.' }, { status: 404 })

    // Campaigns that used it keep their record — the FK is SET NULL, not
    // CASCADE, so deleting an audience never erases a campaign's history.
    await prisma.emailAudience.delete({ where: { id: parsed.data.id } })
    await prisma.auditLog
      .create({ data: { action: 'EMAIL_AUDIENCE_DELETED', userId: session?.userId ?? null, details: { name: row.name } } })
      .catch(() => undefined)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
