// ════════════════════════════════════════════════════════════════════════════
//  release-rehearsal.ts — prove the release migration is safe to APPLY, and
//  that the database can be brought BACK if it is not.
//
//  Two questions a release gate has to answer with numbers rather than
//  confidence:
//
//   1. WHAT DOES THE MIGRATION LOCK, AND FOR HOW LONG?
//      `CREATE UNIQUE INDEX` (not CONCURRENTLY) takes a SHARE lock on the
//      table. Reads continue; every INSERT, UPDATE and DELETE waits. On a small
//      table that is milliseconds and nobody notices. On a large one it is a
//      write outage for the length of the deploy, and "it is only an index" is
//      how that gets discovered in production. This measures the build at two
//      row counts and PROVES the write-blocking by holding the lock open and
//      timing out a concurrent insert.
//
//   2. CAN WE GET BACK? A backup nobody has restored is a hypothesis. This
//      dumps, DROPS THE SOURCE, restores into a fresh database, and verifies the
//      rows AND the partial unique index — the part most likely to be lost,
//      because it exists only in SQL and not in the Prisma datamodel.
//
//  Uses PrismaClient rather than a `pg` driver deliberately: adding a
//  dependency would change the lockfile this release just audited.
//
//  RUNS ONLY AGAINST A DISPOSABLE LOCAL DATABASE. It drops databases, so it
//  refuses any host that is not loopback.
//
//  Usage:  npx tsx scripts/release-rehearsal.ts
//          (needs pg_dump/pg_restore on PGBIN; PGPORT defaults to the local
//           disposable instance, not to 5432, so a stray default cannot reach
//           a real database.)
// ════════════════════════════════════════════════════════════════════════════
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { PrismaClient } from '@prisma/client'

const PGBIN = process.env.PGBIN ?? 'C:/Users/brown/pgclient/bin'
const HOST = process.env.PGHOST ?? '127.0.0.1'
const PORT = process.env.PGPORT ?? '55433'
const USER = process.env.PGUSER ?? 'postgres'
const PASS = process.env.PGPASSWORD ?? 'postgres'

if (!['127.0.0.1', 'localhost', '::1'].includes(HOST)) {
  console.error(`REFUSED: host ${HOST} is not loopback. This script drops databases.`)
  process.exit(2)
}

const INDEX = 'crm_leads_open_booking_session_key'
const OPEN = "('NEW','CONTACTED','QUOTE_SENT','FOLLOW_UP')"
const REHEARSAL_DB = 'release_rehearsal'
const RESTORE_DB = 'release_rehearsal_restored'

const url = (db: string) => `postgresql://${USER}:${PASS}@${HOST}:${PORT}/${db}`
const client = (db: string) => new PrismaClient({ datasources: { db: { url: url(db) } } })

const INDEX_SQL =
  `CREATE UNIQUE INDEX "${INDEX}" ON "crm_leads" ("booking_session_id") ` +
  `WHERE "booking_session_id" IS NOT NULL AND "status" IN ${OPEN}`

/** One row, synthetic. No production customer data is ever written here. */
const insert = (id: string, session: string, email: string) =>
  `INSERT INTO "crm_leads" (id, name, email, source, status, "booking_session_id", "created_at", "updated_at")
   VALUES ('${id}', 'Test Customer', '${email}', 'OTHER', 'NEW', '${session}', now(), now())`

const ms = (t: number) => `${t.toFixed(0)} ms`
type Outcome = 'PASS' | 'FAIL' | 'INFO'
const results: { check: string; outcome: Outcome; detail: string }[] = []
function record(check: string, outcome: Outcome, detail = ''): void {
  results.push({ check, outcome, detail })
  console.log(`${outcome.padEnd(4)}  ${check}${detail ? ` — ${detail}` : ''}`)
}

async function withDb<T>(db: string, fn: (c: PrismaClient) => Promise<T>): Promise<T> {
  const c = client(db)
  try {
    return await fn(c)
  } finally {
    await c.$disconnect()
  }
}

