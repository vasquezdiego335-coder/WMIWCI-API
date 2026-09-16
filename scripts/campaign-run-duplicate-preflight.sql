-- ═══════════════════════════════════════════════════════════════════════════
--  PREFLIGHT for 20260915120000_campaign_run_single_unfinished  (READ-ONLY)
--
--  Run against production BEFORE `npx prisma migrate deploy`. Every statement is
--  a SELECT; nothing here writes.
--
--  Query 1 must return ZERO rows or the migration fails (by design). If it
--  returns rows, do NOT edit data by hand from here: decide per campaign which
--  run survives (the one with recipients or sends), cancel the other through
--  the admin (cancel run), let it settle, then re-run this preflight.
--  Query 2 must also return zero rows. Queries 3-5 are context.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. BLOCKING: campaigns holding more than one unfinished run.
SELECT campaign_id,
       COUNT(*)                              AS unfinished_runs,
       ARRAY_AGG(id ORDER BY started_at)     AS run_ids,
       ARRAY_AGG(status ORDER BY started_at) AS statuses,
       MIN(started_at)                       AS first_started,
       MAX(started_at)                       AS last_started
  FROM email_campaign_runs
 WHERE status IN ('PREPARING', 'QUEUED', 'SENDING', 'PAUSED', 'CANCELLING')
 GROUP BY campaign_id
HAVING COUNT(*) > 1;

-- 2. Unknown status strings (outside the nine run states) — must be zero rows.
--    status is TEXT, so an unknown value would fall outside the index predicate.
SELECT status, COUNT(*)
  FROM email_campaign_runs
 WHERE status NOT IN ('PREPARING', 'QUEUED', 'SENDING', 'PAUSED', 'CANCELLING',
                      'CANCELLED', 'COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED')
 GROUP BY status;

-- 3. Context: run status distribution.
SELECT status, COUNT(*) FROM email_campaign_runs GROUP BY status ORDER BY 2 DESC;

-- 4. Existing indexes on the table: name, uniqueness, VALIDITY and predicate.
--    A same-named index that is not unique or not valid does not enforce.
SELECT c.relname                              AS index_name,
       i.indisunique                          AS is_unique,
       i.indisvalid                           AS is_valid,
       pg_get_expr(i.indpred, i.indrelid)     AS predicate
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid
 WHERE i.indrelid = 'email_campaign_runs'::regclass;

-- 5. Informational: PREPARING runs the next campaign sweep will mark FAILED.
SELECT id, campaign_id, started_at
  FROM email_campaign_runs
 WHERE status = 'PREPARING'
   AND started_at < now() - interval '15 minutes';

-- 6. Informational (recipient migration 20260915120100): recipients recorded as
--    SUPPRESSED only because the suppression list could not be read. Not
--    changed by any migration; any re-open is a separate owner decision.
SELECT run_id, COUNT(*)
  FROM email_campaign_recipients
 WHERE status = 'SUPPRESSED'
   AND reason = 'suppression_read_failed'
 GROUP BY run_id;
