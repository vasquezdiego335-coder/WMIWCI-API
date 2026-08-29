// ════════════════════════════════════════════════════════════════════════
//  queue-contract.test.ts — every job PUBLISHED must be a job the worker
//  DISPATCHES.
//
//  THE PRODUCTION DEFECT THIS EXISTS TO CATCH, found by watching real worker
//  logs after a deploy rather than by any test:
//
//      publisher:  discordQueue.add('lead-notify', { dedupeKey }, ...)
//      worker:     const { type } = job.data;  switch (type) { case 'lead-notify': ...
//
//  BullMQ has two different things called a name. `add(name, data)` sets the
//  job's NAME; the worker switched on `data.type`, which the publisher never
//  set. So `type` was `undefined`, every lead notice fell through to
//  "Unknown discord job type", and the worker marked it COMPLETED.
//
//  The notice was never delivered and nothing failed. The durable outbox row
//  survived — which is the only reason this was recoverable — but the owner was
//  not told about the lead, which is the exact outcome the outbox was built to
//  prevent.
//
//  WHY THE EXISTING TESTS MISSED IT. They drive `processLeadNotification`
//  directly, which is correct for testing retry behaviour and proves the worker
//  and the tests share one implementation. But calling the handler directly
//  steps OVER the dispatch, and the dispatch was the broken part. A test that
//  starts after the switch statement cannot see a switch statement that never
//  matches.
//
//  So this asserts the SEAM: for every `discordQueue.add(...)` in shipped code,
//  the data literal carries a `type`, and that `type` is one the worker handles.
//  It is a source-level check on purpose — it needs no Redis, so it runs
//  everywhere, including where a queue is unavailable.
// ════════════════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const API_ROOT = resolve(__dirname, '../../..')
const NEWLINE = String.fromCharCode(10)

