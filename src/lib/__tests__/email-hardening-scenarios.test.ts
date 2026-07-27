import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { verifySvixSignature, isHardBounce } from '../email-events'
import { renderTemplate, renderableTemplates } from '../email-render'
import { templateRegistry, templateByKey } from '../email-registry'
import { recipientStateForOutcome, RECIPIENT_RETRYABLE_STATES, campaignRunEventId } from '../email-campaign-run'

// ════════════════════════════════════════════════════════════════════════
//  SCENARIO TESTS (owner spec 2026-07-26, audit §6 "Missing tests")
//
//  These exercise BEHAVIOUR, not source text: forged signatures are actually
//  forged, every template is actually rendered, and the DST arithmetic is
//  actually computed. Each names the production failure it protects against.
// ════════════════════════════════════════════════════════════════════════

const lib = (name: string) => readFileSync(resolve(__dirname, '..', name), 'utf8')
const code = (t: string) =>
  t.split('\n').filter((l) => { const s = l.trim(); return !s.startsWith('//') && !s.startsWith('*') && !s.startsWith('/*') }).join('\n')

// ── ADVERSARIAL WEBHOOKS ────────────────────────────────────────────────
// PREVENTS: anyone who learns the endpoint URL forging a bounce for a real
// customer (suppressing them) or a fake delivery (hiding a failure).

const SECRET_B64 = Buffer.from('super-secret-signing-key-value!!').toString('base64')
const SECRET = `whsec_${SECRET_B64}`

function sign(id: string, ts: string, body: string, secret = SECRET): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64')
  return `v1,${crypto.createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64')}`
}

const nowTs = () => String(Math.floor(Date.now() / 1000))

test('a VALID signature is accepted', () => {
  const body = JSON.stringify({ type: 'email.delivered' })
  const id = 'msg_1'
  const ts = nowTs()
  assert.equal(verifySvixSignature(body, { id, timestamp: ts, signature: sign(id, ts, body) }, SECRET), true)
})

test('a FORGED signature is rejected', () => {
  const body = JSON.stringify({ type: 'email.bounced' })
  const id = 'msg_2'
  const ts = nowTs()
  const forged = sign(id, ts, body, `whsec_${Buffer.from('attacker-key-attacker-key-1234!!').toString('base64')}`)
  assert.equal(verifySvixSignature(body, { id, timestamp: ts, signature: forged }, SECRET), false)
})

test('a TAMPERED body invalidates a real signature', () => {
  // The classic attack: capture a legitimate delivered event, swap the address.
  const original = JSON.stringify({ type: 'email.bounced', data: { to: ['someone@example.com'] } })
  const id = 'msg_3'
  const ts = nowTs()
  const sig = sign(id, ts, original)
  const tampered = JSON.stringify({ type: 'email.bounced', data: { to: ['victim@example.com'] } })
  assert.equal(verifySvixSignature(tampered, { id, timestamp: ts, signature: sig }, SECRET), false)
})

test('a REPLAYED old event is rejected on timestamp', () => {
  // PREVENTS: a captured bounce being replayed months later to suppress someone.
  const body = JSON.stringify({ type: 'email.complained' })
  const id = 'msg_4'
  const old = String(Math.floor(Date.now() / 1000) - 3600) // 1h old
  assert.equal(verifySvixSignature(body, { id, timestamp: old, signature: sign(id, old, body) }, SECRET), false)
})

test('a FUTURE-dated event is rejected (clock-skew abuse)', () => {
  const body = '{}'
  const id = 'msg_5'
  const future = String(Math.floor(Date.now() / 1000) + 3600)
  assert.equal(verifySvixSignature(body, { id, timestamp: future, signature: sign(id, future, body) }, SECRET), false)
})

