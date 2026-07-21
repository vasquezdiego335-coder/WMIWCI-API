// EMAIL ADMIN read layer + permission matrix (owner spec 2026-07-21).
//
// Pure functions only — no database, no Redis. What is tested here is the part
// that decides what an owner READS: whether a refusal is explained truthfully,
// whether a rate is honest about its denominator, who may see a customer's
// address, and which suppressions may be lifted.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  explainSend,
  statusTone,
  eventTone,
  maskEmail,
  displayEmail,
  canRestoreSuppression,
  RESTORABLE_REASONS,
  templateForStage,
  parseRange,
  rangeStart,
  formatRate,
} from '../email-admin'
import { can, type Action, type Role } from '../permissions'

// ── Explaining refusals ─────────────────────────────────────────────────

test('a delivered send is not described as a problem', () => {
  assert.match(explainSend('delivered', null), /Accepted by the email provider/)
})

test('an ambiguous outcome says it is never auto-resent', () => {
  const s = explainSend('ambiguous', null)
  assert.match(s, /unknown/i)
  assert.match(s, /never re-sent|never auto-resent/i)
})

test('a deferral explains that it will send later, with the due time', () => {
  const due = new Date('2026-08-01T13:00:00.000Z')
  const s = explainSend('deferred', 'quiet_hours', due)
  assert.match(s, /quiet hours/i)
  assert.ok(s.includes(due.toISOString()), 'a deferral must say when it will be attempted')
})

test('a cap is explained as a hold, not as a failure', () => {
  assert.match(explainSend('deferred', 'cap_daily'), /Held back/i)
})

test('an unsubscribe explains that transactional mail still flows', () => {
  assert.match(explainSend('blocked_terminal', 'unsubscribed'), /[Tt]ransactional mail is unaffected/)
})

test('a validation block is named as a fixable configuration problem', () => {
  const s = explainSend('blocked_retryable', 'validation: bookingUrl is missing')
  assert.match(s, /NOT sent/)
  assert.match(s, /bookingUrl is missing/)
  assert.match(s, /configuration problem/i)
})

test('a missing compliance block names what is unconfigured', () => {
  const s = explainSend('blocked_retryable', 'missing-configuration:marketing-context:postalAddress')
  assert.match(s, /postalAddress/)
  assert.match(s, /unsubscribe link and the business postal address/i)
})

test('a status mismatch says the email would have been untrue', () => {
  const s = explainSend('blocked_terminal', 'status_not_allowed:CANCELLED')
  assert.match(s, /untrue/i)
  assert.match(s, /CANCELLED/)
})

test('an UNRECOGNISED reason is shown verbatim rather than paraphrased', () => {
  // Guessing at an unknown reason is how an admin starts telling the owner
  // something that is not true.
  const s = explainSend('blocked_retryable', 'some_new_reason_nobody_mapped')
  assert.ok(s.includes('some_new_reason_nobody_mapped'), 'an unmapped reason must survive into the explanation')
})

test('a lead that converted is explained as the sequence working, not failing', () => {
  assert.match(explainSend('blocked_terminal', 'lead_converted'), /as designed/i)
})

// ── Tone bands ──────────────────────────────────────────────────────────

test('status tones separate success, timing holds and real failures', () => {
  assert.equal(statusTone('delivered'), 'good')
  assert.equal(statusTone('deferred'), 'warn')
  assert.equal(statusTone('failed_terminal'), 'bad')
  assert.equal(statusTone('ambiguous'), 'bad')
  // A terminal block is usually the system working correctly (unsubscribed,
  // cancelled booking), so it must not be painted as an error.
  assert.equal(statusTone('blocked_terminal'), 'muted')
})

test('bounce and complaint events read as bad, engagement as good', () => {
  assert.equal(eventTone('bounced'), 'bad')
  assert.equal(eventTone('complained'), 'bad')
  assert.equal(eventTone('delivered'), 'good')
  assert.equal(eventTone('clicked'), 'good')
  assert.equal(eventTone('delivery_delayed'), 'warn')
})

// ── Recipient masking ───────────────────────────────────────────────────

test('masking keeps a row recognisable without exposing the address', () => {
  const masked = maskEmail('diego@moveitclearit.com')
  assert.ok(masked.startsWith('di'), 'an operator must be able to recognise the row')
  assert.ok(masked.endsWith('@moveitclearit.com'), 'the domain is useful and not sensitive')
  assert.equal(masked.includes('diego'), false, 'the local part must not survive masking')
})

test('masking handles short and malformed addresses without leaking', () => {
  assert.equal(maskEmail('a@b.com').includes('@b.com'), true)
  assert.equal(maskEmail('notanemail'), '•••')
  assert.equal(maskEmail(''), '•••')
})

test('displayEmail reveals the address only with permission', () => {
  assert.equal(displayEmail('diego@moveitclearit.com', true), 'diego@moveitclearit.com')
  assert.equal(displayEmail('diego@moveitclearit.com', false).includes('diego'), false)
})

// ── Suppression restore policy ──────────────────────────────────────────

test('a spam complaint can never be lifted from the admin', () => {
  const v = canRestoreSuppression('SPAM_COMPLAINT')
  assert.equal(v.allow, false)
  assert.match(v.why, /damages the sending domain/i)
})

test('a hard bounce can never be lifted from the admin', () => {
  const v = canRestoreSuppression('HARD_BOUNCE')
  assert.equal(v.allow, false)
  assert.match(v.why, /mailbox does not exist/i)
})

