// JOURNEY CONFIGURATION (owner spec 2026-07-21). Owner-only.
//
// Edit delays, caps, quiet-hour behaviour and stop rules for one journey. The
// code constants remain the safe defaults; this page shows what is actually in
// force, where it came from, and how it differs.

import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getSession } from '@/lib/auth'
import { can } from '@/lib/permissions'
import { prisma } from '@/lib/db'
import { journeyByKey } from '@/lib/email-registry'
import { effectiveConfig, diffFromDefaults, STOP_RULES, LOCKED_STOP_RULES, MIN_DELAY_MS, MAX_DELAY_MS, MAX_STAGES } from '@/lib/email-journey-config'
import { PageHeader, Card, Empty, COLORS, Callout, SoftBadge } from '../../../_ui'
import { EmailTabs, ClassBadge } from '../../_shared'
import JourneyConfigEditor from './JourneyConfigEditor'

export const dynamic = 'force-dynamic'

export default async function JourneyConfigPage({ params }: { params: { key: string } }) {
  const session = await getSession()
  const isOwner = session?.role === 'OWNER'
  const key = decodeURIComponent(params.key)
  const journey = journeyByKey(key)
  if (!journey) notFound()

  const mayEdit = can(session?.role as never, 'email.manage_journey')

  let stored: { enabled: boolean; version: number; config: unknown; updatedAt: Date; updatedByName: string | null } | null = null
  let error: string | null = null
  try {
    stored = await prisma.emailJourneyConfig.findUnique({ where: { journeyKey: key } })
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }

  const effective = effectiveConfig(key, stored)
  const changes = effective ? diffFromDefaults(key, effective.config) : []

  return (
    <div>
      <PageHeader
        title={`${journey.name} — settings`}
        subtitle={journey.anchor}
        actions={
          <Link href="/admin/email-marketing/journeys" style={{ fontSize: '13px', color: COLORS.muted, textDecoration: 'none' }}>
            ← All journeys
          </Link>
        }
      />
      <EmailTabs active="/admin/email-marketing/journeys" isOwner={isOwner} />

      <div style={{ display: 'flex', gap: '9px', flexWrap: 'wrap', marginBottom: '16px', alignItems: 'center' }}>
        <ClassBadge emailClass={journey.emailClass} />
        <SoftBadge color={effective?.source === 'database' ? COLORS.blue : COLORS.faint}>
          {effective?.source === 'database' ? `Configured · version ${effective.version}` : 'Using safe defaults'}
        </SoftBadge>
        {journey.flag && (
          <SoftBadge color={journey.enabled ? COLORS.green : COLORS.amber}>
            {journey.flag} = {journey.enabled ? 'true' : 'off'}
          </SoftBadge>
        )}
      </div>

      {error && <Callout tone="danger" title="Stored configuration could not be read">{error} — the safe defaults are in force.</Callout>}

      {effective?.degradedReason && (
        <Callout tone="danger" title="The stored configuration is invalid and is being IGNORED">
          {effective.degradedReason}
          <div style={{ marginTop: '6px' }}>
            The journey is running on the code defaults. Save a valid configuration below, or reset.
          </div>
        </Callout>
      )}

      {changes.length > 0 && (
        <Callout tone="info" title={`${changes.length} setting${changes.length === 1 ? '' : 's'} differ from the safe defaults`}>
          <ul style={{ margin: '4px 0 0', paddingLeft: '17px', lineHeight: 1.6 }}>
            {changes.map((c) => <li key={c}>{c}</li>)}
          </ul>
        </Callout>
      )}

      {!mayEdit ? (
        <Card>
          <Empty>Journey configuration is limited to owners. The settings in force are shown above.</Empty>
        </Card>
      ) : effective ? (
        <JourneyConfigEditor
          journeyKey={key}
          journeyName={journey.name}
          config={effective.config}
          version={effective.version}
          source={effective.source}
          stageTypes={journey.stages.map((s) => ({ type: s.type, label: s.label, defaultTemplate: s.template, isCountdown: s.delayMs < 0 }))}
          vocabulary={{
            stopRules: STOP_RULES as unknown as Record<string, string>,
            lockedStopRules: LOCKED_STOP_RULES as unknown as string[],
            minDelayMs: MIN_DELAY_MS,
            maxDelayMs: MAX_DELAY_MS,
            maxStages: MAX_STAGES,
          }}
        />
      ) : null}

      <div style={{ marginTop: '18px', padding: '14px 18px', backgroundColor: '#F9FAFB', borderRadius: '10px', fontSize: '12px', color: COLORS.muted, lineHeight: 1.6 }}>
        Saving increments the <strong>version</strong>, which is stamped onto every send scheduled under it. Changing a
        delay therefore never rewrites why an email already in the queue was scheduled when it was.
        <br />
        <br />
        Unsubscribe, hard bounce and complaint stop rules are <strong>locked on</strong>. They are enforced by the
        suppression list inside the send guard, so a toggle that appeared to disable them would be showing you something
        untrue.
      </div>
    </div>
  )
}
