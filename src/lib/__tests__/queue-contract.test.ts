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

test('the lead-notify publishers specifically are well formed', () => {
  //  Named separately because this is the one that actually broke, and a
  //  regression here means the owner silently stops being told about leads.
  const sites = publishSites().filter((s) => s.name === 'lead-notify')
  assert.ok(sites.length >= 2, `expected the capture and reschedule publishers, found ${sites.length}`)
  for (const s of sites) {
    assert.match(s.data, /type\s*:\s*'lead-notify'/, `${s.file} must set type: 'lead-notify'`)
    assert.match(s.data, /dedupeKey/, `${s.file} must carry the dedupeKey`)
  }
})
