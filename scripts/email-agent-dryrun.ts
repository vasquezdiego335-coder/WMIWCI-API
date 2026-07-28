/**
 * HISTORICAL DRY RUN — the email operations agent, against real data.
 *
 *   npx tsx scripts/email-agent-dryrun.ts [--json] [--window=24]
 *
 * READ-ONLY BY CONSTRUCTION, AND THAT IS NOT A PROMISE — IT IS THE STRUCTURE.
 * This script calls `runHealthChecks()` and the pure policy engine. It never
 * touches the incident manager, the tool executor or the runner, so there is
 * no code path from here to a write. Nothing about production changes: no
 * findings are stored, no incidents are opened, no alerts are sent, and no
 * model is called.
 *
 * WHAT IT ANSWERS: if the agent were switched on right now, what would it say,
 * what would it do by itself, and what would it ask about?
 */

import 'dotenv/config'
import { runHealthChecks, checkCatalogue, ALL_CHECKS } from '../src/lib/email-agent/checks'
import { canWriteAgentRecords, describeRuntime, detectEnvironment } from '../src/lib/email-agent/environment'
import { classify } from '../src/lib/email-agent/policy'
import { envDefaults } from '../src/lib/email-agent/settings'
import { prisma } from '../src/lib/db'
import type { AgentFinding, EmailAgentMode } from '../src/lib/email-agent/types'

const asJson = process.argv.includes('--json')
const windowArg = process.argv.find((a) => a.startsWith('--window='))
const windowHours = windowArg ? Number(windowArg.split('=')[1]) : 24

const line = (s = '') => console.log(s)
const rule = (c = '─') => line(c.repeat(78))

/** Group findings the way the incident manager would, without writing anything. */
function simulateIncidents(findings: AgentFinding[]): Map<string, AgentFinding[]> {
  const RELATED: Record<string, string> = {
    campaign: 'campaign', run: 'run', send: 'send', consent: 'consent',
    suppression: 'suppression', webhook: 'webhook', provider: 'provider',
    scheduler: 'scheduler', infrastructure: 'infrastructure',
  }
  const groups = new Map<string, AgentFinding[]>()
  for (const f of findings) {
    const subject = f.campaignId ?? f.runRefId ?? null
    const key = subject ? `subject:${subject}:${RELATED[f.category] ?? f.category}` : `fp:${f.fingerprint}`
    const list = groups.get(key)
    if (list) list.push(f)
    else groups.set(key, [f])
  }
  return groups
}

