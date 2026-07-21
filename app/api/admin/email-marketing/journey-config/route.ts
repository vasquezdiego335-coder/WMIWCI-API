// JOURNEY CONFIGURATION API (owner spec 2026-07-21).
//
// GET    — the EFFECTIVE configuration for every journey: what is actually in
//          force, whether it came from the database or the code defaults, and
//          how it differs.
// PUT    — save a validated configuration (increments the version).
// DELETE — reset to safe defaults.
//
// Invalid configuration is refused on write, and a stored row that is invalid
// on READ degrades to the code defaults rather than running. Both are
// deliberate: the failure mode of a journey config is mailing real customers.

import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { apiLogger } from '@/lib/logger'
import { denyReason, type Role } from '@/lib/permissions'
import { journeyRegistry } from '@/lib/email-registry'
import {
  validateJourneyConfig,
  effectiveConfig,
  defaultConfig,
  diffFromDefaults,
  STOP_RULES,
  LOCKED_STOP_RULES,
  MIN_DELAY_MS,
  MAX_DELAY_MS,
  MAX_STAGES,
} from '@/lib/email-journey-config'
import { z } from 'zod'

const log = apiLogger.child({ route: 'admin/email-marketing/journey-config' })

export async function GET(): Promise<NextResponse> {
  const session = await getSession()
  const deny = denyReason(session?.role as Role, 'email.view')
  if (deny) return NextResponse.json({ error: deny }, { status: 403 })

  let stored: Array<{ journeyKey: string; enabled: boolean; version: number; config: unknown; updatedAt: Date; updatedByName: string | null }> = []
  let error: string | null = null
  try {
    stored = await prisma.emailJourneyConfig.findMany()
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }
  const byKey = new Map(stored.map((r) => [r.journeyKey, r]))

  const journeys = journeyRegistry().map((j) => {
    const row = byKey.get(j.key) ?? null
    const effective = effectiveConfig(j.key, row)
    return {
      key: j.key,
      name: j.name,
      emailClass: j.emailClass,
      flag: j.flag,
      flagEnabled: j.enabled,
      effective: effective?.config ?? null,
      version: effective?.version ?? 0,
      source: effective?.source ?? 'defaults',
      degradedReason: effective?.degradedReason ?? null,
      changedFromDefaults: effective ? diffFromDefaults(j.key, effective.config) : [],
      updatedAt: row?.updatedAt ?? null,
      updatedByName: row?.updatedByName ?? null,
    }
  })

  return NextResponse.json({
    journeys,
    error,
    vocabulary: {
      stopRules: STOP_RULES,
      lockedStopRules: LOCKED_STOP_RULES,
      minDelayMs: MIN_DELAY_MS,
      maxDelayMs: MAX_DELAY_MS,
      maxStages: MAX_STAGES,
    },
  })
}

const PutSchema = z.object({
  journeyKey: z.string().trim().min(1).max(60),
  config: z.unknown(),
})

export async function PUT(req: NextRequest): Promise<NextResponse> {
  const session = await getSession()
  const deny = denyReason(session?.role as Role, 'email.manage_journey')
  if (deny) return NextResponse.json({ error: deny }, { status: 403 })

  const parsed = PutSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'A journeyKey and config are required.' }, { status: 400 })

  const { journeyKey } = parsed.data
  const validated = validateJourneyConfig(journeyKey, parsed.data.config)
  if (!validated.ok) {
    return NextResponse.json({ error: 'The configuration was rejected.', errors: validated.errors }, { status: 400 })
  }

  try {
    const existing = await prisma.emailJourneyConfig.findUnique({ where: { journeyKey }, select: { version: true } })
    // The version increments on EVERY save. Sends already scheduled carry the
    // previous version, so this cannot rewrite why they were scheduled when
    // they were.
    const nextVersion = (existing?.version ?? 0) + 1

    const row = await prisma.emailJourneyConfig.upsert({
      where: { journeyKey },
      create: {
        journeyKey,
        enabled: validated.config.enabled,
        version: nextVersion,
        config: validated.config as never,
        updatedById: session?.userId ?? null,
        updatedByName: session?.name ?? null,
      },
      update: {
        enabled: validated.config.enabled,
        version: nextVersion,
        config: validated.config as never,
        updatedById: session?.userId ?? null,
        updatedByName: session?.name ?? null,
      },
    })

    await prisma.auditLog
      .create({
        data: {
          action: 'EMAIL_JOURNEY_CONFIG_UPDATED',
          userId: session?.userId ?? null,
          details: { journeyKey, version: nextVersion, changes: diffFromDefaults(journeyKey, validated.config) },
        },
      })
      .catch((err) => log.warn({ err: String(err) }, 'audit write failed (config saved)'))

    log.info({ journeyKey, version: nextVersion, by: session?.userId }, 'journey configuration saved')
    return NextResponse.json({ ok: true, version: row.version, config: validated.config })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const session = await getSession()
  const deny = denyReason(session?.role as Role, 'email.manage_journey')
  if (deny) return NextResponse.json({ error: deny }, { status: 403 })

  const parsed = z.object({ journeyKey: z.string().trim().min(1).max(60) }).safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'A journeyKey is required.' }, { status: 400 })

  const { journeyKey } = parsed.data
  const defaults = defaultConfig(journeyKey)
  if (!defaults) return NextResponse.json({ error: `Unknown journey "${journeyKey}".` }, { status: 404 })

  try {
    // Deleting the row IS the reset: with no row, effectiveConfig() returns the
    // code defaults. That keeps "reset" and "never configured" the same state
    // rather than two subtly different ones.
    await prisma.emailJourneyConfig.deleteMany({ where: { journeyKey } })
    await prisma.auditLog
      .create({ data: { action: 'EMAIL_JOURNEY_CONFIG_RESET', userId: session?.userId ?? null, details: { journeyKey } } })
      .catch(() => undefined)
    log.info({ journeyKey, by: session?.userId }, 'journey configuration reset to safe defaults')
    return NextResponse.json({ ok: true, config: defaults, source: 'defaults' })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
