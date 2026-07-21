-- ════════════════════════════════════════════════════════════════════════════
--  Stage 1-3 PREFLIGHT — READ ONLY
--
--  Run against a STAGING database BEFORE applying
--  20260720000100 / 20260720000200 / 20260720000300.
--
--  Every statement is a SELECT. Nothing is modified. No credentials appear here.
--  ANY non-zero count means a CHECK constraint or UNIQUE index in the new
--  migrations would ABORT the migration. Resolve first, then re-run.
-- ════════════════════════════════════════════════════════════════════════════

\echo '=== 0. Environment sanity ==='
SELECT current_database() AS database, version() AS server;

-- PostgreSQL 12+ is required: the migrations use ALTER TYPE ... ADD VALUE
-- inside Prisma's per-migration transaction.
SELECT CASE WHEN current_setting('server_version_num')::int >= 120000
            THEN 'OK: PG12+' ELSE 'FAIL: upgrade required' END AS pg_version_check;

\echo '=== 1. Existing row volumes (sizes the risk) ==='
SELECT 'job_crew' AS t, count(*) FROM job_crew
UNION ALL SELECT 'bookings', count(*) FROM bookings
UNION ALL SELECT 'jobs', count(*) FROM jobs
UNION ALL SELECT 'users', count(*) FROM users
UNION ALL SELECT 'payments', count(*) FROM payments
UNION ALL SELECT 'expenses', count(*) FROM expenses
UNION ALL SELECT 'owner_transactions', count(*) FROM owner_transactions;

-- ── STAGE 1 blockers ────────────────────────────────────────────────────────

\echo '=== 2. job_crew_clock_order: clock_out before clock_in (MUST be 0) ==='
SELECT count(*) AS violations
FROM job_crew
WHERE clock_in IS NOT NULL AND clock_out IS NOT NULL AND clock_out < clock_in;

\echo '=== 3. job_crew_minutes_nonneg: negative legacy hours (MUST be 0) ==='
SELECT count(*) AS violations
FROM job_crew
WHERE COALESCE(actual_hours, 0) < 0
   OR COALESCE(scheduled_hours, 0) < 0
   OR COALESCE(break_minutes, 0) < 0;

\echo '=== 4. job_crew_rates_nonneg: negative legacy rates/pay (MUST be 0) ==='
SELECT count(*) AS violations
FROM job_crew
WHERE COALESCE(pay_rate, 0) < 0
   OR COALESCE(flat_pay, 0) < 0
   OR COALESCE(tips, 0) < 0
   OR COALESCE(bonus, 0) < 0
   OR COALESCE(deductions, 0) < 0;

\echo '=== 5. Duplicate (job_id, user_id) — @@unique already exists, confirm (MUST be 0) ==='
SELECT job_id, user_id, count(*) AS n
FROM job_crew GROUP BY job_id, user_id HAVING count(*) > 1;

\echo '=== 6. Orphan job_crew rows (FK integrity, MUST be 0) ==='
SELECT count(*) AS orphan_jobs  FROM job_crew jc LEFT JOIN jobs j ON j.id = jc.job_id  WHERE j.id IS NULL;
SELECT count(*) AS orphan_users FROM job_crew jc LEFT JOIN users u ON u.id = jc.user_id WHERE u.id IS NULL;

\echo '=== 7. INFORMATIONAL: crew rows whose rate cannot be snapshotted ==='
-- These become rate-less assignments after Stage 1. NOT a blocker: the code
-- reports them as "missing rate" rather than inventing a zero. Review only.
SELECT count(*) AS crew_with_no_rate_anywhere
FROM job_crew jc JOIN users u ON u.id = jc.user_id
WHERE jc.pay_rate IS NULL AND jc.flat_pay IS NULL AND u.pay_rate IS NULL;

\echo '=== 8. INFORMATIONAL: completed jobs with no crew at all ==='
-- These will correctly read as "labor not recorded", never as $0 labor.
SELECT count(*) AS completed_jobs_without_crew
FROM jobs j
WHERE j.status = 'COMPLETED'
  AND NOT EXISTS (SELECT 1 FROM job_crew jc WHERE jc.job_id = j.id);

\echo '=== 9. INFORMATIONAL: users that will be typed OWNER by backfill ==='
SELECT count(*) AS users_backfilled_to_owner FROM users WHERE role = 'OWNER';

-- ── STAGE 2 blockers ────────────────────────────────────────────────────────

\echo '=== 10. Duplicate closeouts (table is new; MUST be 0 or table absent) ==='
SELECT COALESCE(
  (SELECT count(*) FROM information_schema.tables WHERE table_name = 'move_closeouts'), 0
) AS move_closeouts_already_exists;