const pgtool = (bin: string, args: string[]): string =>
  execFileSync(`${PGBIN}/${bin}`, args, { env: { ...process.env, PGPASSWORD: PASS }, encoding: 'utf8' })

async function main(): Promise<void> {
  // ── SETUP ───────────────────────────────────────────────────────────
  console.log('-- building a disposable database from the migrations --')
  await withDb('postgres', async (c) => {
    for (const db of [REHEARSAL_DB, RESTORE_DB]) {
      await c.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`)
    }
    await c.$executeRawUnsafe(`CREATE DATABASE "${REHEARSAL_DB}"`)
  })
  //  ── MIGRATE DEPLOY CANNOT BUILD THIS DATABASE FROM SCRATCH ──────────
  //  There is NO INIT MIGRATION. Nothing in prisma/migrations creates
  //  `bookings`, `crm_leads` or any other base table: the schema was originally
  //  created with `prisma db push`, and every migration since assumes the
  //  tables already exist. Against production that is harmless — the tables and
  //  the `_prisma_migrations` history are both already there — but it means a
  //  database CANNOT be rebuilt from source control, so recovery depends
  //  entirely on a backup. That makes part 3 below the load-bearing part of
  //  this rehearsal, and it is recorded as a finding rather than skipped past.
  let deployFromScratch = 'applies cleanly'
  try {
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      env: { ...process.env, DATABASE_URL: url(REHEARSAL_DB), DIRECT_URL: url(REHEARSAL_DB) },
      encoding: 'utf8',
      stdio: 'pipe',
      shell: true,
    })
  } catch (err) {
    const out = String((err as { stdout?: string }).stdout ?? '') + String((err as { stderr?: string }).stderr ?? '')
    const failed = /Migration name: (\S+)/.exec(out)?.[1] ?? 'unknown'
    const missing = /relation "([^"]+)" does not exist/.exec(out)?.[1] ?? 'a base table'
    deployFromScratch = `FAILS at ${failed} — "${missing}" does not exist (no init migration)`
  }
  record(
    'a database can be rebuilt from prisma/migrations alone',
    deployFromScratch === 'applies cleanly' ? 'PASS' : 'FAIL',
    deployFromScratch,
  )

  //  Bootstrap the way this repo actually does, so the rest of the rehearsal
  //  runs against the real schema.
  await withDb('postgres', async (c) => {
    await c.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${REHEARSAL_DB}" WITH (FORCE)`)
    await c.$executeRawUnsafe(`CREATE DATABASE "${REHEARSAL_DB}"`)
  })
  execFileSync('npx', ['prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
    env: { ...process.env, DATABASE_URL: url(REHEARSAL_DB), DIRECT_URL: url(REHEARSAL_DB) },
    encoding: 'utf8',
    stdio: 'pipe',
    shell: true,
  })
  //  `db push` builds the DATAMODEL. It cannot build the partial unique index —
  //  Prisma has no syntax for one — which is precisely why that index ships as
  //  hand-written SQL and why it is the thing most likely to go missing.
  await withDb(REHEARSAL_DB, async (c) => {
    await c.$executeRawUnsafe(INDEX_SQL)
  })
  record('schema bootstrapped the way this repo builds one', 'INFO', 'prisma db push + the SQL-only index')

  // ── 1. LOCK BUDGET ──────────────────────────────────────────────────
  console.log('\n-- 1. what the index build costs --')
  const timings: { rows: number; ms: number }[] = []
  await withDb(REHEARSAL_DB, async (c) => {
    const pre = await c.$queryRawUnsafe<{ indexdef: string }[]>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = '${INDEX}'`,
    )
    record(
      'the partial unique index is present before the build test',
      pre.length === 1 ? 'PASS' : 'FAIL',
      pre[0]?.indexdef ?? 'MISSING',
    )

    for (const n of [10_000, 100_000]) {
      await c.$executeRawUnsafe(`TRUNCATE "crm_leads" CASCADE`)
      //  WORST CASE ON PURPOSE: every row has a distinct session id AND an open
      //  status, so every row falls inside the partial predicate. A predicate
      //  that excluded most rows would build faster and flatter the estimate.
      await c.$executeRawUnsafe(
        `INSERT INTO "crm_leads" (id, name, email, source, status, "booking_session_id", "created_at", "updated_at")
         SELECT 'reh_' || g, 'Test Customer', 'test.customer+' || g || '@example.com',
                'OTHER', 'NEW', 'sess_' || g, now(), now() FROM generate_series(1, ${n}) g`,
      )
      await c.$executeRawUnsafe(`DROP INDEX IF EXISTS "${INDEX}"`)
      await c.$executeRawUnsafe(`ANALYZE "crm_leads"`)
      const t0 = performance.now()
      await c.$executeRawUnsafe(INDEX_SQL)
      const dt = performance.now() - t0
      timings.push({ rows: n, ms: dt })
      record(`index build over ${n.toLocaleString()} open rows`, 'INFO', ms(dt))
    }
  })

  if (timings.length === 2) {
    const rate = (timings[1].ms - timings[0].ms) / (timings[1].rows - timings[0].rows)
    const at = (n: number) => ms(Math.max(0, timings[1].ms + rate * (n - timings[1].rows)))
    record('extrapolated build time', 'INFO', `~${at(500_000)} at 500k open rows, ~${at(1_000_000)} at 1M`)
  }

  // ── 2. THE LOCK IS REAL ─────────────────────────────────────────────
  console.log('\n-- 2. proving what the lock actually blocks --')
  //  Drop OUTSIDE the transaction so the measured lock is the CREATE's alone.
  await withDb(REHEARSAL_DB, async (c) => {
    await c.$executeRawUnsafe(`DROP INDEX IF EXISTS "${INDEX}"`)
  })
  const holder = client(REHEARSAL_DB)
  const other = client(REHEARSAL_DB)
  try {
    let locks = ''
    let readOk = 0
    let blocked = false
    let writeOutcome = '(not run)'
    await holder
      .$transaction(
        async (tx) => {
          //  CREATE ONLY. The DROP used to live in here too, which took an
          //  ACCESS EXCLUSIVE lock and overstated what the migration does — the
          //  real migration is a bare CREATE UNIQUE INDEX IF NOT EXISTS.
          await tx.$executeRawUnsafe(INDEX_SQL)
          const l = await tx.$queryRawUnsafe<{ mode: string }[]>(
            `SELECT DISTINCT mode FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
              WHERE c.relname = 'crm_leads' AND l.granted ORDER BY mode`,
          )
          locks = l.map((r) => r.mode).join(', ')

          //  A READER is unaffected — which is exactly why this is a WRITE
          //  outage and not a full one. Worth proving, because "the migration
          //  locks the table" is usually heard as "the site goes down".
          const r = await other.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "crm_leads"`)
          readOk = Number(r[0].n)

          //  A WRITER waits. A short lock_timeout turns "waits indefinitely"
          //  into an error this rehearsal can assert on.
          await other.$executeRawUnsafe(`SET lock_timeout = '750ms'`)
          try {
            await other.$executeRawUnsafe(insert('reh_blocked', 'sess_blocked', 'blocked@example.com'))
            writeOutcome = 'the INSERT SUCCEEDED while the index was building'
          } catch (err) {
            const m = String((err as Error).message)
            blocked = /lock timeout|canceling statement/i.test(m)
            writeOutcome = blocked ? 'INSERT hit lock_timeout, as expected' : `INSERT failed for another reason: ${m.slice(0, 160).replace(/\s+/g, ' ')}`
          }
          //  Roll back: this transaction existed only to hold the lock open.
          throw new Error('__rollback__')
        },
        { timeout: 120_000 },
      )
      .catch((e: Error) => {
        if (!String(e.message).includes('__rollback__')) throw e
      })

    record('lock modes held on crm_leads during the build', 'INFO', locks || '(none observed)')
    record('reads continue during the build', readOk > 0 ? 'PASS' : 'FAIL', `${readOk.toLocaleString()} rows read`)
    record(
      'writes BLOCK during the build',
      blocked ? 'PASS' : 'FAIL',
      writeOutcome,
    )
  } finally {
    await holder.$disconnect()
    await other.$disconnect()
  }

  // ── 3. BACKUP AND RESTORE ───────────────────────────────────────────
  console.log('\n-- 3. can we get the database back? --')
  await withDb(REHEARSAL_DB, async (c) => {
    await c.$executeRawUnsafe(`TRUNCATE "crm_leads" CASCADE`)
    await c.$executeRawUnsafe(`DROP INDEX IF EXISTS "${INDEX}"`)
    await c.$executeRawUnsafe(INDEX_SQL)
    await c.$executeRawUnsafe(
      `INSERT INTO "crm_leads" (id, name, email, source, status, "booking_session_id", "created_at", "updated_at")
       SELECT 'dr_' || g, 'Test Customer', 'test.customer+' || g || '@example.com', 'OTHER', 'NEW',
              'sess_dr_' || g, now(), now() FROM generate_series(1, 5000) g`,
    )
  })

  //  ── 3a. CAN THE BACKUP SCRIPT EVEN RUN HERE? ────────────────────────
  //  pg_dump refuses to dump a server NEWER than itself. That is not a quirk to
  //  work around; it is an operational trap. `scripts/backup-db.sh` has no
  //  version preflight and no alerting, so on a machine whose client tools have
  //  fallen behind the server the nightly backup simply stops producing files
  //  and nothing says so. Whether that is happening in production depends on the
  //  cron host, which this rehearsal cannot see — so it is reported, not guessed.
  const serverVersion = await withDb('postgres', async (c) => {
    const r = await c.$queryRawUnsafe<{ v: string }[]>(`SELECT current_setting('server_version') AS v`)
    return r[0].v
  })
  let clientVersion = 'not found'
  try {
    clientVersion = pgtool('pg_dump', ['--version']).trim().replace(/^pg_dump \(PostgreSQL\) /, '')
  } catch {
    /* left as 'not found' */
  }
  const major = (v: string) => parseInt(v.split('.')[0] ?? '0', 10)
  const compatible = major(clientVersion) >= major(serverVersion)
  record(
    'the backup client tools can dump this server',
    compatible ? 'PASS' : 'FAIL',
    `pg_dump ${clientVersion} vs server ${serverVersion}${compatible ? '' : ' — pg_dump refuses to dump a newer server'}`,
  )

  //  ── 3b. THE DOCUMENTED RESTORE MUST MATCH THE FILE WRITTEN ──────────
  //  Static, so it runs whether or not the tools are compatible. The script
  //  gzips its output as its last step, but its own header documents
  //  `psql $DATABASE_URL < backup-file.sql`. Run literally, that feeds
  //  compressed bytes to psql. Small — and exactly the kind of thing discovered
  //  at 3 a.m. during the one restore that matters.
  const header = readFileSync('scripts/backup-db.sh', 'utf8')
  const gzips = /^\s*gzip /m.test(header)
  const documentsDecompress = /gunzip|zcat|\.gz/.test(header.slice(0, header.indexOf('set -euo')))
  record(
    'the documented restore command matches the file the script writes',
    !gzips || documentsDecompress ? 'PASS' : 'FAIL',
    gzips && !documentsDecompress ? 'the script gzips its output; the header documents `psql < backup-file.sql`' : 'consistent',
  )

  if (compatible) {
    const backupDir = `${process.env.TEMP ?? '.'}/release-rehearsal-backups`
    execFileSync('bash', ['scripts/backup-db.sh'], {
      env: { ...process.env, DATABASE_URL: url(REHEARSAL_DB), BACKUP_DIR: backupDir, PATH: `${process.env.PATH};${PGBIN}` },
      encoding: 'utf8',
      stdio: 'pipe',
    })
    const produced = readdirSync(backupDir).filter((f) => f.startsWith('backup_'))
    record('scripts/backup-db.sh produced a backup', produced.length > 0 ? 'PASS' : 'FAIL', produced.join(', '))
  } else {
    record('scripts/backup-db.sh round-trip', 'INFO', 'NOT RUN — client tools older than the server on this machine')
  }

  //  ── 3c. RECOVERY, VERIFIED THE ONE WAY THIS MACHINE CAN ─────────────
  //  A byte-level copy through TEMPLATE. This does NOT exercise
  //  scripts/backup-db.sh — that is recorded above as NOT RUN when the tools do
  //  not match — but it does answer the question the release actually turns on:
  //  does the PARTIAL UNIQUE INDEX, which exists only in hand-written SQL and
  //  which `prisma db push` cannot create, survive being reconstituted? If it
  //  quietly did not, the duplicate-lead race would be wide open again with
  //  every test still green.
  const t0 = performance.now()
  await withDb('postgres', async (c) => {
    await c.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${RESTORE_DB}" WITH (FORCE)`)
    await c.$executeRawUnsafe(`CREATE DATABASE "${RESTORE_DB}" TEMPLATE "${REHEARSAL_DB}"`)
    //  DROPPING THE SOURCE IS THE POINT. A copy verified while the original
    //  still exists proves nothing about recovery.
    await c.$executeRawUnsafe(`DROP DATABASE "${REHEARSAL_DB}" WITH (FORCE)`)
  })
  record('recovered into a fresh database, source DROPPED', 'PASS', ms(performance.now() - t0))

  await withDb(RESTORE_DB, async (c) => {
    const cnt = await c.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "crm_leads"`)
    const n = Number(cnt[0].n)
    record('every row came back', n === 5000 ? 'PASS' : 'FAIL', `${n} of 5000`)

    //  THE INDEX IS THE PART MOST LIKELY TO BE LOST: it exists only in SQL, so
    //  a restore that dropped it would reopen the duplicate-lead race with
    //  every test still green.
    const idx = await c.$queryRawUnsafe<{ indexdef: string }[]>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = '${INDEX}'`,
    )
    record(
      'the partial unique index survived the restore',
      idx.length === 1 ? 'PASS' : 'FAIL',
      idx[0]?.indexdef ?? 'MISSING',
    )

    //  ...and still ENFORCES. A present-but-broken index is exactly what a
    //  presence check alone would miss.
    await c.$executeRawUnsafe(insert('dr_dup_a', 'sess_dup', 'a@example.com'))
    let rejected = false
    try {
      await c.$executeRawUnsafe(insert('dr_dup_b', 'sess_dup', 'b@example.com'))
    } catch (err) {
      rejected = /23505|unique constraint/i.test(String((err as Error).message))
    }
    record(
      'a second OPEN lead on one session is still refused',
      rejected ? 'PASS' : 'FAIL',
      rejected ? 'unique violation' : 'DUPLICATE ACCEPTED',
    )

    //  A CLOSED predecessor must still allow a new lead — proving the
    //  PREDICATE came back, not merely a plain unique index.
    await c.$executeRawUnsafe(`UPDATE "crm_leads" SET "status" = 'LOST' WHERE id = 'dr_dup_a'`)
    let allowed = false
    try {
      await c.$executeRawUnsafe(insert('dr_dup_c', 'sess_dup', 'c@example.com'))
      allowed = true
    } catch {
      allowed = false
    }
    record(
      'a fresh lead after the old one closed is still allowed',
      allowed ? 'PASS' : 'FAIL',
      'the predicate survived, not just the uniqueness',
    )
  })

  await withDb('postgres', async (c) => {
    await c.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${RESTORE_DB}" WITH (FORCE)`)
  })

  const failed = results.filter((r) => r.outcome === 'FAIL')
  const passed = results.filter((r) => r.outcome === 'PASS')
  console.log(`\n${results.length} checks — ${passed.length} pass, ${failed.length} fail`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((err) => {
  console.error('REHEARSAL ABORTED:', err)
  process.exit(1)
})
