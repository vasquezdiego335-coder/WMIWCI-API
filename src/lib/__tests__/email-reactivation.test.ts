// ════════════════════════════════════════════════════════════════════════
//  REACTIVATION + LIFECYCLE-BEATS-CAMPAIGNS (owner spec 2026-08-07)
//  ---------------------------------------------------------------------
//  The business rule under test, stated once: Day 14 does NOT mean "an email
//  goes out on day 14". It means the person AGES INTO the campaign pool —
//  the deterministic audience may now select them, the discovery sweep may
//  notice them, and a human-approved campaign may reach them. Until then, a
//  lifecycle owns them and campaigns must wait.
// ════════════════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  NURTURE_WINDOW_DAYS,
  QUOTE_JOURNEY_WINDOW_DAYS,
  REACTIVATION_AGE_DAYS,
  activeLifecycleReason,
  activeRecoveryReason,
  reactivationAnchor,
  reactivationBlockReason,
  reactivationCutoff,
  type ReactivationLead,
} from '../email-reactivation'

const DAY = 24 * 60 * 60 * 1000
const NOW = new Date('2026-08-07T15:00:00.000Z')
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY)

function lead(over: Partial<ReactivationLead> = {}): ReactivationLead {
  return {
    email: 'sam@example.com',
    emailMarketingConsent: true,
    quotedAt: null,
    bookedAt: null,
    convertedBookingId: null,
    lostAt: null,
    moveDate: null,
    lastActivityAt: daysAgo(20),
    createdAt: daysAgo(30),
    ...over,
  }
}

// ── The 14-day rule ─────────────────────────────────────────────────────

test('a quoted lead is owned by the quote journey, then waits, then enters the pool', () => {
  // Day 2: mid-journey — the lifecycle owns them.
  assert.equal(reactivationBlockReason(lead({ quotedAt: daysAgo(2) }), NOW), 'active_quote_journey')
  // Day 10: journey finished, but not yet aged in — nobody may email them.
  assert.equal(reactivationBlockReason(lead({ quotedAt: daysAgo(10) }), NOW), 'too_recent')
  // Day 15: in the pool. Eligible for SELECTION — not an automatic send.
  assert.equal(reactivationBlockReason(lead({ quotedAt: daysAgo(15) }), NOW), null)
})

test('a contact lead ages on activity, not creation', () => {
  // Re-submitting the form restarts the intent clock: 20 days old but active
  // 2 days ago means the nurture window still owns them.
  assert.equal(
    reactivationBlockReason(lead({ lastActivityAt: daysAgo(2), createdAt: daysAgo(20) }), NOW),
    'active_nurture'
  )
  assert.equal(reactivationBlockReason(lead({ lastActivityAt: daysAgo(10) }), NOW), 'too_recent')
  assert.equal(reactivationBlockReason(lead({ lastActivityAt: daysAgo(14) }), NOW), null)
})

test('crossing day 14 changes ELIGIBILITY, not behaviour — nothing here sends', () => {
  // The module exports predicates and cutoffs only. A grep over the CODE
  // (comments stripped — a scan that reads its own prose proves nothing)
  // shows it cannot send or schedule: no queue, no prisma, no fetch.
  const src = readFileSync(resolve(__dirname, '../email-reactivation.ts'), 'utf8')
    .split('\n')
    .filter((l) => {
      const t = l.trim()
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    })
    .join('\n')
  for (const forbidden of ['guardedSend', 'scheduledQueue', 'emailQueue', 'prisma', 'fetch(']) {
    assert.ok(!src.includes(forbidden), `email-reactivation.ts must not reference ${forbidden}`)
  }
})

// ── Strict consent (the non-negotiable) ─────────────────────────────────

test('only an explicit true qualifies — null, false, and no email all refuse', () => {
  assert.equal(reactivationBlockReason(lead({ emailMarketingConsent: null }), NOW), 'no_marketing_consent')
  assert.equal(reactivationBlockReason(lead({ emailMarketingConsent: false }), NOW), 'no_marketing_consent')
  assert.equal(reactivationBlockReason(lead({ email: null }), NOW), 'no_email')
})

test('converted, lost, and moved-already leads never re-enter the pool', () => {
  assert.equal(reactivationBlockReason(lead({ bookedAt: NOW }), NOW), 'lead_converted')
  assert.equal(reactivationBlockReason(lead({ convertedBookingId: 'bk_1' }), NOW), 'lead_converted')
  assert.equal(reactivationBlockReason(lead({ lostAt: NOW }), NOW), 'lead_lost')
  assert.equal(reactivationBlockReason(lead({ moveDate: daysAgo(3) }), NOW), 'move_date_passed')
})

// ── The lifecycle-ownership windows ─────────────────────────────────────

