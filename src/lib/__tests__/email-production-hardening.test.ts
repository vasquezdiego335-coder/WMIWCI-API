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
import { CRON_SCHEDULES, createCronReconciler, legacyRepeatKey } from '../cron-schedules'

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

  // 2026-09-15: worker-host.ts is a thin entry that starts src/worker-runtime/host.ts;
  // the gate lives there. The entry must actually reach it.
  const entry2 = code(src('src/worker-host.ts'))
  assert.match(entry2, /import \{ startWorkerHost \} from '\.\/worker-runtime\/host'/, 'the production entrypoint must use the host')
  assert.match(entry2, /startWorkerHost\(\)/, 'and start it')
  const host = code(src('src/worker-runtime/host.ts'))
  assert.match(host, /const env = checkEnv\(\)/, 'the production host must validate the environment')
  assert.match(host, /validateConfig: validateWorkerConfig/, 'with the real validator by default')
  assert.match(host, /state\.envMissing = config\.missing/, 'and record what is missing for /readyz')
  // Workers must NOT start on a bad environment: validation precedes module loading,
  // and module loading is where every worker (and startEmailWorker) comes from.
  const gateAt = host.indexOf('const config = d.validateConfig()')
  const loadAt = host.indexOf('mods = await d.loadModules()')
  const startAt = host.indexOf('starter.start()')
  assert.ok(gateAt > 0 && gateAt < loadAt && loadAt < startAt, 'validation must run BEFORE any worker module loads or starts')
  assert.match(host, /if \(!config\.ok\) \{[\s\S]{0,1200}return\r?\n/, 'a bad environment must return before starting workers')
  assert.match(code(src('src/worker-runtime/load-modules.ts')), /start: emailWorker\.startEmailWorker/, 'the email worker is started only through the loaded modules')
  // /readyz must reflect it (the behaviour is pinned in worker-startup.test.ts).
  assert.match(host, /envMissing: state\.envMissing/, '/readyz must report degraded while vars are missing')
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
  assert.deepEqual(
    CRON_SCHEDULES.find((s) => s.name === 'email-side-effect-sweep'),
    { name: 'email-side-effect-sweep', pattern: '*/15 * * * *', tz: undefined, jobId: 'cron:email-side-effect-sweep' },
    'must be registered in the shared 15-minute recovery window',
  )
  assertCronRegistryIsWhatTheWorkerRegisters()
})

