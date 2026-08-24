// ════════════════════════════════════════════════════════════════════════
//  migration-table-names.test.ts — every table a migration writes to must be
//  a table the Prisma datamodel actually maps to.
//
//  WHY THIS EXISTS. Both migrations in this release were written as
//  `ALTER TABLE "leads"`. The Prisma `Lead` model maps to `crm_leads`
//  (@@map("crm_leads")), and production ALSO carries a separate, empty,
//  28-column legacy `leads` table. The migrations would have applied cleanly,
//  reported success, added ten columns to the dead table — and left the real
//  one without them. Every quick-quote capture would then have thrown on the
//  missing column, been swallowed by capturePartialLeadSafe, and answered
//  HTTP 200 with the lead gone. Silent loss, monitoring green.
//
//  2720 tests did not catch it, and could not have: the suite builds its
//  database from schema.prisma, so Prisma creates the table from the model's
//  @@map and the raw migration SQL is never executed. The SQL and the
//  datamodel were never compared to each other by anything.
//
//  This test compares them. It is pure text analysis — no database, no
//  network, no Prisma engine.
// ════════════════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(__dirname, '../../..')
const SCHEMA = resolve(ROOT, 'prisma/schema.prisma')
const MIGRATIONS = resolve(ROOT, 'prisma/migrations')

/** Every physical table name the datamodel can produce. */
function physicalTables(): Set<string> {
  const src = readFileSync(SCHEMA, 'utf8')
  const names = new Set<string>()

  // `@@map("crm_leads")` — the explicit physical name.
  const mapRe = /@@map\(\s*"([^"]+)"\s*\)/g
  for (let m = mapRe.exec(src); m; m = mapRe.exec(src)) names.add(m[1])

  // A model with no @@map is stored under its own name.
  const modelRe = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm
  for (let m = modelRe.exec(src); m; m = modelRe.exec(src)) {
    if (!/@@map\(/.test(m[2])) names.add(m[1])
  }
  return names
}

/** Tables a migration writes to, with the line each claim came from. */
function tablesWrittenBy(sql: string): Array<{ table: string; line: number }> {
  const out: Array<{ table: string; line: number }> = []
  sql.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim()
    if (line.startsWith('--')) return // prose, not a statement
    const m = /\b(?:ALTER|CREATE)\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"([^"]+)"/i.exec(line)
    if (m) out.push({ table: m[1], line: i + 1 })
  })
  return out
}

/** Migrations this release adds — the ones a reviewer is accountable for. */
const RELEASE_MIGRATIONS = ['20260822120000_quote_price_snapshot', '20260822130000_quote_review_and_mileage']

test('release migrations write only to tables the datamodel maps to', () => {
  const known = physicalTables()
  assert.ok(known.has('crm_leads'), 'sanity: the Lead model maps to crm_leads')

  for (const name of RELEASE_MIGRATIONS) {
    const file = resolve(MIGRATIONS, name, 'migration.sql')
    assert.ok(existsSync(file), `${name}/migration.sql must exist`)
    const targets = tablesWrittenBy(readFileSync(file, 'utf8'))
    assert.ok(targets.length > 0, `${name} must contain at least one table statement`)

    for (const { table, line } of targets) {
      assert.ok(
        known.has(table),
        `${name}/migration.sql:${line} writes to "${table}", which no Prisma model maps to. ` +
          `A migration that targets a table the datamodel does not use applies cleanly and ` +
          `changes nothing the application reads.`,
      )
    }
  }
})

test('the quote snapshot columns land on crm_leads, not the legacy leads table', () => {
  // The specific defect, pinned by name. "leads" exists in production as an
  // empty legacy table, so targeting it is silently successful — which is
  // exactly why this needs its own assertion rather than a generic one.
  for (const name of RELEASE_MIGRATIONS) {
    const sql = readFileSync(resolve(MIGRATIONS, name, 'migration.sql'), 'utf8')
    for (const { table, line } of tablesWrittenBy(sql)) {
      assert.equal(
        table,
        'crm_leads',
        `${name}/migration.sql:${line} targets "${table}". The Lead model is @@map("crm_leads").`,
      )
    }
  }
})

