// ════════════════════════════════════════════════════════════════════════════
//  release-rehearsal.mjs — prove the release migration is safe to APPLY, and
//  that the database can be brought BACK if it is not.
//
//  Two questions a release gate has to answer with numbers rather than
//  confidence:
//
//   1. WHAT DOES THE MIGRATION LOCK, AND FOR HOW LONG?
//      `CREATE UNIQUE INDEX` (not CONCURRENTLY) takes a SHARE lock on the
//      table. Reads continue; every INSERT, UPDATE and DELETE waits. On a small
//      table that is milliseconds and nobody notices. On a large one it is a
//      write outage during the deploy, and "it's just an index" is how that
//      gets discovered in production. This measures the build time at several
//      row counts and PROVES the write-blocking by holding the lock and timing
//      out a concurrent insert.
//
//   2. CAN WE GET BACK? A backup nobody has restored is a hypothesis. This
//      dumps, drops, restores into a fresh database and verifies the row counts
//      AND the partial unique index — which is the part most likely to be lost,
//      because it exists only in SQL and not in the Prisma datamodel.
//
//  RUNS ONLY AGAINST A DISPOSABLE LOCAL DATABASE. It creates and drops
//  databases, so it refuses to run against anything that is not localhost.
//
//  Usage:  node scripts/release-rehearsal.mjs
// ════════════════════════════════════════════════════════════════════════════
import { execFileSync } from 'node:child_process'
import pg from 'pg'

const PGBIN = process.env.PGBIN ?? 'C:/Users/brown/pgclient/bin'
const HOST = process.env.PGHOST ?? '127.0.0.1'
const PORT = process.env.PGPORT ?? '55433'
const USER = process.env.PGUSER ?? 'postgres'
const PASS = process.env.PGPASSWORD ?? 'postgres'

//  SAFETY. This script drops databases. It may only ever see a local one.
if (!['127.0.0.1', 'localhost', '::1'].includes(HOST)) {
  console.error(`REFUSED: host ${HOST} is not local. This script creates and drops databases.`)
  process.exit(2)
}

const INDEX = 'crm_leads_open_booking_session_key'
const REHEARSAL_DB = 'release_rehearsal'
const RESTORE_DB = 'release_rehearsal_restored'

const admin = (db) => `postgresql://${USER}:${PASS}@${HOST}:${PORT}/${db}`
const pgexec = (bin, args, opts = {}) =>
  execFileSync(`${PGBIN}/${bin}`, args, { env: { ...process.env, PGPASSWORD: PASS }, encoding: 'utf8', ...opts })

async function withClient(db, fn) {
  const c = new pg.Client({ connectionString: admin(db) })
  await c.connect()
  try {
    return await fn(c)
  } finally {
    await c.end()
  }
}

const ms = (t) => `${t.toFixed(0)} ms`
const results = []
function record(check, outcome, detail) {
  results.push({ check, outcome, detail })
  console.log(`${outcome === 'PASS' ? 'PASS' : outcome === 'INFO' ? 'INFO' : 'FAIL'}  ${check}${detail ? ` — ${detail}` : ''}`)
}

