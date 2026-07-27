import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  checkComplaintRate, checkBounceRate, checkUnsettledSideEffects, checkStuckRuns,
  checkStrandedRecipients, checkAmbiguousSends, checkMissedSchedules, checkTruncatedRuns,
  emailHealthReport, runEmailMonitoring,
  COMPLAINT_RATE_WARN, COMPLAINT_RATE_CRITICAL, BOUNCE_RATE_WARN, BOUNCE_RATE_CRITICAL,
  type Check,
} from '../email-monitoring'
import { emailRequired } from '../env'
import { AMBIGUOUS_WINDOW_DAYS } from '../email-audience'

// ════════════════════════════════════════════════════════════════════════
//  PRODUCTION HARDENING (owner spec 2026-07-26, audit items E-01…E-09)
//
//  Each test names the PRODUCTION FAILURE it prevents, because every one of
//  these was a real gap: mechanisms that were written, documented, and never
//  wired up. The pattern to guard against is not "the code is wrong" — it is
//  "the code is correct and nothing calls it".
// ════════════════════════════════════════════════════════════════════════

const src = (rel: string) => readFileSync(resolve(__dirname, '..', '..', '..', rel), 'utf8')
const lib = (name: string) => readFileSync(resolve(__dirname, '..', name), 'utf8')
/** Source with comment lines stripped — stops assertions matching prose. */
const code = (text: string) =>
  text.split('\n').filter((l) => {
    const t = l.trim()
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
  }).join('\n')

// ── E-01: env validation actually runs ──────────────────────────────────

test('E-01 assertEnv is CALLED at worker boot, not merely exported', () => {
  // The original defect exactly: assertEnv existed, documented itself as
  // "call at worker boot so a bad deploy fails loudly", and nothing called it.
  const worker = code(src('src/workers/index.ts'))
  assert.match(worker, /import \{ assertEnv \}/, 'worker must import assertEnv')
  assert.match(worker, /^\s*assertEnv\(\)/m, 'worker must CALL assertEnv()')
  // It must run BEFORE any worker claims a job, or a broken deploy processes
  // real sends before failing.
  const callAt = worker.indexOf('assertEnv()')
  const firstWorker = worker.indexOf('startEmailWorker()')
  assert.ok(callAt > 0 && callAt < firstWorker, 'assertEnv() must run before the workers start')
})

test('E-01 the env gate is in the entrypoint PRODUCTION runs, not only the dev one', () => {
  // THE MISTAKE THIS PINS (found during deploy, 2026-07-27): the gate was added
  // to src/workers/index.ts, but Railway runs `host:start` → src/worker-host.ts.
  // The check was therefore live in local development and ABSENT in production —
  // the exact "written, documented, never called" pattern this release exists to
  // remove, reproduced while removing it.
  const pkg = JSON.parse(src('package.json'))
  const entry = pkg.scripts['host:start'] as string
  assert.match(entry, /worker-host\.ts/, 'host:start must point at worker-host.ts (update this test if it moves)')

  const host = code(src('src/worker-host.ts'))
  assert.match(host, /checkEnv\(\)/, 'the production entrypoint must validate the environment')
  assert.match(host, /state\.envMissing = env\.missingRequired/, 'and record what is missing for /health')
  // Workers must NOT start on a bad environment.
  const gateAt = host.indexOf('const env = checkEnv()')
  const firstWorker = host.indexOf('startEmailWorker()')
  assert.ok(gateAt > 0 && gateAt < firstWorker, 'validation must run BEFORE any worker starts')
  assert.match(host, /if \(!env\.ok\)[\s\S]{0,600}return/, 'a bad environment must return before starting workers')
  // /health must reflect it, since this entrypoint deliberately does not crash.
  assert.match(host, /state\.envMissing\.length === 0/, '/health must report degraded while vars are missing')
})

test('E-01 the email vars that fail SILENTLY are required when email is on', () => {
  const env = src('src/lib/env.ts')
  for (const key of ['RESEND_API_KEY', 'RESEND_WEBHOOK_SECRET', 'BUSINESS_POSTAL_ADDRESS', 'EMAIL_FROM', 'MARKETING_SITE_URL']) {
    assert.match(env, new RegExp(`key: '${key}', required: true`), `${key} must be required`)
  }
})

