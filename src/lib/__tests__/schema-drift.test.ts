// ════════════════════════════════════════════════════════════════════════
//  schema-drift.test.ts — the invariants that live OUTSIDE the Prisma
//  datamodel, and therefore outside everything that normally protects them.
//
//  The partial unique index that stops two concurrent captures creating
//  duplicate leads cannot be expressed in the Prisma schema — Prisma has no
//  syntax for a partial unique index. It exists only as hand-written SQL in one
//  migration. That makes it uniquely fragile:
//
//   * `prisma db push` considers it "extra" and DROPS it. The test suite would
//     stay green, because the race only appears under real concurrency.
//   * `prisma migrate dev` would do the same, and would also drop the marketing
//     tracker's separate legacy `leads` table.
//   * A restore that lost it would leave a database that passes every schema
//     check and silently permits the duplicates again.
//
//  So the index is checked HERE, against the live database, rather than trusted
//  because a migration file exists. A file proves intent; only the database
//  proves the constraint.
//
//  Skips without DATABASE_URL rather than pretending to have proven anything.
// ════════════════════════════════════════════════════════════════════════
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { PrismaClient } from '@prisma/client'

const skip = process.env.DATABASE_URL ? false : 'set DATABASE_URL to a disposable PostgreSQL to run the schema-drift gate'
const INDEX = 'crm_leads_open_booking_session_key'
/** The statuses the partial predicate covers. Everything else is CLOSED. */
const OPEN_STATUSES = ['NEW', 'CONTACTED', 'QUOTE_SENT', 'FOLLOW_UP']
const MIGRATIONS = resolve(__dirname, '../../../prisma/migrations')

let prisma: PrismaClient
before(async () => {
  if (skip) return
  prisma = new PrismaClient()
  await prisma.$connect()
})
after(async () => {
  if (skip) return
  await prisma.$disconnect()
})

test('the partial unique index EXISTS in the database, not merely in a file', { skip }, async () => {
  const rows = await prisma.$queryRawUnsafe<{ indexdef: string }[]>(
    `SELECT indexdef FROM pg_indexes WHERE indexname = $1`,
    INDEX,
  )
  assert.equal(
    rows.length,
    1,
    `${INDEX} is MISSING. Something dropped it — most likely \`prisma db push\` or ` +
      `\`prisma migrate dev\`, both of which treat a SQL-only index as extra. Re-apply ` +
      `prisma/migrations/20260825150000_lead_session_unique/migration.sql. Until then, two ` +
      `concurrent captures on one browser session can create duplicate leads.`,
  )
})

test('it is UNIQUE and PARTIAL — not silently rebuilt as a plain index', { skip }, async () => {
  const [row] = await prisma.$queryRawUnsafe<{ indexdef: string }[]>(
    `SELECT indexdef FROM pg_indexes WHERE indexname = $1`,
    INDEX,
  )
  assert.ok(row, 'the index exists')
  //  A plain unique index would forbid a SECOND lead on a session even after the
  //  first was closed — which the product deliberately allows. A non-unique
  //  index would forbid nothing at all. Both are wrong in opposite directions,
  //  and only the definition distinguishes them.
  assert.match(row.indexdef, /CREATE UNIQUE INDEX/i, 'unique')
  assert.match(
    row.indexdef,
    //  `[\s\S]*` rather than the dotAll flag: this project targets an
    //  older lib where /s is a compile error.
    /WHERE [\s\S]*booking_session_id IS NOT NULL/i,
    'partial on a present session id',
  )
  for (const status of OPEN_STATUSES) {
    assert.ok(row.indexdef.includes(status), `the predicate still covers ${status}`)
  }
  //  ── A CLOSED STATUS MUST NOT BE IN THE PREDICATE ──────────────────────
  //  ...or a customer who came back later could never be captured again.
  //
  //  THIS CHECK USED TO BE VACUOUS. It asserted the absence of `'WON'` and
  //  `'LOST'`. `LeadStatus` is NEW | CONTACTED | QUOTE_SENT | FOLLOW_UP |
  //  BOOKED | LOST — there is no `WON`, so half the loop could never fail, and
  //  `BOOKED` (the status that means the customer actually converted) was never
  //  checked at all. A returning customer is precisely the person whose second
  //  lead would be refused if BOOKED were ever added to the predicate.
  //
  //  The closed set is now DERIVED from the schema rather than typed here, so a
  //  status added to the enum later forces a decision instead of silently
  //  falling outside both lists.
  const enumBlock = /enum LeadStatus \{([^}]*)\}/.exec(
    readFileSync(resolve(__dirname, '../../../prisma/schema.prisma'), 'utf8'),
  )
  assert.ok(enumBlock, 'the LeadStatus enum must be findable')
  const allStatuses = enumBlock[1]
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[A-Z_]+$/.test(l))
  assert.ok(allStatuses.length >= 5, `expected the full enum, got ${allStatuses.join(',')}`)

  const closed = allStatuses.filter((st) => !OPEN_STATUSES.includes(st))
  assert.deepEqual(closed.sort(), ['BOOKED', 'LOST'], 'the closed statuses, derived from the schema')
  for (const st of closed) {
    assert.ok(
      !row.indexdef.includes(st),
      `${st} is a CLOSED status and must stay OUTSIDE the predicate — with it in, a ` +
        `customer who came back after booking could never be captured again`,
    )
  }
})

