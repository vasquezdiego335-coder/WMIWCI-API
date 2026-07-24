import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { classifyBlock } from '../email-guard'

// ════════════════════════════════════════════════════════════════════════
//  Global email kill switch (owner spec 2026-07-24).
//  EMAIL_SENDING_ENABLED=false must stop EVERY customer email at the single
//  canonical choke point guardedSend(). Verified two ways:
//    1. the block is classified as a DEFERRAL (held + resumed, never lost);
//    2. a structural check that guardedSend gates on the flag BEFORE it ever
//       calls the provider — the same source-level guarantee the send-path
//       conformance test already relies on.
// ════════════════════════════════════════════════════════════════════════

test('kill-switch block is classified as a DEFERRAL (resumes when re-enabled, never terminal)', () => {
  assert.equal(classifyBlock('email_sending_disabled'), 'deferred')
})

test('guardedSend enforces EMAIL_SENDING_ENABLED before the provider send', () => {
  const src = readFileSync(resolve(__dirname, '../email-guard.ts'), 'utf8')

  const killIdx = src.indexOf("process.env.EMAIL_SENDING_ENABLED === 'false'")
  assert.ok(killIdx > -1, 'guardedSend must gate on EMAIL_SENDING_ENABLED === "false"')

  // Match the ACTUAL provider call (`await resend.emails.send(`), not the
  // `resend.emails.send()` references in the file's header comments.
  const providerIdx = src.indexOf('await resend.emails.send(')
  assert.ok(providerIdx > -1, 'guardedSend should contain the provider call')

  // The kill-switch gate must appear BEFORE the provider call in guardedSend,
  // so a disabled switch can never reach the provider.
  assert.ok(killIdx < providerIdx, 'the kill switch must be checked before the provider send')

  // And it must refuse with the deferral reason (so nothing is lost).
  assert.ok(
    /EMAIL_SENDING_ENABLED === 'false'[\s\S]{0,300}refuse\('email_sending_disabled'/.test(src),
    'the kill switch must refuse with the email_sending_disabled deferral reason'
  )
})
