# Rollback

_Last updated 2026-07-20._

## Fast stop (no deploy)

**Stop all new journey scheduling** — unset, or set to anything but `true`:

```
EMAIL_JOURNEYS_ENABLED
MARKETING_FOLLOWUPS_ENABLED
REFERRAL_PROGRAM_ENABLED
```

This prevents new sequences from being scheduled. It does **not** drain jobs
already queued — but every queued stage re-reads the flag and the booking state
before sending, so a disabled journey's pending jobs no-op on arrival.

**Stop everything already queued**, if needed: pause the BullMQ queues, or scale
the worker service to zero. Pausing is preferred — it preserves the jobs for
inspection instead of discarding them.

**Stop a single address immediately** — insert an `ADMIN_BLOCK` suppression:

```sql
INSERT INTO email_suppressions (id, email, reason, scope, source, created_at, updated_at)
VALUES (gen_random_uuid()::text, lower('someone@example.com'),
        'ADMIN_BLOCK', 'all', 'admin', NOW(), NOW())
ON CONFLICT (email) DO UPDATE SET reason = 'ADMIN_BLOCK', scope = 'all';
```

## Code rollback

Revert to the commit before `2436a9fb`. The three send paths return to calling
Resend directly.

**Understand what that loses**: suppression, the unsubscribe route,
bounce/complaint processing, and idempotency — i.e. all four release blockers
come back. Prefer disabling journeys via flags over reverting code.

## Database

The migration is **additive only**: it creates three new tables and touches no
existing column.

**Do not roll it back.** Leaving the tables in place is harmless when the code is
reverted, and dropping them destroys the suppression list — which is both an
operational record and a legal one.

The backfill wrote suppression rows for customers who had already opted out via
SMS `STOP`. Those rows are correct regardless of which code version is deployed.

## Templates

Template changes are ordinary code — revert the specific file. Note that two
reverts would reintroduce defects the new tests now reject: the old referral hero
was a raw gift emoji, and the old abandoned-checkout stage-1 copy contained an
invented-scarcity line ("before someone else takes the slot"). `npm test` will
fail rather than let either ship again.
