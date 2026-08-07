// Offline tests for the journey stage tables + the quote-follow-up stop rules.
// Pure functions only — scheduling itself needs Redis and is covered by the
// staging scenarios in docs/email-marketing/staging-plan.md.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  ABANDONED_STAGES,
  QUOTE_STAGES,
  REMINDER_OFFSETS,
  jobIdFor,
  quoteFollowupBlockReason,
  type LeadState,
} from '../journeys'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const NOW = new Date('2026-07-20T15:00:00Z')

// ── stage tables ────────────────────────────────────────────────────────

test('abandoned recovery has 3 stages in increasing order', () => {
  assert.equal(ABANDONED_STAGES.length, 3)
  for (let i = 1; i < ABANDONED_STAGES.length; i++) {
    assert.ok(ABANDONED_STAGES[i].delay > ABANDONED_STAGES[i - 1].delay, `stage ${i} must be later`)
  }
})

test('recovery stage 1 is a fast follow, not instant and not next-week', () => {
  const first = ABANDONED_STAGES[0].delay
  assert.ok(first >= 30 * 60_000, 'not instant — the customer may still be checking out')
  assert.ok(first <= 2 * HOUR, 'still same-session-ish')
})

test('quote follow-up stages are 24h / ~3d / ~7d', () => {
  assert.deepEqual(
    QUOTE_STAGES.map((s) => s.delay),
    [24 * HOUR, 3 * DAY, 7 * DAY]
  )
})

test('every stage type is unique — two stages must never share an idempotency slot', () => {
  const all = [...ABANDONED_STAGES, ...QUOTE_STAGES].map((s) => s.type)
  assert.equal(new Set(all).size, all.length)
})

test('pre-move reminders fire BEFORE the move, longest lead first', () => {
  assert.equal(REMINDER_OFFSETS.length, 2)
  assert.ok(REMINDER_OFFSETS[0].before > REMINDER_OFFSETS[1].before)
  for (const r of REMINDER_OFFSETS) assert.ok(r.before > 0)
})

// ── job ids: the queue-level anti-duplication guarantee ─────────────────

test('the same journey/stage/subject always yields the same job id', () => {
  assert.equal(jobIdFor('abandoned', 'stage-1', 'bk1'), jobIdFor('abandoned', 'stage-1', 'bk1'))
})

test('different subjects, stages, or journeys yield different job ids', () => {
  const base = jobIdFor('abandoned', 'stage-1', 'bk1')
  assert.notEqual(base, jobIdFor('abandoned', 'stage-1', 'bk2'))
  assert.notEqual(base, jobIdFor('abandoned', 'stage-2', 'bk1'))
  assert.notEqual(base, jobIdFor('quote', 'stage-1', 'bk1'))
})

// ── quote follow-up stop rules ──────────────────────────────────────────

const lead = (over: Partial<LeadState> = {}): LeadState => ({
  email: 'lead@example.com',
  status: 'QUOTED',
  quotedAt: new Date('2026-07-18T15:00:00Z'),
  bookedAt: null,
  lostAt: null,
  moveDate: new Date('2026-08-15T15:00:00Z'),
  convertedBookingId: null,
  // The fixture is a lead we MAY market to. Quote follow-ups are
  // promotional, so consent is now part of what makes a lead eligible.
  emailMarketingConsent: true,
  ...over,
})

test('a quoted, open lead with a future move date may be followed up', () => {
  assert.equal(quoteFollowupBlockReason(lead(), NOW), null)
})

test('a deleted lead blocks', () => {
  assert.equal(quoteFollowupBlockReason(null, NOW), 'lead_deleted')
})

test('a lead with no email blocks', () => {
  assert.equal(quoteFollowupBlockReason(lead({ email: null }), NOW), 'no_email')
})

test('NO REAL QUOTE means no quote email — the core rule of Stage B', () => {
  assert.equal(quoteFollowupBlockReason(lead({ quotedAt: null }), NOW), 'no_quote')
})

test('a converted lead stops immediately (booked timestamp)', () => {
  assert.equal(quoteFollowupBlockReason(lead({ bookedAt: NOW }), NOW), 'lead_converted')
})

test('a converted lead stops immediately (linked booking)', () => {
  assert.equal(quoteFollowupBlockReason(lead({ convertedBookingId: 'bk1' }), NOW), 'lead_converted')
})

test('a lost lead stops', () => {
  assert.equal(quoteFollowupBlockReason(lead({ lostAt: NOW }), NOW), 'lead_lost')
})

test('a terminal lead status stops, whatever the timestamps say', () => {
  for (const status of ['WON', 'LOST', 'BOOKED', 'CONVERTED', 'won', 'lost']) {
    const r = quoteFollowupBlockReason(lead({ status }), NOW)
    assert.ok(r?.startsWith('lead_status:'), `${status} → ${r}`)
  }
})