\echo '=== 11. Payments where refund exceeds capture (Stage 2 HARD blocker data) ==='
-- Not a migration blocker, but every such row makes its move un-finalizable.
SELECT count(*) AS refund_exceeds_capture
FROM payments
WHERE refunded_amount_cents IS NOT NULL AND refunded_amount_cents > amount;

\echo '=== 12. Partially refunded payments with no recorded amount ==='
SELECT count(*) AS unknown_partial_refunds
FROM payments
WHERE status = 'PARTIALLY_REFUNDED' AND refunded_amount_cents IS NULL;

\echo '=== 13. Ownership split must total 100 (Stage 2 reads it) ==='
SELECT diego_split_percent, sebastian_split_percent,
       (diego_split_percent + sebastian_split_percent) AS total,
       CASE WHEN diego_split_percent + sebastian_split_percent = 100
            THEN 'OK' ELSE 'FIX BEFORE DISTRIBUTING' END AS verdict
FROM business_config;

\echo '=== 14. Negative money anywhere in the existing ledgers (MUST be 0) ==='
SELECT count(*) AS negative_expenses FROM expenses WHERE amount < 0;
SELECT count(*) AS negative_owner_tx FROM owner_transactions WHERE amount < 0;
SELECT count(*) AS negative_payments FROM payments WHERE amount < 0;

\echo '=== 15. Expense statuses outside the known enum set (MUST be 0) ==='
SELECT status, count(*) FROM expenses
WHERE status::text NOT IN ('SUBMITTED','NEEDS_REVIEW','APPROVED','REJECTED','REIMBURSED')
GROUP BY status;

-- ── STAGE 3 blockers ────────────────────────────────────────────────────────

\echo '=== 16. Bookings whose first-touch will be seeded (informational) ==='
SELECT count(*) AS bookings_with_a_source
FROM bookings WHERE COALESCE(source, found_us) IS NOT NULL;
SELECT count(*) AS bookings_with_no_source_at_all
FROM bookings WHERE COALESCE(source, found_us) IS NULL;
-- The second number stays UNKNOWN in reporting. It is never guessed.

\echo '=== 17. Column collisions: Stage 3 attribution columns must NOT exist yet ==='
SELECT column_name FROM information_schema.columns
WHERE table_name = 'bookings'
  AND column_name IN ('first_touch_source','last_touch_source','booking_source',
                      'owner_assigned_source','utm_source','utm_medium',
                      'utm_campaign','utm_content','qr_campaign');

\echo '=== 18. New tables must NOT already exist ==='
SELECT table_name FROM information_schema.tables
WHERE table_name IN ('labor_payments','move_closeouts','financial_snapshots',
                     'reserve_allocations','owner_distributions',
                     'marketing_campaigns','marketing_spend',
                     'saved_report_views','report_exports');

\echo '=== 19. New enum types must NOT already exist ==='
SELECT typname FROM pg_type
WHERE typname IN ('CrewWorkerType','CrewRole','CrewAssignmentStatus','TimeEntrySource',
                  'LaborApprovalStatus','LaborPaymentStatus','LaborPayModel','TravelPayPolicy',
                  'CloseoutStatus','OverheadMethod','ReserveKind','SplitMethod',
                  'DistributionStatus','TruckSource','CampaignStatus','CampaignChannel',
                  'SpendKind','ReportExportStatus');

\echo '=== 20. Migration history ==='
SELECT migration_name, finished_at, rolled_back_at
FROM _prisma_migrations ORDER BY started_at DESC LIMIT 10;

\echo '=== 21. Any migration left in a failed state blocks everything ==='
-- `rolled_back_at IS NULL` is REQUIRED. A row with finished_at NULL *and*
-- rolled_back_at SET is a failure that was already resolved with
-- `prisma migrate resolve --rolled-back`. Prisma does not treat those as
-- blocking and neither should this query. Confirmed 2026-07-21 against the
-- staging database, which carries 4 such resolved rows from two July retry
-- loops (attribution_followups and admin_operating_system, each of which
-- failed twice before succeeding on the third attempt).
SELECT migration_name, started_at, logs
FROM _prisma_migrations
WHERE finished_at IS NULL AND rolled_back_at IS NULL;

\echo '=== 21b. Resolved rollbacks (informational, NOT blockers) ==='
SELECT migration_name, started_at, rolled_back_at
FROM _prisma_migrations
WHERE finished_at IS NULL AND rolled_back_at IS NOT NULL;

\echo '=== PREFLIGHT COMPLETE — every violation count above must be 0 ==='
