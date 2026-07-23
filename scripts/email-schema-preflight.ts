/**
 * EMAIL SCHEMA DRIFT PREFLIGHT — finding EMAIL-P2-18.
 *
 *   npx tsx scripts/email-schema-preflight.ts
 *
 * WHY THIS EXISTS: the email-lifecycle migrations use `CREATE TABLE IF NOT
 * EXISTS` and `ADD COLUMN IF NOT EXISTS`. That makes them safely re-runnable,
 * but it also means a PARTIALLY-CREATED or INCOMPATIBLE table is accepted in
 * silence — the migration reports success and the application then fails at
 * runtime on a missing column, in the middle of sending mail.
 *
 * This script inspects what is ACTUALLY in the database and reports every
 * missing table, column, index and constraint the email system depends on.
 * Run it after `prisma migrate deploy` and before enabling any journey.
 *
 * Read-only. It never creates or alters anything.
 * Exit 0 = clean, 1 = drift found, 2 = could not connect.
 */
import { prisma } from '../src/lib/db'

type Expectation = {
  table: string
  columns: string[]
  indexes?: string[]
  constraints?: string[]
}

// Kept in step with prisma/schema.prisma + the four email migrations.
const EXPECTED: Expectation[] = [
  {
    table: 'email_suppressions',
    columns: ['id', 'email', 'reason', 'scope', 'source', 'detail', 'created_at', 'updated_at'],
    indexes: ['email_suppressions_email_key'],
    constraints: ['email_suppressions_scope_check'],
  },
  {
    table: 'email_sends',
    columns: [
      'id', 'idempotency_key', 'email', 'template', 'email_class', 'journey',
      'booking_id', 'lead_id', 'campaign', 'status', 'outcome_class',
      'blocked_reason', 'attempts', 'next_attempt_at', 'provider_id', 'error',
      'sent_at', 'created_at', 'updated_at',
      // Email marketing admin (2026-07-21).
      'campaign_id', 'is_test', 'journey_config_version',
    ],
    indexes: [
      'email_sends_idempotency_key_key',
      'email_sends_status_next_attempt_at_idx',
      'email_sends_email_class_status_sent_at_idx',
      'email_sends_campaign_id_idx',
      'email_sends_is_test_idx',
    ],
    constraints: ['email_sends_status_check', 'email_sends_email_class_check'],
  },
  {
    table: 'email_events',
    columns: [
      'id', 'provider_event_id', 'email_send_id', 'email', 'type', 'detail',
      'processing_status', 'side_effect_attempts', 'side_effect_error',
      'occurred_at', 'created_at', 'updated_at',
    ],
    indexes: ['email_events_provider_event_id_key', 'email_events_processing_status_idx'],
    constraints: ['email_events_processing_status_check'],
  },
  {
    table: 'followup_ledger',
    columns: [
      'id', 'booking_id', 'type', 'channel', 'status', 'error',
      'email_status', 'sms_status', 'email_attempts', 'sms_attempts',
      'email_provider_id', 'sms_provider_id', 'email_last_error', 'sms_last_error',
      'next_attempt_at', 'terminal_reason', 'delivered_at',
      'sent_at', 'created_at', 'updated_at',
    ],
    indexes: ['followup_ledger_status_next_attempt_at_idx'],
    constraints: ['followup_ledger_status_check'],
  },
  // -- Email marketing admin (owner spec 2026-07-21) --
  // These five tables back the campaign composer, the audience builder, journey
  // configuration and automations. Without them the admin pages fail on read.
  {
    table: 'email_audiences',
    columns: [
      'id', 'name', 'description', 'definition',
      'last_preview_count', 'last_preview_at',
      'created_by_id', 'created_by_name', 'created_at', 'updated_at',
    ],
    indexes: ['email_audiences_name_key'],
  },
  {
    table: 'email_campaign_configs',
    columns: [
      'id', 'campaign_id', 'template', 'subject', 'audience_id', 'scheduled_at',
      'approved_by_id', 'approved_by_name', 'approved_at',
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'discount_code',
      'validation', 'status_note', 'dispatched_at', 'dispatched_count',
      'created_by_id', 'created_at', 'updated_at',
    ],
    indexes: ['email_campaign_configs_campaign_id_key'],
    // The audience FK is SET NULL: deleting an audience must not delete the
    // record of a campaign that used it.
    constraints: ['email_campaign_configs_campaign_id_fkey', 'email_campaign_configs_audience_id_fkey'],
  },
  {
    table: 'email_journey_configs',
    columns: [
      'id', 'journey_key', 'enabled', 'version', 'config',
      'updated_by_id', 'updated_by_name', 'created_at', 'updated_at',
    ],
    indexes: ['email_journey_configs_journey_key_key'],
    constraints: ['email_journey_configs_version_positive'],
  },
  {
    table: 'email_automations',
    columns: [
      'id', 'name', 'description', 'status', 'active_version',
      'created_by_id', 'created_by_name', 'created_at', 'updated_at',
    ],
    indexes: ['email_automations_name_key'],
    constraints: ['email_automations_status_known'],
  },
  {
    table: 'email_automation_versions',
    columns: ['id', 'automation_id', 'version', 'definition', 'created_by_id', 'created_by_name', 'created_at'],
    // The unique pair IS the immutability guarantee for a versioned definition.
    indexes: ['email_automation_versions_automation_id_version_key'],
    constraints: ['email_automation_versions_automation_id_fkey', 'email_automation_versions_version_positive'],
  },
]