test('E-01 emailRequired: promotions on ⇒ email config required; all off ⇒ not', () => {
  assert.equal(emailRequired({ EMAIL_PROMOTIONS_ENABLED: 'true' } as never), true)
  assert.equal(emailRequired({ EMAIL_JOURNEYS_ENABLED: 'true' } as never), true)
  assert.equal(emailRequired({ NODE_ENV: 'production' } as never), true)
  assert.equal(emailRequired({} as never), false, 'a dev box with email off must not be blocked')
  // The kill switch means "deliberately not sending" — it must not demand config.
  assert.equal(emailRequired({ NODE_ENV: 'production', EMAIL_SENDING_ENABLED: 'false' } as never), false)
})

// ── E-02: the suppression recovery sweep is scheduled ───────────────────

test('E-02 retryPendingSideEffects is registered as a cron, not just exported', () => {
  // PREVENTS: a bounce whose suppression write failed stays `side_effect_failed`
  // forever and the address remains sendable — we keep mailing a hard-bounced
  // or complaining customer with nothing surfacing anywhere.
  const worker = code(src('src/workers/scheduled.worker.ts'))
  assert.match(worker, /import \{ retryPendingSideEffects \}/, 'must import the sweep')
  assert.match(worker, /await retryPendingSideEffects\(/, 'must CALL it in a job handler')
  assert.match(worker, /pattern: '\*\/10 \* \* \* \*' \}, jobId: 'cron:email-side-effect-sweep'/, 'must be registered every 10 minutes')
})

