# Email staging plan

_Last updated 2026-07-21._ Complements
[../email-marketing/staging-plan.md](../email-marketing/staging-plan.md), which
covers the engine. This document covers the **admin** scenarios.

## Environment

Railway staging + staging Neon + Redis + a Resend test configuration +
`EMAIL_TEST_RECIPIENT`. **Not** Vercel previews — those are not the real API.
**No real customers**, and no production promotional sending for rehearsal.

## Required migration

```
npx prisma migrate deploy
```

Applies `20260721190000_email_admin_audit_actions` and
`20260721210000_email_marketing_admin`. Then:

```
npm run email:preflight     # needs a live DATABASE_URL
npm run email:doctor
```

## Scenarios

| # | Scenario | Pass criterion |
|---|---|---|
| 1 | Template test send | `[TEST]` arrives at the configured recipient; ledger row `isTest = true` |
| 2 | Transactional confirmation | Sends normally; unaffected by the admin |
| 3 | Promotional campaign draft | Created as DRAFT; cannot be set ACTIVE |
| 4 | Audience preview | Counts match the database; exclusions itemised |
| 5 | Suppressed recipient exclusion | Suppressed address absent from eligible count |
| 6 | Promotional unsubscribe | Suppression written; promotional blocked, transactional flows |
| 7 | Hard bounce | Webhook → suppression `scope=all` |
| 8 | Complaint | Suppression written; not restorable in the admin |
| 9 | Webhook replay | Duplicate `providerEventId` is a no-op |
| 10 | Provider failure | Row `provider_rejected`, retryable, reason shown |
| 11 | Deferred send | Quiet hours → `deferred` with `nextAttemptAt` |
| 12 | Queue retry | Resumes the same logical send, no duplicate |
| 13 | Booking state change before dispatch | Send refused with `status_not_allowed:` |
| 14 | Abandoned journey stops after booking | Deposit paid → stages cancelled |
| 15 | Review eligibility | No review → eligible; review exists → excluded |
| 16 | Referral eligibility | Positive review required |
| 17 | Campaign click → booking | UTM lands on the booking |
| 18 | Booking → collected revenue → finalized profit | Only finalized snapshots counted |
| 19 | Campaign pause | ACTIVE → PAUSED; no further dispatch |
| 20 | Campaign cancellation | Reason required and recorded |
| 21 | Journey config version stability | Sends in flight keep their version |
| 22 | Customer timeline | Multiple bookings + campaigns render, refusals visible |
| 23 | Direct campaign relation | New send stores `campaignId`; deleting the campaign leaves the send |
| 24 | Test sends excluded from conversions | Attribution unchanged by a test send |
| 25 | Manager and crew denied | UI **and** direct API requests return 403 |

Record each as PASS/FAIL with the evidence type (database row, queue job,
provider dashboard, browser). Separate pure-test evidence from live evidence.
