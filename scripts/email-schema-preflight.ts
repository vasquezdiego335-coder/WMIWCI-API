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
    ],
    indexes: [
      'email_sends_idempotency_key_key',
      'email_sends_status_next_attempt_at_idx',
      'email_sends_email_class_status_sent_at_idx',
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
