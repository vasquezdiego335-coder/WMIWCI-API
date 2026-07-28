// ════════════════════════════════════════════════════════════════════════
//  OPERATIONS AGENT — /admin/email-marketing/agent (owner spec 2026-07-27)
//  ---------------------------------------------------------------------
//  One page that answers, in this order: is anything wrong, does anything need
//  me, what did the agent do, and what has it learned.
//
//  IT DEGRADES HONESTLY. Before the migration is applied the agent tables do
//  not exist, so every query here is individually guarded and the page renders
//  a plain explanation of what is missing instead of a stack trace. A status
//  page that cannot load is the same failure as an agent that cannot run.
//
//  IT NEVER CLAIMS MORE THAN IT KNOWS. When the last cycle is old, it says how
//  old. When the AI was not called, it says why. "Healthy" is only shown when a
//  cycle actually ran and actually passed.
// ════════════════════════════════════════════════════════════════════════

import Link from 'next/link'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { can, type Role } from '@/lib/permissions'
import { loadSettings } from '@/lib/email-agent/settings'
import { effectiveStatus, overallBadge, readHeartbeat } from '@/lib/email-agent/status'
import { readUsage } from '@/lib/email-agent/budget'
import { ALL_CHECKS } from '@/lib/email-agent/checks'
import { AGENT_TOOL_NAMES } from '@/lib/email-agent/types'
import { Card, COLORS, Empty, PageHeader, SoftBadge, StatCard, StatGrid, tableScrollProps, tableStyles } from '../../_ui'
import { EmailTabs, dt } from '../_shared'
import AgentControls from './AgentControls'
import { ApprovalDecision, IncidentDecision } from './AgentDecisions'

export const dynamic = 'force-dynamic'

const severityColor = (s: string): string =>
  s === 'critical' ? COLORS.red : s === 'warning' ? COLORS.amber : COLORS.blue

const statusColor = (s: string): string =>
  s === 'critical' ? COLORS.red : s === 'warning' ? COLORS.amber : s === 'healthy' ? COLORS.green : COLORS.muted

const modeLabel: Record<string, string> = {
  off: 'Off — nothing is being checked',
  read_only: 'Read-only — watches and reports, changes nothing',
  safe_auto: 'Safe-auto — may make narrow, policy-approved repairs',
}

/** Every agent query is wrapped: a missing table renders a message, not a 500. */
async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<{ value: T; failed: boolean }> {
  try {
    return { value: await fn(), failed: false }
  } catch {
    return { value: fallback, failed: true }
  }
}

