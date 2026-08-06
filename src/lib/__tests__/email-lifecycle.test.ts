// ════════════════════════════════════════════════════════════════════════
//  EMAIL LIFECYCLE — the end-to-end contract (owner spec 2026-08-06)
//  ---------------------------------------------------------------------
//  One file, thirty scenarios, offline. It exists because the lifecycle is
//  assembled from a dozen modules that each test themselves well and had no
//  test of the thing they add up to: "who gets which email, and why not?"
//
//  TWO KINDS OF ASSERTION, deliberately mixed:
//
//   • BEHAVIOURAL — the pure decision functions are called with real inputs.
//     These are the tests that matter; they fail when a rule changes.
//
//   • SOURCE CONFORMANCE — a handful of guarantees live in a database `select`,
//     a queue job id, or an ordering, none of which can be exercised without a
//     live Postgres and Redis. Those are asserted by reading the source, the
//     same technique journeys.test.ts and queue-jobid-safety.test.ts already
//     use here. A source assertion is weaker than a behavioural one and is
//     used ONLY where the alternative is no test at all — each one says which
//     guarantee it stands in for.
//
//  NO REAL EMAIL CAN BE SENT BY THIS FILE. Nothing here calls guardedSend, the
//  Resend client, or any queue; every import is either a pure function or a
//  file read.
// ════════════════════════════════════════════════════════════════════════

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  bookingBlockReason,
  promotionalConsentBlockReason,
  movePassed,
  type BookingSnapshot,
} from '../email-eligibility'
import {
  quoteFollowupBlockReason,
  leadNurtureBlockReason,
  transactionalLeadBlockReason,
  QUOTE_STAGES,
  LEAD_NURTURE_STAGES,
  ABANDONED_STAGES,
  REMINDER_OFFSETS,
  jobIdFor,
  type LeadState,
  type NurtureLeadState,
} from '../journeys'
import {
  classifyTemplate,
  classifyBlock,
  buildIdempotencyKey,
  inQuietHours,
  nextAllowedTime,
  etHour,
  inRolloutAllowlist,
  rolloutAllowlist,
} from '../email-guard'
import { scopeForReason } from '../email-suppression'
import { decideConsent, CONSENT_VERSION } from '../consent'
import {
  buildLeadCreate,
  buildLeadUpdate,
  countsAsPriorBooking,
  hasPromotionalConsent,
  mayWriteEstimate,
  type ExistingLead,
} from '../leads'
import { hasRealQuote, formatEstimate } from '../quote-capture'
import { templateRegistry, journeyRegistry } from '../email-registry'

const src = (rel: string) => readFileSync(resolve(__dirname, '..', '..', rel), 'utf8')
const NOW = new Date('2026-08-06T15:00:00Z')
const FUTURE = new Date('2026-09-01T14:00:00Z')
const PAST = new Date('2026-07-01T14:00:00Z')

// ── Fixtures ────────────────────────────────────────────────────────────

/** A booking whose customer explicitly opted in. */
const booking = (over: Partial<BookingSnapshot> = {}): BookingSnapshot => ({
  status: 'CONFIRMED',
  isInternalTest: false,
  depositPaid: true,
  completedAt: null,
  requestedDate: FUTURE,
  confirmedDate: FUTURE,
  scheduledStart: FUTURE,
  customerMarketingConsent: true,
  customerMarketingOptOut: false,
  ...over,
})

/** A quoted lead we may market to. */
const quoted = (over: Partial<LeadState> = {}): LeadState => ({
  email: 'sam@example.com',
  status: 'QUOTE_SENT',
  quotedAt: PAST,
  bookedAt: null,
  lostAt: null,
  moveDate: FUTURE,
  convertedBookingId: null,
  emailMarketingConsent: true,
  ...over,
})

/** An opted-in lead with NO quote — the Sequence B audience. */
const nurture = (over: Partial<NurtureLeadState> = {}): NurtureLeadState => ({
  ...quoted({ status: 'NEW', quotedAt: null }),
  previousCustomer: false,
  ...over,
})

// ════════════════════════════════════════════════════════════════════════
//  1–3.  THE NON-NEGOTIABLE RULE: consent is `true`, or nothing sends.
// ════════════════════════════════════════════════════════════════════════

test('1. an opted-in quick-quote lead is eligible for the promotional sequence', () => {
  assert.equal(quoteFollowupBlockReason(quoted(), NOW), null)
  // ...and the sequence it becomes eligible for is the three-stage one that
  // already existed. Preserved deliberately: the owner spec allows a fourth
  // stage, the existing design says three, and three is what shipped.
  assert.equal(QUOTE_STAGES.length, 3)
})

test('2. `false` consent blocks every promotional path', () => {
  assert.equal(quoteFollowupBlockReason(quoted({ emailMarketingConsent: false }), NOW), 'no_marketing_consent')
  assert.equal(leadNurtureBlockReason(nurture({ emailMarketingConsent: false }), NOW), 'no_marketing_consent')
  assert.equal(
    promotionalConsentBlockReason(booking({ customerMarketingConsent: false })),
    'no_marketing_consent'
  )
  assert.equal(hasPromotionalConsent({ emailMarketingConsent: false }), false)
})

test('3. `null` consent blocks just as hard — absence of a decision is not permission', () => {
  assert.equal(quoteFollowupBlockReason(quoted({ emailMarketingConsent: null }), NOW), 'no_marketing_consent')
  assert.equal(leadNurtureBlockReason(nurture({ emailMarketingConsent: null }), NOW), 'no_marketing_consent')
  assert.equal(
    promotionalConsentBlockReason(booking({ customerMarketingConsent: null })),
    'no_marketing_consent'
  )
  assert.equal(hasPromotionalConsent({ emailMarketingConsent: null }), false)
  assert.equal(hasPromotionalConsent({}), false, 'undefined is not permission either')
})

// ════════════════════════════════════════════════════════════════════════
//  4–5.  NON-QUOTE LEADS (contact form, coupon, tracker) — Sequence B.
// ════════════════════════════════════════════════════════════════════════

test('4. a contact-form lead with no consent gets no nurture sequence', () => {
  assert.equal(leadNurtureBlockReason(nurture({ emailMarketingConsent: null }), NOW), 'no_marketing_consent')
})

