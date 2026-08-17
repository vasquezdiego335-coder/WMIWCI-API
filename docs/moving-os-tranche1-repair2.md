# Tranche 1 — third pass: one root cause, four narrow holes (2026-08-14)

Round 2 closed the headline regressions: the concurrent double-send is gone (exactly-once
is now a database property — a deterministic AuditLog primary key inside the money
transaction), the admin can reach the repair, the webhook lease no longer reports a
killed run as success, and a partial fan-out no longer re-sends what already succeeded.
Those are verified PASS and must not regress.

Verification then found four narrower holes. **Three of them share one root cause**, which
the verifier stated exactly:

> The claim is keyed to the BOOKING and is permanent; the money is keyed to the INTENT.

Fix that alignment and two failures disappear together. The rest are localised.

Standing rules unchanged: no git, no database commands, never edit package.json (report
new test files), no pricing constants, no removal of existing work, no claim the database
cannot prove. Build rows with the shipped writer. Mutation-test every assertion, and
prove your harness can still SEE the original defect (the round-2 agent did this and it
is why its work held).

---

## T1 — key the exactly-once claim to the MONEY, not the booking
**Reproduced (regression):** a customer reschedules through the portal, which sets the
booking back to PENDING_APPROVAL for the new date. Re-approval hits the permanent
`pyrcv_<bookingId>` primary key, the unique violation is (correctly) classified as
non-retryable, and the owner's re-approval is reported `already_confirmed` — so **the
customer is never told the new date is confirmed**. Audits stay 1, notifications stay 1.

**Reproduced (latent, worse):** a booking approved against a DIFFERENT intent captures at
Stripe and can NEVER have its Payment row written — the transaction always rolls back on
the primary key, the conflict is non-retryable, and `recordedByAnotherCaller` looks for
the wrong intent. Result: a permanent `commit_failed` loop, the "Retry payment record"
button failing forever, and `bookingPricing` billing the customer that $49 again. No
shipped path reaches it today, which is exactly why it must be closed now rather than
discovered later.

**Fix:** make the claim id a function of the booking AND the payment intent — the same
key the money already uses. A legitimate second approval against a new intent then gets
its own claim, its own Payment row, and its own customer confirmation, while two
concurrent approvals of the SAME intent still collide as they must. Keep everything else
about the mechanism: the claim stays the AuditLog insert inside the money transaction, a
unique violation stays non-retryable, and the loser still asks the database before
reporting anything. Re-run the round-2 concurrency reproductions to prove they still hold.

## T2 — the fulfilment progress list only exists in memory until the end
**Reproduced:** kill the runner after the fan-out and the audit write but before the
single ledger persist. `done` grows only in memory and is flushed once, so the resume
reads `done: []` and re-drives EVERY handoff — a second SMS, a second email, a second
marketing enrolment, two Discord cards, and **two PAYMENT_RECEIVED rows for one $49**.

**Fix:** persist progress incrementally — each handoff records its own completion durably
as it succeeds, so a resume can never re-run it. The audit write needs the same
protection as T1's (it is the same "two rows for one $49" harm). If incremental persistence
is genuinely impossible for a handoff, that handoff must be idempotent by deterministic
job id instead; say which you chose and why.

## T3 — a swallowed ledger read is a skip reported as success, with the lease still held
**Reproduced:** on the resume path the lease is taken by conditional update, then the
payload read fails and is swallowed by `.catch(() => null)`. The function returns
`already-fulfilled-or-not-pending`, which is NOT one of the reasons the caller throws on
— so the webhook is marked `processed`, the Stripe event is retired, the outstanding
customer email and Discord card never happen, and the lease is left held for 60s with
nothing to release it.

**Fix:** a read failure is not a state. Do not swallow it — release the lease and report a
reason the caller treats as retryable, so Stripe redelivers. Audit the OTHER reasons the
caller does not throw on and confirm each genuinely means "finished", not "unknown".

## T4 — the R5 sibling guard is itself read-then-write, and R7's fallback moved rather than left
**R5:** the stated scenario now passes (the stranded booking no longer suppresses the good
one — 3 stages restored). But the new evidence check reads the sibling's queue/ledger state
while the sibling writes that state moments later, so `Promise.all` of two near-simultaneous
submissions (a double-click) both pass. Make the decision atomic, or make the downstream
enqueue idempotent so a double-scheduled sequence collapses.

**R7:** the Discord card is now honest — but the `?? booking.depositAmount` fallback was
RELOCATED into the money writer (`intent.amount_received ?? intent.amount ?? booking.depositAmount`),
where it has four consumers instead of one, and the code's own type declares both Stripe
fields optional. If Stripe does not tell us the captured amount, the system must not invent
one. Remove the fallback and make the unknown case explicit end to end.

## Definition of done
Every reproduction above fails to reproduce, proven the way it was proven. The round-2
PASSes still hold (re-run their reproductions). `npx tsc --noEmit` clean,
`npm run test:moving-os` green, new test files reported for the gate. No new mechanism may
be a read-then-write two callers can pass, and no message may state what the database
cannot support.