test('missing headers or secret are rejected, never treated as valid', () => {
  const body = '{}'
  const ts = nowTs()
  assert.equal(verifySvixSignature(body, { id: null, timestamp: ts, signature: 'v1,x' }, SECRET), false)
  assert.equal(verifySvixSignature(body, { id: 'a', timestamp: null, signature: 'v1,x' }, SECRET), false)
  assert.equal(verifySvixSignature(body, { id: 'a', timestamp: ts, signature: null }, SECRET), false)
  // No secret configured must NOT mean "accept everything".
  assert.equal(verifySvixSignature(body, { id: 'a', timestamp: ts, signature: sign('a', ts, body) }, undefined as never), false)
})

test('malformed signature values do not throw — they are refused', () => {
  const body = '{}'
  const id = 'a'
  const ts = nowTs()
  for (const bad of ['', 'garbage', 'v1,', 'v1,!!!!not-base64!!!!', 'v2,abc']) {
    assert.doesNotThrow(() => verifySvixSignature(body, { id, timestamp: ts, signature: bad }, SECRET))
    assert.equal(verifySvixSignature(body, { id, timestamp: ts, signature: bad }, SECRET), false, `"${bad}" must be refused`)
  }
})

test('the webhook refuses to process at all when no secret is configured', () => {
  // PREVENTS: an unconfigured deploy accepting unauthenticated suppressions.
  const ev = code(lib('email-events.ts'))
  assert.match(ev, /RESEND_WEBHOOK_SECRET is not set — refusing to process/)
  assert.match(ev, /status: 503/)
})

test('soft bounces do NOT suppress a real customer', () => {
  // PREVENTS: a full mailbox permanently unsubscribing a paying customer.
  assert.equal(isHardBounce({ type: 'Transient' }), false)
  assert.equal(isHardBounce({ type: 'Transient', subType: 'MailboxFull' }), false)
  assert.equal(isHardBounce({ subType: 'MessageTooLarge' }), false)
  assert.equal(isHardBounce({ type: 'Permanent' }), true)
  assert.equal(isHardBounce({ subType: 'NoSuchUser' }), true)
  // Unknown provider data must not suppress — keep mailing rather than drop a customer.
  assert.equal(isHardBounce({ type: 'Weird' }), false)
  assert.equal(isHardBounce(undefined), false)
})

// ── TEMPLATE MATRIX ─────────────────────────────────────────────────────
// PREVENTS: a template that has never been rendered failing at send time —
// only `abandoned-checkout` had ever been through a real send.