async function main() {
  const startedAt = Date.now()
  const settings = { ...envDefaults(), mode: 'read_only' as EmailAgentMode }

  // The boundary this script is on the safe side of. Reported at the top so a
  // reader knows whether these findings describe production or this machine —
  // a local .env missing RESEND_WEBHOOK_SECRET produces a CRITICAL finding
  // that is true of the laptop and false of production.
  const runtime = describeRuntime()
  const writeCheck = canWriteAgentRecords()
  const environment = detectEnvironment()

  // ── Corpus ────────────────────────────────────────────────────────────
  const [campaigns, emailCampaigns, runs, recipients, sends, events, suppressions, audiences, automations] =
    await Promise.all([
      prisma.marketingCampaign.count(),
      prisma.marketingCampaign.count({ where: { channel: 'EMAIL' } }),
      prisma.emailCampaignRun.count(),
      prisma.emailCampaignRecipient.count(),
      prisma.emailSend.count(),
      prisma.emailEvent.count(),
      prisma.emailSuppression.count(),
      prisma.emailAudience.count(),
      prisma.emailAutomation.count(),
    ])

  const report = await runHealthChecks({ settings, windowHours, dryRun: true })
  const groups = simulateIncidents(report.findings)

  // ── What WOULD happen, per mode ───────────────────────────────────────
  const suggested = Array.from(new Set(report.findings.flatMap((f) => f.suggestedActions)))
  const perMode = (mode: EmailAgentMode) => {
    const auto: string[] = []
    const approval: string[] = []
    const forbidden: string[] = []
    for (const tool of suggested) {
      const d = classify(tool, mode)
      if (d.classification === 'automatic') auto.push(tool)
      else if (d.classification === 'approval_required') approval.push(tool)
      else forbidden.push(tool)
    }
    return { auto, approval, forbidden }
  }
  const readOnly = perMode('read_only')
  const safeAuto = perMode('safe_auto')

  // ── The three specific questions the owner asked about ────────────────
  const verifications: Array<{ question: string; verdict: string; ok: boolean }> = []

  // 1. The successful campaign (1 sent, 5 skipped) must read as healthy.
  const successfulRuns = await prisma.emailCampaignRun.findMany({
    where: { status: { in: ['COMPLETED', 'COMPLETED_WITH_ERRORS'] } },
    select: { id: true, status: true, totalRecipients: true, sentCount: true, skippedCount: true, failedCount: true, cancelledCount: true },
  })
  for (const run of successfulRuns) {
    const flagged = report.findings.filter((f) => f.runRefId === run.id && f.severity !== 'info')
    const shape = `total=${run.totalRecipients} sent=${run.sentCount} skipped=${run.skippedCount}`
    verifications.push({
      question: `Completed run ${run.id} (${shape}) is classified healthy`,
      verdict: flagged.length === 0 ? 'HEALTHY — no finding raised' : `FLAGGED by ${flagged.map((f) => f.checkId).join(', ')}`,
      ok: flagged.length === 0,
    })
  }

  // 2. A temporary "1 pending" mid-flight snapshot must not be called stuck.
  const midFlight = await prisma.emailCampaignRun.findMany({
    where: { status: { in: ['PREPARING', 'QUEUED', 'SENDING'] } },
    select: { id: true, status: true, startedAt: true, updatedAt: true },
  })
  const pendingRows = await prisma.emailCampaignRecipient.count({ where: { status: 'PENDING' } })
  if (midFlight.length === 0) {
    verifications.push({
      question: 'A mid-flight run is not mistaken for a stuck one',
      verdict: `No run is currently in flight (${pendingRows} PENDING recipient rows exist overall), so the distinction could not be exercised on live data. The grace-window logic is covered by test "a run that is mid-flight is NOT past the stuck threshold".`,
      ok: true,
    })
  } else {
    for (const run of midFlight) {
      const stuckFinding = report.findings.find((f) => f.runRefId === run.id && f.checkId.startsWith('run.stuck'))
      const idleMin = Math.round((Date.now() - run.updatedAt.getTime()) / 60_000)
      verifications.push({
        question: `In-flight run ${run.id} (${run.status}, idle ${idleMin}m) is not called stuck`,
        verdict: stuckFinding ? `FLAGGED as ${stuckFinding.severity}` : 'Correctly treated as in flight',
        ok: !stuckFinding || idleMin > 30,
      })
    }
  }

  // 3. The real deliveredAt webhook chain must read as complete.
  const delivered = await prisma.emailSend.findMany({
    where: { deliveredAt: { not: null } },
    select: { id: true, sentAt: true, deliveredAt: true, providerId: true, bouncedAt: true, complainedAt: true },
    orderBy: { deliveredAt: 'desc' },
    take: 5,
  })
  for (const s of delivered) {
    const flagged = report.findings.filter((f) => f.sendId === s.id && f.severity !== 'info')
    const gap = s.sentAt && s.deliveredAt ? Math.round((s.deliveredAt.getTime() - s.sentAt.getTime()) / 1000) : null
    verifications.push({
      question: `Send ${s.id} with a real deliveredAt (${gap}s after send) reads as complete`,
      verdict:
        flagged.length > 0
          ? `FLAGGED by ${flagged.map((f) => f.checkId).join(', ')}`
          : `COMPLETE — provider id present: ${s.providerId ? 'yes' : 'no'}, no bounce, no complaint`,
      ok: flagged.length === 0 && !!s.providerId,
    })
  }

  // ── Structural leftovers worth naming separately ──────────────────────
  const [oldUnresolvedRuns, failedEvents, unsettledEvents, orphanRecipients] = await Promise.all([
    prisma.emailCampaignRun.count({ where: { status: { in: ['PREPARING', 'QUEUED', 'SENDING', 'CANCELLING'] }, startedAt: { lt: new Date(Date.now() - 24 * 3600_000) } } }),
    prisma.emailEvent.count({ where: { processingStatus: { in: ['side_effect_failed', 'dead_letter'] } } }),
    prisma.emailEvent.count({ where: { processingStatus: 'side_effect_pending' } }),
    prisma.emailCampaignRecipient.count({ where: { status: { in: ['PENDING', 'SENDING'] }, run: { status: { in: ['COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED', 'CANCELLED'] } } } }),
  ])

  const payload = {
    generatedAt: new Date().toISOString(),
    windowHours,
    mode: 'DRY RUN (read-only; nothing was written, no AI was called)',
    runtime: { description: runtime, environment, wouldBeAllowedToWrite: writeCheck.allowed, writeReason: writeCheck.reason },
    corpus: { campaigns, emailCampaigns, runs, recipients, sends, events, suppressions, audiences, automations, inspected: report.inspected },
    checks: { registered: ALL_CHECKS.length, emittedIds: checkCatalogue().flatMap((c) => c.emits).length, run: report.checksRun, failed: report.errors.length },
    overallStatus: report.overallStatus,
    findings: report.findings.map((f) => ({
      checkId: f.checkId, severity: f.severity, category: f.category, title: f.title,
      description: f.description, campaignId: f.campaignId, runRefId: f.runRefId, sendId: f.sendId,
      suggestedActions: f.suggestedActions, evidence: f.evidence,
    })),
    checkErrors: report.errors,
    wouldCreateIncidents: groups.size,
    readOnly,
    safeAuto,
    verifications,
    structural: { oldUnresolvedRuns, failedEvents, unsettledEvents, orphanRecipients },
    durationMs: Date.now() - startedAt,
  }

  if (asJson) {
    console.log(JSON.stringify(payload, null, 2))
    return
  }

  rule('═')
  line('  EMAIL OPERATIONS AGENT — HISTORICAL DRY RUN')
  line('  Read-only. Nothing was written; no AI provider was called.')
  rule('═')
  line()
  line(`Generated       ${payload.generatedAt}`)
  line(`Runtime         ${runtime}`)
  line(`Would write?    ${writeCheck.allowed ? 'yes (but this script never writes)' : 'NO - ' + writeCheck.reason.slice(0, 90)}`)
  if (environment !== 'production') {
    line()
    line('  NOTE: this is NOT a production runtime. Configuration findings')
    line('  (missing environment variables, alerting, provider keys) describe')
    line('  THIS MACHINE and may be false of the deployed worker.')
  }
  line(`Window          last ${windowHours} hours (structural checks look back 90 days)`)
  line(`Duration        ${payload.durationMs} ms`)
  line()

  line('RECORDS INSPECTED')
  rule()
  line(`  Marketing campaigns          ${campaigns} (${emailCampaigns} email)`)
  line(`  Campaign runs                ${runs}`)
  line(`  Campaign recipients          ${recipients}`)
  line(`  Email sends                  ${sends}`)
  line(`  Provider events              ${events}`)
  line(`  Suppressions                 ${suppressions}`)
  line(`  Audiences / automations      ${audiences} / ${automations}`)
  line()
  line('  Per-check row counts:')
  for (const [k, v] of Object.entries(report.inspected).sort()) line(`    ${k.padEnd(38)} ${v}`)
  line()

  line('CHECKS')
  rule()
  line(`  Definitions registered       ${ALL_CHECKS.length}`)
  line(`  Distinct finding ids         ${checkCatalogue().flatMap((c) => c.emits).length}`)
  line(`  Ran this pass                ${report.checksRun}`)
  line(`  Could not run                ${report.errors.length}`)
  for (const e of report.errors) line(`    ! ${e.checkId}: ${e.error}`)
  line()

  line(`OVERALL: ${report.overallStatus.toUpperCase()}`)
  rule()
  const bySeverity = (s: string) => report.findings.filter((f) => f.severity === s)
  line(`  critical ${bySeverity('critical').length}   warning ${bySeverity('warning').length}   info ${bySeverity('info').length}`)
  line()

  line(`FINDINGS (${report.findings.length})`)
  rule()
  for (const f of report.findings) {
    line(`  [${f.severity.toUpperCase().padEnd(8)}] ${f.checkId}`)
    line(`     ${f.title}`)
    for (const chunk of f.description.match(/.{1,70}(\s|$)/g) ?? []) line(`     ${chunk.trim()}`)
    if (f.campaignId) line(`     campaign: ${f.campaignId}`)
    if (f.runRefId) line(`     run: ${f.runRefId}`)
    if (f.suggestedActions.length) line(`     suggests: ${f.suggestedActions.join(', ')}`)
    line()
  }

  line(`INCIDENTS THAT WOULD BE CREATED: ${groups.size}`)
  rule()
  for (const [key, list] of Array.from(groups.entries())) {
    const lead = list.slice().sort((a, b) => (a.severity === 'critical' ? -1 : 1))[0]
    line(`  [${lead.severity.toUpperCase()}] ${lead.title}`)
    line(`     grouping key: ${key}`)
    line(`     ${list.length} finding(s): ${list.map((f) => f.checkId).join(', ')}`)
    line()
  }

  line('WHAT THE AGENT WOULD DO')
  rule()
  line('  In read_only (the production default):')
  line(`    automatic (inspection + recording only): ${readOnly.auto.join(', ') || 'none'}`)
  line(`    would ASK before doing:                  ${readOnly.approval.join(', ') || 'none'}`)
  line(`    refused outright:                        ${readOnly.forbidden.join(', ') || 'none'}`)
  line()
  line('  In safe_auto (only if deliberately enabled):')
  line(`    would do by itself:                      ${safeAuto.auto.join(', ') || 'none'}`)
  line(`    would still ASK:                         ${safeAuto.approval.join(', ') || 'none'}`)
  line(`    refused outright:                        ${safeAuto.forbidden.join(', ') || 'none'}`)
  line()

  line('SPECIFIC VERIFICATIONS')
  rule()
  for (const v of verifications) {
    line(`  ${v.ok ? 'PASS' : 'FAIL'}  ${v.question}`)
    line(`        ${v.verdict}`)
  }
  line()

  line('STRUCTURAL LEFTOVERS')
  rule()
  line(`  Runs unresolved for over 24h            ${oldUnresolvedRuns}`)
  line(`  Webhook events failed / dead-lettered   ${failedEvents}`)
  line(`  Webhook events pending a suppression    ${unsettledEvents}`)
  line(`  Recipients stranded in a finished run   ${orphanRecipients}`)
  line()
  rule('═')
}

main()
  .catch((err) => {
    console.error('DRY RUN FAILED:', err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
    process.exit(process.exitCode ?? 0)
  })