export default async function AgentPage() {
  const session = await getSession()
  const role = session?.role as Role
  const isOwner = can(role, 'email.manage_campaign')
  const canConfigure = can(role, 'email.configure')

  const settings = await loadSettings()
  // TRUTHFUL STATUS. `effectiveMode` is what will actually happen, which is not
  // necessarily what the database row asks for; `heartbeat` is whether a
  // production WORKER is alive, which reading the settings row proves nothing
  // about. Both are computed before anything is rendered.
  const status = effectiveStatus(settings)

  const [lastRunR, incidentsR, approvalsR, actionsR, lessonsR, modelCallR, runCountR, heartbeatR, usageR] = await Promise.all([
    safe(() => prisma.emailAgentRun.findFirst({ orderBy: { startedAt: 'desc' } }), null),
    safe(
      () =>
        prisma.emailAgentIncident.findMany({
          where: { status: { in: ['open', 'investigating', 'awaiting_approval', 'mitigated'] } },
          orderBy: [{ severity: 'desc' }, { lastDetectedAt: 'desc' }],
          take: 25,
          include: { findings: { orderBy: { detectedAt: 'desc' }, take: 5 }, actions: { orderBy: { startedAt: 'desc' }, take: 3 }, events: { orderBy: { createdAt: 'desc' }, take: 5 } },
        }),
      [] as never[]
    ),
    safe(
      () => prisma.emailAgentApproval.findMany({ where: { status: 'pending' }, orderBy: { createdAt: 'desc' }, take: 20, include: { incident: { select: { reference: true, title: true } } } }),
      [] as never[]
    ),
    safe(() => prisma.emailAgentAction.findMany({ orderBy: { startedAt: 'desc' }, take: 20 }), [] as never[]),
    safe(() => prisma.emailAgentLesson.findMany({ orderBy: [{ lastObservedAt: 'desc' }], take: 15 }), [] as never[]),
    safe(() => prisma.emailAgentModelCall.findFirst({ orderBy: { createdAt: 'desc' } }), null),
    safe(() => prisma.emailAgentRun.count(), 0),
    safe(() => readHeartbeat(settings), null),
    safe(() => readUsage(settings), null),
  ])

  const tablesMissing = lastRunR.failed && incidentsR.failed
  const lastRun = lastRunR.value
  const incidents = incidentsR.value
  const approvals = approvalsR.value
  const actions = actionsR.value
  const lessons = lessonsR.value
  const modelCall = modelCallR.value

  const heartbeat = heartbeatR.value
  const usage = usageR.value
  const ageMinutes = lastRun ? Math.round((Date.now() - new Date(lastRun.startedAt).getTime()) / 60_000) : null
  // NEVER derived from "the settings row was readable". A stale worker or a
  // disabled agent outranks a healthy last result.
  const badge = heartbeat
    ? overallBadge(status, heartbeat, lastRun?.overallStatus ?? null)
    : { badge: 'unknown' as const, message: 'The heartbeat could not be read.' }

  return (
    <div>
      <PageHeader
        title="Operations Agent"
        subtitle="Watches the email system continuously, groups problems into incidents, and asks before touching anything that reaches a customer."
      />
      <EmailTabs active="/admin/email-marketing/agent" isOwner={isOwner} />

      {tablesMissing && (
        <Card>
          <div style={{ padding: '4px 0' }}>
            <h2 style={{ fontSize: '16px', fontWeight: 700, color: COLORS.red, margin: '0 0 8px' }}>The agent&rsquo;s database tables do not exist yet</h2>
            <p style={{ fontSize: '14px', color: COLORS.ink, margin: '0 0 8px', lineHeight: 1.6 }}>
              The migration <code>20260727120000_email_ops_agent</code> has not been applied to this database. The agent cannot record findings, incidents,
              actions or approvals until it is. Nothing else in the email system is affected — campaigns, sending and webhooks are unchanged.
            </p>
            <p style={{ fontSize: '13px', color: COLORS.muted, margin: 0 }}>
              Apply it with <code>npm run db:migrate:prod</code> against the production database, then reload this page.
            </p>
          </div>
        </Card>
      )}

      {/* ── Overview ─────────────────────────────────────────────── */}
      <StatGrid>
        <StatCard label="Overall status" value={badge.badge} accent={statusColor(badge.badge)} sub={badge.message.slice(0, 90)} />
        <StatCard
          label="Effective mode"
          value={status.effectiveMode}
          accent={status.effectiveMode === 'off' ? COLORS.muted : status.safeAutoActive ? COLORS.gold : COLORS.blue}
          sub={
            status.requestedMode === status.effectiveMode
              ? modeLabel[status.effectiveMode] ?? status.effectiveMode
              : `requested ${status.requestedMode} — ${status.reason ?? 'overridden by the environment'}`
          }
        />
        <StatCard
          label="Worker heartbeat"
          value={heartbeat?.state ?? 'unknown'}
          accent={
            heartbeat?.state === 'healthy'
              ? COLORS.green
              : heartbeat?.state === 'delayed'
                ? COLORS.amber
                : heartbeat?.state === 'disabled'
                  ? COLORS.muted
                  : COLORS.red
          }
          sub={heartbeat?.message.slice(0, 90) ?? 'no heartbeat data'}
        />
        <StatCard
          label="Last health check"
          value={lastRun ? (ageMinutes! < 1 ? 'just now' : `${ageMinutes}m ago`) : 'never'}
          accent={COLORS.navy}
          sub={lastRun ? `${lastRun.checksRun} checks, ${lastRun.findingsTotal} findings` : `${ALL_CHECKS.length} checks registered`}
        />
        <StatCard label="Open incidents" value={String(incidents.length)} accent={incidents.length > 0 ? COLORS.amber : COLORS.green} sub={`${runCountR.value} cycles recorded`} />
        <StatCard label="Waiting on you" value={String(approvals.length)} accent={approvals.length > 0 ? COLORS.orange : COLORS.green} sub="approval requests" />
        <StatCard
          label="Marketing dispatch"
          value={settings.marketingDispatchPaused ? 'PAUSED' : 'active'}
          accent={settings.marketingDispatchPaused ? COLORS.red : COLORS.green}
          sub={settings.marketingDispatchPaused ? settings.pausedReason ?? 'no reason recorded' : 'campaigns can send'}
        />
        <StatCard
          label="AI investigator"
          value={status.aiEnabled ? (settings.model ?? settings.provider ?? 'deepseek') : 'off'}
          accent={status.aiEnabled ? COLORS.navy : COLORS.muted}
          sub={status.aiReason ?? (modelCall ? `last call: ${modelCall.outcome}${modelCall.totalTokens ? ` · ${modelCall.totalTokens} tokens` : ''}` : 'no call recorded yet')}
        />
        <StatCard
          label="AI spend this month"
          value={usage ? `$${usage.month.costUsd.toFixed(4)}` : 'unknown'}
          accent={
            !usage ? COLORS.muted : usage.monthlyPercentUsed >= 80 ? COLORS.red : usage.monthlyPercentUsed >= 50 ? COLORS.amber : COLORS.green
          }
          sub={
            usage
              ? `${usage.monthlyPercentUsed.toFixed(1)}% of the $${usage.limits.costPerMonth.toFixed(2)} cap · ${usage.month.calls} calls · projected $${(usage.projectedMonthEndUsd ?? 0).toFixed(2)}`
              : 'no usage data'
          }
        />
      </StatGrid>

      {settings.degraded && (
        <Card>
          <p style={{ fontSize: '13px', color: COLORS.red, margin: 0 }}>
            <strong>The agent cannot read its own settings.</strong> It is running on environment defaults, which means the marketing dispatch pause stored in
            the database is <em>not</em> in force right now. {settings.degradedReason}
          </p>
        </Card>
      )}

      {/* ── Last cycle ───────────────────────────────────────────── */}
      {lastRun && (
        <Card title="Last health check" icon="🔎">
          <p style={{ fontSize: '14px', color: COLORS.ink, lineHeight: 1.65, margin: '0 0 12px' }}>{lastRun.summary ?? 'No summary was recorded.'}</p>
          <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', fontSize: '12px', color: COLORS.muted }}>
            <span>{dt(lastRun.startedAt)}</span>
            <span>{lastRun.durationMs ? `${(lastRun.durationMs / 1000).toFixed(1)}s` : ''}</span>
            <span>mode: {lastRun.mode}</span>
            <span>
              {lastRun.findingsCritical} critical · {lastRun.findingsWarning} warning · {lastRun.findingsInfo} info
            </span>
            {lastRun.checksFailed > 0 && <span style={{ color: COLORS.red }}>{lastRun.checksFailed} checks could not run</span>}
            <span>
              {lastRun.aiInvoked ? 'AI investigated' : `AI not used${lastRun.aiSkippedReason ? ` — ${lastRun.aiSkippedReason}` : ''}`}
            </span>
            {lastRun.actionsExecuted > 0 && <span>{lastRun.actionsExecuted} automatic action(s)</span>}
          </div>
        </Card>
      )}

      {/* ── Approvals ────────────────────────────────────────────── */}
      <Card title={`Waiting on you (${approvals.length})`} icon="✋">
        {approvals.length === 0 ? (
          <Empty>Nothing needs a decision.</Empty>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {approvals.map((a) => {
              const expired = new Date(a.expiresAt) <= new Date()
              return (
                <div key={a.id} style={{ border: `1px solid ${COLORS.line}`, borderRadius: '10px', padding: '14px' }}>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '8px' }}>
                    <SoftBadge color={COLORS.orange}>{a.reference}</SoftBadge>
                    <code style={{ fontSize: '12px', color: COLORS.muted }}>{a.toolName}</code>
                    {a.incident && <span style={{ fontSize: '12px', color: COLORS.muted }}>· {a.incident.reference}</span>}
                  </div>
                  <p style={{ fontSize: '14px', fontWeight: 600, color: COLORS.navy, margin: '0 0 8px' }}>{a.question}</p>
                  <dl style={{ margin: '0 0 12px', fontSize: '13px', color: COLORS.ink, lineHeight: 1.6 }}>
                    <div><strong>Why:</strong> {a.reason}</div>
                    <div><strong>What will happen:</strong> {a.expectedEffect}</div>
                    <div><strong>Risk:</strong> {a.risk}</div>
                    <div style={{ color: COLORS.muted, fontSize: '12px', marginTop: '4px' }}>
                      Expires {dt(a.expiresAt)}
                      {a.campaignId ? ` · campaign ${a.campaignId}` : ''}
                      {a.runRefId ? ` · run ${a.runRefId}` : ''}
                    </div>
                  </dl>
                  {isOwner ? (
                    <ApprovalDecision
                      approvalId={a.id}
                      reference={a.reference}
                      toolName={a.toolName}
                      question={a.question}
                      resourceChanged={false}
                      expired={expired}
                    />
                  ) : (
                    <p style={{ fontSize: '12px', color: COLORS.muted, margin: 0 }}>Only an owner can decide this.</p>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </Card>

      {/* ── Incidents ────────────────────────────────────────────── */}
      <Card title={`Open incidents (${incidents.length})`} icon="🚨">
        {incidents.length === 0 ? (
          <Empty>{lastRun ? 'No open incidents. Everything the agent checks is behaving.' : 'The agent has not run yet.'}</Empty>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {incidents.map((i) => (
              <div key={i.id} style={{ border: `1px solid ${COLORS.line}`, borderLeft: `3px solid ${severityColor(i.severity)}`, borderRadius: '10px', padding: '14px' }}>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '8px' }}>
                  <SoftBadge color={severityColor(i.severity)}>{i.severity.toUpperCase()}</SoftBadge>
                  <SoftBadge color={COLORS.muted}>{i.status.replace(/_/g, ' ')}</SoftBadge>
                  <code style={{ fontSize: '12px', color: COLORS.muted }}>{i.reference}</code>
                  <span style={{ fontSize: '12px', color: COLORS.muted }}>· {i.category} · seen {i.detectionCount}×</span>
                </div>

                {/* h2, not h3: PageHeader owns the h1 and the outline must not
                    skip a level for the screen-reader users who navigate by it. */}
                <h2 style={{ fontSize: '15px', fontWeight: 700, color: COLORS.navy, margin: '0 0 6px' }}>{i.title}</h2>
                <p style={{ fontSize: '14px', color: COLORS.ink, lineHeight: 1.6, margin: '0 0 10px' }}>{i.summary}</p>

                {i.probableCause && (
                  <p style={{ fontSize: '13px', color: COLORS.ink, margin: '0 0 10px' }}>
                    <strong>Probable cause:</strong> {i.probableCause}
                    {i.confidence !== null && i.confidence !== undefined && (
                      <span style={{ color: COLORS.muted }}> (confidence {(i.confidence * 100).toFixed(0)}%)</span>
                    )}
                  </p>
                )}

                {i.findings.length > 0 && (
                  <details style={{ marginBottom: '10px' }}>
                    <summary style={{ fontSize: '12px', color: COLORS.muted, cursor: 'pointer' }}>Evidence ({i.findings.length} finding{i.findings.length === 1 ? '' : 's'})</summary>
                    <ul style={{ fontSize: '12px', color: COLORS.ink, margin: '8px 0 0', paddingLeft: '18px', lineHeight: 1.6 }}>
                      {i.findings.map((f) => (
                        <li key={f.id}>
                          <code>{f.checkId}</code> — {f.description}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}

                {i.actions.length > 0 && (
                  <p style={{ fontSize: '12px', color: COLORS.muted, margin: '0 0 10px' }}>
                    Actions attempted: {i.actions.map((a) => `${a.toolName} (${a.status})`).join(', ')}
                  </p>
                )}

                <div style={{ fontSize: '12px', color: COLORS.muted, marginBottom: '10px' }}>
                  First seen {dt(i.firstDetectedAt)} · last seen {dt(i.lastDetectedAt)}
                  {i.affectedCount > 1 ? ` · ${i.affectedCount} things affected` : ''}
                </div>

                {isOwner && <IncidentDecision incidentId={i.id} reference={i.reference} status={i.status} />}
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* ── Controls ─────────────────────────────────────────────── */}
      {canConfigure ? (
        <Card title="Controls" icon="🎛️">
          <AgentControls
            settings={{
              mode: settings.mode,
              aiEnabled: settings.aiEnabled,
              autoActionsEnabled: settings.autoActionsEnabled,
              alertsEnabled: settings.alertsEnabled,
              digestWarnings: settings.digestWarnings,
              marketingDispatchPaused: settings.marketingDispatchPaused,
            }}
          />
        </Card>
      ) : (
        <Card title="Controls" icon="🎛️">
          <Empty>You can see the agent&rsquo;s status but not change it. Ask an owner.</Empty>
        </Card>
      )}

      {/* ── Actions ──────────────────────────────────────────────── */}
      <Card title="What the agent has done" icon="📋" wide>
        {actions.length === 0 ? (
          <Empty>No actions recorded. In read-only mode the agent never changes anything, so this staying empty is correct.</Empty>
        ) : (
          <div {...tableScrollProps('Agent actions')}>
            <table style={tableStyles.table}>
              <thead>
                <tr>
                  <th style={tableStyles.th}>When</th>
                  <th style={tableStyles.th}>Tool</th>
                  <th style={tableStyles.th}>Policy</th>
                  <th style={tableStyles.th}>Result</th>
                  <th style={tableStyles.th}>By</th>
                  <th style={tableStyles.th}>Before → after</th>
                </tr>
              </thead>
              <tbody>
                {actions.map((a) => (
                  <tr key={a.id}>
                    <td style={tableStyles.td}>{dt(a.startedAt)}</td>
                    <td style={tableStyles.td}><code style={{ fontSize: '12px' }}>{a.toolName}</code></td>
                    <td style={tableStyles.td}>
                      <SoftBadge color={a.policyClassification === 'forbidden' ? COLORS.red : a.policyClassification === 'automatic' ? COLORS.green : COLORS.amber}>
                        {a.policyClassification.replace(/_/g, ' ')}
                      </SoftBadge>
                    </td>
                    <td style={tableStyles.td}>
                      <SoftBadge color={a.status === 'succeeded' ? COLORS.green : a.status === 'failed' ? COLORS.red : COLORS.muted}>{a.status}</SoftBadge>
                      {a.error && <div style={{ fontSize: '11px', color: COLORS.muted, marginTop: '3px' }}>{a.error.slice(0, 120)}</div>}
                    </td>
                    <td style={tableStyles.td}>{a.actorName ?? a.actor}{a.aiModel ? <div style={{ fontSize: '11px', color: COLORS.muted }}>{a.aiProvider}/{a.aiModel}</div> : null}</td>
                    <td style={{ ...tableStyles.td, fontSize: '11px', color: COLORS.muted, maxWidth: '260px' }}>
                      {a.beforeState ? JSON.stringify(a.beforeState).slice(0, 90) : '—'}
                      {' → '}
                      {a.afterState ? JSON.stringify(a.afterState).slice(0, 90) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* ── Memory ───────────────────────────────────────────────── */}
      <Card title="What the agent has learned" icon="🧠" wide>
        {lessons.length === 0 ? (
          <Empty>No lessons yet. The agent records one when an incident is resolved or marked a false positive.</Empty>
        ) : (
          <div {...tableScrollProps('Agent lessons')}>
            <table style={tableStyles.table}>
              <thead>
                <tr>
                  <th style={tableStyles.th}>Pattern</th>
                  <th style={tableStyles.th}>Confidence</th>
                  <th style={tableStyles.th}>Seen</th>
                  <th style={tableStyles.th}>Probable cause</th>
                  <th style={tableStyles.th}>What worked</th>
                  <th style={tableStyles.th}>Last seen</th>
                </tr>
              </thead>
              <tbody>
                {lessons.map((l) => (
                  <tr key={l.id}>
                    <td style={tableStyles.td}>
                      <code style={{ fontSize: '12px' }}>{l.patternKey}</code>
                      <div style={{ fontSize: '11px', color: COLORS.muted }}>{l.title.slice(0, 80)}</div>
                    </td>
                    <td style={tableStyles.td}>{(l.confidence * 100).toFixed(0)}%</td>
                    <td style={tableStyles.td}>
                      {l.occurrences}×{l.falsePositives > 0 ? <span style={{ color: COLORS.amber }}> ({l.falsePositives} false)</span> : null}
                    </td>
                    <td style={{ ...tableStyles.td, maxWidth: '280px', fontSize: '12px' }}>{l.probableCause.slice(0, 180)}</td>
                    <td style={{ ...tableStyles.td, maxWidth: '240px', fontSize: '12px' }}>{l.successfulResolution?.slice(0, 160) ?? '—'}</td>
                    <td style={tableStyles.td}>{dt(l.lastObservedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* ── What it can and cannot do ────────────────────────────── */}
      <Card title="What this agent is allowed to do" icon="🔒">
        <p style={{ fontSize: '13px', color: COLORS.ink, lineHeight: 1.7, margin: '0 0 10px' }}>
          It runs <strong>{ALL_CHECKS.length} deterministic checks</strong> and may name <strong>{AGENT_TOOL_NAMES.length} tools</strong>, all allowlisted. Deterministic
          code decides what is true; the AI only explains and recommends, and a policy engine — not the model — decides whether anything happens.
        </p>
        <p style={{ fontSize: '13px', color: COLORS.ink, lineHeight: 1.7, margin: '0 0 10px' }}>
          <strong>It can never</strong> send a campaign, resend an email, reschedule, change an audience, create consent, remove a suppression, raise the{' '}
          {settings.stageRecipientLimit}-recipient limit, run SQL, or change its own mode. Those are refused by the policy engine regardless of what the model asks for.
        </p>
        <p style={{ fontSize: '12px', color: COLORS.muted, margin: 0 }}>
          Full delivery history stays in{' '}
          <Link href="/admin/email-marketing/sends" style={{ color: COLORS.navy }}>Send history</Link> and{' '}
          <Link href="/admin/email-marketing/deliverability" style={{ color: COLORS.navy }}>Deliverability</Link>.
        </p>
      </Card>
    </div>
  )
}