// ── SETUP ─────────────────────────────────────────────────────────────
console.log('── building a disposable database from the migrations ──')
await withClient('postgres', async (c) => {
  for (const db of [REHEARSAL_DB, RESTORE_DB]) {
    await c.query(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`)
  }
  await c.query(`CREATE DATABASE "${REHEARSAL_DB}"`)
})

execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
  env: { ...process.env, DATABASE_URL: admin(REHEARSAL_DB), DIRECT_URL: admin(REHEARSAL_DB) },
  encoding: 'utf8',
  stdio: 'pipe',
  shell: true,
})
record('every migration applies to an empty database', 'PASS', 'prisma migrate deploy')

// ── 1. LOCK BUDGET ────────────────────────────────────────────────────
console.log('\n── 1. what the index build costs ──')
const timings = []
await withClient(REHEARSAL_DB, async (c) => {
  //  The index must already exist — the migration created it.
  const { rows: pre } = await c.query(`SELECT indexdef FROM pg_indexes WHERE indexname = $1`, [INDEX])
  record('the partial unique index exists after migrate deploy', pre.length === 1 ? 'PASS' : 'FAIL', pre[0]?.indexdef ?? 'MISSING')

  for (const n of [10_000, 100_000]) {
    await c.query(`TRUNCATE "crm_leads" CASCADE`)
    //  Realistic shape: every row has a distinct session id and an OPEN status,
    //  so every row is INSIDE the partial predicate. That is the worst case for
    //  the build, which is the number worth quoting.
    await c.query(
      `INSERT INTO "crm_leads" (id, name, email, phone, source, status, booking_session_id, created_at, updated_at)
       SELECT 'reh_' || g, 'Test Customer', 'test.customer+' || g || '@example.com', NULL,
              'OTHER', 'NEW', 'sess_' || g, now(), now()
         FROM generate_series(1, $1) g`,
      [n],
    )
    await c.query(`DROP INDEX IF EXISTS "${INDEX}"`)
    await c.query('ANALYZE "crm_leads"')
    const t0 = performance.now()
    await c.query(
      `CREATE UNIQUE INDEX "${INDEX}" ON "crm_leads" ("booking_session_id")
        WHERE "booking_session_id" IS NOT NULL AND "status" IN ('NEW','CONTACTED','QUOTE_SENT','FOLLOW_UP')`,
    )
    const dt = performance.now() - t0
    timings.push({ rows: n, ms: dt })
    record(`index build over ${n.toLocaleString()} open rows`, 'INFO', ms(dt))
  }
})

if (timings.length === 2) {
  const rate = (timings[1].ms - timings[0].ms) / (timings[1].rows - timings[0].rows)
  const at = (n) => ms(timings[1].ms + rate * (n - timings[1].rows))
  record('extrapolated build time', 'INFO', `~${at(500_000)} at 500k open rows, ~${at(1_000_000)} at 1M`)
}

// ── 2. THE LOCK IS REAL: writes wait, reads do not ────────────────────
console.log('\n── 2. proving what the lock actually blocks ──')
await withClient(REHEARSAL_DB, async (holder) => {
  await holder.query('BEGIN')
  await holder.query(`DROP INDEX IF EXISTS "${INDEX}"`)
  await holder.query(
    `CREATE UNIQUE INDEX "${INDEX}" ON "crm_leads" ("booking_session_id")
      WHERE "booking_session_id" IS NOT NULL AND "status" IN ('NEW','CONTACTED','QUOTE_SENT','FOLLOW_UP')`,
  )
  //  Lock held open inside the transaction, exactly as it is for the duration
  //  of the real build.
  const { rows: locks } = await holder.query(
    `SELECT mode FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
      WHERE c.relname = 'crm_leads' AND l.granted ORDER BY mode`,
  )
  record('lock modes taken on crm_leads', 'INFO', locks.map((r) => r.mode).join(', '))

  await withClient(REHEARSAL_DB, async (other) => {
    //  A READER must be unaffected. This is why the outage is writes-only.
    const { rows } = await other.query(`SELECT count(*)::int AS n FROM "crm_leads"`)
    record('reads continue during the build', rows[0].n > 0 ? 'PASS' : 'FAIL', `${rows[0].n.toLocaleString()} rows read`)

    //  A WRITER must wait. A short lock_timeout turns "waits" into an error we
    //  can assert on instead of hanging the rehearsal.
    await other.query(`SET lock_timeout = '750ms'`)
    let blocked = false
    try {
      await other.query(
        `INSERT INTO "crm_leads" (id, name, email, source, status, booking_session_id, created_at, updated_at)
         VALUES ('reh_blocked', 'Test Customer', 'blocked@example.com', 'OTHER', 'NEW', 'sess_blocked', now(), now())`,
      )
    } catch (err) {
      blocked = /lock timeout|canceling statement/i.test(String(err.message))
    }
    record('writes BLOCK during the build', blocked ? 'PASS' : 'FAIL', blocked ? 'INSERT hit lock_timeout as expected' : 'INSERT was NOT blocked')
  })
  await holder.query('ROLLBACK')
})

// ── 3. BACKUP AND RESTORE ─────────────────────────────────────────────
console.log('\n── 3. backup, drop, restore, verify ──')
await withClient(REHEARSAL_DB, async (c) => {
  await c.query(`TRUNCATE "crm_leads" CASCADE`)
  await c.query(
    `INSERT INTO "crm_leads" (id, name, email, source, status, booking_session_id, created_at, updated_at)
     SELECT 'dr_' || g, 'Test Customer', 'test.customer+' || g || '@example.com', 'OTHER', 'NEW', 'sess_dr_' || g, now(), now()
       FROM generate_series(1, 5000) g`,
  )
})

const dumpPath = `${process.env.TEMP ?? '.'}/release-rehearsal.dump`
const t0 = performance.now()
pgexec('pg_dump', ['-h', HOST, '-p', PORT, '-U', USER, '-d', REHEARSAL_DB, '-Fc', '-f', dumpPath])
record('pg_dump completed', 'PASS', ms(performance.now() - t0))

//  DROPPING THE SOURCE IS THE POINT. A restore verified against a database that
//  still exists proves nothing about recovery.
await withClient('postgres', async (c) => {
  await c.query(`DROP DATABASE "${REHEARSAL_DB}" WITH (FORCE)`)
  await c.query(`CREATE DATABASE "${RESTORE_DB}"`)
})
record('source database DROPPED', 'PASS', 'the restore has nothing to fall back on')

const t1 = performance.now()
pgexec('pg_restore', ['-h', HOST, '-p', PORT, '-U', USER, '-d', RESTORE_DB, '--no-owner', '--no-privileges', dumpPath])
record('pg_restore completed', 'PASS', ms(performance.now() - t1))

await withClient(RESTORE_DB, async (c) => {
  const { rows: cnt } = await c.query(`SELECT count(*)::int AS n FROM "crm_leads"`)
  record('every row came back', cnt[0].n === 5000 ? 'PASS' : 'FAIL', `${cnt[0].n} of 5000`)

  //  THE INDEX IS THE PART MOST LIKELY TO BE LOST. It exists only in SQL — the
  //  Prisma datamodel cannot express a partial unique index — so a restore that
  //  quietly dropped it would leave the duplicate-lead race wide open again
  //  with every test still passing.
  const { rows: idx } = await c.query(`SELECT indexdef FROM pg_indexes WHERE indexname = $1`, [INDEX])
  record('the partial unique index survived the restore', idx.length === 1 ? 'PASS' : 'FAIL', idx[0]?.indexdef ?? 'MISSING')

  //  And it still ENFORCES. A present-but-broken index is the failure a
  //  presence check would miss.
  await c.query(
    `INSERT INTO "crm_leads" (id, name, email, source, status, booking_session_id, created_at, updated_at)
     VALUES ('dr_dup_a', 'Test Customer', 'a@example.com', 'OTHER', 'NEW', 'sess_dup', now(), now())`,
  )
  let rejected = false
  try {
    await c.query(
      `INSERT INTO "crm_leads" (id, name, email, source, status, booking_session_id, created_at, updated_at)
       VALUES ('dr_dup_b', 'Test Customer', 'b@example.com', 'OTHER', 'NEW', 'sess_dup', now(), now())`,
    )
  } catch (err) {
    rejected = err.code === '23505'
  }
  record('a second OPEN lead on one session is still refused', rejected ? 'PASS' : 'FAIL', rejected ? '23505' : 'DUPLICATE ACCEPTED')

  //  ...and a CLOSED one is still allowed, so the predicate came back intact
  //  rather than being restored as a plain unique index.
  await c.query(`UPDATE "crm_leads" SET status = 'LOST' WHERE id = 'dr_dup_a'`)
  let allowed = false
  try {
    await c.query(
      `INSERT INTO "crm_leads" (id, name, email, source, status, booking_session_id, created_at, updated_at)
       VALUES ('dr_dup_c', 'Test Customer', 'c@example.com', 'OTHER', 'NEW', 'sess_dup', now(), now())`,
    )
    allowed = true
  } catch {
    allowed = false
  }
  record('a new lead after the old one closed is still allowed', allowed ? 'PASS' : 'FAIL', 'the predicate survived, not just the uniqueness')
})

await withClient('postgres', async (c) => {
  await c.query(`DROP DATABASE IF EXISTS "${RESTORE_DB}" WITH (FORCE)`)
})

const failed = results.filter((r) => r.outcome === 'FAIL')
console.log(`\n${results.length} checks — ${results.filter((r) => r.outcome === 'PASS').length} pass, ${failed.length} fail`)
process.exit(failed.length ? 1 : 0)