test('5. a contact-form lead WITH consent enters the non-quote sequence', () => {
  assert.equal(leadNurtureBlockReason(nurture(), NOW), null)
  // Three stages, and they move forward in time. A stage that fired at or
  // before its predecessor would arrive out of order.
  assert.equal(LEAD_NURTURE_STAGES.length, 3)
  for (let i = 1; i < LEAD_NURTURE_STAGES.length; i++) {
    assert.ok(
      LEAD_NURTURE_STAGES[i].delay > LEAD_NURTURE_STAGES[i - 1].delay,
      'nurture stages must be strictly increasing'
    )
  }
})

// ════════════════════════════════════════════════════════════════════════
//  6–7.  THE NUMBER WE QUOTED IS THE NUMBER WE STORED.
// ════════════════════════════════════════════════════════════════════════

test('6. the confirmation prints the STORED estimate, never a recomputed one', () => {
  // Behavioural: the formatter is fed cents off the lead row.
  assert.equal(formatEstimate(87_900), '$879')
  // ABSENT, not empty — the template drops the whole paragraph rather than
  // printing a blank value.
  assert.equal(formatEstimate(null), undefined)
  assert.equal(formatEstimate(0), undefined)

  // SOURCE CONFORMANCE — stands in for "the email body cannot be built from
  // the request". There is no way to assert this behaviourally without a live
  // database, so the read is asserted instead: the payload comes off `lead`.
  const s = src('lib/quote-capture.ts')
  const fn = s.slice(s.indexOf('async function queueConfirmationEmail'), s.indexOf('//  2. THE INTERNAL ALERT'))
  assert.match(fn, /formatEstimate\(lead\.estimatedValue\)/, 'the estimate must come off the LEAD')
  assert.ok(!/req\.|body\./.test(fn), 'the confirmation must never read the request')
})

test('7. the booking form cannot undercut a price we already emailed', () => {
  const emailed = { estimatedValue: 87_900, quoteConfirmationQueuedAt: PAST }
  // A lower browser figure after a confirmation went out is refused...
  assert.equal(mayWriteEstimate(emailed, 77_900, false), false)
  // ...a HIGHER one is real information (stairs, a second stop) and lands...
  assert.equal(mayWriteEstimate(emailed, 97_900, false), true)
  // ...and the server's own price always wins, up or down.
  assert.equal(mayWriteEstimate(emailed, 77_900, true), true)
  // Nothing beats nothing.
  assert.equal(mayWriteEstimate({ estimatedValue: null }, 77_900, false), true)
  assert.equal(mayWriteEstimate(emailed, null, false), false)
  assert.equal(mayWriteEstimate(emailed, 0, false), false)
})

// ════════════════════════════════════════════════════════════════════════
//  8–11.  STATE CHANGES STOP SEQUENCES — at schedule time AND at send time.
// ════════════════════════════════════════════════════════════════════════

test('8. booking stops the quote sequence and the abandoned-checkout sequence', () => {
  // SEND-TIME: conversion is checked before anything else that could excuse it.
  assert.equal(quoteFollowupBlockReason(quoted({ bookedAt: NOW }), NOW), 'lead_converted')
  assert.equal(quoteFollowupBlockReason(quoted({ convertedBookingId: 'bk_1' }), NOW), 'lead_converted')
  assert.equal(leadNurtureBlockReason(nurture({ bookedAt: NOW }), NOW), 'lead_converted')
  // ...and recovery mail is untruthful the moment the deposit lands.
  for (const t of ['abandoned-checkout', 'abandoned-checkout-2', 'abandoned-checkout-3']) {
    assert.equal(bookingBlockReason(t, booking({ status: 'PENDING_PAYMENT', depositPaid: true }), NOW), 'deposit_already_paid', t)
  }

  // SCHEDULE-TIME: the cancel ids must match the ids the scheduler created.
  // A typo here means cancel() looks up a job that was never made and the
  // email still fires — which is exactly why this is asserted, not assumed.
  const s = src('lib/journeys.ts')
  const closed = s.slice(s.indexOf('export async function onLeadClosed'), s.indexOf('//  SEND-TIME ELIGIBILITY'))
  assert.match(closed, /QUOTE_STAGES\.map\(\(s\) => cancel\(jobIdFor\('quote', s\.type, leadId\)\)\)/)
  assert.match(closed, /LEAD_NURTURE_STAGES\.map\(\(s\) => cancel\(jobIdFor\('lead-nurture', s\.type, leadId\)\)\)/)
  assert.equal(jobIdFor('quote', 'quote-followup-1', 'l1'), 'journey__quote__quote-followup-1__l1')
  assert.equal(jobIdFor('lead-nurture', 'lead-nurture-1', 'l1'), 'journey__lead-nurture__lead-nurture-1__l1')
})

test('9. declining stops every lead-scoped promotional sequence', () => {
  assert.equal(quoteFollowupBlockReason(quoted({ lostAt: NOW }), NOW), 'lead_lost')
  assert.equal(leadNurtureBlockReason(nurture({ lostAt: NOW }), NOW), 'lead_lost')
  for (const status of ['WON', 'LOST', 'BOOKED', 'CONVERTED']) {
    assert.equal(quoteFollowupBlockReason(quoted({ status }), NOW), `lead_status:${status}`)
    assert.equal(leadNurtureBlockReason(nurture({ status }), NOW), `lead_status:${status}`)
  }
})

