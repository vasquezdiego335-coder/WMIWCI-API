# Moving OS — external review: 9 release blockers (2026-08-14)

An independent static review of the review bundle returned **nine release-blocking
defects** plus a list of operational fixes, and a clear instruction: do not merge or
deploy commit `a4b5d7a2` until these are closed.

The theme is **durability and truthfulness around money and lifecycle**. The previous
rounds hardened the *booking* path; this review found the *payment, webhook and
completion* paths are not durable, and that several customer-facing messages describe
outcomes the code did not verify. That is the same failure class this project keeps
hitting — a claim the system cannot prove — now on the money side.

## Method for this round (unchanged discipline)
1. **VERIFY EACH FINDING FIRST.** The review was static, against a bundle, not a
   runnable repo. Some findings may be inaccurate, already handled, or WORSE than
   described. Confirm each in the real code with file:line before changing anything,
   and say plainly when the reviewer is wrong.
2. Trace the DEFAULT path: admin Book Move → `stripe_link` → PENDING_PAYMENT → Stripe
   paid → PENDING_APPROVAL → `approveBooking` → CONFIRMED.
3. Never invent a time for a day-level booking. Never change pricing constants. Never
   run migrations or deploy. Never remove existing work.
4. **No message may claim** something was sent, released, captured, refunded, charged,
   scheduled, assigned or current unless the code can prove it.
5. Mutation-test every new guard: introduce the defect, confirm red, restore.

## The nine blockers, in the reviewer's recommended fix order

### Tranche 1 — payment and webhook durability
**B1. Stripe can capture the deposit while local approval remains incomplete.**
`booking-approval.ts` ~790-873, ~1142-1175. The booking is marked CONFIRMED before
Stripe capture and before the final Payment/Job/Audit transaction. If capture succeeds
and `commitApproval()` fails, a retry only repairs staffing — the booking already reads
CONFIRMED, so the Payment/Job/audit rows never appear.
*Fix:* a durable approval saga / reconciliation. A retry or a Stripe success webhook
must converge on EXACTLY ONE Payment, Job, audit record, staffing plan and customer
notification.

**B3. Stripe webhook events can be permanently lost — or processed twice.**
`stripe-events.ts` ~83-161. If queueing times out, inline processing is attempted; if
that also fails, the handler still returns success, so Stripe never retries. Conversely
the timed-out queue request may later succeed while inline processing also ran.
*Fix:* return non-2xx unless the event is durably stored or processed; atomic event
claim/lease keyed by Stripe event id.

**B4. Paid checkout can report "processed" when every notification handoff failed.**
`fulfillment.ts` ~54-68, ~211-232, ~392-420. Queue and outbox failures are swallowed
while the webhook logs that all jobs were queued — a paid booking can get no customer
message and no Discord approval card.
*Fix:* transactional database outbox with deterministic ids; do not mark fulfillment
processed until durable work exists.

**B9. Public checkout can create an orphaned live Stripe session.**
`app/api/bookings/route.ts` ~504-564. The Stripe session is created before an unguarded
database update; if that update fails the API errors while a usable checkout exists and
the booking stays DRAFT.
*Fix:* Stripe idempotency key derived from booking id, explicit checkout-creation
state, and a safe regenerate/reconcile path.

### Tranche 2 — lifecycle unification
**B7. Admin completion and cancellation leave Booking and Job inconsistent.**
admin status route ~207-230: completion sets `Job.completedAt` but not
`Booking.completedAt`; cancellation does not set the Job to CANCELLED; Job, Booking and
Audit are not one transaction. `Booking.completedAt` gates follow-ups
(`email-eligibility.ts` ~116-122), so completion automation can be silently blocked.
*Fix:* ONE shared transactional lifecycle service updating Booking + Job + Audit
together.

**B8. Discord completion skips customer completion workflows.**
Discord interactions route ~759-780 completes records but never triggers the completion
email, balance reminder, review, referral or repeat-customer automation.
*Fix:* both Discord and admin completion call the same lifecycle service, followed by
idempotent outbox events.