test('the windows cover the journey spans plus a day of deferral slack', () => {
  // Sequence A's last stage is +7d; the window must extend past it.
  assert.equal(QUOTE_JOURNEY_WINDOW_DAYS, 8)
  // Sequence B and checkout recovery both end at +72h.
  assert.equal(NURTURE_WINDOW_DAYS, 4)
  // Inside the window: owned. Outside: free.
  assert.equal(activeLifecycleReason({ quotedAt: daysAgo(7.5), lastActivityAt: null, createdAt: daysAgo(9) }, NOW), 'active_quote_journey')
  assert.equal(activeLifecycleReason({ quotedAt: daysAgo(8.5), lastActivityAt: null, createdAt: daysAgo(9) }, NOW), null)
})

test('an unpaid booking owns its customer for the recovery window, then lets go', () => {
  const b = (createdDaysAgo: number, over: Partial<Parameters<typeof activeRecoveryReason>[0]> = {}) => ({
    status: 'PENDING_PAYMENT',
    depositPaid: false,
    createdAt: daysAgo(createdDaysAgo),
    ...over,
  })
  assert.equal(activeRecoveryReason(b(1), NOW), 'active_checkout_recovery')
  assert.equal(activeRecoveryReason(b(5), NOW), null, 'recovery journey has finished')
  assert.equal(activeRecoveryReason(b(1, { depositPaid: true }), NOW), null, 'paid = not in recovery')
  assert.equal(activeRecoveryReason(b(1, { status: 'CONFIRMED' }), NOW), null)
})

// ── Anchors + cutoff ────────────────────────────────────────────────────

test('the anchor prefers the quote, then activity, then creation', () => {
  const q = daysAgo(3), a = daysAgo(2), c = daysAgo(30)
  assert.equal(reactivationAnchor({ quotedAt: q, lastActivityAt: a, createdAt: c }).getTime(), q.getTime())
  assert.equal(reactivationAnchor({ quotedAt: null, lastActivityAt: a, createdAt: c }).getTime(), a.getTime())
  assert.equal(reactivationAnchor({ quotedAt: null, lastActivityAt: null, createdAt: c }).getTime(), c.getTime())
})

test('the SQL cutoff and the predicate agree on the boundary', () => {
  const cutoff = reactivationCutoff(NOW)
  assert.equal(NOW.getTime() - cutoff.getTime(), REACTIVATION_AGE_DAYS * DAY)
  // A lead anchored exactly ON the cutoff is admitted by the predicate, so a
  // SQL `lte: cutoff` matches the same population.
  assert.equal(reactivationBlockReason(lead({ quotedAt: cutoff }), NOW), null)
})

// ── The audience layer actually applies these rules ─────────────────────

function audienceSrc(): string {
  return readFileSync(resolve(__dirname, '../email-audience.ts'), 'utf8')
    .split('\n')
    .filter((l) => {
      const t = l.trim()
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    })
    .join('\n')
}

test('both reactivation segments exist and enforce consent IN the SQL', () => {
  const src = audienceSrc()
  assert.match(src, /quick_quote_reactivation/)
  assert.match(src, /contact_lead_reactivation/)
  const seg = src.slice(src.indexOf("case 'quick_quote_reactivation'"), src.indexOf("case 'abandoned_booking'"))
  assert.match(seg, /emailMarketingConsent: true/, 'the segment query itself requires the opt-in')
  assert.match(seg, /reactivationCutoff\(/, 'the 14-day rule comes from the one module, not a scattered constant')
})

test('LIFECYCLE BEATS CAMPAIGNS: dispatch AND preview both exclude actively-owned people', () => {
  const src = audienceSrc()
  // Both pipelines must CALL the shared lookup — the exclusion cannot exist
  // in one and not the other, or the owner's preview count lies about sends.
  const calls = (src.match(/lifecycleOwnedEmails\(emails\)/g) ?? []).length
  assert.equal(calls, 2, `both pipelines call the lifecycle lookup (found ${calls})`)
  // Dispatch records the machine-readable reason; preview counts the bucket.
  assert.match(src, /active_lifecycle:\$\{owned\}/)
  assert.match(src, /excluded\.activeLifecycle\+\+/)
  // The predicate is imported from the one rules module, never restated.
  assert.match(src, /activeLifecycleReason/)
  assert.match(src, /activeRecoveryReason/)
})

test('a booking-scoped candidate keeps its OWN recovery conversation', () => {
  // The abandoned_booking segment IS the recovery audience; excluding a
  // candidate from it because they are in checkout recovery would empty the
  // segment by definition. The exemption is asserted here.
  const src = audienceSrc()
  const exemptions = (src.match(/c\.bookingId && owned === 'active_checkout_recovery'/g) ?? []).length
  assert.ok(exemptions >= 2, 'both pipelines carry the booking-scoped exemption')
})
