import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { scanEnvOwnership } from '../env-ownership-scan'

// ════════════════════════════════════════════════════════════════════════
//  ENVIRONMENT OWNERSHIP — the API and the worker are SEPARATE Railway
//  services with SEPARATE variable sets (incident 2026-09-14: the campaign
//  drafter's flag existed on the API and was missing on the worker that runs
//  it, so the feature silently never ran while the admin said ACTIVE).
//
//  docs/env-ownership.json declares, for every variable the code reads, which
//  service reads it. This suite recomputes that from the import graph and fails
//  when the two disagree — so a new variable read, or a variable that starts
//  being read by the worker, cannot ship without the manifest (and therefore
//  the deploy checklist) saying so.
// ════════════════════════════════════════════════════════════════════════

const ROOT = resolve(__dirname, '../../..')
type Entry = { readBy: Array<'api' | 'worker' | 'none'>; secret: boolean; mustMatch?: boolean; note?: string }
const manifest = JSON.parse(readFileSync(resolve(ROOT, 'docs/env-ownership.json'), 'utf8')) as {
  version: number
  vars: Record<string, Entry>
}
const scan = scanEnvOwnership(ROOT)

test('the scan found both entrypoints (a broken graph must not pass vacuously)', () => {
  assert.ok(scan.workerModules > 50, `worker graph too small (${scan.workerModules}) — src/worker-host.ts imports not resolved?`)
  assert.ok(scan.apiModules > 100, `api graph too small (${scan.apiModules})`)
  assert.ok(scan.readers.size > 50, 'too few environment reads found — the scan is broken')
})

test('every variable the code reads is declared in docs/env-ownership.json', () => {
  const missing = [...scan.readers.keys()].filter((n) => !manifest.vars[n]).sort()
  assert.deepEqual(missing, [], `undeclared environment variables — add them to docs/env-ownership.json: ${missing.join(', ')}`)
})

test('no declared variable is stale (read nowhere any more)', () => {
  const stale = Object.keys(manifest.vars).filter((n) => !scan.readers.has(n)).sort()
  assert.deepEqual(stale, [], `docs/env-ownership.json lists variables no code reads: ${stale.join(', ')}`)
})

test('the declared readers match the import graph for every variable', () => {
  const wrong: string[] = []
  for (const [name, r] of scan.readers) {
    const e = manifest.vars[name]
    if (!e) continue
    const computed = [...(r.api ? ['api'] : []), ...(r.worker ? ['worker'] : [])]
    const expected = computed.length ? computed : ['none']
    if (JSON.stringify([...e.readBy].sort()) !== JSON.stringify(expected.sort())) {
      wrong.push(`${name}: manifest ${JSON.stringify(e.readBy)} vs code ${JSON.stringify(expected)}`)
    }
  }
  assert.deepEqual(wrong, [], `regenerate or correct docs/env-ownership.json:\n${wrong.join('\n')}`)
})

test('the incident variable is declared as read by BOTH services and must match', () => {
  const e = manifest.vars.EMAIL_MARKETING_AGENT_ENABLED
  assert.ok(e, 'EMAIL_MARKETING_AGENT_ENABLED must be declared')
  assert.ok(e.readBy.includes('worker'), 'the discovery sweep runs on the worker')
  assert.ok(e.readBy.includes('api'), 'the admin card reads it on the API')
  assert.equal(e.mustMatch, true, 'API and worker must carry the same value')
})

test('every value that must be identical on both services is read by both', () => {
  for (const [name, e] of Object.entries(manifest.vars)) {
    if (!e.mustMatch) continue
    assert.ok(e.readBy.includes('api') && e.readBy.includes('worker'), `${name} is mustMatch but is not read by both services`)
  }
})

test('the manifest carries names and flags only — never a value', () => {
  const raw = readFileSync(resolve(ROOT, 'docs/env-ownership.json'), 'utf8')
  assert.ok(!/re_[A-Za-z0-9]{8,}|sk_(live|test)_|whsec_|postgres(ql)?:\/\/|redis:\/\//.test(raw), 'a secret-shaped value leaked into the manifest')
  for (const e of Object.values(manifest.vars)) {
    assert.deepEqual(Object.keys(e).filter((k) => !['readBy', 'secret', 'mustMatch', 'note'].includes(k)), [])
  }
})

test('SMS is gone: no Twilio variable is read anywhere', () => {
  const twilio = [...scan.readers.keys()].filter((n) => n.startsWith('TWILIO'))
  assert.deepEqual(twilio, [], 'Move It Clear It no longer sends SMS (owner, 2026-09-15)')
})
