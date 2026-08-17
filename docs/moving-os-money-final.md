# Money paths — final pass, plus lifecycle and stale holds (2026-08-14)

Round 3 settled the durability half: the fulfilment progress list is now persisted
incrementally (a kill mid fan-out no longer re-runs handoffs or writes a second
PAYMENT_RECEIVED), a failed ledger read is no longer a skip reported as success, and
every earlier guarantee — exactly-once as a database property, the admin-reachable
repair, the webhook lease, the un-re-sent partial fan-out — still holds. **Do not
regress any of those.**

Three things remain on the money paths, then two whole blockers that have not been
started.

---

## M1 — the invented captured amount (FAILED THREE ROUNDS RUNNING; an ownership error)
`src/lib/booking-approval.ts:1355`
```
const capturedCents = intent.amount_received ?? intent.amount ?? booking.depositAmount
```
Byte-identical to HEAD; three separate verifiers have now flagged it. It survived
because the contracts split ownership so that nobody owned it: the agent assigned R7 was
told to report rather than edit this file, and the agent who owned this file was briefed
only on the claim key. **That is an orchestration failure, not an agent failure** — this
pass gives one owner both.

Reproduced: drive the shipped `approveBooking` with a Stripe capture response carrying
NEITHER amount field (legal per the module's own `CapturedIntent` type). Result: the
Payment row, the audit row, the customer's confirmation email, the owner's ops alert and
the admin retry message ALL state a dollar figure taken from a booking column rather
than from Stripe. Proven by setting `booking.depositAmount = 12345` and watching 12345
be recorded as captured.

**Fix:** remove the fallback. If Stripe does not report the captured amount, the system
does not know it — every consumer (ledger, audit, email, alert, card, retry message)
must render the unknown case explicitly rather than a number. `intentCaptureState`
returns `captured` on `status === 'succeeded'` with no amount at all, so the unknown
case is reachable and must be handled, not assumed away.

## M2 — the reschedule fix rests on an assumption Stripe does not honour
Round 3's reschedule repair is load-bearing on a test fake whose `capture()` returns
`succeeded` unconditionally. Stripe idempotency keys expire after **24 hours**, and this
module's own comment (`booking-approval.ts:336-339`) says so: *"a blind capture is
unsafe: Stripe's idempotency keys expire after 24h, so re-capturing an already-captured
intent errors instead of deduping."* `convergeConfirmed` refuses to blind-capture for
exactly that reason — while `approveBooking` blind-captures on the very reschedule path
T1 claims to fix. A reschedule approved more than 24h after the original capture
therefore errors rather than confirming.

**Fix:** the reschedule path must ask Stripe what the intent's state actually is (the
same discipline `convergeConfirmed` already applies) instead of blind-capturing, and the
test fake must model the real contract — a capture of an already-captured intent outside
the idempotency window ERRORS. Fix the fake first: a fake that cannot express the
failure cannot prove the fix.

## M3 — a test asserts a conclusion the database contradicts
`src/lib/__tests__/fulfilment-progress.test.ts:717-729` seeds a state the verifier
reproduced as a PERMANENT LOSS and asserts it is *finished*
(`reason === 'already-fulfilled-or-not-pending'`, mapped to "finished" at :808). Both
files are green while the hole stands, so the gate cannot see it, and the test name
states the conclusion.

**Fix:** correct the underlying behaviour at `fulfillment.ts:901-909` and make the test
assert what the database supports. When a future pass fixes this, the temptation will be
to keep the test and drop the fix — leave a comment saying so.

---

## B7/B8 — the lifecycle blocker (NOT STARTED; highest frequency of the nine)
Verified findings are in `docs/moving-os-blocker-findings.md`. The short version: the
crew taps "Complete Job" on the Discord move-day card — the way jobs are ACTUALLY
completed — and the customer receives **nothing**: no completion email, no reminder for
the balance still owed, no review request, no referral, no repeat-customer follow-up.
It is unrecoverable afterwards because the admin then offers only "Archive". Separately
the admin route sets `Job.completedAt` but not `Booking.completedAt` (which gates
follow-ups), does not set the Job to CANCELLED on cancellation (so crew keep seeing a
cancelled move in "upcoming" and more crew can be assigned to it), and does not write
Job + Booking + Audit in one transaction.

**Fix:** ONE shared transactional lifecycle service that both the admin route and the
Discord handler call, updating Booking + Job + Audit together and then emitting the
completion events idempotently. Cancellation must mark the Job cancelled so the existing
crew guard can finally fire.

## B6 — expired checkouts leave permanent truck holds (NOT STARTED)
`checkout.session.expired` is only logged, while a PENDING_PAYMENT booking holds its
truck — and the 30-minute expiry means the ordinary "let me ask my wife" customer trips
it. The stuck row is permanent: no transition out of PENDING_PAYMENT is allowed and
`truckId` is not editable, so the Action Center raises a CRITICAL `truck-double-booked`
alert the owner can never resolve at source — training him to dismiss the one guard
against genuinely double-booking a truck.

**DANGER, from the verified findings:** an expiry handler keyed on `metadata.bookingId`
ALONE will cancel bookings mid-payment, because the resume route issues a new session
without persisting its id. The session-identity guard and that persistence must land
together. The fix must be more careful than the bug.

Also note: admin-created bookings never enter the abandoned-checkout journey at all
(`onBookingCreated` is wired only into the public route), so a customer who abandons an
admin checkout gets no recovery email AND no cleanup.

## Definition of done
Every reproduction above fails to reproduce, proven by running the shipped code with
failure injected at the exact seam. Every earlier guarantee re-verified. No claim of a
captured amount the database cannot support. `npx tsc --noEmit` clean,
`npm run test:moving-os` green, new test files reported for the gate.
