// EMAIL REGISTRY CONFORMANCE (owner spec 2026-07-21).
//
// The registry is what the admin renders. If it drifts from the code, the owner
// is reading fiction — a template quietly added to the worker would appear
// nowhere, and one removed would still be advertised as live.
//
// These tests assert the registry against the CODE, not against prose. Where a
// constant is not exported (the worker's ALLOWED_TEMPLATES lives inside a file
// that constructs a BullMQ Worker on import, so it cannot be imported here),
// the source is read as text — the same static technique as
// send-path-conformance.test.ts, and for the same reason.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { templateRegistry, journeyRegistry, templateByKey, formatDelay } from '../email-registry'
import { classifyTemplate } from '../email-guard'
import { ABANDONED_STAGES, QUOTE_STAGES, REMINDER_OFFSETS } from '../journeys'
import { canClaimConversions } from '../email-attribution'

const SRC = join(__dirname, '..', '..')
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8')

/** Template keys the BullMQ worker will actually dispatch. */
function workerAllowedTemplates(): string[] {
  const src = read('workers/email.worker.ts')
  const block = src.match(/const ALLOWED_TEMPLATES = new Set<[^>]*>\(\[([\s\S]*?)\]\)/)
  assert.ok(block, 'could not find ALLOWED_TEMPLATES in email.worker.ts — has it been renamed?')
  return Array.from(block[1].matchAll(/'([^']+)'/g)).map((m) => m[1])
}

test('every template the worker can dispatch is in the registry', () => {
  const registered = new Set(templateRegistry().map((t) => t.key))
  const missing = workerAllowedTemplates().filter((k) => !registered.has(k))
  assert.deepEqual(
    missing,
    [],
    `these templates can be sent but are invisible in the admin: ${missing.join(', ')}. Add a registry entry in src/lib/email-registry.ts.`
  )
})

test('the registry does not advertise a template the system cannot send', () => {
  // Templates reached outside the BullMQ worker are legitimate, but each one
  // must be traceable to a real sender. These are the known non-worker paths.
  const nonWorker = new Set([
    'lead-acknowledgement', // src/lib/notify.ts (guarded customer sender)
    'review-reminder', // src/lib/followups.ts
    'repeat-reminder', // src/lib/followups.ts
  ])
  const allowed = new Set(workerAllowedTemplates())
  const orphans = templateRegistry()
    .map((t) => t.key)
    .filter((k) => !allowed.has(k) && !nonWorker.has(k))
  assert.deepEqual(orphans, [], `registered but unreachable: ${orphans.join(', ')}`)
})

test('the non-worker templates really are sent by the files claimed', () => {
  const followups = read('lib/followups.ts')
  assert.ok(followups.includes("'review-reminder'"), 'followups.ts no longer sends review-reminder')
  assert.ok(followups.includes("'repeat-reminder'"), 'followups.ts no longer sends repeat-reminder')
  const notify = read('lib/notify.ts')
  assert.ok(notify.includes("'lead-acknowledgement'"), 'notify.ts no longer sends lead-acknowledgement')
})

test('transactional/promotional classification is never restated by hand', () => {
  // The registry must DERIVE the class from the guard. If someone hard-codes a
  // different answer, the legal + deliverability boundary has two sources.
  for (const t of templateRegistry()) {
    assert.equal(t.emailClass, classifyTemplate(t.key), `${t.key} disagrees with email-guard.classifyTemplate`)
  }
})

test('every promotional template names at least one stop rule', () => {
  for (const t of templateRegistry()) {
    if (t.emailClass !== 'promotional') continue
    assert.ok(t.stopRules.length > 0, `${t.key} is promotional but declares no stop rules`)
  }
})

test('every template component file exists', () => {
  for (const t of templateRegistry()) {
    // The lead acknowledgement is built inline rather than as a component.
    if (t.file.includes('(inline)')) continue
    assert.ok(existsSync(join(SRC, t.file)), `${t.key} points at a missing file: ${t.file}`)
  }
})

test('registry keys are unique', () => {
  const keys = templateRegistry().map((t) => t.key)
  assert.equal(new Set(keys).size, keys.length, 'duplicate template key in the registry')
})