const problems: string[] = []
const ok: string[] = []

async function columnsOf(table: string): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1`,
    table
  )
  return rows.map((r) => r.column_name)
}

async function indexesOf(table: string): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ indexname: string }>>(
    `SELECT indexname FROM pg_indexes
      WHERE schemaname = current_schema() AND tablename = $1`,
    table
  )
  return rows.map((r) => r.indexname)
}

async function constraintsOf(table: string): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ conname: string }>>(
    `SELECT c.conname FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = $1`,
    table
  )
  return rows.map((r) => r.conname)
}

async function main() {
  console.log('EMAIL SCHEMA PREFLIGHT — read-only drift check\n')

  for (const exp of EXPECTED) {
    const cols = await columnsOf(exp.table)

    if (cols.length === 0) {
      problems.push(`TABLE MISSING: ${exp.table} — the migration has not been applied`)
      continue
    }

    const missingCols = exp.columns.filter((c) => !cols.includes(c))
    if (missingCols.length) {
      // This is the exact hazard IF NOT EXISTS hides: the table is present, so
      // the migration is a no-op, but it is the WRONG shape.
      problems.push(`${exp.table}: missing column(s) ${missingCols.join(', ')} — table exists but is incompatible`)
    } else {
      ok.push(`${exp.table}: ${cols.length} columns`)
    }

    const idx = await indexesOf(exp.table)
    const missingIdx = (exp.indexes ?? []).filter((i) => !idx.includes(i))
    if (missingIdx.length) problems.push(`${exp.table}: missing index(es) ${missingIdx.join(', ')}`)

    const cons = await constraintsOf(exp.table)
    const missingCons = (exp.constraints ?? []).filter((c) => !cons.includes(c))
    if (missingCons.length) {
      problems.push(`${exp.table}: missing constraint(s) ${missingCons.join(', ')} — invalid states are not blocked`)
    }
  }

  // The NotificationStatus enum must carry DEFERRED, or the worker throws when
  // it tries to record a quiet-hours deferral.
  const labels = await prisma.$queryRawUnsafe<Array<{ enumlabel: string }>>(
    `SELECT e.enumlabel FROM pg_enum e
       JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'NotificationStatus'`
  )
  const names = labels.map((l) => l.enumlabel)
  if (names.length === 0) problems.push('enum NotificationStatus not found')
  else if (!names.includes('DEFERRED')) {
    problems.push("enum NotificationStatus is missing 'DEFERRED' — deferrals will fail to record")
  } else ok.push('NotificationStatus includes DEFERRED')

  // -- Enum additions the admin depends on (2026-07-21) --
  const enumLabels = async (typname: string): Promise<string[]> => {
    const rows = await prisma.$queryRawUnsafe<Array<{ enumlabel: string }>>(
      `SELECT e.enumlabel FROM pg_enum e
         JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = $1`,
      typname
    )
    return rows.map((r) => r.enumlabel)
  }

  const campaignStates = await enumLabels('CampaignStatus')
  const neededStates = ['VALIDATING', 'READY', 'SCHEDULED', 'CANCELLED', 'FAILED']
  const missingStates = neededStates.filter((v) => !campaignStates.includes(v))
  if (campaignStates.length === 0) problems.push('enum CampaignStatus not found')
  else if (missingStates.length) {
    problems.push(`enum CampaignStatus is missing ${missingStates.join(', ')} - the campaign lifecycle cannot advance`)
  } else ok.push('CampaignStatus carries the email campaign lifecycle states')

  const auditActions = await enumLabels('AuditAction')
  const neededActions = [
    'EMAIL_SCHEDULED_CANCELLED', 'EMAIL_SEND_RETRIED', 'EMAIL_SUPPRESSION_RESTORED', 'EMAIL_TEST_SENT',
    'EMAIL_CAMPAIGN_CREATED', 'EMAIL_CAMPAIGN_UPDATED', 'EMAIL_CAMPAIGN_APPROVED', 'EMAIL_CAMPAIGN_STATE_CHANGED',
    'EMAIL_AUDIENCE_SAVED', 'EMAIL_AUDIENCE_DELETED', 'EMAIL_JOURNEY_CONFIG_UPDATED', 'EMAIL_JOURNEY_CONFIG_RESET',
    'EMAIL_AUTOMATION_SAVED', 'EMAIL_AUTOMATION_STATE_CHANGED',
  ]
  const missingActions = neededActions.filter((v) => !auditActions.includes(v))
  if (missingActions.length) {
    problems.push(`enum AuditAction is missing ${missingActions.join(', ')} - admin actions will throw when audited`)
  } else ok.push('AuditAction carries every email admin action')

  // -- THE DELETE RULE THAT MATTERS --
  // email_sends.campaign_id must be ON DELETE SET NULL. If a migration were
  // hand-edited to CASCADE, deleting a campaign would erase the record that
  // real people were emailed - silently, and only discovered afterwards.
  const fk = await prisma.$queryRawUnsafe<Array<{ confdeltype: string }>>(
    `SELECT confdeltype FROM pg_constraint WHERE conname = 'email_sends_campaign_id_fkey'`
  )
  if (fk.length === 0) {
    problems.push('email_sends_campaign_id_fkey not found - the campaign relation was never created')
  } else if (fk[0].confdeltype !== 'n') {
    // 'n' = SET NULL, 'c' = CASCADE, 'a' = NO ACTION, 'r' = RESTRICT
    problems.push(
      `email_sends.campaign_id has delete rule '${fk[0].confdeltype}' but MUST be SET NULL ('n'). ` +
        'Deleting a campaign would destroy send history.'
    )
  } else ok.push('email_sends.campaign_id deletes SET NULL (send history survives campaign deletion)')

  for (const line of ok) console.log(`  OK    ${line}`)
  if (problems.length) {
    console.log('')
    for (const p of problems) console.log(`  DRIFT ${p}`)
    console.log(`\n${problems.length} problem(s). Do NOT enable email journeys until these are resolved.`)
    process.exit(1)
  }
  console.log('\nNo drift. Email schema matches what the application expects.')
}

main()
  .catch((err) => {
    console.error('preflight could not run:', err instanceof Error ? err.message : err)
    process.exit(2)
  })
  .finally(() => prisma.$disconnect())
