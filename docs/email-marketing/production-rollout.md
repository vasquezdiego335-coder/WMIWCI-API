# Production rollout

_Last updated 2026-07-20._

## Order (do not reorder)

1. **Migration** — `npx prisma migrate deploy`. Additive, idempotent, safe to
   apply before any code. Creates `email_suppressions`, `email_sends`,
   `email_events`; backfills existing `marketing_opt_out` customers.
2. **Environment** — set on both the API and worker services:
   `EMAIL_TOKEN_SECRET`, `RESEND_WEBHOOK_SECRET`, `EMAIL_SUPPRESSION_API_KEY`,
   `BUSINESS_POSTAL_ADDRESS`, and confirm `APP_URL` is the real public origin.
   Leave every journey flag **unset** (= off).
3. **Backend + routes** — deploy. At this point `/api/email/unsubscribe`,
   `/api/email/webhook` and `/api/email/suppression` exist, and the guard is
   active on all three send paths; **no new journey sends anything.**
   This is a safe, verifiable resting point.
4. **Resend webhook** — register `{APP_URL}/api/email/webhook` for
   `email.sent, delivered, delivery_delayed, bounced, complained, opened, clicked`.
   Verify a test event lands in `EmailEvent`.
5. **Workers** — redeploy so `scheduled.worker` and `email.worker` run the new code.
6. **Soak (48 h)** — existing transactional mail only. Watch for: `EmailSend`
   rows appearing with `status='sent'`, zero unexpected `blocked` reasons, and
   no drop in delivery volume versus the previous week.
7. **Enable journeys one at a time**, waiting ~48 h between each:
   - `EMAIL_JOURNEYS_ENABLED=true` **plus** `EMAIL_JOURNEY_QUOTE_DISABLED=true`
     and `EMAIL_JOURNEY_REMINDERS_DISABLED=true` → abandoned recovery only.
   - then reminders, then (once a trigger is wired) quote.
8. **Referral last** — `REFERRAL_PROGRAM_ENABLED=true` only after confirming a
   real completed booking produces `AuditLog(RECEIPT_SENT)`.

## Gate before enabling ANY promotional journey

- [ ] Migration applied and verified
- [ ] `EMAIL_TOKEN_SECRET` set to a real secret
- [ ] Unsubscribe round-trip verified in production
- [ ] `RESEND_WEBHOOK_SECRET` set, and a real bounce observed suppressing
- [ ] `BUSINESS_POSTAL_ADDRESS` set — **CAN-SPAM requires it and no sender
      currently passes it** (see deliverability.md)
- [ ] SPF / DKIM / DMARC confirmed in the DNS zone, not assumed
- [ ] Staging scenarios 1–7 passed

## Not ready to enable

- **Quote follow-up** — nothing calls `onQuoteCreated` yet.
- **Pre-move reminders** — nothing calls `onMoveDateSet` yet.
- **`referral-reward`** — no trigger detects that a referral converted.
