// SEND-PATH CONFORMANCE (finding EMAIL-P3-20).
//
// The documentation claimed every send path had the same safeguards while two
// of the three did not. Prose cannot be trusted to stay true, so this test
// asserts the claim directly against the SOURCE of each production sender.
//
// It is a static check, deliberately. Executing all three paths needs Postgres,
// Redis and a provider; what actually drifts is someone adding a fourth sender,
// or dropping `text`/`payload`/`recheck` from an existing call. That is visible
// in the source and is exactly what this catches.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(__dirname, '..', '..')
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8')

/** The three production senders and what each must hand to the guard. */
const SEND_PATHS: Array<{ name: string; file: string; requires: string[] }> = [
  {
    name: 'BullMQ email worker',
    file: 'workers/email.worker.ts',
    requires: ['guardedSend', 'text', 'payload', 'recheck', 'buildMarketingContext'],
  },
  {
    name: 'Outbox service',
    file: 'outbox/services/emailService.ts',
    // Transactional only, so no marketing context — but everything else applies.
    requires: ['guardedSend', 'text:', 'payload:', 'recheck:', 'classifyTemplate'],
  },
  {
    name: 'Direct post-job follow-ups',
    file: 'lib/followups.ts',
    requires: ['guardedSend', 'text:', 'payload:', 'recheck:', 'buildMarketingContext'],
  },
]

test('every production send path hands the guard the full contract', () => {
  for (const path of SEND_PATHS) {
    const src = read(path.file)
    for (const token of path.requires) {
      assert.ok(src.includes(token), `${path.name} (${path.file}) no longer passes \`${token}\``)
    }
  }
})

test('NO production code calls the provider directly — guardedSend is the only door', () => {
  // The original defect: three files each called resend.emails.send(). If a
  // fourth appears, or one of these regresses, it bypasses suppression,
  // validation, idempotency and compliance in one step.
  const offenders: string[] = []
  const walk = (dir: string, rel = '') => {
    for (const entry of readdirSync(join(SRC, dir), { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue
        walk(join(dir, entry.name), relPath)
        continue
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue
      const full = join(dir, entry.name)
      // Strip comments first. Several files legitimately DESCRIBE the old
      // direct call in a comment explaining why it was removed; matching those
      // would report a defect that no longer exists.
      const src = readFileSync(join(SRC, full), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
      if (/resend\s*\.\s*emails\s*\.\s*send\s*\(/.test(src)) {
        // SANCTIONED CALLERS:
        //  • lib/email-guard.ts  — the one customer-mail door.
        //  • lib/notify.ts       — INTERNAL owner/ops alerts to the business's
        //    own inbox (sendInternalEmail). Not customer mail; must fire even
        //    when the marketing system is off. Its CUSTOMER-facing lead
        //    acknowledgement does go through the guard — asserted below.
        const sanctioned = full.endsWith(join('lib', 'email-guard.ts')) || full.endsWith(join('lib', 'notify.ts'))
        if (!sanctioned) offenders.push(full)
      }
    }
  }
  walk('')
  assert.deepEqual(offenders, [], `provider called outside the guard in: ${offenders.join(', ')}`)
})

test('the guard itself performs each documented step', () => {
  const src = read('lib/email-guard.ts')
  for (const step of [
    'isValidEmailAddress', // 1 recipient format
    'isSuppressed', // 2 suppression, fails closed
    'input.recheck', // 3 live state reload
    'inQuietHours', // 4 quiet hours
    'countSentSince', // 4 frequency caps
    'assertEmailPayload', // 5 payload + URL validation
    'buildMarketingContext', // 5b promotional compliance
    'claimOrResumeSend', // 6 claim or resume
  ]) {
    assert.ok(src.includes(step), `email-guard no longer performs: ${step}`)
  }
})

test('the guard classifies outcomes rather than treating every refusal alike', () => {
  const src = read('lib/email-guard.ts')
  for (const s of ['blocked_terminal', 'blocked_retryable', 'deferred', 'ambiguous', 'provider_rejected']) {
    assert.ok(src.includes(s), `attempt state machine is missing state: ${s}`)
  }
})

test('no send path renders HTML by string concatenation', () => {
  // finding EMAIL-P1-13: raw interpolation of customer-controlled values.
  // A `<p>`/`<a href=` inside a template literal in a SENDER is the shape of
  // that bug. Templates render through React; senders must not build markup.
  for (const path of SEND_PATHS) {
    const src = read(path.file)
    const inlineHtml = /`[^`]*<(?:p|a|div|table)\b[^`]*\$\{/.test(src)
    assert.equal(inlineHtml, false, `${path.name} builds HTML by interpolation`)
  }
})

test('follow-ups no longer carry their own palette or HTML builder', () => {
  // The repeat-reminder used to be hand-built here, which put it outside the
  // marketing footer AND outside the palette test — how a blue CTA survived.
  const src = read('lib/followups.ts')
  assert.equal(/const BRAND = \{/.test(src), false, 'followups has a local palette again')
  assert.equal(/function emailHtml\(/.test(src), false, 'followups has an inline HTML builder again')
})

test('the documented send-path table matches the code', () => {
  // Keeps docs/email-marketing/architecture.md honest — the P3-20 defect was a
  // table asserting safeguards that two paths did not have.
  const doc = readFileSync(join(SRC, '..', 'docs', 'email-marketing', 'architecture.md'), 'utf8')
  for (const path of SEND_PATHS) {
    assert.ok(doc.includes(path.file), `architecture.md does not list ${path.file}`)
  }
  assert.ok(
    doc.includes('send-path-conformance.test.ts'),
    'architecture.md should point at this test as the source of truth'
  )
})

test('notify.ts sends CUSTOMER mail through the guard, not directly', () => {
  // This file was a FOURTH direct provider caller — missed by the audit and by
  // the first remediation pass, and found by this test rather than by reading.
  // Its customer-facing lead acknowledgement skipped suppression entirely, so a
  // person who had unsubscribed or filed a spam complaint was still written to
  // the moment they touched the quote form.
  const src = read('lib/notify.ts')
  assert.ok(src.includes('sendCustomerEmail'), 'notify.ts lost its guarded customer sender')
  assert.ok(src.includes('guardedSend'), 'notify.ts no longer routes customer mail through the guard')
  assert.ok(src.includes('sendInternalEmail'), 'the internal/customer split has been removed')
  // The lead acknowledgement specifically must not go direct again.
  assert.equal(
    /email:lead-ack[\s\S]{0,200}sendInternalEmail/.test(src),
    false,
    'the customer lead acknowledgement is using the INTERNAL sender'
  )
})
