# Admin controls

_Last updated 2026-07-20._

## What exists

There is **no email-marketing admin UI**. There never was — the admin app
(`app/(admin)`) covers bookings, jobs, expenses, owner money, reminders and
roadmap, but nothing for email.

What an owner *can* do today is entirely through data and env:

| Need | How |
|---|---|
| Turn journeys on/off | `EMAIL_JOURNEYS_ENABLED`, `EMAIL_JOURNEY_<NAME>_DISABLED` |
| Turn post-job follow-ups on/off | `MARKETING_FOLLOWUPS_ENABLED` |
| Turn the referral programme on/off | `REFERRAL_PROGRAM_ENABLED` |
| Change frequency caps / quiet hours | `EMAIL_CAP_*`, `EMAIL_QUIET_*` |
| See why an email did not send | query `EmailSend` where `status='blocked'` — `blockedReason` is machine-readable |
| See a customer's email history | query `EmailSend` by `email` |
| See suppression status + reason | query `EmailSuppression` by `email` |
| Find sends stuck mid-flight | `staleClaims()` in `src/lib/email-guard.ts` |
| Allow a deliberate retry of a failed send | `releaseForRetry(idempotencyKey)` — only touches rows that failed with **no** provider id |

The important part is that the *data* to answer "why didn't this customer get
their email?" now exists. Before this pass it did not exist at any level.

## What is missing

Not built in this pass, in rough priority order:

1. **Blocked-send inspector** — a table of recent `EmailSend` rows with reason,
   filterable by customer. This is the highest-value page and is a thin read.
2. **Suppression list view** + a manual add/remove with an audit record.
3. Customer email timeline on the booking detail page.
4. Campaign list / status (draft / active / paused / archived) — needs a
   `Campaign` model, which does not exist.
5. Journey configuration UI (delays, conditions). A structured config page would
   be sufficient; a visual journey builder is not supportable by the current
   architecture and should not be attempted.
6. Send-test-email, desktop/mobile preview.
7. A/B test results — nothing to show; experiments are not implemented.
8. Campaign statistics, bookings generated, revenue generated — blocked on
   attribution (see [tracking-and-attribution.md](./tracking-and-attribution.md)).