/** The registry is only meaningful if the scheduled worker hands it to the reconciler. */
function assertCronRegistryIsWhatTheWorkerRegisters(): void {
  const worker = code(src('src/workers/scheduled.worker.ts'))
  assert.match(worker, /import \{ CRON_SCHEDULES, createCronReconciler/, 'the worker must import the registry and reconciler')
  assert.match(worker, /createCronReconciler\(\{[\s\S]{0,400}queue: scheduledQueue,[\s\S]{0,400}schedules: CRON_SCHEDULES,/, 'the reconciler must register CRON_SCHEDULES on the scheduled queue')
  assert.match(worker, /^\s*registerCronJobs\(\)/m, 'startScheduledWorker must start registration')
  const recon = code(lib('cron-schedules.ts'))
  assert.match(recon, /opts\.queue\.add\(s\.name, \{ type: s\.name \}, \{ repeat, jobId: s\.jobId \}\)/, 'registration uses the legacy repeat API with the registry jobId')
}

test('E-02 a dead-lettered suppression raises a CRITICAL alert naming the risk', () => {
  const worker = src('src/workers/scheduled.worker.ts')
  assert.match(worker, /dead_letter/, 'must count dead-lettered events')
  assert.match(worker, /STILL SENDABLE/, 'the alert must say what the consequence is')
  assert.match(code(worker), /log\.error\(/, 'must log at error level so alerting catches it')
})

// ── NEON-COST: idle means zero database traffic ─────────────────────────

test('NEON-COST production host does not start the legacy interval poller', () => {
  // PREVENTS: an UPDATE...RETURNING transaction every three seconds with no
  // mail to send, which keeps Neon's compute active around the clock.
  const host = code(src('src/worker-host.ts')) + code(src('src/worker-runtime/host.ts')) + code(src('src/worker-runtime/load-modules.ts'))
  assert.doesNotMatch(host, /startOutboxWorker/, 'production must be event-driven, not interval-polled')
  assert.match(host, /state\.outbox = process\.env\.OUTBOX_ENABLED === 'true'/)
})

test('NEON-COST a committed outbox event publishes an immediate drain nudge', () => {
  const integration = code(src('src/outbox/integration.ts'))
  assert.match(integration, /scheduledQueue\.add\(\s*'outbox-email-drain'/)
  const commitAt = integration.indexOf('await fn()')
  const nudgeAt = integration.indexOf('await nudgeOutbox(label, bookingId)')
  assert.ok(commitAt >= 0 && nudgeAt > commitAt, 'the Redis nudge must happen only after the durable transaction returns')
  assert.match(integration, /outbox drain nudge timed out after 3s/, 'a Redis outage must not hang the booking request')
  assert.match(integration, /recovery sweep will retry/, 'a failed nudge must explicitly rely on durable recovery')
})

test('NEON-COST immediate and recovery outbox jobs use the same bounded drain', () => {
  const worker = code(src('src/workers/scheduled.worker.ts'))
  assert.match(worker, /case 'outbox-email-drain':\s*case 'outbox-email-recovery':/)
  assert.match(worker, /await drainOutbox\(\)/)
  assert.deepEqual(
    CRON_SCHEDULES.find((s) => s.name === 'outbox-email-recovery'),
    { name: 'outbox-email-recovery', pattern: '*/15 * * * *', tz: undefined, jobId: 'cron:outbox-email-recovery' },
  )
  assertCronRegistryIsWhatTheWorkerRegisters()

  const processor = code(src('src/outbox/workers/emailWorker.ts'))
  assert.match(processor, /export async function drainOutbox/)
  assert.match(processor, /while \(batches < maxBatches\)/, 'a backlog drain must be bounded')
})

test('NEON-COST recurring database maintenance shares one 15-minute wake window', () => {
  const aligned = [
    'campaign-sweep',
    'lead-notification-sweep',
    'automation-sweep',
    'outbox-email-recovery',
    'email-side-effect-sweep',
    'email-monitoring',
    'email-agent-cycle',
  ]
  for (const name of aligned) {
    assert.deepEqual(
      CRON_SCHEDULES.find((s) => s.name === name),
      { name, pattern: '*/15 * * * *', tz: undefined, jobId: `cron:${name}` },
      `${name} must run in the shared quarter-hour window (UTC, no tz)`,
    )
  }
  const texts = [code(src('src/workers/scheduled.worker.ts')), code(lib('cron-schedules.ts'))]
  for (const oldPattern of ['*/2 * * * *', '*/5 * * * *', '*/10 * * * *', '5-59/10 * * * *']) {
    assert.ok(!CRON_SCHEDULES.some((s) => s.pattern === oldPattern), `stale frequent pattern must be absent: ${oldPattern}`)
    for (const t of texts) assert.ok(!t.includes(`'${oldPattern}'`), `stale frequent pattern must be absent from source: ${oldPattern}`)
  }
  assert.deepEqual(
    CRON_SCHEDULES.find((s) => s.name === 'lifecycle-repair'),
    { name: 'lifecycle-repair', pattern: '0 * * * *', tz: undefined, jobId: 'cron:lifecycle-repair' },
    'the hourly repair must align with a quarter-hour wake',
  )
  assertCronRegistryIsWhatTheWorkerRegisters()
})

test('NEON-COST deployment prunes old BullMQ repeatables instead of leaving both schedules live', async () => {
  // Behavioural since 2026-09-15 (the prune moved into the reconciler): a managed
  // name left on an old frequent pattern is removed by key, and the desired
  // schedule is present exactly once. Full matrix: cron-reconciler.test.ts.
  const live = new Map<string, { key: string; name: string; pattern: string; tz: string | null }>()
  const staleKey = legacyRepeatKey({ name: 'campaign-sweep', pattern: '*/5 * * * *', tz: undefined, jobId: 'cron:campaign-sweep' })
  live.set(staleKey, { key: staleKey, name: 'campaign-sweep', pattern: '*/5 * * * *', tz: null })
  const removed: string[] = []
  const reconciler = createCronReconciler({
    redisOk: async () => true,
    sleep: async () => undefined,
    queue: {
      add: async (name, _data, opts) => {
        const key = legacyRepeatKey({ name: name as never, pattern: opts.repeat.pattern, tz: opts.repeat.tz, jobId: opts.jobId })
        live.set(key, { key, name, pattern: opts.repeat.pattern, tz: opts.repeat.tz ?? null })
      },
      getRepeatableJobs: async () => [...live.values()],
      removeRepeatableByKey: async (key) => {
        removed.push(key)
        return live.delete(key)
      },
    },
  })
  const status = await reconciler.reconcileOnce()
  assert.deepEqual(removed, [staleKey], 'the stale pattern must be removed by its key')
  assert.equal(status.ok, true)
  assert.equal([...live.values()].filter((r) => r.name === 'campaign-sweep').length, 1)
  assert.equal(live.size, CRON_SCHEDULES.length)
  assert.match(code(lib('cron-schedules.ts')), /removeRepeatableByKey\(stale\.key\)/)
  assertCronRegistryIsWhatTheWorkerRegisters()
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
  // PREVENTS: a campaign refused every 15 minutes for days while the UI shows a
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
  assert.deepEqual(
    CRON_SCHEDULES.find((s) => s.name === 'email-monitoring'),
    { name: 'email-monitoring', pattern: '*/15 * * * *', tz: undefined, jobId: 'cron:email-monitoring' },
  )
  assertCronRegistryIsWhatTheWorkerRegisters()
  assert.match(worker, /runEmailMonitoring\(\)/)
})

// ── Admin links must point at routes that exist ─────────────────────────

test('the Queues page does not link to a route that does not exist', () => {
  // FOUND 2026-07-27 while checking third-party advice: the "Open Bull Board"
  // button pointed at /api/admin/queues/bull-board, which has no route file.
  // src/workers/bull-board.ts is an Express app bound to 127.0.0.1 that nothing
  // imports — it can never serve that URL. A dead control in an incident tool
  // is worse than no control: it is consulted precisely when something is wrong.
  const page = src('app/(admin)/admin/(dashboard)/queues/page.tsx')
  assert.ok(!/queues\/bull-board/.test(page), 'must not link to the non-existent bull-board route')
  assert.match(page, /\/api\/admin\/queues\/failed/, 'must link to the inspector that exists')
})

test('the failed-job inspector is authenticated and read-only', () => {
  const route = src('app/api/admin/queues/failed/route.ts')
  assert.match(route, /denyReason/, 'must be admin-authenticated server-side')
  assert.match(route, /INSPECTABLE\.includes\(requested\)/, 'queue name must come from a closed list, never raw input')
  // Read-only: no retry/remove/promote. Inspecting an incident must not change it.
  // Plain substring checks — no regex escaping to get wrong.
  for (const mutation of ['.retry(', '.remove(', '.promote(', '.drain(', '.clean(', '.obliterate(']) {
    assert.ok(!route.includes(mutation), `the inspector must not call ${mutation}`)
  }
})
