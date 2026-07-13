// Offline tests for scan concurrency + cooldown decisions (increment 2.1).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isScanLive, withinCooldown, decideClaim, sanitizeScanError, SCAN_STALE_MS, SCAN_COOLDOWN_MS } from '../scan-lock'

const NOW = new Date('2026-07-13T12:00:00Z')

test('isScanLive: fresh RUNNING is live, stale is not (crash-safe)', () => {
  assert.equal(isScanLive(new Date(NOW.getTime() - 1000), NOW), true)
  assert.equal(isScanLive(new Date(NOW.getTime() - SCAN_STALE_MS - 1), NOW), false)
})

test('withinCooldown: recent = true, old = false, null = false', () => {
  assert.equal(withinCooldown(new Date(NOW.getTime() - 1000), NOW), true)
  assert.equal(withinCooldown(new Date(NOW.getTime() - SCAN_COOLDOWN_MS - 1), NOW), false)
  assert.equal(withinCooldown(null, NOW), false)
})

test('decideClaim: an in-flight scan always blocks (even forced)', () => {
  assert.deepEqual(decideClaim({ liveRunningExists: true, lastScanStartedAt: null, trigger: 'MANUAL', force: true }, NOW), { proceed: false, reason: 'already_running' })
})

test('decideClaim: cooldown blocks automatic scans but a forced manual bypasses it', () => {
  const recent = new Date(NOW.getTime() - 1000)
  assert.deepEqual(decideClaim({ liveRunningExists: false, lastScanStartedAt: recent, trigger: 'PAGE_LOAD', force: false }, NOW), { proceed: false, reason: 'cooldown' })
  assert.deepEqual(decideClaim({ liveRunningExists: false, lastScanStartedAt: recent, trigger: 'MANUAL', force: true }, NOW), { proceed: true })
})

test('decideClaim: proceeds when idle and cooled down', () => {
  const old = new Date(NOW.getTime() - SCAN_COOLDOWN_MS - 1000)
  assert.deepEqual(decideClaim({ liveRunningExists: false, lastScanStartedAt: old, trigger: 'SCHEDULED', force: false }, NOW), { proceed: true })
})

test('sanitizeScanError: single line, capped, no crash on non-Error', () => {
  const s = sanitizeScanError(new Error('boom\n  at somewhere secret'))
  assert.ok(!s.includes('\n'))
  assert.ok(s.startsWith('boom'))
  assert.equal(sanitizeScanError('plain string'), 'plain string')
  assert.ok(sanitizeScanError('x'.repeat(500)).length <= 300)
})