test('archived templates are NOT presented as active', () => {
  // email-archive/ holds legacy React templates no send path can reach. A file
  // existing is not a feature; listing one here would tell the owner an email
  // is live when nothing can send it.
  for (const t of templateRegistry()) {
    assert.ok(!t.file.includes('email-archive'), `${t.key} points into email-archive/`)
  }
})

// ── Journeys ────────────────────────────────────────────────────────────

test('journey stage timings come from the scheduling code, not from prose', () => {
  const j = journeyRegistry()

  const abandoned = j.find((x) => x.key === 'abandoned')!
  assert.deepEqual(
    abandoned.stages.map((s) => s.delayMs),
    ABANDONED_STAGES.map((s) => s.delay),
    'the abandoned-recovery timeline shown in the admin does not match journeys.ABANDONED_STAGES'
  )

  const quote = j.find((x) => x.key === 'quote')!
  assert.deepEqual(
    quote.stages.map((s) => s.delayMs),
    QUOTE_STAGES.map((s) => s.delay),
    'the quote follow-up timeline does not match journeys.QUOTE_STAGES'
  )

  const preMove = j.find((x) => x.key === 'pre-move')!
  assert.deepEqual(
    preMove.stages.map((s) => s.delayMs),
    REMINDER_OFFSETS.map((r) => -r.before),
    'the pre-move reminder timeline does not match journeys.REMINDER_OFFSETS'
  )
})

test('every journey stage renders a registered template', () => {
  for (const j of journeyRegistry()) {
    for (const s of j.stages) {
      assert.ok(templateByKey(s.template), `journey ${j.key} stage ${s.type} renders unregistered template ${s.template}`)
    }
  }
})

test('every journey declares stop rules', () => {
  for (const j of journeyRegistry()) {
    assert.ok(j.stopRules.length > 0, `journey ${j.key} has no stop rules — nothing would ever stop it`)
  }
})

test('a journey that can send promotional mail is flag-gated', () => {
  // Turning the marketing engine on must stay a deliberate act.
  for (const j of journeyRegistry()) {
    if (j.emailClass !== 'promotional') continue
    assert.ok(j.flag, `promotional journey ${j.key} has no feature flag — it would run the moment it is deployed`)
  }
})

// ── Attribution honesty (rule 1) ────────────────────────────────────────

test('transactional journeys can NEVER be credited with causing a booking', () => {
  for (const j of journeyRegistry()) {
    if (j.emailClass !== 'transactional') continue
    assert.equal(
      canClaimConversions(j.key),
      false,
      `${j.key} is transactional but is allowed to claim conversions — a receipt is sent BECAUSE a booking happened`
    )
  }
})

test('the converting journeys are exactly the ones with a conversion model', () => {
  const claiming = journeyRegistry().filter((j) => canClaimConversions(j.key)).map((j) => j.key).sort()
  assert.deepEqual(claiming, ['abandoned', 'post-job', 'quote'])
})

// ── Formatting ──────────────────────────────────────────────────────────

test('delay formatting reads correctly in both directions', () => {
  assert.equal(formatDelay(0), 'Immediately')
  assert.equal(formatDelay(45 * 60_000), '45 min')
  assert.equal(formatDelay(24 * 3_600_000), '24 hours')
  // A follow-up 3 days after its anchor reads in days...
  assert.equal(formatDelay(3 * 24 * 3_600_000), '3 days')
  // ...but the SAME interval counting down to a move is "the 72h reminder".
  assert.equal(formatDelay(-3 * 24 * 3_600_000), '72 hours before')
  // Negative = BEFORE the anchor (the move date), which is how reminders work.
  assert.equal(formatDelay(-72 * 3_600_000), '72 hours before')
  assert.equal(formatDelay(-24 * 3_600_000), '24 hours before')
  // Units pluralise. A stage at exactly one day used to render as "1 days".
  assert.equal(formatDelay(1 * 3_600_000), '1 hour')
  assert.equal(formatDelay(30 * 24 * 3_600_000), '30 days')
  assert.equal(/\b1 days\b/.test(formatDelay(72 * 3_600_000)), false)
})

test('no registry text carries the retired slogan', () => {
  const blob = JSON.stringify(templateRegistry()) + JSON.stringify(journeyRegistry())
  assert.equal(/we move it\.?\s*we clear it/i.test(blob), false, 'the retired slogan is back in the registry')
})
