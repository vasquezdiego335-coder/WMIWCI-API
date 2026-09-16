// ════════════════════════════════════════════════════════════════════════
//  migration-bootstrap.test.ts — CI must actually RUN a new migration.
//
//  THE DEFECT THIS EXISTS TO PREVENT (found 2026-09-15). `prisma/migrations`
//  has no init migration, so CI builds its database from prisma/baseline/
//  00_init.sql and then tells Prisma which migrations that baseline already
//  contains. The old scripts/bootstrap-fresh-database.sh did that for EVERY
//  directory in prisma/migrations, with no cutoff and with resolve failures
//  redirected to /dev/null. A migration added after the baseline was therefore
//  recorded as applied WITHOUT ITS SQL EVER RUNNING:
//    • the table or column it creates did not exist in CI;
//    • `prisma migrate status` still reported "up to date";
//    • DB-gated tests touching it failed for reasons that looked unrelated, or
//      passed because they only queried tables that already existed;
//    • and nothing proved the migration worked before it reached Neon.
//
//  The fix is an explicit list — prisma/baseline/REPRESENTED_MIGRATIONS.txt —
//  of the migrations the baseline contains. Only those are recorded; every
//  other one is EXECUTED by a plain `prisma migrate deploy`, exactly as
//  production does it. These tests hold that arrangement in place.
//
//  Offline except the final DB-gated block, which proves it on the database CI
//  actually built.
// ════════════════════════════════════════════════════════════════════════
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { PrismaClient } from '@prisma/client'
import { assertNoProductionCredentials, dbSkip } from './_disposable-test-env'

assertNoProductionCredentials()

const ROOT = resolve(__dirname, '../../..')
const MIGRATIONS_DIR = resolve(ROOT, 'prisma/migrations')
const REPRESENTED_FILE = resolve(ROOT, 'prisma/baseline/REPRESENTED_MIGRATIONS.txt')
const BOOTSTRAP = resolve(ROOT, 'scripts/bootstrap-fresh-database.sh')
const CI = resolve(ROOT, '.github/workflows/ci.yml')

