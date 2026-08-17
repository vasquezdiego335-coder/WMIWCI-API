# Money/lifecycle — closing pass (2026-08-14)

M2 (reschedule capture), M3 (orphaned fan-out) and every earlier money guarantee verified
PASS and must not regress. Three things remain, and the first is a **decision, not a
patch**.

---

## D1 — REVERT the automatic checkout cancellation (the fix is more dangerous than the bug)
The B6 fix does the thing its own contract warned about. Verified reproductions:

- **Mid-payment cancellation via the sweep.** `expiredOnItsOwnSchedule` (the guard) is
  applied only in the webhook handler; `sweepStaleCheckouts` goes straight from
  `previousSessionVerdict === 'gone'` to `releaseExpiredCheckoutHold`. A booking whose
  customer is being redirected into a fresh session is **CANCELLED** while they pay. The
  module header claims "THREE INDEPENDENT GUARDS, all of which must hold" and "both go
  through the SAME conditional statement" — neither is true of the sweep path.
- **No concurrency required.** The resume route retires the recorded session, then keeps
  the dead id when replacement fails. Within one sweep interval the booking is
  terminally cancelled. The customer clicked "finish your booking", something hiccuped,
  and their booking is gone.
- **Terminal.** `VALID_TRANSITIONS` has no key out of CANCELLED (and none out of
  PENDING_PAYMENT), so neither the owner nor the customer can undo it.

Weigh the two harms honestly. The bug: a stale truck hold — friction, an override the
owner already has, and un-actionable CRITICAL noise. The fix: **cancelling a paying
customer's booking, irreversibly.** That trade is unacceptable.

**Decision: remove the automatic cancellation.** Keep only what is provably safe:
1. The `checkout.session.expired` handler may RECORD the expiry (audit/log) and surface
   it. It must NOT cancel a booking or release a hold on its own.
2. Give the owner an explicit, permission-gated, audited **"release this truck hold"**
   action on the booking — a human decides, with the booking in front of them.
3. Keep the reconciliation sweep as a REPORT (it finds holds whose webhook was missed)
   and surface those in the Action Center. Reporting is safe; automatic cancellation is
   not.
4. Delete or clearly neutralise the sweep's cancellation path and any test that asserts
   automatic cancellation is correct — do not leave a dormant loaded gun.

If a future pass wants automatic cancellation, it needs a durable record of every live
session per booking (which is exactly what the resume route does not keep today), not a
fourth guard bolted onto an unsound one.

## D2 — M1's remaining two paths (the ones that actually ship)
The approval module is fixed, but the invented amount survives where it matters:
- **The OUTBOX email path**, which `EMAIL-REGISTRY.md` calls "the live setting":
  `ApprovedPayload` carries no amount at all, so `premiumEmails.tsx` falls through to
  `dollarsFromCents(b?.depositAmount)`. Reproduced end to end: `depositAmount = 12345` →
  the customer's confirmation reads **"Your $123.45 deposit is applied to your move"**.
- **The payment-receipt resend route**, which builds `amountPaid` from `depositAmount`
  and `captured` from `depositPaid`.

**Fix:** carry the proven amount (or its absence) through the outbox payload and the
receipt route, and render the unknown case the same way the approval path now does. A
receipt is the strongest claim the system makes about money — it must never be derived
from an intention column.

## D3 — the lifecycle EffectReport claims work that was never scheduled
Reproduced with the shipped `followups.ts` / `journeys.ts` through the real
`completeBooking`, **under the shipped default env**
(`EMAIL_JOURNEYS_ENABLED=false`, `MARKETING_FOLLOWUPS_ENABLED=false`):

```
effects: {"email":"queued","followups":"ok","balance":"ok"}
owner sees: "Move-complete email queued · review/referral sequence scheduled ·
             balance reminder scheduled."
```

Nothing was scheduled — both functions return before their enqueue. Same when the
customer has not consented to promotional mail. This is a NEW false claim of exactly the
class this project keeps closing.

**Fix:** the report must distinguish scheduled / skipped-disabled / skipped-no-consent /
failed, and the owner-facing string must say which. "Review request skipped — customer
has not opted in" is useful; "scheduled" when nothing was is not.

Also close the smaller one the verifier named: in `cancelJobForBooking`, a P2002 on the
deterministic audit id rolls back real remediation and is then reported as a skip.

## Definition of done
Every reproduction above fails to reproduce, proven by running the shipped code. No
automatic path may cancel a booking. No message or record may state an amount, or that
work was scheduled, that the system cannot prove. Earlier guarantees re-verified.
`npx tsc --noEmit` clean, `npm run test:moving-os` green, new test files reported.
