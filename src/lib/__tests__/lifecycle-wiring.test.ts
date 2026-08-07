// ════════════════════════════════════════════════════════════════════════
//  LIFECYCLE WIRING — every public entry point reaches the right journey.
//  (owner spec 2026-08-07)
//  ---------------------------------------------------------------------
//  The ORCHESTRATION is tested behaviourally in lifecycle-orchestration.test.ts.
//  What that cannot see is whether the API routes actually CALL it — and two of
//  the three production bugs were exactly that:
//
//    • /api/leads/partial stored an explicit opt-in and called nothing;
//    • /api/bookings called the consent READER one step before the consent
//      WRITER, so no new customer could enter the recovery sequence.
//
//  A route handler cannot be invoked offline (no Next request, no database), so
//  these are source-level conformance checks — the same technique
//  send-path-conformance.test.ts uses to prove every sender goes through
//  guardedSend. Comments are stripped first: a scan that reads its own
//  explanatory prose proves nothing, and this codebase has been caught by that
//  twice.
// ════════════════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(__dirname, '../../..')

/** File contents with comment lines removed. */
function code(rel: string): string {
  return readFileSync(resolve(ROOT, rel), 'utf8')
    .split('\n')
    .filter((l) => {
      const t = l.trim()
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    })
    .join('\n')
}

test('BOOKING: /api/bookings hands over through the ONE ordered composite', () => {
  const src = code('app/api/bookings/route.ts')

  assert.match(src, /onBookingCreated\(/, 'the composite is called')
  // And the two halves it composes are NOT sequenced by hand any more. That is
  // the whole guarantee: there is no longer a place in this route where the
  // consent read can drift back above the consent write.
  assert.ok(!/\bawait onCheckoutStarted\(/.test(src), 'onCheckoutStarted is not called directly')
  assert.ok(!/\bawait markLeadConverted\(/.test(src), 'markLeadConverted is not called directly')
})

test('BOOKING: the not-sure lead is ingested BEFORE the hand-over converts it', () => {
  // Ingesting afterwards left a brand-new NEW lead for somebody who had just
  // booked — a converted customer sitting in the prospect pipeline forever.
  const src = code('app/api/bookings/route.ts')
  const ingest = src.indexOf('ingestLeadSafe(')
  const handover = src.indexOf('onBookingCreated(')
  assert.ok(ingest > -1 && handover > -1)
  assert.ok(ingest < handover, 'ingest, then convert')
})

test('BOOKING STEP 1: /api/leads/partial enrols a consented lead instead of doing nothing', () => {
  const src = code('app/api/leads/partial/route.ts')
  assert.match(src, /onLeadCaptured\(/, 'the partial route reaches Sequence B')
  // It must be gated on something that can CHANGE the answer, not fired on
  // every autosave — the booking form calls this route from five triggers.
  assert.match(src, /result\.isNew \|\| d\.marketingConsent === true/)
})

test('CONTACT: /api/contact enrols through the same Sequence B entry point', () => {
  const src = code('app/api/contact/route.ts')
  assert.match(src, /onLeadCaptured\(/)
})

test('TRACKER: /api/notify/lead enrols through the same Sequence B entry point', () => {
  const src = code('app/api/notify/lead/route.ts')
  assert.match(src, /onLeadCaptured\(/)
})

test('QUICK QUOTE: the capture module routes to A or B and RE-ENSURES on repeat saves', () => {
  const src = code('src/lib/quote-capture.ts')
  assert.match(src, /if \(marked\.newlyQuoted\) await deps\.startQuoteFollowup/)
  assert.match(src, /else await deps\.ensureQuoteFollowup/)
  assert.match(src, /await deps\.startLeadNurture/)
  // The production wiring must point at the retryable enrolment, not a second
  // copy of the trigger.
  assert.match(src, /ensureQuoteJourney/)
})

test('ADMIN: re-marking a lead quoted re-ensures rather than doing nothing', () => {
  const src = code('app/api/admin/email-marketing/leads/[id]/quote/route.ts')
  assert.match(src, /result\.newlyQuoted \? onQuoteCreated\(/)
  assert.match(src, /: ensureQuoteJourney\(/)
  // ...and it reports what the lifecycle ACTUALLY did. Reporting the intent is
  // how a silent refusal stayed invisible in the first place.
  assert.match(src, /followupStarted: followupScheduled/)
})

test('WORKER: the stranded-journey repair is dispatched AND scheduled', () => {
  const src = code('src/workers/scheduled.worker.ts')
  assert.match(src, /case 'lifecycle-repair'/, 'the worker handles the job')
  assert.match(src, /repairStrandedQuoteJourneys\(/)
  assert.match(src, /jobId: 'cron:lifecycle-repair'/, 'and a cron actually fires it')
  // The job type must exist in the queue contract or the payload is untyped.
  assert.match(code('src/lib/queues/index.ts'), /\| 'lifecycle-repair'/)
})

test('NO SECOND EMAIL UNIVERSE: only journeys.ts schedules lifecycle stages', () => {
  // Every stage insert must go through the module that owns the stop rules.
  // A route that queued a stage directly would inherit none of them.
  const src = code('app/api/leads/partial/route.ts') + code('app/api/contact/route.ts')
  assert.ok(!/scheduledQueue\.add\(/.test(src), 'no route enqueues a journey stage by hand')
})