/** Shipped source only — a test may publish a deliberately malformed job. */
function shipped(): string[] {
  return execFileSync('git', ['ls-files', '--', 'src', 'app'], { cwd: API_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((f) => f && /\.tsx?$/.test(f) && !f.includes('__tests__'))
}

/** Comments blanked length-preservingly so prose cannot satisfy a code rule. */
function code(rel: string): string {
  return readFileSync(resolve(API_ROOT, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))
}

/** The `case '...':` labels the discord worker actually handles. */
function workerCases(): Set<string> {
  const src = code('src/workers/discord.worker.ts')
  const body = src.slice(src.indexOf('switch (type)'))
  return new Set(Array.from(body.matchAll(/case\s+'([a-z-]+)'\s*:/g), (m) => m[1]))
}

/** Every discordQueue.add(...) in shipped code: its name and its data literal. */
function publishSites(): { file: string; name: string; data: string }[] {
  const out: { file: string; name: string; data: string }[] = []
  for (const f of shipped()) {
    const src = code(f)
    for (const m of src.matchAll(/discordQueue\.add\(\s*'([a-z-]+)'\s*,\s*(\{[\s\S]{0,400}?\})\s*[,)]/g)) {
      out.push({ file: f, name: m[1], data: m[2] })
    }
  }
  return out
}

test('the discord worker dispatches on data.type, not on the job name', () => {
  const src = code('src/workers/discord.worker.ts')
  //  If this ever changes to `job.name`, the rule below changes with it — and
  //  this assertion is what forces someone to notice.
  assert.match(src, /const\s*\{\s*type\b[^}]*\}\s*=\s*job\.data/, 'the type is read off job.data')
  assert.match(src, /switch\s*\(\s*type\s*\)/, 'and the switch is on that value')
})

test('every published discord job carries a type its worker handles', () => {
  const sites = publishSites()
  assert.ok(sites.length > 0, 'there is at least one publisher to check')

  const handled = workerCases()
  assert.ok(handled.size > 3, `expected several worker cases, found ${[...handled].join(', ')}`)

  const problems: string[] = []
  for (const s of sites) {
    const typeMatch = /\btype\s*:\s*'([a-z-]+)'/.exec(s.data)
    if (!typeMatch) {
      problems.push(
        `${s.file}: add('${s.name}', ...) has NO \`type\` in its data. BullMQ's job NAME is ` +
          `not job.data.type — the worker switches on the latter, so this job would be ` +
          `discarded as "Unknown discord job type" and marked completed.`,
      )
      continue
    }
    const t = typeMatch[1]
    if (!handled.has(t)) {
      problems.push(`${s.file}: publishes type '${t}', which the discord worker does not handle`)
    }
    if (t !== s.name) {
      problems.push(
        `${s.file}: job name '${s.name}' and data.type '${t}' disagree. They may legally ` +
          `differ, but every publisher here keeps them equal, and a mismatch is far more ` +
          `often a mistake than an intention.`,
      )
    }
  }

  assert.deepEqual(problems, [], problems.join('\n'))
})

/** The body of one `case 'x':` in the worker's switch. */
function caseBody(type: string): string {
  const src = code('src/workers/discord.worker.ts')
  const start = src.indexOf(`case '${type}':`)
  if (start === -1) return ''
  const next = src.slice(start + 1).search(/case\s+'[a-z-]+'\s*:|^\s*default\s*:/m)
  return next === -1 ? src.slice(start) : src.slice(start, start + 1 + next)
}

test('if a handler reads job.data.payload, its publishers must send a payload', () => {
  //  THE SECOND HALF OF THE SAME DEFECT, and the one that survived the first
  //  fix. The handler reads `payload.dedupeKey` — that is `job.data.payload
  //  .dedupeKey`, matching every other case in the file. The publishers put
  //  `dedupeKey` at the TOP level of job.data, so `payload` was undefined,
  //  `dedupeKey` came out '', and `if (!dedupeKey) return` completed the job in
  //  milliseconds having done nothing.
  //
  //  Adding `type` fixed the dispatch and revealed this one underneath: the job
  //  now reached the right branch and still did nothing. Both are the same
  //  mistake — publisher and consumer disagreeing about a shape that no type
  //  checks, because `job.data` is typed loosely enough to allow either.
  const problems: string[] = []

  for (const s of publishSites()) {
    const t = /\btype\s*:\s*'([a-z-]+)'/.exec(s.data)?.[1]
    if (!t) continue // covered by the test above
    const body = caseBody(t)
    if (!body) continue

    const readsPayload = /\bpayload\b/.test(body)
    const sendsPayload = /\bpayload\s*:/.test(s.data)

    if (readsPayload && !sendsPayload) {
      problems.push(
        `${s.file}: the '${t}' handler reads job.data.payload, but this publisher sends no ` +
          `\`payload\` — the handler would read undefined and do nothing.`,
      )
    }
  }

  assert.deepEqual(problems, [], problems.join(NEWLINE))
})

test('a lead-notify job with no payload.dedupeKey FAILS rather than completing', () => {
  //  The silent `return` is what hid this for two deploys: a malformed job was
  //  marked completed, so nothing retried and nothing surfaced. It must land in
  //  BullMQ's failed set instead.
  const body = caseBody('lead-notify')
  assert.ok(body, "the worker still has a 'lead-notify' case")
  assert.match(body, /throw new Error\(/, 'a missing dedupeKey throws')
  assert.ok(
    !/if\s*\(!dedupeKey\)\s*return/.test(body),
    'it must NOT return quietly — that is what made the defect invisible',
  )
})

test('lead notices are delivered INLINE, not handed to the worker queue', () => {
  //  ARCHITECTURE, pinned deliberately.
  //
  //  The capture path used to publish a `lead-notify` job. In production that
  //  job wedged the worker host: it logged "Processing discord job" and then the
  //  process stopped logging altogether — no completion, no failure, and the
  //  five-minute sweeps stopped with it. One lead notice took email, SMS and
  //  every Discord card down.
  //
  //  So delivery happens in the capture process, which is proven to work: the
  //  same two functions, pointed at the production database, claimed and
  //  delivered three stuck notices in under a second each.
  //
  //  Durability is unchanged and is the reason this is safe: the outbox row is
  //  written in the SAME TRANSACTION as the lead, so a failure here leaves the
  //  row `pending` for `sweepLeadNotifications` to re-drive. The queue was only
  //  ever a nudge.
  const leads = code('src/lib/leads.ts')

  assert.match(
    leads,
    /processLeadNotification\(\s*key\s*,\s*deliverLeadNotice\s*\)/,
    'the capture path delivers the notice itself',
  )
  assert.ok(
    !/discordQueue\.add\(\s*'lead-notify'/.test(leads),
    'the capture path must NOT publish a lead-notify job — that is what wedged the worker',
  )
  assert.match(
    leads,
    /recordLeadNotification\(leadId, 'lead_created'\)/,
    'and the durable row is still written before any delivery is attempted',
  )
})

test('the worker still HANDLES lead-notify, so anything already queued is drained', () => {
  //  The branch is dormant, not deleted: jobs published before this change may
  //  still be in Redis, and the sweeper may publish again in future. Removing
  //  the case would turn those into "Unknown discord job type" — the original
  //  defect, reintroduced from the other end.
  const worker = code('src/workers/discord.worker.ts')
  assert.match(worker, /case\s+'lead-notify'\s*:/, 'the worker keeps its handler')
  assert.match(worker, /processLeadNotification\(/, 'and still delegates to the shared processor')
})