### Tranche 3 — customer-facing truthfulness
**B2. A failed hold release is reported to the customer as successful.**
`booking-approval.ts` ~1009-1065 and the portal ~197-202, ~363-370. Decline marks the
booking CANCELLED first, catches Stripe release failures, then still sends "hold
released" messaging; retrying a cancelled booking does not retry the release. The
generic cancellation route can cancel a CAPTURED booking without refunding while the
portal says the card was never charged.
*Fix:* a CANCEL_PENDING / payment-release state, retry the release, and derive portal
and email wording from the ACTUAL payment/refund status.

**B5. SMS messages are sent at the wrong lifecycle stages.**
Payment/PENDING_APPROVAL queues `final-confirmation-sms` (`fulfillment.ts` ~267-281);
approval/CONFIRMED queues `pre-approval-sms` (`booking-approval.ts` ~1272-1277). They
are swapped. (Noted in an earlier audit as a copy/key inversion and never fixed.)
*Fix:* swap them and test the full payment → approval lifecycle.

### Tranche 4 — stale holds and operational visibility
**B6. Expired Stripe checkouts leave permanent truck holds.**
`stripe-events.ts` ~250-255 only logs `checkout.session.expired`, while
`truck-conflicts.ts` ~102-118 treats PENDING_PAYMENT as occupying the truck — so an
abandoned checkout blocks a truck forever.
*Fix:* on expiry, conditionally expire/cancel the matching booking or clear its truck;
add a periodic reconciliation scan for missed webhooks.

## Operational and logic fixes (same review, lower severity)
- Jobs Today/Week omit date-only bookings and use server-local instead of ET
  boundaries. Use `scheduledStart → confirmedDate → requestedDate` precedence and the
  shared ET helpers.
- "All active" hides PENDING_PAYMENT. Add an **Awaiting Payment** stage with
  resend / regenerate / cancel actions.
- Invalid trucks can be assigned — the server does not require the truck to exist, be
  active, or be available. Validate under the same transaction/lock as the assignment.
- Customer dedup only checks selected id / email, so a phone-only existing customer
  duplicates when a new email is typed. Check normalized phone and return a conflict
  for owner resolution — never silently merge.
- Custom specialty items bypass crew minimums: typing "Piano"/"Safe" raises review
  warnings but can keep an insufficient crew size. Custom items need structured
  heavy-item and minimum-mover fields.
- The portal claims the crew is assigned/locked. Approval creates a staffing
  REQUIREMENT, not acknowledged assignments. Say "booking confirmed; crew assignment in
  progress" until real assignments exist.
- Portal reference formatting is broken: `WMIC-1042` renders as `MIC-IC1042`. Display
  the canonical `bookingReference`/`displayId`.
- Portal trust claims are hardcoded (5.0 rating, verified profile, 2-24h response) —
  make them verified/config-driven or remove them.
- Admin GET validation is weak: invalid status/date/page can reach the database as
  errors, and the accepted `crew` filter is unused.
- Lead PATCH has a race: simultaneous transitions both validate stale status and
  overwrite each other. Conditional update or row lock.
- Missing indexes for repeated truck conflict queries (truck/status/date).
- Truck "today" counts ignore jobs occupying today after starting the previous night.
- The crew card can show both "Start break" and "End break"; expose break state and
  disable actions while one is pending.

## Corrections the reviewer made to OUR documentation
- **`STATUS.txt` was wrong** to call all 18 baseline failures pricing-parity. The
  accurate split is in `docs/deployment.md`: 7 stale in-repo price constants, 9
  sibling-site mirror, 1 site HTML content, 1 missing generated email-preview artifact.
  Our own `deployment.md` already carried this correction; the bundle summary did not
  read it. Fixed.
- Three unapplied migrations, and `db:preflight`/`db:postcheck` do NOT verify the
  moving-OS tables, columns or indexes. No CI or protected merge gate is documented.
  *Fix:* extend preflight/postcheck to assert the new tables/columns/indexes, and
  document (or add) a merge gate.

## Definition of done
Every blocker either fixed and mutation-tested, or refuted with file:line evidence.
`npx tsc --noEmit` clean. `npm run test:moving-os` green. `npm test` shows only the
documented baseline. No claim in any customer- or owner-facing string that the code
cannot prove.
