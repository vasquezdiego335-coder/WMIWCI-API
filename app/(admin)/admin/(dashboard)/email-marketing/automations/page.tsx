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
  // Runtime truth: enrollment counts + upcoming steps + stop reasons, so
  // "ACTIVE" is always shown next to what is actually enrolled and running.
  const enrollmentsByAutomation = new Map<string, Record<string, number>>()
  let upcoming: Array<{ automationId: string; email: string; currentStage: number; nextRunAt: Date | null }> = []
  let stopRows: Array<{ automationId: string; stopReason: string | null; count: number }> = []
  try {
    rows = await prisma.emailAutomation.findMany({
      orderBy: { updatedAt: 'desc' },
      include: { versions: { orderBy: { version: 'desc' }, take: 5 } },
    })
    const groups = await prisma.emailAutomationEnrollment.groupBy({ by: ['automationId', 'status'], _count: { _all: true } })
    for (const g of groups) {
      const entry = enrollmentsByAutomation.get(g.automationId) ?? {}
      entry[g.status] = g._count._all
      enrollmentsByAutomation.set(g.automationId, entry)
    }
    upcoming = await prisma.emailAutomationEnrollment.findMany({
      where: { status: 'ACTIVE', nextRunAt: { not: null } },
      orderBy: { nextRunAt: 'asc' },
      take: 25,
      select: { automationId: true, email: true, currentStage: true, nextRunAt: true },
    })
    const stopGroups = await prisma.emailAutomationEnrollment.groupBy({
      by: ['automationId', 'stopReason'],
      where: { status: 'STOPPED', stopReason: { not: null } },
      _count: { _all: true },
    })
    stopRows = stopGroups.map((s) => ({ automationId: s.automationId, stopReason: s.stopReason, count: s._count._all }))
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }
  const promotionsOn = process.env.EMAIL_PROMOTIONS_ENABLED === 'true'

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

      {!promotionsOn && (
        <Callout tone="warning" title="Promotional sending is globally disabled">
          EMAIL_PROMOTIONS_ENABLED is not set, so an automation marked ACTIVE is <strong>not sending</strong> right now —
          enrollments are held, not lost, and resume when the switch is deliberately enabled after the staging rehearsal.
        </Callout>
      )}

      {/* ── EXECUTION — what is actually enrolled and running ─────────── */}
      {rows.length > 0 && (
        <Card>
          <h3 style={{ fontSize: '13px', fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 12px' }}>
            Execution
          </h3>
          {rows.map((a) => {
            const counts = enrollmentsByAutomation.get(a.id) ?? {}
            const next = upcoming.filter((u) => u.automationId === a.id).slice(0, 3)
            const stops = stopRows.filter((s) => s.automationId === a.id)
            const sending = a.status === 'ACTIVE' && promotionsOn
            return (
              <div key={a.id} style={{ padding: '10px 0', borderBottom: '1px solid #F1F1F1' }}>
                <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
                  <strong style={{ fontSize: '13px', color: COLORS.navy }}>{a.name}</strong>
                  <span style={{ fontSize: '11px', fontWeight: 700, color: sending ? COLORS.green : COLORS.faint }}>
                    {sending ? '● executing' : a.status === 'ACTIVE' ? '○ ACTIVE but not sending (promo switch off)' : `○ ${a.status.toLowerCase()} — not executing`}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap', fontSize: '12px', color: '#374151', marginTop: '6px' }}>
                  <span><strong>{counts.ACTIVE ?? 0}</strong> enrolled</span>
                  <span style={{ color: COLORS.green }}><strong>{counts.COMPLETED ?? 0}</strong> completed</span>
                  <span style={{ color: COLORS.muted }}><strong>{counts.STOPPED ?? 0}</strong> stopped</span>
                  {(counts.FAILED ?? 0) > 0 && <span style={{ color: COLORS.red }}><strong>{counts.FAILED}</strong> failed</span>}
                </div>
                {next.length > 0 && (
                  <div style={{ fontSize: '11px', color: COLORS.muted, marginTop: '5px' }}>
                    Next steps:{' '}
                    {next
                      .map((u) => `${u.email.replace(/^(.).*(@.*)$/, '$1…$2')} → stage ${u.currentStage + 1} at ${u.nextRunAt?.toLocaleString('en-US', { timeZone: 'America/New_York' })} ET`)
                      .join(' · ')}
                  </div>
                )}
                {stops.length > 0 && (
                  <div style={{ fontSize: '11px', color: COLORS.faint, marginTop: '4px' }}>
                    Stop reasons: {stops.map((s) => `${s.stopReason} ×${s.count}`).join(' · ')}
                  </div>
                )}
              </div>
            )
          })}
        </Card>
      )}

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