test('it ENFORCES: a second open lead on one session is refused', { skip }, async () => {
  //  Presence is not enforcement. An index can exist and be invalid — a failed
  //  concurrent build leaves exactly that — so the constraint is exercised.
  const session = `drift_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const mk = (id: string) =>
    prisma.$executeRawUnsafe(
      `INSERT INTO "crm_leads" (id, name, email, source, status, "booking_session_id", "created_at", "updated_at")
       VALUES ($1, 'Test Customer', $2, 'OTHER', 'NEW', $3, now(), now())`,
      id,
      `${id}@example.com`,
      session,
    )
  const a = `${session}_a`
  const b = `${session}_b`
  try {
    await mk(a)
    let refused = false
    try {
      await mk(b)
    } catch (err) {
      refused = /23505|unique constraint/i.test(String((err as Error).message))
    }
    assert.ok(refused, 'the database itself refuses the duplicate')
  } finally {
    await prisma.$executeRawUnsafe(`DELETE FROM "crm_leads" WHERE "booking_session_id" = $1`, session)
  }
})

// ── FILE-LEVEL PROTECTION ─────────────────────────────────────────────
test('the migration that creates it is still present and unedited in spirit', () => {
  const dir = readdirSync(MIGRATIONS).find((d) => d.endsWith('_lead_session_unique'))
  assert.ok(dir, 'the migration directory still exists')
  const sql = readFileSync(resolve(MIGRATIONS, dir, 'migration.sql'), 'utf8')
  //  AN APPLIED MIGRATION MUST NEVER BE EDITED — production records its
  //  checksum, and a changed file makes `migrate deploy` refuse to run. This
  //  pins the statement itself; changing the rule means a NEW migration.
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS "crm_leads_open_booking_session_key"/)
  assert.match(sql, /ON "crm_leads" \("booking_session_id"\)/)
  assert.match(sql, /WHERE "booking_session_id" IS NOT NULL/)
  assert.match(sql, /'NEW', 'CONTACTED', 'QUOTE_SENT', 'FOLLOW_UP'/)
})

test('no migration AFTER the crm_leads separation touches the tracker table', () => {
  //  THE HISTORY, because the exemption below is otherwise indefensible.
  //
  //  `Lead` maps to "crm_leads". Production ALSO carries the marketing tracker's
  //  own raw-SQL "leads" table, and the tracker got there first. Migration
  //  20260713000100 tried to CREATE TABLE "leads" for the CRM inside a
  //  `DO $$ ... EXCEPTION WHEN duplicate_table THEN null $$` block — so on
  //  production the create was SILENTLY SKIPPED, the name kept pointing at the
  //  tracker's table, and every `prisma.lead.*` call failed with "column
  //  leads.status does not exist". Contact capture, "not sure" bookings, lead
  //  conversion and partial capture were all broken by one swallowed exception.
  //
  //  20260724010000 fixed it by giving the model its own "crm_leads" table and
  //  leaving the tracker's alone. That migration is the boundary: everything
  //  from it onward must name crm_leads, and the two earlier ones are ALREADY
  //  APPLIED and may never be edited — production records their checksums.
  const SEPARATION = '20260724010000_lead_own_table_crm_leads'
  const dirs = readdirSync(MIGRATIONS).filter((d) => /^\d{14}_/.test(d)).sort()
  const from = dirs.indexOf(SEPARATION)
  assert.ok(from > -1, 'the crm_leads separation migration is still present')

  for (const dir of dirs.slice(from)) {
    let sql: string
    try {
      sql = readFileSync(resolve(MIGRATIONS, dir, 'migration.sql'), 'utf8')
    } catch {
      continue
    }
    const code = sql.replace(/--[^\n]*/g, '')
    const hit = /\b(?:ALTER|DROP|TRUNCATE|INSERT\s+INTO|UPDATE)\s+(?:TABLE\s+)?"?leads"\b/i.exec(code)
    assert.ok(
      !hit,
      `${dir} operates on "leads" — the marketing tracker's table — rather than "crm_leads". ` +
        `That table belongs to another system and is not ours to change.`,
    )
  }
})

test('the earlier CREATE of a bare "leads" table is still guarded, and still historical', () => {
  //  Pinning the shape of the migration that caused the incident, so nobody
  //  "tidies" the guard away later and turns a historical no-op into a failing
  //  deploy on any environment where the tracker exists.
  const dir = readdirSync(MIGRATIONS).find((d) => d.endsWith('_admin_operating_system'))
  assert.ok(dir, 'the historical migration is still present')
  const sql = readFileSync(resolve(MIGRATIONS, dir, 'migration.sql'), 'utf8')
  const at = sql.indexOf('CREATE TABLE "leads"')
  assert.ok(at > -1, 'it still contains the original bare-name create')
  assert.match(
    sql.slice(at, sql.indexOf('END $$;', at) + 8),
    /EXCEPTION WHEN duplicate_table THEN null/i,
    'still guarded — without this it would fail wherever the tracker owns the name',
  )
})