/** The ten columns this release introduces. Named, because `quote_*` also
 *  matches nine pre-existing confirmation-delivery columns that these
 *  migrations correctly do NOT touch. */
const SNAPSHOT_COLUMNS = [
  'quote_base_cents',
  'quote_truck_cents',
  'quote_total_cents',
  'quote_included_truck',
  'quote_mileage_status',
  'quote_price_book_version',
  'quote_mileage_cents',
  'quote_billable_miles',
  'quote_requires_review',
  'quote_review_reasons',
]

test('each snapshot column is in BOTH the datamodel and a migration', () => {
  // The other half of the same seam. A field added to the datamodel with no
  // migration reaches production as a missing column and fails the same silent
  // way; a migration with no field is a column nothing reads. Both directions
  // have to hold, so both are asserted.
  const leadBlock = /^model\s+Lead\s*\{([\s\S]*?)^\}/m.exec(readFileSync(SCHEMA, 'utf8'))
  assert.ok(leadBlock, 'the Lead model must be findable')
  const body = leadBlock[1]

  const allSql = RELEASE_MIGRATIONS.map((n) =>
    readFileSync(resolve(MIGRATIONS, n, 'migration.sql'), 'utf8'),
  ).join('\n')

  for (const col of SNAPSHOT_COLUMNS) {
    assert.match(
      body,
      new RegExp(`@map\\(\\s*"${col}"\\s*\\)`),
      `no Lead field maps to "${col}" — the migration would add a column nothing reads`,
    )
    assert.match(
      allSql,
      new RegExp(`ADD COLUMN IF NOT EXISTS\\s+"${col}"`),
      `schema.prisma maps a Lead field to "${col}" but no release migration adds that column`,
    )
  }
})

test('no migration in the tree writes to a table no model maps to', () => {
  // Repo-wide sweep. Historical migrations legitimately reference tables that
  // were later renamed or superseded, so those are allowed — but the exception
  // is scoped to the EXACT migrations that already contain it.
  //
  // A blanket `RETIRED = { leads: '…' }` would have let a NEW migration write
  // to `leads` and pass this test, which is the precise failure it exists to
  // catch. So the allowance is a (migration, table) pair: the historical
  // migrations below may mention `leads`; any migration not on this list may
  // not, and adding one to the list is a visible, reviewable act.
  const known = physicalTables()

  // `leads` is the pre-CRM lead table: superseded by crm_leads and kept empty
  // in production. These three migrations are the COMPLETE, EXACT set that
  // already writes to it. The list is enumerated by name rather than derived
  // from a timestamp cutoff, because a cutoff is not a scope — a new migration
  // named with an older timestamp would slip straight through it, which is
  // exactly the failure this test exists to prevent.
  const GRANDFATHERED: Record<string, string[]> = {
    '20260713000100_admin_operating_system': ['leads'],
    '20260715000100_lead_ingestion_fields': ['leads'],
    '20260724000000_partial_lead_capture': ['leads'],
  }
  const RETIRED_TABLES = new Set(Object.values(GRANDFATHERED).flat())

  const unexplained: string[] = []

  for (const dir of readdirSync(MIGRATIONS, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    const file = resolve(MIGRATIONS, dir.name, 'migration.sql')
    if (!existsSync(file)) continue
    const allowedHere = GRANDFATHERED[dir.name] ?? []
    for (const { table, line } of tablesWrittenBy(readFileSync(file, 'utf8'))) {
      if (known.has(table)) continue
      if (allowedHere.includes(table)) continue
      unexplained.push(
        `${dir.name}/migration.sql:${line} -> "${table}"` +
          (RETIRED_TABLES.has(table)
            ? `  ("${table}" is a RETIRED table and this migration is not one of the ` +
              `${Object.keys(GRANDFATHERED).length} grandfathered ones — a new migration may never write to it)`
            : ''),
      )
    }
  }

  assert.deepEqual(
    unexplained,
    [],
    'these migrations write to tables no model maps to and no retirement note explains:\n  ' +
      unexplained.join('\n  '),
  )
})