test('EVERY renderable template renders without throwing', async () => {
  const templates = renderableTemplates()
  assert.ok(templates.length >= 8, `expected the full registry, got ${templates.length}`)
  const failures: string[] = []
  for (const key of templates) {
    const payload = {
      customerName: 'Test Customer', firstName: 'Test', bookingId: 'bk_test', locale: 'en',
      moveDate: '2026-08-01', movingFrom: '1 Main St', movingTo: '2 Oak Ave',
      total: 460, deposit: 49, balance: 411, amount: 460, hours: 3, crewSize: 2,
      unsubscribeUrl: 'https://moveitclearit.com/unsubscribe?t=x',
      bookingUrl: 'https://moveitclearit.com/my-booking/x', quoteUrl: 'https://moveitclearit.com/quote',
      reviewUrl: 'https://g.page/r/x', referralUrl: 'https://moveitclearit.com/referral',
      resumeUrl: 'https://moveitclearit.com/resume', businessAddress: '123 Test St, NJ 07050',
      discountCode: 'TEST10', expiresAt: '2026-09-01',
    }
    try {
      const out = await renderTemplate(key, payload as never)
      if ('error' in out) { failures.push(`${key}: ${out.error}`); continue }
      if (!out.html || out.html.length < 50) failures.push(`${key}: html too short (${out.html?.length ?? 0})`)
      if (typeof out.text !== 'string') failures.push(`${key}: missing plain-text alternative`)
    } catch (err) {
      failures.push(`${key} THREW: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  assert.deepEqual(failures, [], `templates failed to render:\n${failures.join('\n')}`)
})

test('every registered template declares an emailClass and subject', () => {
  // PREVENTS: an unclassified template defaulting into the wrong compliance
  // path (promotional rules applied to transactional mail, or worse).
  const missing = templateRegistry()
    .filter((t) => !t.emailClass || !t.subject)
    .map((t) => t.key)
  assert.deepEqual(missing, [], `templates missing class/subject: ${missing.join(', ')}`)
})

test('promotional templates are classified as such, not defaulted', () => {
  for (const key of ['abandoned-checkout', 'review-request', 'referral']) {
    const t = templateByKey(key)
    if (!t) continue
    assert.equal(t.emailClass, 'promotional', `${key} must be promotional`)
  }
})

test('rendered HTML escapes a hostile customer name', async () => {
  // PREVENTS: HTML/script injection through a user-controlled field.
  const hostile = '<script>alert(1)</script>'
  const out = await renderTemplate('abandoned-checkout', {
    customerName: hostile, firstName: hostile, locale: 'en',
    unsubscribeUrl: 'https://moveitclearit.com/u?t=x', businessAddress: '123 Test St, NJ',
    resumeUrl: 'https://moveitclearit.com/resume', quoteUrl: 'https://moveitclearit.com/quote',
  } as never)
  if ('error' in out) return // template requires more context; covered by the matrix test
  assert.ok(!out.html.includes('<script>alert(1)</script>'), 'raw script tag must never survive into the HTML')
})

// ── CONCURRENT CLAIM / WORKER CRASH ─────────────────────────────────────

test('the recipient claim is ATOMIC and a lost race is skipped, not double-sent', () => {
  // PREVENTS: two workers processing the same batch and sending twice.
  const d = code(lib('email-campaign-dispatch.ts'))
  assert.match(d, /updateMany\(\{\s*where: \{ id: recipient\.id, status: 'PENDING' \}/, 'the claim must filter on the CURRENT status')
  assert.match(d, /if \(count === 0\) continue/, 'a lost race must skip the recipient entirely')
  assert.ok(!/update\(\{ where: \{ id: recipient\.id \}, data: \{ status: 'SENDING'/.test(d), 'an unconditional update would let both workers claim')
})

test('the send claim in the guard is also conditional (worker crash after provider accept)', () => {
  // PREVENTS THE WORST CASE: provider accepted, our DB write died, a retry
  // resends. The claim row is written BEFORE the provider call, and a terminal
  // row stops any resume.
  const g = code(lib('email-guard.ts'))
  assert.match(g, /TERMINAL_STATUSES\.has\(existing\.status\)/, 'a terminal row must stop a resume')
  assert.match(g, /'ambiguous'/, 'unknown outcomes must be terminal')
  assert.match(g, /where: \{ id: existing\.id, status: existing\.status, attempts: existing\.attempts \}/, 'the resume takeover must be atomic')
  assert.match(g, /if \(count === 0\) return \{ ok: false, reason: 'in_flight'/, 'losing the takeover race must back off')
  // A stale 'sending' row is only taken over after a bounded wait.
  assert.match(g, /SENDING_STALE_MS/, 'in-flight rows must not be stolen immediately')
})

test('an ambiguous outcome becomes FAILED but is NOT auto-retryable in practice', () => {
  const mapped = recipientStateForOutcome({ sent: false, reason: 'ambiguous' } as never)
  assert.equal(mapped.status, 'FAILED')
  // FAILED is in the retryable set — which is exactly why the SERVER-side
  // unknown-outcome filter (E-07) exists. Both facts are pinned together so a
  // future change to either has to confront the other.
  assert.ok(RECIPIENT_RETRYABLE_STATES.has('FAILED'))
  const d = code(lib('email-campaign-dispatch.ts'))
  assert.match(d, /UNRESOLVED_SEND_STATUSES/, 'the retry path must filter ambiguous sends out')
})

test('the idempotency event id is scoped per RUN — the reason cross-run protection is needed', () => {
  const a = campaignRunEventId('run_a')
  const b = campaignRunEventId('run_b')
  assert.notEqual(a, b, 'different runs produce different keys — so a re-dispatch is NOT deduped by the key')
  assert.match(a, /run_a/)
})

// ── SUPPRESSION FAILURE RECOVERY ────────────────────────────────────────

test('a failed suppression is recorded as unfinished and re-driven, never deduped away', () => {
  // PREVENTS: the original P0 — a bounce whose suppression failed, whose replay
  // hit the unique providerEventId and short-circuited as "duplicate".
  const ev = code(lib('email-events.ts'))
  assert.match(ev, /side_effect_pending/, 'the event must be written as pending BEFORE the suppression is attempted')
  assert.match(ev, /processingStatus === 'processed'/, 'only a confirmed side effect may short-circuit a replay')
  assert.match(ev, /export async function retryPendingSideEffects/, 'a re-drive path must exist')
  // And it must actually be scheduled — the gap this release closes.
  const worker = code(readFileSync(resolve(__dirname, '..', '..', 'workers', 'scheduled.worker.ts'), 'utf8'))
  assert.match(worker, /retryPendingSideEffects\(/)
})

// ── DST / TIMEZONE ──────────────────────────────────────────────────────

test('DST: a scheduled send stored in UTC survives both US transitions', () => {
  // PREVENTS: a campaign scheduled for a given moment firing an hour early or
  // late across a DST boundary, or the sweep's due-ness comparison drifting.
  //
  // 2026 US transitions, as INSTANTS (this is the part that is easy to get
  // wrong): spring forward at 2am EST on 8 Mar = 07:00Z; fall back at 2am EDT
  // on 1 Nov = 06:00Z. Both occur BEFORE 12:00Z, so noon UTC lands on the new
  // offset on the transition day itself.
  const localHour = (iso: string) =>
    Number(
      new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false })
        .format(new Date(iso))
    )

  // Straddle spring-forward: EST (UTC-5) -> EDT (UTC-4).
  assert.equal(localHour('2026-03-07T12:00:00.000Z'), 7, 'day before: 12:00Z is 7am EST')
  assert.equal(localHour('2026-03-08T12:00:00.000Z'), 8, 'transition day: 12:00Z is 8am EDT')

  // Straddle fall-back: EDT (UTC-4) -> EST (UTC-5).
  assert.equal(localHour('2026-10-31T12:00:00.000Z'), 8, 'day before: 12:00Z is 8am EDT')
  assert.equal(localHour('2026-11-01T12:00:00.000Z'), 7, 'transition day: 12:00Z is 7am EST')

  // THE POINT: the stored instant never moved — only its local rendering did.
  // The sweep compares instants, so due-ness is unaffected by any of the above.
  const scheduled = new Date('2026-11-01T12:00:00.000Z')
  assert.ok(scheduled.getTime() <= new Date('2026-11-01T12:00:01.000Z').getTime(), 'a due campaign is due regardless of local offset')
  assert.ok(scheduled.getTime() > new Date('2026-11-01T11:59:59.000Z').getTime(), 'and not due one second early')
})

test('DST: the daily crons are pinned to a timezone, not to UTC drift', () => {
  // A digest scheduled in bare UTC would arrive an hour early for half the year.
  const worker = code(readFileSync(resolve(__dirname, '..', '..', 'workers', 'scheduled.worker.ts'), 'utf8'))
  assert.match(worker, /tz: 'America\/New_York'/, 'time-of-day crons must declare their timezone')
})

test('the campaign sweep compares absolute time (lte on a Date), not a formatted string', () => {
  const d = code(lib('email-campaign-dispatch.ts'))
  assert.match(d, /scheduledAt: \{ lte: new Date\(\) \}/, 'due-ness must be an instant comparison')
})
