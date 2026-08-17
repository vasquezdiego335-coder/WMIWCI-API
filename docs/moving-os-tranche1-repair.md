# Tranche 1 repair — the fixes regressed the money paths (2026-08-14)

The B1/B3/B4/B9 repairs closed real defects and **introduced new ones**. Adversarial
verification reproduced each by running the shipped code. Three are strictly worse than
what they replaced. Nothing merges until these are closed.

**Root cause, common to four of the six:** the fixes introduced claim / lease / guard
mechanisms that are **read-then-write in application code** rather than atomic in the
database, or that **release or suppress on partial success**. A guard that two callers
can both pass is not a guard.

Standing rules unchanged: no git, no database commands, never edit package.json (report
test files to add), no pricing constants, no removal of existing work, no message that
claims what the database cannot prove. Build rows with the shipped writer. Mutation-test
every assertion. **Preserve everything verification found correct** — the `capture:${pi}`
idempotency key, the compensating `rollbackClaim`, the Payment/Job upserts, the intent
metadata lookup, and the atomic `PENDING_APPROVAL -> CONFIRMED` claim.

---

## R1 — the repair path double-sends and double-audits (B1, FAIL)
**Reproduced:** `await Promise.all([approve(), approve()])` on an incident booking →
outcomes `['repaired','repaired']`, payments 1, **paymentAudits 2, notified 2**. The
customer gets two "your booking is approved" emails and two SMS; the ledger carries two
PAYMENT_RECEIVED rows for one $49.

`countApprovalAudits` runs BEFORE `commitApprovalWithRetry` and gates both the audit and
the notification, so two callers both read 0. The ordinary approval is protected by the
atomic `claimConfirm`; the repair runs on an already-CONFIRMED row and has no claim at
all. Nothing downstream dedupes: AuditLog has only plain indexes, the queue adds pass no
`jobId`, and `final-confirmation` is transactional so it is exempt from caps.

**Fix:** make exactly-once a DATABASE property, not a read-then-write. Options in order
of preference: a unique constraint that makes a second PAYMENT_RECEIVED for one booking
impossible (additive migration, hand-authored, not applied); or a conditional
`updateMany`-style claim that only one caller can win; plus deterministic `jobId`s on the
email/SMS enqueues so a duplicate handoff collapses in the queue. The notification must
be gated on the same winning claim as the audit.

## R2 — the retry the owner is told to perform is unreachable (B1, FAIL)
`commitFailedMessage` tells the owner "Click Approve again". On the admin surface that is
impossible: `VALID_TRANSITIONS.CONFIRMED = ['SCHEDULED','CANCELLED']` and the 422 fires
BEFORE the approval branch, so `approveBooking` is never called. Only the Discord card
can execute the repair — and that card is delivered best-effort, so the very infra
incident that causes the failure can also remove the only route to the cure.

**Fix:** give the admin an explicit, permission-gated "retry approval / finish payment
record" action that routes to the same convergence path, and make the message name the
action that actually exists on the surface the owner is looking at. Do not weaken the
transition table for ordinary status changes.

## R3 — the webhook lease turns a killed run into a silent success (B3, REGRESSION)
**Reproduced:** runner A stamps `status='processing'` and is killed; the BullMQ retry
10s later sees `claim.count === 0`, **returns normally**, and the worker marks the job
COMPLETED — so the retry chain ends and nothing ever revisits the row. `WEBHOOK_LEASE_MS`
is 10 minutes while every rescue delivery arrives inside 10s–2.5min, so the lease's
stated purpose is inverted. Pre-fix code re-ran the handler for a `processing` row; this
is a regression that converts a retryable event into a permanently lost one.

**Fix:** a skip must never be reported as success unless the event is genuinely finished.
Distinguish "another runner holds a LIVE lease" (return non-2xx / throw so the delivery
is retried later) from "finished" (2xx). Size the lease to the real retry cadence, and
make an expired lease reclaimable. The test must assert what the skip COSTS THE CALLER,
not merely that exclusivity happened — that is the adjacent-assertion trap again.

## R4 — releasing the fulfilment claim makes the retry double-send (B4, REGRESSION)
**Reproduced:** with a partial fan-out (SMS + marketing succeeded, email + card failed),
`fulfillPaidCheckout` returned `no-durable-handoff` and RELEASED the claim; the forced
Stripe retry re-ran the whole fan-out → **2 SMS, 2 marketing enrolments**. And this is
the mainline case, not a corner: the documented Upstash failure is `queue.add()` HANGING,
and the 5s race ABANDONS the add without cancelling it, so a handoff recorded `ok:false`
can still land later.

**Fix:** never re-run work that already succeeded. Record per-handoff state durably and
retry ONLY the outstanding handoffs; use deterministic job ids so a late-landing add
collapses instead of duplicating. Keeping the claim (pre-fix behaviour) is safer than
releasing it — if you release, you must have per-handoff idempotency first.

## R5 — phantom-sibling suppression kills the recovery sequence (B9, REGRESSION)
**Reproduced with the shipped `onCheckoutStarted`:** a booking stranded by a kill used to
be DRAFT and did not match `siblingUnpaidBooking`; now it is PENDING_PAYMENT and DOES —
so the customer's good re-submission is suppressed. After a strand NEITHER booking gets a
recovery email: stages scheduled went from 3 to **0**. The log line even claims "an
earlier unpaid booking already owns a recovery sequence", which the database cannot
support — that booking owns no sequence.

**Fix:** suppress only when a sequence GENUINELY EXISTS for the sibling (check the
scheduled work, not the status), and make the log statement provable.

## R6 — the scheduled money detector is dead on arrival
`vercel.json` runs the reconciliation daily; the route requires `CRON_SECRET`, which
appears NOWHERE else in the repo — not in `.env.example` (19KB and otherwise exhaustive),
not in DEPLOY.md, not in any doc. As shipped it 403s every day, with one log line. Every
detection credited to the B1 fix therefore does not run.

**Fix:** document the variable everywhere the others are documented, state plainly what
is lost until it is set, and make a refused scheduled run raise the ops alert rather than
only logging. This is the project's recurring "presence != configuration" failure.

## R7 — owner-facing card can still print an unproven amount
`app/api/discord/interactions/route.ts:99` still reads
`capturedCents ?? booking.depositAmount ?? 4900` under a hardcoded "Deposit captured".
The convergence path legitimately returns `capturedCents: null` when a Payment row exists
but is not COMPLETED, so the card can assert a capture the code did not verify.

**Fix:** print only what is proven; when the amount is unknown, say so.

## Definition of done
Every reproduction above must fail to reproduce, proven the same way it was proven
(drive the shipped code, inject the failure at the exact seam). No fix may re-run work
that already succeeded, and no guard may be a read-then-write that two callers can pass.
`npx tsc --noEmit` clean, `npm run test:moving-os` green (it currently has one failure
from a concurrent refactor — fix it), and every new test in the gate.
