# Customer journeys

_Last updated 2026-07-20._

## Before this pass

| Stage | State |
|---|---|
| New lead | Leadtracking drip only (SendGrid): welcome+10% → brand story → urgency → re-engagement |
| Quote follow-up | **did not exist** |
| Abandoned booking | template + allowlist ready; **nothing enqueued it** |
| Pre-booking education | none |
| Booking conversion | transactional mail only; no journey to stop |
| Pre-move | pre-approval, confirmation, updates; reminder template **never scheduled** |
| Completed job | review → review reminder → referral → repeat (worked, but referral had **no eligibility gate**) |
| Reactivation | 30-day repeat reminder only |

## Now

### A — New lead
Unchanged. Leadtracking owns this. The only change: its promotional sends can
now consult this system's suppression list (API built; Leadtracking-side call
not yet wired — see [suppression.md](./suppression.md)).

### B — Quote follow-up  *(new, built, not yet triggered)*
`quotedAt` + 24 h → "did your quote come through?"
`quotedAt` + 3 d → "what labor-only actually means" (objection handling)
`quotedAt` + 7 d → "still moving?"

**Constraint, stated plainly:** there is no `Quote` model. These emails do not
restate the quote — any figure would be invented. They confirm a quote was sent
and drive back to the booking form.

Needs: a call to `onQuoteCreated(leadId)` wherever `Lead.quotedAt` gets set.

### C — Abandoned booking recovery  *(new, wired)*
~45 min → the link back (they may simply have been interrupted)
+24 h → what's included
+72 h → did plans change?

No fourth stage by default. No countdown, no "your slot is about to go" — we do
not check live availability at send time, so that would be invented scarcity.
The pre-existing stage-1 copy said *"Lock it in before someone else takes the
slot"*; that line was removed for exactly this reason.

Stops immediately on payment, cancellation, or a passed move date — checked at
dispatch **and** again at send.

### D — Pre-booking education
The stage-2 recovery and stage-2 quote emails carry the education content
(what we bring / what you bring / we don't drive or pack). A standalone
educational series is **not built** — see [segmentation.md](./segmentation.md)
for why the data does not yet support targeting one.

### E — Booking conversion
`onBookingPaid` cancels recovery. `onBookingCancelled` stops every journey.
Conversion attribution is **not** implemented — see
[tracking-and-attribution.md](./tracking-and-attribution.md).

### F — Pre-move transactional
Unchanged, plus the 72 h/24 h reminder scheduler now exists (`onMoveDateSet`),
awaiting a call site at date confirmation.

### G — Completed job
Unchanged sequence, but the referral ask now passes a 10-rule eligibility gate
at **both** schedule and send time. Previously a cancelled, refunded, unpaid, or
internal-test booking could ask a customer to refer their friends.

### H — Reactivation
30-day repeat reminder only. Long-term / seasonal reactivation is **not built**.
