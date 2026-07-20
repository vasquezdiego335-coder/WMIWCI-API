# Staging plan

_Last updated 2026-07-20. **Nothing in this document has been executed yet** —
this pass had no database, Redis, or provider access._

## Preconditions

1. Apply the migration: `npx prisma migrate deploy` (adds three tables, backfills
   `marketing_opt_out` into the suppression list). Additive and re-runnable.
2. Set `RESEND_WEBHOOK_SECRET`, `EMAIL_TOKEN_SECRET`, `APP_URL`,
   `EMAIL_SUPPRESSION_API_KEY`, `BUSINESS_POSTAL_ADDRESS`.
3. Register the Resend webhook at `{APP_URL}/api/email/webhook`.
4. Leave every journey flag OFF for scenarios 1–5; enable per scenario.

**Use synthetic customers only.** Suggested fixtures — no real data:
`staging+lead1@moveitclearit.test`, `staging+abandon1@…`, `staging+bounce1@…`,
`staging+complaint1@…`, `staging+referral1@…`. Resend provides
`bounced@resend.dev` and `complained@resend.dev` for deterministic events.

## Scenarios

### 1 · Unsubscribe (release blocker)
- Send any promotional template to a synthetic address.
- Confirm the `List-Unsubscribe` header is present and the URL resolves.
- `POST` it with no `Accept: text/html` → expect `200 {ok:true}`, no page.
- Confirm an `EmailSuppression` row (`UNSUBSCRIBED`, scope `promotional`) **and**
  `Customer.marketingOptOut = true`.
- Re-POST → still 200 (idempotent), still one row.
- Attempt another promotional send → `EmailSend` row `blocked / unsubscribed`.
- Attempt a **transactional** send → must still deliver.
- Tamper one character of the token → invalid page, no suppression written.

### 2 · Bounce and complaint
- Send to `bounced@resend.dev` → confirm `EmailEvent type='bounced'` and, if the
  payload says permanent, `EmailSuppression HARD_BOUNCE` scope `all`.
- Send to `complained@resend.dev` → `SPAM_COMPLAINT`, scope `all`.
- Attempt a **transactional** send to that address → must be BLOCKED.
- Replay the same webhook body → expect `{result:'duplicate'}`, no second row.
- POST with a corrupted `svix-signature` → 400, nothing written.

### 3 · Abandoned recovery + stop-on-payment
- `EMAIL_JOURNEYS_ENABLED=true`. Create a booking, do not pay.
- Confirm three `scheduled` jobs with ids `journey:abandoned:*:<bookingId>`.
- Let stage 1 fire → one email, `EmailSend` `sent`, journey `abandoned`.
- Complete the deposit → confirm the remaining jobs are removed.
- Force-run a removed stage manually → must record `blocked / booking_advanced:*`.

### 4 · Idempotency
- Run the same email job twice (re-add with the same booking + template).
- Expect exactly ONE provider send and a second outcome of `duplicate`.
- Kill the process between claim and provider response, then re-run: the row
  stays `claimed`, no resend, and `staleClaims()` surfaces it.

### 5 · Frequency caps and quiet hours
- Make three promotional sends eligible for one address in a day.
- Expect 1 sent, 2 `blocked / cap_daily`.
- Send a transactional email, then immediately a promotional one → expect a
  `transactional_gap` deferral carrying a `retryAt`.
- Move the clock (or the env hours) into quiet hours → expect a `quiet_hours`
  deferral, then delivery inside the window.

### 6 · Referral eligibility
Build six synthetic bookings and confirm exactly one sends:
completed+Stripe+paid+receipt (**sends**); non-Stripe; pending payment;
refunded; cancelled; no `AuditLog(RECEIPT_SENT)`.
Then set `REFERRAL_PROGRAM_ENABLED=false` and confirm the eligible one stops too.

### 7 · Cross-system suppression
- `GET /api/email/suppression?email=` with a wrong key → 401.
- With no key configured → 503.
- With the right key → the correct `suppressed` answer.
- `POST` a Leadtracking unsubscribe → confirm the row, then confirm this system
  refuses to send promotional mail to that address.

### 8 · Quote follow-up (once a trigger exists)
- Set `Lead.quotedAt`, call `onQuoteCreated`. Confirm three jobs.
- Set `bookedAt` → confirm all three cancel and a forced run records
  `lead_converted`.
- A lead with `quotedAt = null` must schedule nothing.

## Evidence to capture

For each scenario: the `EmailSend` rows (id, template, status, blockedReason),
the `EmailEvent` rows, the queue job ids, and the Resend message ids.
**Redact recipient addresses in anything shared.**
