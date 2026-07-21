// AUTOMATIONS (owner spec 2026-07-21). Owner-only.
//
// Trigger → delay → approved template, with stop rules. Declarative and
// versioned. There is no scripting surface here and no field that could become
// one: triggers, templates and audiences all come from closed lists.

import { getSession } from '@/lib/auth'
import { can } from '@/lib/permissions'
import { prisma } from '@/lib/db'
import { validateAutomationDefinition, APPROVED_TRIGGERS, describeAutomation } from '@/lib/email-automation'
import { STOP_RULES, LOCKED_STOP_RULES } from '@/lib/email-journey-config'
import { templateRegistry } from '@/lib/email-registry'
import { SEGMENTS } from '@/lib/email-audience'
import { PageHeader, Card, Empty, COLORS, Callout } from '../../_ui'
import { EmailTabs } from '../_shared'
import AutomationBuilder from './AutomationBuilder'

export const dynamic = 'force-dynamic'

export default async function AutomationsPage() {
  const session = await getSession()
  const isOwner = session?.role === 'OWNER'

  if (!can(session?.role as never, 'email.view')) {
    return (
      <div>
        <PageHeader title="Automations" />
        <Card><Empty>You do not have access to automations.</Empty></Card>
      </div>
    )
  }

  const mayEdit = can(session?.role as never, 'email.manage_journey')

  let rows: Array<{
    id: string; name: string; description: string | null; status: string; activeVersion: number | null
    updatedAt: Date; createdByName: string | null
    versions: Array<{ version: number; definition: unknown; createdAt: Date; createdByName: string | null }>
  }> = []
  let error: string | null = null
  try {
    rows = await prisma.emailAutomation.findMany({
      orderBy: { updatedAt: 'desc' },
      include: { versions: { orderBy: { version: 'desc' }, take: 5 } },
    })
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }

  const automations = rows.map((a) => {
    const active = a.versions.find((v) => v.version === a.activeVersion) ?? a.versions[0] ?? null
    // Validated on READ: a definition that became invalid is reported as such
    // rather than described as if it would run.
    const validated = active ? validateAutomationDefinition(active.definition) : null
    return {
      id: a.id,
      name: a.name,
      description: a.description,
      status: a.status,
      activeVersion: a.activeVersion,
      updatedAt: a.updatedAt.toISOString(),
      summary: validated?.ok ? describeAutomation(validated.definition) : null,
      invalidReason: validated && !validated.ok ? validated.errors.join(' ') : null,
      versions: a.versions.map((v) => ({ version: v.version, createdAt: v.createdAt.toISOString(), createdByName: v.createdByName })),
    }
  })

  // Only promotional templates — a transactional template states a fact about
  // one specific booking and cannot be broadcast by an automation.
  const templates = templateRegistry()
    .filter((t) => t.emailClass === 'promotional')
    .map((t) => ({ key: t.key, name: t.name }))

  return (
    <div>
      <PageHeader
        title="Automations"
        subtitle="Trigger, delay, approved template, stop rules. Versioned — a run in flight keeps the rules that scheduled it."
      />
      <EmailTabs active="/admin/email-marketing/automations" isOwner={isOwner} />

      <Callout tone="info" title="An automation cannot bypass anything">
        It does not send email — it schedules through the same journey machinery, which sends through the guard. Every
        message still passes suppression, live-state recheck, frequency caps, the postal-address rule, the unsubscribe
        requirement and idempotency. Saving a new version of an <strong>ACTIVE</strong> automation pauses it, so a rule
        change never takes effect on live customers without a deliberate re-activation.
      </Callout>

      {error && <p style={{ fontSize: '12px', color: COLORS.red, marginBottom: '14px' }}>Automations unavailable: {error}</p>}

      <AutomationBuilder
        automations={automations}
        mayEdit={mayEdit}
        vocabulary={{
          triggers: APPROVED_TRIGGERS as unknown as Record<string, string>,
          segments: SEGMENTS as unknown as Record<string, string>,
          stopRules: STOP_RULES as unknown as Record<string, string>,
          lockedStopRules: LOCKED_STOP_RULES as unknown as string[],
          templates,
        }}
      />
    </div>
  )
}