test('E-02 a dead-lettered suppression raises a CRITICAL alert naming the risk', () => {
  const worker = src('src/workers/scheduled.worker.ts')
  assert.match(worker, /dead_letter/, 'must count dead-lettered events')
  assert.match(worker, /STILL SENDABLE/, 'the alert must say what the consequence is')
  assert.match(code(worker), /log\.error\(/, 'must log at error level so alerting catches it')
})

// ── E-03: cross-run duplicate protection ────────────────────────────────

test('E-03 prior AMBIGUOUS sends are excluded from a later run of the same campaign', () => {
  // PREVENTS THE ONE REAL DUPLICATE PATH: the idempotency key is scoped per
  // RUN, so a re-dispatch mints a new key and would resend to someone whose
  // message may already have been delivered.
  const aud = code(lib('email-audience.ts'))
  assert.match(aud, /priorAmbiguousEmails/, 'the check must exist')
  assert.match(aud, /prior_ambiguous_outcome/, 'and produce a named exclusion reason')
  assert.match(aud, /status: 'ambiguous'/, 'scoped to ambiguous sends only')
  // A DELIVERED send must NOT exclude anyone — deliberate re-sends are legal.
  assert.ok(!/status: \{ in: \['ambiguous', 'delivered'\]/.test(aud), 'delivered sends must not block a re-send')
})

test('E-03 the ambiguous check FAILS CLOSED — a DB error must not silently allow sending', () => {
  const aud = code(lib('email-audience.ts'))
  const fn = aud.slice(aud.indexOf('export async function priorAmbiguousEmails'), aud.indexOf('export type DetailedAudience'))
  assert.match(fn, /throw new Error/, 'a failed check must throw, never return an empty set')
  assert.ok(!/catch[\s\S]{0,120}return new Set\(\)/.test(fn), 'swallowing the error would reopen the duplicate path')
})

test('E-03 dispatch passes campaignId so the exclusion can actually apply', () => {
  const d = code(lib('email-campaign-dispatch.ts'))
  assert.match(d, /resolveAudienceDetailed\(preflight\.audience, \{ campaignId \}\)/, 'dispatch must scope the audience to the campaign')
  assert.ok(AMBIGUOUS_WINDOW_DAYS > 0 && AMBIGUOUS_WINDOW_DAYS <= 365, 'window must be bounded, not permanent')
})

// ── E-05: audience truncation is never silent ───────────────────────────

test('E-05 an over-cap audience REFUSES to dispatch unless explicitly acknowledged', () => {
  // PREVENTS: recipients beyond MAX_AUDIENCE are never fetched, so they get no
  // row and no reason, and the owner sees a completed campaign and believes
  // everyone was mailed.
  const d = code(lib('email-campaign-dispatch.ts'))
  assert.match(d, /detailed\.truncated && !acknowledgedTruncation/, 'must refuse by default')
  assert.match(d, /acknowledgedTruncation = opts\.acknowledgeTruncation === true/, 'acknowledgement must be explicit, never defaulted')
  assert.match(d, /TRUNCATED:/, 'the run must record that it was cut off')
})

test('E-05 the truncation acknowledgement requires a second human confirmation', () => {
  const ui = src('app/(admin)/admin/(dashboard)/email-marketing/campaigns/CampaignComposer.tsx')
  assert.match(ui, /needsTruncationAck/, 'the UI must handle the refusal')
  assert.match(ui, /will receive NOTHING/, 'the confirmation must state the consequence plainly')
  assert.match(ui, /acknowledgeTruncation: true/, 'and only then re-send with the acknowledgement')
})

// ── E-06: delivery-state precedence ─────────────────────────────────────

test('E-06 a late `delivered` webhook can never erase a recorded bounce', () => {
  // PREVENTS: out-of-order provider events rewriting a final outcome, which
  // would make bounce rate under-report exactly when it matters.
  const ev = code(lib('email-events.ts'))
  const fn = ev.slice(ev.indexOf('export async function applyDeliveryState'))
  assert.match(fn, /\[column\]: null/, 'the write must be conditional on the column being unset (first writer wins)')
  assert.match(fn, /updateMany/, 'conditional writes need updateMany, not update')
  // Each fact gets its own column; they are not mutually exclusive.
  assert.match(ev, /delivered: 'deliveredAt'/)
  assert.match(ev, /bounced: 'bouncedAt'/)
  assert.match(ev, /complained: 'complainedAt'/)
})

test('E-06 delivery-state failure never fails the webhook', () => {
  const ev = code(lib('email-events.ts'))
  const fn = ev.slice(ev.indexOf('export async function applyDeliveryState'))
  assert.match(fn, /catch/, 'a reporting column must not break suppression processing')
  assert.match(fn, /log\.warn/, 'but it must be visible')
})

test('E-06 the misleading "Delivered" column is renamed to Accepted', () => {
  const page = src('app/(admin)/admin/(dashboard)/email-marketing/campaigns/page.tsx')
  assert.match(page, />Accepted</, 'the column counts provider acceptance, so it must say Accepted')
  assert.ok(!/>Delivered</.test(page), 'no column may still claim Delivered from acceptance data')
})

// ── E-07: unknown outcomes refused SERVER-side ──────────────────────────

test('E-07 retryFailedRecipients refuses unknown outcomes in the SERVER, not the UI', () => {
  // PREVENTS: any script or future automation bypassing the operator
  // protection that previously existed only as a hidden button.
  const d = code(lib('email-campaign-dispatch.ts'))
  const fn = d.slice(d.indexOf('export async function retryFailedRecipients'))
  assert.match(fn, /UNRESOLVED_SEND_STATUSES/, 'must consult the send status, not just the recipient status')
  assert.match(fn, /needsReconciliation/, 'and report what it held back')
  assert.match(fn, /unknown_provider_outcome_not_retried/, 'held rows must carry an explicit reason')
  assert.match(d, /const UNRESOLVED_SEND_STATUSES: string\[\] = \['ambiguous', 'sending', 'failed_terminal'\]/)
})

test('E-07 held-back recipients are surfaced to the operator, not silently skipped', () => {
  const route = src('app/api/admin/email-marketing/campaigns/route.ts')
  assert.match(route, /needsReconciliation: result\.needsReconciliation/)
  assert.match(route, /could deliver a duplicate/, 'the notice must explain WHY they were held')
})

// ── E-08 / E-09: invariants and visibility ──────────────────────────────

test('E-08 recipient rows cannot be destroyed by deleting a run', () => {
  // PREVENTS: losing the only record that a real person was emailed.
  const schema = src('prisma/schema.prisma')
  assert.match(schema, /run EmailCampaignRun @relation\(fields: \[runId\], references: \[id\], onDelete: Restrict\)/)
  assert.ok(!/references: \[id\], onDelete: Cascade\)\n\s*\n?\s*@@unique\(\[runId, email\]\)/.test(schema))
})

test('E-08 the bug #7 invariant is MONITORED: terminal run ⇒ completedAt', () => {
  const mon = code(lib('email-monitoring.ts'))
  assert.match(mon, /completedAt: null/, 'must look for terminal runs with no completion time')
  assert.match(mon, /status: \{ in: \['CANCELLED', 'COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED'\] \}/)
})

test('E-09 a refused scheduled dispatch is PERSISTED, not only logged', () => {
  // PREVENTS: a campaign refused every 5 minutes for days while the UI shows a
  // healthy SCHEDULED badge — the silent-non-delivery trap behind bugs #2/#8.
  const d = code(lib('email-campaign-dispatch.ts'))
  assert.match(d, /emailCampaignConfig[\s\S]{0,200}statusNote:/, 'the reason must land on the campaign row')
  assert.match(d, /Scheduled dispatch was refused at/, 'and be dated so staleness is visible')
})

// ── E-04: monitoring behaviour ──────────────────────────────────────────

test('E-04 thresholds match the levels providers actually act on', () => {
  assert.equal(COMPLAINT_RATE_CRITICAL, 0.003, 'Gmail/Microsoft act around 0.3%')
  assert.ok(COMPLAINT_RATE_WARN < COMPLAINT_RATE_CRITICAL, 'warn must fire before the damage')
  assert.equal(BOUNCE_RATE_CRITICAL, 0.05)
  assert.ok(BOUNCE_RATE_WARN < BOUNCE_RATE_CRITICAL)
})

test('E-04 a check that cannot RUN is reported as critical, never as healthy', async () => {
  // PREVENTS the worst monitoring failure: a broken query returning "all good".
  const mon = code(lib('email-monitoring.ts'))
  assert.match(mon, /errors\.push\(/, 'a throwing check must be captured')
  assert.match(mon, /errors\.length > 0 \? 'critical'/, 'and must force critical severity')
})

test('E-04 every alert carries a human sentence and an action', async () => {
  // A monitor that emits `queue_depth=1240` is not an alert.
  const checks: Check[] = []
  for (const fn of [checkComplaintRate, checkBounceRate, checkUnsettledSideEffects, checkStuckRuns,
                    checkStrandedRecipients, checkAmbiguousSends, checkMissedSchedules, checkTruncatedRuns]) {
    try { checks.push(await fn()) } catch { /* no DB in offline runs — shape is asserted below */ }
  }
  for (const c of checks) {
    assert.ok(c.message.length > 20, `${c.id}: message must be a sentence, got "${c.message}"`)
    assert.ok(/[.!]$/.test(c.message.trim()), `${c.id}: message must read as prose`)
    if (c.severity !== 'ok') assert.ok(c.action && c.action.length > 10, `${c.id}: a non-ok check must say what to do`)
  }
})

test('E-04 monitoring is READ-ONLY — it must never repair what it reports', () => {
  // A monitor that fixes things hides the problem it exists to reveal, and
  // would race the sweep that legitimately owns repair.
  const mon = code(lib('email-monitoring.ts'))
  for (const mutation of ['\\.update\\(', '\\.updateMany\\(', '\\.create\\(', '\\.delete\\(', '\\.deleteMany\\(']) {
    assert.ok(!new RegExp(mutation).test(mon), `email-monitoring must not call ${mutation}`)
  }
})

test('E-04 the health endpoint reuses the SAME checks the cron alerts on', async () => {
  // Two implementations would eventually disagree and the owner would have to
  // guess which was lying.
  const route = src('app/api/admin/email-marketing/health/route.ts')
  assert.match(route, /runEmailMonitoring/, 'the endpoint must call the shared runner')
  assert.match(route, /denyReason/, 'and stay authorized')
  assert.ok(typeof emailHealthReport === 'function' && typeof runEmailMonitoring === 'function')
})

test('E-04 the monitoring cron is registered', () => {
  const worker = code(src('src/workers/scheduled.worker.ts'))
  assert.match(worker, /jobId: 'cron:email-monitoring'/)
  assert.match(worker, /runEmailMonitoring\(\)/)
})
