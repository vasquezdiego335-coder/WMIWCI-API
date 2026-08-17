# Customer-facing money truth + lifecycle honesty (2026-08-15)

D1 is DONE and verified: no automatic path can cancel a booking or release a hold. The
owner gets a named, permission-gated, audited "release truck hold" action that refuses
what it cannot prove is safe; stale holds are a REPORT plus an Action Center reminder
that stays silent when it cannot prove age. Tests asserting automatic cancellation were
removed, with a source guard so they cannot come back. **Do not regress any of that.**

D3's main half is done too (the effect report no longer claims work that never happened).

What remains is **one wide problem and three narrow ones**. The wide one absorbs the
tranche-3 blocker (B2), so they are fixed together by one owner rather than two agents
editing the portal.

---

## C1 — every customer-facing surface must state only money the system can prove
The approval path was fixed; the surfaces were not. Verified FAILs:

- The **"proof" rule itself accepts money Stripe never reported** in both renderers —
  the rule was written to accept a value the ledger has, but the ledger figure can
  originate from the booking column. Fix the rule, not just its callers.
- **The proven amount never travels on the OUTBOX event** in shipped code, so the live
  path still falls back.
- More renderers read `depositAmount` directly: the **admin cancellation email**
  (customer-facing), the **customer portal**, the **declined email**, **Discord cards**,
  the **admin money page**, and the **pre-approval hold figure**.
- The **receipt route** has an unhandled ledger-read failure and a migration-window twin.

**Fix:** ONE owner for every customer- and owner-facing money renderer. Carry the proven
amount (or its explicit absence) end to end — including on the outbox event — and make
the unknown case render the way the approval path now does. A figure that came from an
intention column may not appear anywhere.

## C2 — the portal lies on every CANCELLED booking (this is blocker B2)
Verified: the portal asserts an outcome it never checked. The original blocker: a failed
hold release still tells the customer *"the authorization on your card was released in
full — you were not charged"*, and cancelling a CAPTURED booking shows *"nothing is
owed"* and *"your card was never charged"* next to a receipt link. In a dispute, the
customer's evidence is our own page.

**Fix:** derive every portal and email statement from the ACTUAL payment/refund state
(`depositPaid`, `Payment.status`, `refundedAmountCents`), not from booking status. Add
the release-retry the original finding called for: a decline whose Stripe release failed
must be retryable and must not tell the customer it succeeded. The correct data is
already on the row the page reads — the page asks the wrong question first.

## C3 — three narrow lifecycle holes
1. `cancelJobForBooking`: a thrown booking READ is still reported as a deliberate skip —
   the same defect as the write seam, one line up.
2. No shipped caller reads the `failed` field the last fix added, so a failure is
   recorded and never surfaced.
3. `cancelBooking` reports `already_cancelled` for a booking that is **COMPLETED**, and
   the route then emails the customer a cancellation for a move that already happened.

## C4 — the release-hold path skips the Job/crew half its two twins perform
Both other cancellation paths update the Job and crew; the new owner release does not,
and it does not stop the booking's journeys or automation enrolments. An acknowledged
release also leaves the Stripe session payable on a booking nothing can consume.

## Definition of done
No customer- or owner-facing string states an amount, a capture, a release, a refund or a
cancellation the system cannot prove from the database. Every reproduction above fails to
reproduce, proven by running the shipped code. Earlier guarantees re-verified.
`npx tsc --noEmit` clean, `npm run test:moving-os` green, new test files reported.