test('10. an unsubscribe ends every ACTIVE automation enrollment for the address', () => {
  // SOURCE CONFORMANCE — stands in for a live suppression write. The queue
  // cleanup is best-effort by design; the send-time gate below is the
  // guarantee, and test 11 asserts that.
  const s = src('lib/email-suppression.ts')
  const fn = s.slice(s.indexOf('export async function suppress'), s.indexOf('export type ResubscribeResult'))
  assert.match(fn, /stopEnrollmentsFor\(\{ email \}/, 'a suppression must stop enrollments')
  assert.match(fn, /`suppressed:\$\{String\(input\.reason\)\.toLowerCase\(\)\}`/)
})

test('11. an OLD queued job is refused at send time after an unsubscribe', () => {
  // An unsubscribe is terminal for a promotional send: the logical send is
  // closed rather than left resumable, so a sweep cannot resurrect it.
  assert.equal(classifyBlock('unsubscribed'), 'terminal')
  assert.equal(classifyBlock('marketing_opted_out'), 'terminal')
  // Never having been ASKED is different: a later opt-in must be able to
  // rescue the send, so it stays resumable.
  assert.equal(classifyBlock('no_marketing_consent'), 'retryable')

  // SOURCE CONFORMANCE — the ORDER inside guardedSend. Suppression is checked
  // BEFORE the claim, so a queued job cannot slip past by having been created
  // earlier. Ordering cannot be observed without a provider.
  const s = src('lib/email-guard.ts')
  const suppressionAt = s.indexOf('const suppression = await isSuppressed(')
  const recheckAt = s.indexOf('if (input.recheck)')
  const claimAt = s.indexOf('const claim = await claimOrResumeSend(')
  const sendAt = s.indexOf('await resend.emails.send(')
  assert.ok(suppressionAt > 0 && suppressionAt < recheckAt, 'suppression precedes the state recheck')
  assert.ok(recheckAt < claimAt, 'the live recheck precedes the claim')
  assert.ok(claimAt < sendAt, 'the claim precedes the provider call')
})

// ════════════════════════════════════════════════════════════════════════
//  12–13.  BOUNCES AND BAD ADDRESSES.
// ════════════════════════════════════════════════════════════════════════

test('12. a hard bounce or complaint blocks EVERYTHING, not just marketing', () => {
  assert.equal(scopeForReason('HARD_BOUNCE'), 'all')
  assert.equal(scopeForReason('SPAM_COMPLAINT'), 'all')
  assert.equal(scopeForReason('INVALID_ADDRESS'), 'all')
  assert.equal(scopeForReason('PROVIDER_REJECTED'), 'all')
  assert.equal(scopeForReason('ADMIN_BLOCK'), 'all')
  // An unsubscribe is a marketing decision, not a delivery failure. Keeping
  // them as separate states is what lets a booked customer keep their receipts.
  assert.equal(scopeForReason('UNSUBSCRIBED'), 'promotional')
  // ...and all of them are terminal for the send that hit them.
  for (const r of ['hard_bounce', 'spam_complaint', 'invalid_address', 'provider_rejected', 'admin_block']) {
    assert.equal(classifyBlock(r), 'terminal', r)
  }
})

test('13. a lead with no usable email is never scheduled and never sent', () => {
  assert.equal(quoteFollowupBlockReason(quoted({ email: null }), NOW), 'no_email')
  assert.equal(leadNurtureBlockReason(nurture({ email: null }), NOW), 'no_email')
  assert.equal(transactionalLeadBlockReason({ ...quoted({ email: null }) }), 'no_email')
  // A missing address beats even a missing consent decision: there is nobody
  // to ask, so naming the consent problem would be misleading.
  assert.equal(
    leadNurtureBlockReason(nurture({ email: null, emailMarketingConsent: null }), NOW),
    'no_email'
  )
})

// ════════════════════════════════════════════════════════════════════════
//  14.  PREVIOUS CUSTOMERS.
// ════════════════════════════════════════════════════════════════════════

test('14. someone who has booked before never re-enters the first-time sequence', () => {
  assert.equal(leadNurtureBlockReason(nurture({ previousCustomer: true }), NOW), 'previous_customer')

  // The definition of "previous customer" is BOOKING history, and deliberately
  // not "a booking row exists": a DRAFT or PENDING_PAYMENT booking is somebody
  // who started a form, which is precisely who the welcome sequence is for.
  assert.equal(countsAsPriorBooking({ status: 'COMPLETED', depositPaid: true, isInternalTest: false }), true)
  assert.equal(countsAsPriorBooking({ status: 'CONFIRMED', depositPaid: false, isInternalTest: false }), true)
  assert.equal(countsAsPriorBooking({ status: 'SCHEDULED', depositPaid: false, isInternalTest: false }), true)
  assert.equal(countsAsPriorBooking({ status: 'PENDING_PAYMENT', depositPaid: false, isInternalTest: false }), false)
  assert.equal(countsAsPriorBooking({ status: 'DRAFT', depositPaid: false, isInternalTest: false }), false)
  // Money captured is proof regardless of the status label.
  assert.equal(countsAsPriorBooking({ status: 'PENDING_APPROVAL', depositPaid: true, isInternalTest: false }), true)
  // A rehearsal booking is never a customer.
  assert.equal(countsAsPriorBooking({ status: 'COMPLETED', depositPaid: true, isInternalTest: true }), false)

  // ...and a returning customer who ASKS for a quote still gets quote
  // follow-ups. They requested a price; the first-time welcome is the only
  // thing they are excluded from.
  assert.equal(quoteFollowupBlockReason(quoted(), NOW), null)
})

// ════════════════════════════════════════════════════════════════════════
//  15–17.  COMPLETION, DUPLICATION, CANCELLATION.
// ════════════════════════════════════════════════════════════════════════

test('15. post-move mail requires the job to have actually finished', () => {
  const done = booking({ status: 'COMPLETED', completedAt: NOW })
  assert.equal(bookingBlockReason('review-request', done, NOW), null)
  assert.equal(bookingBlockReason('referral', done, NOW), null)
  // A scheduled date that has merely passed is NOT completion.
  for (const t of ['review-request', 'review-reminder', 'referral', 'repeat-reminder', 'job-completion']) {
    assert.equal(
      bookingBlockReason(t, booking({ status: 'COMPLETED', completedAt: null }), NOW),
      'not_completed',
      t
    )
  }
})

test('16. a repeated completion event cannot duplicate the review request', () => {
  // Three independent layers, none of which needs the others to be correct.
  //
  // (a) the completion stamp is claimed once — `completedAt: null` in the
  //     WHERE, so a second trigger matches no rows and the anchor never moves.
  const f = src('lib/followups.ts')
  assert.match(f, /updateMany\(\{ where: \{ id: bookingId, completedAt: null \}/)
  // (b) the queue job id is stable per (type, booking).
  assert.match(f, /`followup__\$\{type\}__\$\{bookingId\}`/)
  // (c) the ledger claims the send before it happens, keyed on booking+type.
  assert.match(f, /bookingId_type: \{ bookingId, type \}/)
  // ...and the guard's own key is stable for the same business event.
  assert.equal(
    buildIdempotencyKey({ email: 'a@b.com', template: 'review-request', journey: 'post-job', eventId: 'bk_1' }),
    buildIdempotencyKey({ email: 'A@B.com', template: 'review-request', journey: 'post-job', eventId: 'bk_1' }),
    'the key must be address-normalised, so casing cannot mint a second send'
  )
})

test('17. a cancelled booking gets no move reminder and no recovery mail', () => {
  assert.equal(bookingBlockReason('job-reminder', booking({ status: 'CANCELLED' }), NOW), 'status_not_allowed:CANCELLED')
  assert.equal(bookingBlockReason('final-confirmation', booking({ status: 'CANCELLED' }), NOW), 'status_not_allowed:CANCELLED')
  // The cancel path drops every journey id, including the post-job ones.
  const s = src('lib/journeys.ts')
  const fn = s.slice(s.indexOf('export async function onBookingCancelled'), s.indexOf('// ── BALANCE REMINDER'))
  assert.match(fn, /ABANDONED_STAGES/)
  assert.match(fn, /REMINDER_OFFSETS/)
  assert.match(fn, /'review-request', 'review-reminder', 'repeat-reminder', 'referral-ask'/)
})

// ════════════════════════════════════════════════════════════════════════
//  18–19.  TIME: New Jersey calendar dates, and quiet hours.
// ════════════════════════════════════════════════════════════════════════

test('18. every customer-facing date is rendered in America/New_York', () => {
  // THE BUG THIS PREVENTS: a UTC render turns an 8pm ET move into "tomorrow".
  // Asserted by source scan because a template's own formatting is what does
  // it, and there are eight of them.
  const dated = [
    'emails/job-reminder.tsx',
    'emails/final-confirmation.tsx',
    'emails/booking-updated.tsx',
    'emails/quote-followup.tsx',
    'emails/quote-request-received.tsx',
  ]
  for (const f of dated) {
    const s = src(f)
    if (!/toLocaleDateString|toLocaleTimeString/.test(s)) continue
    assert.match(s, /timeZone: 'America\/New_York'/, `${f} must render dates in ET`)
  }
  // The digest + quiet-hour helpers agree.
  assert.match(src('workers/scheduled.worker.ts'), /timeZone: 'America\/New_York'/)
  assert.equal(etHour(new Date('2026-08-06T03:30:00Z')), 23, 'ET is UTC-4 in August — 03:30Z is 11pm the day before')

  // A move day is "today" all day: a job at 9am must not be treated as past at
  // 10am, and it must be past the following day.
  const day = booking({ scheduledStart: new Date('2026-08-06T13:00:00Z'), confirmedDate: null, requestedDate: null })
  assert.equal(movePassed(day, new Date('2026-08-06T22:00:00Z')), false)
  assert.equal(movePassed(day, new Date('2026-08-08T13:00:00Z')), true)
})

test('19. a promotional send computed inside quiet hours moves to the next window', () => {
  // 03:00Z on 6 Aug = 11pm ET on 5 Aug — inside quiet hours.
  const night = new Date('2026-08-06T03:00:00Z')
  assert.equal(inQuietHours(night), true)
  const moved = nextAllowedTime(night)
  assert.equal(inQuietHours(moved), false, 'it must land OUTSIDE quiet hours')
  assert.ok(moved.getTime() > night.getTime(), 'and forward in time — never dropped, never sent early')
  assert.ok(etHour(moved) >= 8 && etHour(moved) < 21, 'inside the allowed ET window')
  // Midday is untouched.
  const noon = new Date('2026-08-06T16:00:00Z')
  assert.equal(inQuietHours(noon), false)
  assert.equal(nextAllowedTime(noon).getTime(), noon.getTime())
})

// ════════════════════════════════════════════════════════════════════════
//  20.  CONCURRENCY.
// ════════════════════════════════════════════════════════════════════════

test('20. two workers cannot send the same email', () => {
  // The key is the delivery identity: same business event ⇒ same key ⇒ the
  // second claim loses. Every component is load-bearing.
  const base = { email: 'sam@example.com', template: 'quote-followup-1', journey: 'quote', eventId: 'lead_1' }
  assert.equal(buildIdempotencyKey(base), buildIdempotencyKey({ ...base, email: 'SAM@example.com ' }))
  assert.notEqual(buildIdempotencyKey(base), buildIdempotencyKey({ ...base, template: 'quote-followup-2' }))
  assert.notEqual(buildIdempotencyKey(base), buildIdempotencyKey({ ...base, eventId: 'lead_2' }))
  assert.notEqual(buildIdempotencyKey(base), buildIdempotencyKey({ ...base, version: 'v2' }))

  // SOURCE CONFORMANCE — the claim is a CONDITIONAL update, and the condition
  // is what makes the takeover atomic. A plain `update` here would let two
  // workers both believe they had the claim.
  const s = src('lib/email-guard.ts')
  const fn = s.slice(s.indexOf('async function claimOrResumeSend'), s.indexOf('export async function guardedSend'))
  assert.match(fn, /where: \{ id: existing\.id, status: existing\.status, attempts: existing\.attempts \}/)
  assert.match(fn, /if \(count === 0\) return \{ ok: false, reason: 'in_flight'/)
  assert.match(fn, /SENDING_STALE_MS/, 'a live in-flight attempt is not stolen')
})

// ════════════════════════════════════════════════════════════════════════
//  21–23.  TEMPLATE COMPLIANCE.
// ════════════════════════════════════════════════════════════════════════

/** Registry entries whose file is a real React template we can read. */
const readableTemplates = () =>
  templateRegistry().filter((t) => t.file.endsWith('.tsx'))

test('21. every promotional template carries a working unsubscribe mechanism', () => {
  for (const t of readableTemplates().filter((x) => x.emailClass === 'promotional')) {
    const s = src(t.file)
    assert.match(s, /MarketingFooter/, `${t.key} must render the marketing footer`)
    assert.match(s, /unsubscribeUrl/, `${t.key} must accept an unsubscribe URL`)
    assert.match(s, /postalAddress/, `${t.key} must accept the postal address`)
  }
  // ...and the send is BLOCKED rather than quietly non-compliant when the
  // configuration behind that footer is missing.
  const g = src('lib/email-guard.ts')
  assert.match(g, /missing-configuration:marketing-context:/)
  assert.equal(classifyBlock('missing-configuration:marketing-context:postalAddress'), 'retryable')
})

test('22. transactional templates carry no promotional footer or offer', () => {
  for (const t of readableTemplates().filter((x) => x.emailClass === 'transactional')) {
    const s = src(t.file)
    assert.ok(!/MarketingFooter/.test(s), `${t.key} is transactional and must not carry the marketing footer`)
  }
  // The classification table itself is the boundary, and it is explicit on
  // both sides — an unknown template defaults to PROMOTIONAL, which is the
  // safe direction (caps, quiet hours, unsubscribe).
  assert.equal(classifyTemplate('quote-request-received'), 'transactional')
  assert.equal(classifyTemplate('job-reminder'), 'transactional')
  assert.equal(classifyTemplate('review-request'), 'promotional')
  assert.equal(classifyTemplate('lead-nurture-1'), 'promotional')
  assert.equal(classifyTemplate('something-nobody-registered'), 'promotional')
})

test('23. no marketing template can send without an explicit opt-in', () => {
  // The booking-scoped gate is derived from the classification, so the two can
  // never disagree: every promotional template is refused for a customer whose
  // consent is not exactly true.
  const noConsent = booking({ status: 'COMPLETED', completedAt: NOW, customerMarketingConsent: null })
  for (const t of templateRegistry().filter((x) => x.emailClass === 'promotional')) {
    assert.equal(bookingBlockReason(t.key, noConsent, NOW), 'no_marketing_consent', t.key)
  }
  // ...and the transactional ones are unaffected by the same customer.
  assert.equal(bookingBlockReason('job-completion', noConsent, NOW), null)
  // A STOP text beats a stale checkbox.
  assert.equal(
    bookingBlockReason('review-request', booking({ status: 'COMPLETED', completedAt: NOW, customerMarketingOptOut: true }), NOW),
    'marketing_opted_out'
  )
})

// ════════════════════════════════════════════════════════════════════════
//  24–26.  THE GATES CAN SEE WHAT THEY GATE ON.
// ════════════════════════════════════════════════════════════════════════

test('24. every worker query loads the consent columns its gate needs', () => {
  // A gate that cannot see a field cannot enforce it. The TYPES already make
  // this a compile error (LeadState / NurtureLeadState / BookingSnapshot all
  // REQUIRE the consent fields), and these assertions say so out loud so the
  // requirement is not silently relaxed to `?:` later.
  const w = src('workers/scheduled.worker.ts')
  const quoteCase = w.slice(w.indexOf("case 'quote-followup-1':"), w.indexOf("case 'lead-nurture-1':"))
  assert.match(quoteCase, /emailMarketingConsent: true/)
  const nurtureCase = w.slice(w.indexOf("case 'lead-nurture-1':"), w.indexOf("case 'review-request-48h':"))
  assert.match(nurtureCase, /emailMarketingConsent: true/)
  assert.match(nurtureCase, /hasEverBooked\(/, 'booking history is asked for, not assumed')

  const e = src('lib/email-eligibility.ts')
  assert.match(e, /customer: \{ select: \{ emailMarketingConsent: true, marketingOptOut: true \} \}/)

  const j = src('lib/journeys.ts')
  assert.match(j, /export type LeadState = \{[\s\S]*?emailMarketingConsent: boolean \| null/)
  assert.ok(!/emailMarketingConsent\?:/.test(j), 'consent must never become optional on LeadState')

  const l = src('lib/leads.ts')
  assert.match(l, /export type ExistingLead = \{[\s\S]*?emailMarketingConsent: boolean \| null/)
})

test('25. every public email form persists the consent source and version', () => {
  for (const route of ['../app/api/contact/route.ts', '../app/api/leads/quote-capture/route.ts', '../app/api/notify/lead/route.ts']) {
    const s = readFileSync(resolve(__dirname, '..', '..', route), 'utf8')
    assert.match(s, /normaliseConsentSource\(/, `${route} must normalise the capture surface`)
    assert.match(s, /CONSENT_VERSION/, `${route} must record the disclosure version`)
  }
  // The partial/booking path has its own default surface.
  assert.match(src('lib/leads.ts'), /marketingConsentSource: consented \? \(normaliseConsentSource\(input\.consentSource\) \?\? 'BOOKING_FORM'\)/)

  // A CREATE writes all four columns explicitly, including the all-null case,
  // so "never asked" is a recorded fact rather than an absent field.
  const created = buildLeadCreate({ email: 'sam@example.com' }, NOW)
  assert.equal(created.emailMarketingConsent, null)
  assert.equal(created.marketingConsentAt, null)
  assert.equal(created.marketingConsentSource, null)
  assert.equal(created.marketingConsentVersion, null)

  const optedIn = buildLeadCreate(
    { email: 'sam@example.com', marketingConsent: true, consentSource: 'CONTACT_FORM' },
    NOW
  )
  assert.equal(optedIn.emailMarketingConsent, true)
  assert.equal(optedIn.marketingConsentAt, NOW)
  assert.equal(optedIn.marketingConsentSource, 'CONTACT_FORM')
  assert.equal(optedIn.marketingConsentVersion, CONSENT_VERSION)
})

test('26. another form submission can never silently re-subscribe someone', () => {
  const existing: ExistingLead = {
    id: 'l1', status: 'NEW', name: 'Sam', phone: null, notes: null, message: null,
    moveDate: null, zip: null, originCity: null, destCity: null, jobType: null, promoCode: null,
    emailMarketingConsent: null, marketingConsentSource: null, marketingConsentVersion: null,
  }

  // A suppressed address ticking a box changes nothing.
  const suppressed = buildLeadUpdate(existing, { marketingConsent: true, isSuppressed: true }, NOW)
  assert.equal(suppressed.emailMarketingConsent, undefined, 'suppression overrides the form')

  // A form with NO checkbox changes nothing either — silence is not a decision.
  const silent = buildLeadUpdate({ ...existing, emailMarketingConsent: true }, { message: 'hi' }, NOW)
  assert.equal(silent.emailMarketingConsent, undefined, 'an absent field must not touch a stored opt-in')

  // An unchecked box on a LATER form is not an unsubscribe.
  const unticked = buildLeadUpdate({ ...existing, emailMarketingConsent: true }, { marketingConsent: false }, NOW)
  assert.equal(unticked.emailMarketingConsent, undefined, 'an earlier explicit opt-in stands')

  // A genuine first opt-in is recorded, with its evidence.
  const granted = buildLeadUpdate(existing, { marketingConsent: true, consentSource: 'CONTACT_FORM' }, NOW)
  assert.equal(granted.emailMarketingConsent, true)
  assert.equal(granted.marketingConsentSource, 'CONTACT_FORM')
  assert.equal(granted.marketingConsentVersion, CONSENT_VERSION)

  // And the rule module agrees — this is the same decision, stated once.
  assert.equal(decideConsent({ consent: null }, { consent: true, isSuppressed: true }, NOW).granted, false)

  // SOURCE CONFORMANCE — the suppression lookup happens BEFORE the builders,
  // otherwise `isSuppressed` would always be false and the branch above dead.
  const l = src('lib/leads.ts')
  const fn = l.slice(l.indexOf('export async function ingestLeadSafe'), l.indexOf('//  LEAD LIFECYCLE TRANSITIONS'))
  assert.ok(
    fn.indexOf('isAddressSuppressed(') < fn.indexOf('createOrUpdateLead('),
    'suppression must be resolved before the consent decision is made'
  )
})

// ════════════════════════════════════════════════════════════════════════
//  27–29.  ONE CONFIRMATION, HONEST COPY, DEAD DATES.
// ════════════════════════════════════════════════════════════════════════

test('27. a quote lead receives exactly one immediate confirmation', () => {
  // SOURCE CONFORMANCE — the claim is a CONDITIONAL updateMany, so two
  // concurrent submits produce one job; a live race cannot be run offline.
  const s = src('lib/quote-capture.ts')
  assert.match(s, /where: force \? \{ id: leadId \} : \{ id: leadId, quoteConfirmationQueuedAt: null \}/)
  // ...and the queued job carries a STABLE business key, so a BullMQ retry
  // dedupes at the guard instead of minting a second logical send.
  assert.match(s, /businessEventKey: `lead:\$\{lead\.id\}:quote-request-received:v\$\{nextCount\}`/)
  // The one place that may add a SECOND immediate email is the marketing
  // trigger, and it is consent-gated and runs after — it can never replace or
  // duplicate the confirmation.
  const entry = s.slice(s.indexOf('export async function onQuoteRequestCaptured'))
  assert.ok(
    entry.indexOf('queueConfirmationEmail(') < entry.indexOf('fireMarketingTrigger('),
    'the transactional confirmation is queued before any marketing decision'
  )
})

test('28. a lead with no quote never receives quote-specific copy', () => {
  // The two sequences are mutually exclusive by construction, not by luck.
  assert.equal(leadNurtureBlockReason(nurture({ quotedAt: PAST }), NOW), 'has_quote')
  assert.equal(quoteFollowupBlockReason(quoted({ quotedAt: null }), NOW), 'no_quote')

  // The routing test: a real number ⇒ quote sequence; an in-person visit or a
  // job we refuse to auto-price ⇒ nurture.
  assert.equal(hasRealQuote({ formStep: 'quote', estimatedValue: 87_900 }), true)
  assert.equal(hasRealQuote({ formStep: 'quote_in_person', estimatedValue: 87_900 }), false)
  assert.equal(hasRealQuote({ formStep: 'quote', estimatedValue: null }), false)
  assert.equal(hasRealQuote({ formStep: 'quote', estimatedValue: 0 }), false)

  // ...and the nurture COPY cannot mention a price or a checkout even by
  // accident. This is the honesty rule the template header states, enforced.
  //
  // COMMENTS ARE STRIPPED FIRST. The header states the rule in the very words
  // the rule forbids ("no 'finish your booking' wording"), so scanning the raw
  // file would fail on the documentation of the constraint rather than on a
  // breach of it.
  const t = src('emails/lead-nurture.tsx')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n')
  assert.ok(!/\$\{?\d/.test(t), 'no dollar figure may appear in the nurture template')
  assert.ok(!/estimatedPrice|totalDollars|amountPaid|balanceDue/.test(t), 'no price prop')
  assert.ok(!/finish (your )?(booking|checkout)|complete your booking/i.test(t), 'no checkout wording')
  assert.ok(!/only \d+ (spots?|slots?)|almost gone|last chance/i.test(t), 'no invented scarcity')
})

test('29. a move date that has gone stops the chasing emails', () => {
  assert.equal(quoteFollowupBlockReason(quoted({ moveDate: PAST }), NOW), 'move_date_passed')
  assert.equal(leadNurtureBlockReason(nurture({ moveDate: PAST }), NOW), 'move_date_passed')
  // Recovery mail: still unpaid, but the date is gone.
  const goneUnpaid = booking({ status: 'PENDING_PAYMENT', depositPaid: false, scheduledStart: PAST, confirmedDate: PAST, requestedDate: PAST })
  for (const t of ['abandoned-checkout', 'abandoned-checkout-2', 'abandoned-checkout-3']) {
    assert.equal(bookingBlockReason(t, goneUnpaid, NOW), 'move_date_passed', t)
  }
  // The move reminder is only ever truthful in a confirmed state anyway, so
  // its date rule is checked there — a status refusal would mask it.
  const goneConfirmed = booking({ status: 'CONFIRMED', scheduledStart: PAST, confirmedDate: PAST, requestedDate: PAST })
  assert.equal(bookingBlockReason('job-reminder', goneConfirmed, NOW), 'move_date_passed')
  assert.equal(classifyBlock('move_date_passed'), 'terminal')
})

// ════════════════════════════════════════════════════════════════════════
//  30.  UNSUBSCRIBING FROM MARKETING DOES NOT CANCEL YOUR MOVE.
// ════════════════════════════════════════════════════════════════════════

test('30. a booked customer keeps their operational mail after unsubscribing', () => {
  // The whole point of a two-scope suppression list: `promotional` stops the
  // offers and leaves the receipts. A customer who unsubscribes has consent
  // null/false — and the transactional templates do not consult it.
  const unsubscribed = booking({ status: 'CONFIRMED', customerMarketingConsent: false })
  for (const t of ['job-reminder', 'final-confirmation', 'booking-updated', 'payment-receipt']) {
    assert.equal(bookingBlockReason(t, unsubscribed, NOW), null, t)
  }
  // ...and a cancellation notice still reaches them, in the state where it is
  // the truthful thing to send.
  assert.equal(
    bookingBlockReason('booking-cancellation', booking({ status: 'CANCELLED', customerMarketingConsent: false }), NOW),
    null
  )
  // ...but the offers stop.
  assert.equal(
    bookingBlockReason('review-request', booking({ status: 'COMPLETED', completedAt: NOW, customerMarketingConsent: false }), NOW),
    'no_marketing_consent'
  )
  // And those operational messages stay operational: the pre-move journey is
  // classified transactional, so it carries no unsubscribe link and no offer.
  const preMove = journeyRegistry().find((j) => j.key === 'pre-move')
  assert.equal(preMove?.emailClass, 'transactional')
  assert.equal(REMINDER_OFFSETS.length, 2, '72h and 24h')
  assert.ok(REMINDER_OFFSETS.every((r) => r.before > 0), 'reminders fire BEFORE the move')
})

// ════════════════════════════════════════════════════════════════════════
//  REGISTRY INTEGRITY — the admin cannot describe a journey nobody runs.
// ════════════════════════════════════════════════════════════════════════

test('the registry describes exactly the journeys the schedulers run', () => {
  const keys = journeyRegistry().map((j) => j.key).sort()
  assert.deepEqual(keys, ['abandoned', 'booking', 'lead-intake', 'lead-nurture', 'post-job', 'pre-move', 'quote'])

  const nurtureJourney = journeyRegistry().find((j) => j.key === 'lead-nurture')!
  assert.equal(nurtureJourney.emailClass, 'promotional')
  assert.deepEqual(
    nurtureJourney.stages.map((s) => s.type),
    LEAD_NURTURE_STAGES.map((s) => s.type),
    'the admin timeline must match the scheduler'
  )
  assert.deepEqual(
    nurtureJourney.stages.map((s) => s.delayMs),
    LEAD_NURTURE_STAGES.map((s) => s.delay)
  )
  // The abandoned journey is unchanged by this pass.
  assert.equal(ABANDONED_STAGES.length, 3)
})

test('every lifecycle template the worker can send has a registry entry', () => {
  const worker = src('workers/email.worker.ts')
  const block = worker.slice(worker.indexOf('const ALLOWED_TEMPLATES'), worker.indexOf('const TEMPLATES:'))
  // From the opening `([` so the generic parameter `EmailJobData['template']`
  // is not mistaken for a template key.
  const allowed = block
    .slice(block.indexOf('(['))
    .match(/'([a-z0-9-]+)'/g)!
    .map((s) => s.replace(/'/g, ''))
  assert.ok(allowed.length >= 20, 'the allowlist scan found suspiciously few entries')
  const registered = new Set(templateRegistry().map((t) => t.key))
  const missing = allowed.filter((k) => !registered.has(k))
  assert.deepEqual(missing, [], `templates with no registry entry: ${missing.join(', ')}`)
})

// ════════════════════════════════════════════════════════════════════════
//  CONTROLLED ROLLOUT — the recipient allowlist (owner spec 2026-08-06)
//  ---------------------------------------------------------------------
//  A journey used to have two settings: off, and on for every eligible person.
//  These cover the third one, and in particular the two ways a canary gate can
//  be actively dangerous: defaulting to "block everything", and reaching
//  transactional mail.
// ════════════════════════════════════════════════════════════════════════

test('rollout: an UNSET allowlist restricts nobody', () => {
  // THE FAILURE THIS PREVENTS: an empty or unpropagated variable becoming a
  // silent, total marketing outage. Restriction must be opt-IN.
  assert.equal(inRolloutAllowlist('anyone@example.com', null), true)

  const prev = process.env.EMAIL_PROMOTIONAL_ALLOWLIST
  try {
    delete process.env.EMAIL_PROMOTIONAL_ALLOWLIST
    assert.equal(rolloutAllowlist(), null)
    process.env.EMAIL_PROMOTIONAL_ALLOWLIST = '   '
    assert.equal(rolloutAllowlist(), null, 'whitespace is not a list')
    process.env.EMAIL_PROMOTIONAL_ALLOWLIST = ' , ,, '
    assert.equal(rolloutAllowlist(), null, 'a list of nothing is not a list')
  } finally {
    if (prev === undefined) delete process.env.EMAIL_PROMOTIONAL_ALLOWLIST
    else process.env.EMAIL_PROMOTIONAL_ALLOWLIST = prev
  }
})

test('rollout: a configured allowlist admits addresses and whole domains', () => {
  const list = ['diego@moveitclearit.com', '@moveitclearit.com']
  assert.equal(inRolloutAllowlist('diego@moveitclearit.com', list), true)
  assert.equal(inRolloutAllowlist('sebastian@moveitclearit.com', list), true, 'domain entry')
  assert.equal(inRolloutAllowlist('DIEGO@MoveItClearIt.com ', list), true, 'address-normalised')
  assert.equal(inRolloutAllowlist('someone@example.com', list), false)
  // A domain entry must not match by suffix — `@clearit.com` is a different
  // company, and `evilmoveitclearit.com` is an attacker's.
  assert.equal(inRolloutAllowlist('a@notmoveitclearit.com', ['@moveitclearit.com']), false)
  assert.equal(inRolloutAllowlist('', list), false)
})

test('rollout: the canary NEVER touches transactional mail', () => {
  // A receipt, a confirmation and a move-day reminder must arrive during a
  // canary. Asserted at the source, because the gate lives inside the
  // `emailClass === 'promotional'` branch and that placement IS the guarantee.
  // Line endings are whatever git checked out, so the slice boundaries are
  // matched as patterns rather than as literal text with a `\n` in it.
  const s = src('lib/email-guard.ts')
  const start = s.search(/if \(emailClass === 'promotional'\) \{\s*\r?\n\s*\/\/ ── 4a\. CONTROLLED ROLLOUT/)
  assert.ok(start > -1, 'the rollout gate must sit inside the promotional branch of guardedSend')
  const promoBlock = s.slice(start, s.indexOf('// ── 5. payload validation'))
  assert.match(promoBlock, /inRolloutAllowlist\(email, allowlist\)/, 'the check must be inside the promotional branch')
  assert.equal(
    (s.match(/!inRolloutAllowlist\(/g) ?? []).length,
    1,
    'exactly one place in the guard may refuse on the allowlist'
  )
  // ...and it is checked BEFORE quiet hours, so an operator reading the ledger
  // sees the real reason rather than a deferral they will chase for an hour.
  assert.ok(
    promoBlock.indexOf('not_in_rollout_allowlist') < promoBlock.indexOf('quiet_hours'),
    'the canary reason must win over the quiet-hours deferral'
  )
})

test('rollout: an excluded recipient is RETRYABLE, never terminal', () => {
  // A real lead captured during the canary must not have its idempotency key
  // permanently burned — widening the allowlist has to be able to rescue it.
  assert.equal(classifyBlock('not_in_rollout_allowlist'), 'retryable')
  assert.notEqual(classifyBlock('not_in_rollout_allowlist'), 'terminal')
})

test('rollout: the schedulers refuse too, so the queue stays honest', () => {
  // Two gates, same as every other rule here: the scheduler avoids filling the
  // queue with certain refusals, and the send gate is the guarantee.
  const j = src('lib/journeys.ts')
  for (const fn of ['export async function onQuoteCreated', 'export async function onLeadCaptured']) {
    const body = j.slice(j.indexOf(fn), j.indexOf('await enqueue(', j.indexOf(fn)))
    assert.match(body, /inRolloutAllowlist\(/, `${fn} must apply the allowlist before enqueueing`)
  }
  const e = src('lib/email-eligibility.ts')
  const booking = e.slice(e.indexOf('export async function bookingMarketingBlockReason'))
  assert.match(booking, /inRolloutAllowlist\(/, 'booking-scoped sequences too')
  assert.match(booking, /customer: \{ select: \{ email: true/, 'and it must load the address to check it')
})

test('rollout: the preflight is read-only', () => {
  // A preflight that can change state is a preflight nobody dares to run.
  const s = readFileSync(resolve(__dirname, '..', '..', '..', 'scripts/email-rollout-preflight.ts'), 'utf8')
  for (const forbidden of ['.create(', '.update(', '.updateMany(', '.delete(', '.deleteMany(', '.upsert(', 'Queue(', '.add(']) {
    assert.ok(!s.includes(forbidden), `the preflight must not call ${forbidden}`)
  }
  // ...and it must not be able to reach a send path at all. Asserted on the
  // IMPORTS rather than on the word: the file legitimately mentions Resend in
  // prose ("reconcile against the Resend dashboard"), and a test that fails on
  // a comment teaches people to weaken the test.
  const imports = (s.match(/^import .*$/gm) ?? []).join('\n')
  assert.ok(!/guardedSend/.test(imports), 'the preflight must not import guardedSend')
  assert.ok(!/['"].*\/resend['"]/.test(imports), 'the preflight must not import the Resend client')
  assert.ok(!/['"].*\/queues['"]/.test(imports), 'the preflight must not import a queue')
})

// ════════════════════════════════════════════════════════════════════════
//  THE UNSUBSCRIBE MIRROR (found by a production smoke test, 2026-08-06)
//  ---------------------------------------------------------------------
//  `unsubscribeEmail` sets Customer.marketingOptOut = true. Nothing ever set
//  it back, so somebody who unsubscribed and then clicked "keep me subscribed"
//  had their suppression row deleted, was shown "You are back on the list",
//  and stayed permanently blocked — promotionalConsentBlockReason reads that
//  flag and `marketing_opted_out` classifies as TERMINAL. The page was telling
//  them something untrue.
// ════════════════════════════════════════════════════════════════════════

test('resubscribe un-mirrors the flag that unsubscribe set', () => {
  const s = src('lib/email-suppression.ts')
  const unsub = s.slice(s.indexOf('export async function unsubscribeEmail'))
  const resub = s.slice(s.indexOf('export async function resubscribe'), s.indexOf('export type UnsubscribeResult'))

  assert.match(unsub, /data: \{ marketingOptOut: true \}/, 'unsubscribe sets the mirror')
  assert.match(resub, /data: \{ marketingOptOut: false \}/, 'resubscribe must clear the same mirror')
  // Only when a suppression was ACTUALLY removed — clearing an opt-out for
  // somebody who was never suppressed would be inventing consent.
  assert.ok(
    resub.indexOf('if (count > 0)') < resub.indexOf('marketingOptOut: false'),
    'the mirror clears only inside the "we removed a row" branch'
  )
  // ...and the outcome is REPORTED, so the page cannot claim a change it did
  // not fully make.
  assert.match(resub, /return \{ status: 'removed', mirrored \}/)
  assert.match(s, /\{ status: 'removed'; mirrored: boolean \}/, 'the type carries the partial-success case')
})

test('the resubscribe page tells the truth when the mirror fails', () => {
  const r = readFileSync(resolve(__dirname, '..', '..', '..', 'app/api/email/unsubscribe/route.ts'), 'utf8')
  assert.match(r, /if \(!result\.mirrored\)/, 'the route must act on the partial-success flag')
  assert.match(r, /You're mostly back/, 'and say so rather than claiming full success')
  // The flag is terminal downstream, which is exactly why a half-done
  // resubscribe must not be reported as done.
  assert.equal(classifyBlock('marketing_opted_out'), 'terminal')
})
