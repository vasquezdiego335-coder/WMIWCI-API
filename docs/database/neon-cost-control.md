# Neon idle-cost control

## Goal

Let the production Neon compute suspend when Move It Clear It has no real
database work, without delaying normal booking emails or weakening durable
recovery.

This release requires no database migration and does not delete or rewrite any
customer data.

## What changed

The previous worker host claimed pending `email_jobs` every three seconds. The
claim is an `UPDATE ... RETURNING` transaction even when it returns zero rows,
so Neon never saw a five-minute idle period.

The production path is now:

1. A payment, approval, or reschedule commits its outbox row in Postgres.
2. After the commit returns, the API publishes an `outbox-email-drain` nudge to
   the existing BullMQ scheduled queue.
3. The worker drains the outbox immediately.
4. If the process or Redis fails between steps 1 and 2, the durable Postgres row
   remains pending and `outbox-email-recovery` drains it in the next shared
   15-minute recovery window.

The campaign, automation, lead-notification, suppression, monitoring, email
agent, and outbox recovery jobs now all run on `*/15 * * * *`. The hourly
lifecycle repair moved from `:35` to `:00`, inside that same window. On worker
boot, stale BullMQ repeatables are removed; otherwise the former 2-, 5-, and
10-minute schedules would remain active alongside the new ones.

Normal customer activity is still immediate. Only recovery and maintenance can
wait up to 15 minutes.

## Deployment

1. Deploy the same commit to the API and combined worker services.
2. Keep `OUTBOX_ENABLED` identical on both services. It can remain `true`; this
   cost fix does not require switching back to the legacy email path.
3. Do not run `npm run outbox:start` as another production service. The combined
   `npm run host:start` process owns event-driven draining and recovery.
4. No Prisma migration command is needed for this release.
5. Restart the worker once so it registers the desired repeatables and prunes
   the old schedules.

Expected worker log:

```text
Combined worker host running ... event-driven outbox ...
```

The production worker must not log an outbox line showing `poll=3000ms`.

## Neon console settings

Code can create idle windows, but the Neon project must be allowed to use them:

1. Confirm **Scale to Zero** is enabled for the production compute.
2. Use the lowest suspend delay your plan and acceptable cold-start latency
   permit. Five minutes is conservative; a shorter delay reduces the scheduled
   background floor further.
3. Set a modest autoscaling ceiling for this low-volume application. Start with
   0.5 CU maximum rather than leaving an unnecessarily high limit, then raise it
   only if measured request latency requires it.
4. Use Neon's pooled connection hostname for application traffic. Keep migration
   and shadow-database connections separate and direct. Never point
   `SHADOW_DATABASE_URL` at production.

Do not paste connection strings into a ticket, chat, log, or commit. Update them
only in the deployment provider's encrypted environment-variable settings.

## Expected cost effect

With no customer activity and Neon's default five-minute suspend delay, one
quarter-hour wake window has a theoretical background active-time floor of
about one third of the month instead of the entire month. Using the audit's
0.25-CU Scale-plan assumptions, that is roughly **$13.50/month** in compute
instead of **$40.52/month**, before real traffic and any off-window daily jobs.

If the project supports and uses a one-minute suspend delay, the same simplified
background model is roughly **$2.70/month**. These are models, not invoice
promises; verify them against Neon's per-compute usage chart after deployment.

## Verification

Immediately after deployment:

- `GET /healthz` on the worker returns `200` and reports six BullMQ workers.
- Worker logs identify the outbox as `event-driven` when enabled.
- One internal/test booking event produces an `outbox-email-drain` job and the
  associated `email_jobs` row reaches `sent` or an explicit policy-blocked
  terminal outcome.
- Queue repeatables contain no `*/2`, `*/5`, `*/10`, or `5-59/10` schedule for
  the managed recovery jobs.

After at least 30 quiet minutes:

- Neon's compute timeline shows idle/suspended gaps between quarter-hour wake
  windows.
- No customer email is left pending longer than 15 minutes.

After 24 hours, compare compute active time with the day before deployment.
Billing is usage-based, so a past charge is not reversed; the lower usage shows
up in the next invoice period.

## Rollback

Revert this release and redeploy both services on the same commit. That restores
the former polling and schedules. No data rollback is required because the
change adds no schema objects and the durable `email_jobs` rows are unchanged.