test('a passed move date stops the sequence', () => {
  const past = new Date('2026-07-10T15:00:00Z')
  assert.equal(quoteFollowupBlockReason(lead({ moveDate: past }), NOW), 'move_date_passed')
})

test('the move DAY itself is still in play — we allow a full day of grace', () => {
  const today = new Date('2026-07-20T08:00:00Z')
  assert.equal(quoteFollowupBlockReason(lead({ moveDate: today }), NOW), null)
})

test('a lead with no move date is not blocked on that basis', () => {
  assert.equal(quoteFollowupBlockReason(lead({ moveDate: null }), NOW), null)
})

test('conversion is checked before the move date — the strongest signal wins', () => {
  const r = quoteFollowupBlockReason(
    lead({ bookedAt: NOW, moveDate: new Date('2026-07-01T15:00:00Z') }),
    NOW
  )
  assert.equal(r, 'lead_converted')
})

// ════════════════════════════════════════════════════════════════════════
//  PROMOTIONAL CONSENT ON QUOTE FOLLOW-UPS (2026-08-05)
//  quote-followup-1/2/final are not in TRANSACTIONAL_TEMPLATES, so the guard
//  treats them as promotional — caps, quiet hours, an unsubscribe link. The
//  one gate that decided whether to SEND them never asked about consent.
// ════════════════════════════════════════════════════════════════════════

test('a lead who never opted in gets NO quote follow-up', () => {
  // The contact form shows no consent checkbox, so these leads are NULL
  // forever. Before this, marking a quote given sent them three promotional
  // emails.
  assert.equal(quoteFollowupBlockReason(lead({ emailMarketingConsent: null }), NOW), 'no_marketing_consent')
})

test('an explicit decline blocks just as hard as never being asked', () => {
  assert.equal(quoteFollowupBlockReason(lead({ emailMarketingConsent: false }), NOW), 'no_marketing_consent')
})

test('consent is checked BEFORE the quote state — it is the more fundamental fact', () => {
  // A lead with no consent AND no quote reports the consent reason: we may not
  // market to them at all, which is true regardless of what else is missing.
  assert.equal(
    quoteFollowupBlockReason(lead({ emailMarketingConsent: null, quotedAt: null }), NOW),
    'no_marketing_consent'
  )
  // ...but a missing EMAIL still wins: there is nobody to ask.
  assert.equal(quoteFollowupBlockReason(lead({ emailMarketingConsent: null, email: null }), NOW), 'no_email')
})

test('an opted-in lead is unaffected', () => {
  assert.equal(quoteFollowupBlockReason(lead({ emailMarketingConsent: true }), NOW), null)
})

test('the scheduler refuses too, so three doomed jobs are never queued', () => {
  // COMMENTS STRIPPED FIRST. A source-scanning test that reads its own
  // explanatory prose proves nothing — this file's history already has two
  // instances of exactly that.
  const src = readFileSync(resolve(__dirname, '../journeys.ts'), 'utf8')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
    .join('\n')
  const scheduler = src.slice(
    src.indexOf('export async function ensureQuoteJourney'),
    src.indexOf('export async function cancelLeadNurture')
  )
  assert.ok(scheduler.length > 0, 'ensureQuoteJourney is the scheduler')
  // It applies the SHARED matrix rather than a second hand-written consent
  // check — which is what stops the two from ever drifting.
  assert.match(scheduler, /quoteFollowupBlockReason\(/, 'and apply the same rule as the send gate')
  const guard = scheduler.indexOf('quoteFollowupBlockReason(')
  const scheduleAt = scheduler.indexOf('scheduleStages(')
  assert.ok(guard > -1 && scheduleAt > guard, 'the refusal must precede the enqueue')
  // The column has to be LOADED or the rule cannot be applied. It now comes
  // from the deps seam, so the requirement is stated on the shared lead type.
  assert.match(src, /loadLead\(leadId: string\): Promise<JourneyLead \| null>/)
  assert.match(src, /emailMarketingConsent: true/, 'the production loader selects it')
})

test('quoteFollowupBlockReason is the ONE matrix — the scheduler owns no second consent rule', () => {
  // The scheduler used to inline hasPromotionalConsent(). That was correct, but
  // it was a SECOND copy of the rule, and the send gate's copy could change
  // without it. Now there is one predicate and both call it.
  const src = readFileSync(resolve(__dirname, '../journeys.ts'), 'utf8')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
    .join('\n')
  const calls = src.match(/hasPromotionalConsent\(/g) ?? []
  assert.equal(calls.length, 2, 'exactly two call sites: quoteFollowupBlockReason and leadNurtureBlockReason')
})

test('the send gate LOADS the consent column — a gate that cannot see it cannot enforce it', () => {
  const src = readFileSync(resolve(__dirname, '../journeys.ts'), 'utf8')
  const loader = src.slice(src.indexOf('export async function leadEligibility'))
  assert.match(loader, /emailMarketingConsent: true/)
})
