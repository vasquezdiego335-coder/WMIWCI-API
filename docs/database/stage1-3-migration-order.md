# Stage 1-3 migration order

26 migrations, applied in filename (timestamp) order. No duplicate prefixes, no
missing `migration.sql`, no divergent-branch collisions.

## The three stage migrations

| # | Migration | Stage | Purpose | Depends on | Additive | Destructive | Safe to retry | Risk |
|--:|---|---|---|---|---|---|---|---|
| 24 | `20260720000100_phase1_jobcrew_labor` | 1 | JobCrew labor + `labor_payments` | `job_crew`, `users`, `business_config` must exist (they do, from `20260713000100_admin_operating_system`) | yes | none | yes (Prisma runs once; `ADD VALUE IF NOT EXISTS`) | CHECK constraints validate existing `job_crew` rows |
| 25 | `20260720000200_phase2_financial_closeout` | 2 | `move_closeouts`, `financial_snapshots`, `reserve_allocations`, `owner_distributions` | `bookings`, `TaskOwner`, `PaymentMethod` | yes | none | yes | cascade FK to `bookings` (P1-2) |
| 26 | `20260720000300_stage3_reporting_analytics` | 3 | `marketing_campaigns`, `marketing_spend`, `saved_report_views`, `report_exports`, attribution columns | `bookings`, `AuditAction` | yes | none | yes | none structural |

## Prior 23 migrations

`20260525000000_deposit_paid_and_truck_addon` · `20260531000000_booking_agreement` ·
`20260607000000_add_customer_locale` · `20260611000000_add_reschedule_fields` ·
`20260619000000_manual_events` · `20260619010000_owner_tasks` ·
`20260629000000_phase2_phase3_attribution_followups` ·
`20260710120000_email_open_tracking` · `20260711130000_service_area` ·
`20260712120000_structured_access_fields` · `20260712130000_admin_operations` ·
`20260712140000_audit_booking_details_updated` ·
`20260712160000_verified_address_and_test_payments` ·
`20260712170000_waiting_time_policy` · `20260713000000_admin_os_audit_actions` ·
`20260713000100_admin_operating_system` · `20260713020000_action_center_audit_actions` ·
`20260713020100_action_center_and_roadmap` · `20260713040000_hardening_audit_actions` ·
`20260713040100_hardening_scan_and_lifecycle` · `20260713120000_booking_reference` ·
`20260715000100_lead_ingestion_fields` · `20260715000200_payment_refund_dispute`

None are email-system migrations; the email work in the tree is application code
only and adds no migrations.

## Enum-only migrations

Four earlier migrations are audit-enum-only (`admin_os_audit_actions`,
`action_center_audit_actions`, `hardening_audit_actions`, and the
`AuditAction` blocks inside the three stage migrations). All use
`ALTER TYPE … ADD VALUE IF NOT EXISTS` and none *use* the new value in the same
file, so the PostgreSQL same-transaction restriction is not triggered.

## Final safe order

```
(23 existing migrations, already in the chain)
  -> 20260720000100_phase1_jobcrew_labor
  -> 20260720000200_phase2_financial_closeout
  -> 20260720000300_stage3_reporting_analytics
```

Apply **one at a time**, verifying between each. Do not run all three blind.
