-- ═══════════════════════════════════════════════════════════════════════════
--  PREFLIGHT — run BEFORE applying 20260825150000_lead_session_unique.
--
--  The migration adds a PARTIAL UNIQUE index on crm_leads(booking_session_id)
--  for OPEN leads. If production already contains two open leads sharing one
--  booking session, CREATE UNIQUE INDEX will FAIL and the migration will abort.
--
--  THAT IS THE DESIGNED BEHAVIOUR, not an accident. Duplicate leads are two
--  halves of one customer — their consent, attribution and enrichment are split
--  across the rows — and deciding which half survives is a business call, not
--  something a migration may guess. Nothing here deletes or merges anything.
--
--  Run every query. Record the output in MIGRATION_PREFLIGHT.md.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. THE BLOCKING QUESTION: are there open duplicates today?
--    Zero rows => the migration will apply cleanly.
SELECT booking_session_id,
       COUNT(*)                       AS open_leads,
       MIN(created_at)                AS first_seen,
       MAX(created_at)                AS last_seen,
       ARRAY_AGG(id ORDER BY created_at) AS lead_ids
FROM   crm_leads
WHERE  booking_session_id IS NOT NULL
  AND  status IN ('NEW', 'CONTACTED', 'QUOTE_SENT', 'FOLLOW_UP')
GROUP  BY booking_session_id
HAVING COUNT(*) > 1
ORDER  BY COUNT(*) DESC;

-- 2. How big is the problem, if there is one?
SELECT COUNT(*) AS sessions_with_duplicates,
       COALESCE(SUM(n) - COUNT(*), 0) AS surplus_rows_to_reconcile
FROM (
  SELECT booking_session_id, COUNT(*) AS n
  FROM   crm_leads
  WHERE  booking_session_id IS NOT NULL
    AND  status IN ('NEW', 'CONTACTED', 'QUOTE_SENT', 'FOLLOW_UP')
  GROUP  BY booking_session_id
  HAVING COUNT(*) > 1
) d;

-- 3. Shape of the table, for the postflight comparison.
SELECT COUNT(*)                                              AS total_leads,
       COUNT(*) FILTER (WHERE booking_session_id IS NULL)    AS null_session_leads,
       COUNT(*) FILTER (WHERE booking_session_id IS NOT NULL) AS session_leads,
       COUNT(DISTINCT booking_session_id)                    AS distinct_sessions
FROM   crm_leads;

-- 4. The legacy tracker table MUST be untouched by this release. Record it.
SELECT (SELECT COUNT(*) FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'leads') AS legacy_leads_columns,
       (SELECT COUNT(*) FROM "leads")                           AS legacy_leads_rows;

-- 5. Price snapshots must not move. Record the count.
SELECT COUNT(*) AS quote_snapshot_columns
FROM   information_schema.columns
WHERE  table_schema = 'public' AND table_name = 'crm_leads' AND column_name LIKE 'quote\_%';

-- 6. Indexes on crm_leads before the change.
SELECT indexname, indexdef
FROM   pg_indexes
WHERE  tablename = 'crm_leads'
ORDER  BY indexname;

-- ═══════════════════════════════════════════════════════════════════════════
--  IF QUERY 1 RETURNS ROWS — STOP. Do not apply the migration.
--
--  Remediation is a REVIEWED, MANUAL merge, and it is not part of this release:
--
--   a. For each session, take the EARLIEST row as the survivor. It holds the
--      first-touch attribution the campaign report joins on.
--   b. Carry forward, from the later rows onto the survivor, ONLY values the
--      survivor is missing: email, phone, name, zips, found_us, the quote_*
--      snapshot, and the attribution columns.
--   c. CONSENT IS NOT MERGED BY RULE. If two rows disagree
--      (email_marketing_consent true vs false), the SAFE value wins: keep the
--      non-consenting state and let the customer opt in again. Never promote a
--      false to a true during a merge.
--   d. Close the surplus rows by setting status = 'LOST' with
--      lost_reason recorded as a duplicate-merge. DO NOT DELETE THEM — they are
--      the evidence of what was merged, and deleting them destroys consent
--      provenance.
--   e. Re-run query 1. Only when it returns zero rows may the migration proceed.
--
--  Closing the surplus rows (rather than deleting) also satisfies the partial
--  index by itself, because the predicate only covers OPEN statuses.
-- ═══════════════════════════════════════════════════════════════════════════