/** Strip comments, blanks and any stray CR — the same rules the shell and CI use. */
function readRepresented(): string[] {
  return readFileSync(REPRESENTED_FILE, 'utf8')
    .split('\n')
    .map((l) => l.replace(/\r$/, '').replace(/#.*$/, '').trim())
    .filter((l) => l.length > 0)
}

/** Every migration directory in the repository, in the order Prisma applies them. */
function migrationDirs(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(resolve(MIGRATIONS_DIR, e.name, 'migration.sql')))
    .map((e) => e.name)
    .sort()
}

/**
 * The selection the bootstrap performs, reimplemented here so the rule can be
 * asserted without a shell: RECORD the represented ones, EXECUTE the rest.
 */
function partitionMigrations() {
  const represented = new Set(readRepresented())
  const all = migrationDirs()
  return {
    recorded: all.filter((n) => represented.has(n)),
    executed: all.filter((n) => !represented.has(n)),
    represented: [...represented],
  }
}

// core.autocrlf is on, so a Windows checkout has CRLF where CI has LF. The
// anchored patterns below (`^set -euo pipefail$`) would fail on the trailing
// carriage return, which is a test failure that says nothing about the code.
const readText = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
const bootstrap = readText(BOOTSTRAP)
const ci = readText(CI)

// ── The list itself ─────────────────────────────────────────────────────

test('REPRESENTED_MIGRATIONS.txt names migrations that exist', () => {
  const represented = readRepresented()
  assert.ok(represented.length >= 60, `only ${represented.length} names — the baseline covers 64 migrations; did the file get truncated?`)
  const missing = represented.filter((n) => !existsSync(resolve(MIGRATIONS_DIR, n, 'migration.sql')))
  assert.deepEqual(
    missing,
    [],
    `the baseline claims to contain these, but their directories are gone. A migration production has already recorded must never be deleted: ${missing.join(', ')}`,
  )
  assert.deepEqual([...represented].sort(), represented, 'keep the list sorted — the ordering check below compares against its last entry')
  assert.equal(new Set(represented).size, represented.length, 'no duplicates')
})

test('every migration the baseline does NOT contain sorts after the last one it does', () => {
  // Prisma applies migrations in directory-name order. A new migration whose
  // timestamp sorted BEFORE the last represented one would be applied to
  // production by `migrate deploy` but never executed here, because the
  // bootstrap records the earlier names first — the same false green as before.
  const { executed, represented } = partitionMigrations()
  const last = [...represented].sort().at(-1) as string
  const tooEarly = executed.filter((n) => !(n > last))
  assert.deepEqual(
    tooEarly,
    [],
    `these sort at or before the last baselined migration (${last}), so CI would never run them. Give them a later timestamp: ${tooEarly.join(', ')}`,
  )
})

test('every migration directory is named so that ordering is meaningful', () => {
  const bad = migrationDirs().filter((n) => !/^\d{14}_[a-z0-9_]+$/.test(n))
  assert.deepEqual(bad, [], `<14-digit timestamp>_<snake_case> is what makes lexicographic order equal chronological order: ${bad.join(', ')}`)
})

test('the partition is derived, never hardcoded: recorded + executed = every migration', () => {
  const { recorded, executed } = partitionMigrations()
  assert.deepEqual([...recorded, ...executed].sort(), migrationDirs(), 'every migration is either recorded or executed, and none is both')
  assert.ok(executed.length >= 1, 'this branch adds migrations; if that is no longer true, the bootstrap has nothing left to prove')
})

// ── The script ──────────────────────────────────────────────────────────

test('the bootstrap resolves ONLY the migrations the baseline represents', () => {
  assert.match(bootstrap, /REPRESENTED_MIGRATIONS\.txt/, 'the script must read the explicit list')
  assert.match(
    bootstrap,
    /REPRESENTED_NAMES\[@\][\s\S]{0,600}migrate resolve --applied/,
    'the resolve loop must iterate the represented list, not every directory in prisma/migrations',
  )
  assert.doesNotMatch(
    bootstrap,
    /for dir in "\$HERE"\/prisma\/migrations\/\*\/[\s\S]{0,400}migrate resolve --applied/,
    'resolving every directory is exactly the defect: a new migration gets marked applied without running',
  )
})

test('the bootstrap fails loudly instead of swallowing a resolve error', () => {
  assert.match(bootstrap, /^set -euo pipefail$/m, 'without -e a failed step continues and the script still reports success')
  assert.doesNotMatch(bootstrap, /migrate resolve --applied[^\n]*2>&1/, 'stderr must not be discarded')
  assert.doesNotMatch(bootstrap, /migrate resolve[^\n]*>\s*\/dev\/null\s*2>\s*&1\s*&&/, 'the old `… >/dev/null 2>&1 && COUNT++` swallowed every failure')
  assert.match(bootstrap, /could not record/, 'a resolve failure must say which migration failed')
  assert.match(bootstrap, /does not exist/, 'a listed migration whose directory is gone must stop the build')
})

test('the bootstrap APPLIES the migrations the baseline does not contain', () => {
  assert.match(bootstrap, /^\s*npx prisma migrate deploy\s*$/m, 'a plain `migrate deploy` under set -e: its SQL runs, and a failure fails CI')
  assert.doesNotMatch(bootstrap, /migrate deploy[^\n]*tee[^\n]*grep/, 'the old pipeline turned a real failure into a NOTE on stderr')
  assert.doesNotMatch(bootstrap, /NOTE: migrate deploy applied something/, 'that soft warning is what let an unrun migration pass')
  assert.match(bootstrap, /will execute: \$name/, 'the log must name what is actually being executed')
})

test('the bootstrap verifies the objects Prisma cannot express, and that they are VALID', () => {
  // An index left INVALID by a failed build still appears in pg_indexes and
  // enforces nothing, so presence alone is not proof.
  assert.match(bootstrap, /indisunique AND i\.indisvalid/, 'a unique index must be checked for indisunique AND indisvalid')
  assert.match(bootstrap, /crm_leads_open_booking_session_key/, 'the partial unique index that stops duplicate leads')
  assert.match(
    bootstrap,
    /email_campaign_runs_one_unfinished_per_campaign/,
    'without it two runs of one campaign can be unfinished at once and every recipient is sent twice',
  )
  assert.match(bootstrap, /lifecycle_enqueue_retries/, 'without it a failed enqueue is lost and the journey never runs')
})

test('the bootstrap still refuses a database that is already in use', () => {
  assert.match(bootstrap, /already has \$\{EXISTING\} tables/, 'it must never run against a populated database')
  assert.match(bootstrap, /PSQL_URL="\$\{DATABASE_URL%%\\\?\*\}"/, 'psql still needs the URL without Prisma-only query parameters')
})

// ── CI wiring ───────────────────────────────────────────────────────────

test('CI lints migration ordering against the represented list', () => {
  assert.match(ci, /REPRESENTED_MIGRATIONS\.txt/, 'the lint step must read the list')
  assert.match(ci, /LC_ALL=C/, 'string ordering must not depend on the runner locale')
  assert.match(ci, /LAST_REPRESENTED/, 'the check compares each unlisted migration against the last represented name')
  assert.match(ci, /\^\[0-9\]\{14\}_\[a-z0-9_\]\+\$/, 'the naming lint is still there')
})

test('CI builds the database with the bootstrap and only then runs the suite', () => {
  const bootstrapAt = ci.indexOf('bash scripts/bootstrap-fresh-database.sh')
  const testAt = ci.indexOf('npm test')
  const typecheckAt = ci.indexOf('npm run typecheck')
  assert.ok(bootstrapAt > 0 && testAt > 0 && typecheckAt > 0)
  assert.ok(typecheckAt < bootstrapAt, 'typecheck and lint run first, so a database problem cannot hide a code defect')
  assert.ok(bootstrapAt < testAt, 'the suite needs the database the bootstrap builds')
  assert.match(ci, /npx prisma migrate status/, 'and the deploy state is printed after it')
})

// ── DB-GATED: prove it on the database CI actually built ────────────────

let prisma: PrismaClient
const skip = dbSkip()
before(async () => {
  if (skip) return
  prisma = new PrismaClient()
  await prisma.$connect()
})
after(async () => {
  if (skip) return
  await prisma.$disconnect()
})

test('every migration is recorded, and every new one was EXECUTED not merely resolved', { skip }, async () => {
  const rows = await prisma.$queryRawUnsafe<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }[]>(
    'SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations',
  )
  const byName = new Map(rows.map((r) => [r.migration_name, r]))
  const { recorded, executed } = partitionMigrations()

  for (const name of [...recorded, ...executed]) {
    const row = byName.get(name)
    assert.ok(row, `${name} is not in _prisma_migrations — the bootstrap neither recorded nor applied it`)
    assert.ok(row.finished_at, `${name} is recorded but unfinished`)
    assert.equal(row.rolled_back_at, null, `${name} is marked rolled back`)
  }

  // `migrate resolve --applied` ALSO writes a finished_at, so the rows above
  // cannot distinguish "recorded" from "ran". Only the objects can: assert that
  // what the new migrations create is really in the database.
  // count(*) comes back as a BigInt; Number() is safe for a 0/1 existence check.
  const objectExists = async (sql: string, ...args: unknown[]) =>
    Number((await prisma.$queryRawUnsafe<{ n: bigint }[]>(sql, ...args))[0].n) > 0

  assert.ok(
    await objectExists(
      `SELECT count(*)::bigint AS n FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       WHERE c.relname = $1 AND i.indisunique AND i.indisvalid`,
      'email_campaign_runs_one_unfinished_per_campaign',
    ),
    'the partial unique index that makes a second unfinished campaign run impossible is missing — its migration was resolved but never executed',
  )
  assert.ok(
    await objectExists(
      `SELECT count(*)::bigint AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
      'lifecycle_enqueue_retries',
    ),
    'lifecycle_enqueue_retries is missing — its migration was resolved but never executed',
  )
  assert.ok(
    await objectExists(
      `SELECT count(*)::bigint AS n FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'email_campaign_recipients' AND column_name = $1`,
      'transient_attempts',
    ),
    'email_campaign_recipients.transient_attempts is missing — its migration was resolved but never executed',
  )
})
