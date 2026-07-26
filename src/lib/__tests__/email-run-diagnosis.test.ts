import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diagnoseRun, explainRunError } from '../email-run-diagnosis'

// ════════════════════════════════════════════════════════════════════════
//  Phase 1 requirement 5 (owner spec 2026-07-26): operational error reporting.
//
//  What the owner actually saw on the failed production run:
//      RUN FAILED · 1 recipients · 0 sent · 5 skipped
//      ✗ Custom Id cannot contain :
//
//  That says nothing about whether anyone was emailed or whether retrying is
//  safe. The rule under test: retry safety is decided by whether the PROVIDER
//  was handed the message (emailSendId), never by the run's status. A duplicate
//  to a real customer is worse than a missing email.
// ════════════════════════════════════════════════════════════════════════

test('THE PRODUCTION RUN: failed during preparation, nothing sent, retry is safe', () => {
  const d = diagnoseRun({
    runId: 'run_abc',
    status: 'FAILED',
    totalRecipients: 6,
    recipientCounts: { PENDING: 1, SKIPPED: 5 },
    submittedCount: 0,
    error: 'Custom Id cannot contain :',
  })
  assert.equal(d.stage, 'preparation')
  assert.equal(d.providerAttempted, false, 'nothing reached the provider')
  assert.equal(d.unknownOutcome, 0, 'nothing submitted means nothing ambiguous')
  assert.equal(d.safeToRetry, 1, 'the one PENDING recipient is safely retryable')
  assert.match(d.summary, /Nothing was handed to the email provider/)
  assert.match(d.summary, /5 recipients were skipped with a recorded reason/)
  assert.match(d.nextAction, /Safe to retry/)
})

test('a submitted-but-unsettled recipient is NEVER offered as a safe retry', () => {
  const d = diagnoseRun({
    runId: 'r',
    status: 'FAILED',
    totalRecipients: 2,
    recipientCounts: { SENT: 1, FAILED: 1 },
    submittedCount: 2, // both were handed over; one has no confirmation
    error: 'socket hang up',
  })
  assert.equal(d.stage, 'sending')
  assert.equal(d.providerAttempted, true)
  assert.equal(d.unknownOutcome, 1)
  assert.equal(d.safeToRetry, 0, 'an ambiguous attempt is not retryable')
  assert.match(d.nextAction, /Do NOT retry/)
  assert.match(d.nextAction, /Resend dashboard/)
})

test('an empty audience is reported as such, with nothing to retry', () => {
  const d = diagnoseRun({ runId: 'r', status: 'FAILED', totalRecipients: 0, recipientCounts: {}, submittedCount: 0, error: 'no recipients' })
  assert.equal(d.stage, 'audience_resolution')
  assert.equal(d.safeToRetry, 0)
  assert.match(d.nextAction, /Fix the audience/)
  assert.match(d.nextAction, /nothing to retry/)
})

test('a clean completed run reports no failure stage', () => {
  const d = diagnoseRun({ runId: 'r', status: 'COMPLETED', totalRecipients: 1, recipientCounts: { SENT: 1 }, submittedCount: 1, error: null })
  assert.equal(d.stage, 'none')
  assert.equal(d.deadNoDelivery, false)
  assert.equal(d.unknownOutcome, 0)
  assert.equal(d.nextAction, 'No action needed.')
})

test('unknownOutcome can never exceed what was actually submitted', () => {
  // 5 failures but only 1 submission → at most 1 can be ambiguous.
  const d = diagnoseRun({ runId: 'r', status: 'FAILED', totalRecipients: 5, recipientCounts: { FAILED: 5 }, submittedCount: 1, error: 'x' })
  assert.ok(d.unknownOutcome <= 1, `over-reported ambiguity: ${d.unknownOutcome}`)
  assert.equal(d.safeToRetry, 4, 'the four never submitted are safe')
})

test('a run that delivered nothing is flagged, even when it "completed"', () => {
  const d = diagnoseRun({ runId: 'r', status: 'COMPLETED', totalRecipients: 3, recipientCounts: { SKIPPED: 3 }, submittedCount: 0, error: null })
  assert.equal(d.deadNoDelivery, true, 'zero delivered must be visible, not hidden behind COMPLETED')
})

test('counts are never invented when submittedCount is unavailable', () => {
  // Without the submitted count, a SENT row still proves the provider was used,
  // and absence of one must not be read as proof it was not ambiguous.
  const withSent = diagnoseRun({ runId: 'r', status: 'FAILED', totalRecipients: 2, recipientCounts: { SENT: 1, PENDING: 1 }, error: 'x' })
  assert.equal(withSent.providerAttempted, true)
  const inFlight = diagnoseRun({ runId: 'r', status: 'FAILED', totalRecipients: 1, recipientCounts: { SENDING: 1 }, error: 'x' })
  assert.equal(inFlight.unknownOutcome, 1, 'a SENDING row is ambiguous by definition')
})

test('error explanations are actionable and never replace an unknown error', () => {
  assert.match(explainRunError('Custom Id cannot contain :')!, /colon-in-job-id/)
  assert.match(explainRunError('429 rate limit exceeded')!, /throttled/)
  assert.match(explainRunError('401 invalid api key')!, /RESEND_API_KEY/)
  assert.match(explainRunError('domain not verified')!, /DNS/)
  assert.match(explainRunError('ENOTFOUND redis.railway.internal')!, /network or Redis/)
  // Unrecognised → verbatim, not a vague generic message.
  assert.equal(explainRunError('something nobody has seen'), 'something nobody has seen')
  assert.equal(explainRunError(null), null)
})

test('the retry button is not offered when a retry could duplicate a delivery', () => {
  // Pinned in the UI: the control is hidden on unknown outcomes, so the operator
  // cannot click the one action the diagnosis says not to take.
  const ui = require('node:fs').readFileSync(
    require('node:path').resolve(__dirname, '../../../app/(admin)/admin/(dashboard)/email-marketing/campaigns/CampaignComposer.tsx'),
    'utf8'
  )
  assert.ok(/d \? d\.unknownOutcome === 0 : true/.test(ui), 'Retry failed must be gated on a zero unknown-outcome count')
})