test('an unsubscribe and an admin block are restorable', () => {
  assert.equal(canRestoreSuppression('UNSUBSCRIBED').allow, true)
  assert.equal(canRestoreSuppression('ADMIN_BLOCK').allow, true)
})

test('an unknown suppression reason is refused, not allowed by default', () => {
  assert.equal(canRestoreSuppression('SOMETHING_NEW').allow, false)
})

test('the restorable set never contains a hard suppression', () => {
  for (const r of ['HARD_BOUNCE', 'SPAM_COMPLAINT']) {
    assert.equal((RESTORABLE_REASONS as readonly string[]).includes(r), false, `${r} must never be restorable`)
  }
})

// ── Queue stage mapping ─────────────────────────────────────────────────

test('scheduled job types map to the template they will render', () => {
  assert.equal(templateForStage('abandoned-checkout-recovery'), 'abandoned-checkout')
  assert.equal(templateForStage('abandoned-checkout-recovery-3'), 'abandoned-checkout-3')
  assert.equal(templateForStage('job-reminder-72h'), 'job-reminder')
  assert.equal(templateForStage('job-reminder-24h'), 'job-reminder')
  assert.equal(templateForStage('referral-ask'), 'referral')
  // Unknown types pass through rather than being guessed into something wrong.
  assert.equal(templateForStage('quote-followup-1'), 'quote-followup-1')
})

// ── Ranges + rates ──────────────────────────────────────────────────────

test('an unknown range falls back to a sane default rather than throwing', () => {
  assert.equal(parseRange('nonsense'), '30d')
  assert.equal(parseRange(null), '30d')
  assert.equal(parseRange('7d'), '7d')
})

test('the all-time range has no lower bound', () => {
  assert.equal(rangeStart('all'), null)
  assert.ok(rangeStart('24h') instanceof Date)
})

test('a rate with no denominator is unknown, not 0% and not 100%', () => {
  assert.equal(formatRate({ bp: null, numerator: 0, denominator: 0 }), '—')
  assert.equal(formatRate({ bp: 10_000, numerator: 5, denominator: 5 }), '100.0%')
  assert.equal(formatRate({ bp: 5_000, numerator: 1, denominator: 2 }), '50.0%')
})

// ── Permissions ─────────────────────────────────────────────────────────

const EMAIL_ACTIONS: Action[] = [
  'email.view',
  'email.view_recipients',
  'email.view_attribution',
  'email.manage_journey',
  'email.cancel_scheduled',
  'email.retry_send',
  'email.manage_suppression',
  'email.manage_campaign',
  'email.send_test',
  'email.configure',
]

test('an owner can do everything in email marketing', () => {
  for (const a of EMAIL_ACTIONS) assert.equal(can('OWNER', a), true, `OWNER denied ${a}`)
})

test('crew are denied every email action', () => {
  for (const a of EMAIL_ACTIONS) assert.equal(can('CREW', a), false, `CREW allowed ${a}`)
})

test('a signed-out visitor is denied every email action', () => {
  for (const a of EMAIL_ACTIONS) assert.equal(can(null, a), false, `null role allowed ${a}`)
})

test('BETA: a manager has NO email access at all', () => {
  // The section is owner-only until the staging scenarios pass. The
  // manager-operational split below is the POST-BETA design and is already
  // implemented; lifting Beta is deleting three entries from OWNER_ONLY.
  assert.equal(can('MANAGER', 'email.view'), false)
  assert.equal(can('MANAGER', 'email.cancel_scheduled'), false)
  assert.equal(can('MANAGER', 'email.send_test'), false)
  // These stay owner-only PERMANENTLY, beta or not.
  assert.equal(can('MANAGER', 'email.view_recipients'), false, 'the full recipient list IS the customer list')
  assert.equal(can('MANAGER', 'email.view_attribution'), false, 'attribution ends in company net profit')
  assert.equal(can('MANAGER', 'email.manage_suppression'), false)
  assert.equal(can('MANAGER', 'email.manage_journey'), false)
  assert.equal(can('MANAGER', 'email.retry_send'), false, 'a retry can put a second copy in a real inbox')
  assert.equal(can('MANAGER', 'email.manage_campaign'), false)
  assert.equal(can('MANAGER', 'email.configure'), false)
})

test('email permissions did not accidentally widen an existing financial action', () => {
  // The email work appends to a SHARED permission file. This is the regression
  // guard: the Stage 4 boundaries must be exactly what they were.
  const stillOwnerOnly: Action[] = [
    'money.view_company_profit',
    'money.view_owner_ledger',
    'closeout.finalize',
    'distribution.approve',
    'report.view_owner_money',
  ]
  for (const a of stillOwnerOnly) {
    assert.equal(can('MANAGER', a), false, `${a} is no longer owner-only`)
    assert.equal(can('OWNER', a), true)
  }
  // CREW's narrow self-service set must be exactly what it was — adding email
  // actions must not have widened it.
  const crewAllowed: Action[] = ['labor.clock_self', 'labor.submit_hours', 'labor.view_own_labor']
  for (const a of crewAllowed) assert.equal(can('CREW', a), true, `CREW lost ${a}`)
  const crewDenied: Action[] = ['action_center.view', 'money.record_payment', 'labor.view_all_labor']
  for (const a of crewDenied) assert.equal(can('CREW', a), false, `CREW gained ${a}`)
})
