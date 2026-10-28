#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════════
//  scripts/winter/restore-test.mjs — prove a winter backup restores and is whole.
//  ------------------------------------------------------------------------
//  Restores every database in a backup folder (made by backup.mjs) into an
//  ISOLATED, throwaway PostgreSQL on 127.0.0.1, then checks it:
//    • every table's row count equals the count recorded at backup time;
//    • every foreign key is present and validated (no orphaned rows);
//    • Prisma migration history is intact (count and last migration name);
//    • bookings keep unique, non-empty references; the hand-written partial
//      unique index on crm_leads exists; pgcrypto is installed;
//    • the email suppression list has the same number of rows.
//
//  ISOLATION. Nothing here starts the application, so nothing can send email or
//  SMS or create a payment. The throwaway server listens on 127.0.0.1 only and
//  its data folder is deleted at the end (use --keep to inspect it). It refuses
//  any RESTORE_TEST_URL whose host is not localhost/127.0.0.1.
//
//  Usage (Git Bash):
//    export PGBIN="$HOME/pgclient/bin"                 # psql + pg_restore
//    export PG_SERVER_BIN="<folder with initdb, pg_ctl, postgres>"   # any PG >= the dump's
//    node scripts/winter/restore-test.mjs "<backup folder>" [--keep]
//  Writes restore-report.json into the backup folder; exits 1 on any failure.
// ════════════════════════════════════════════════════════════════════════════
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'

const [folder, ...rest] = process.argv.slice(2)
const keep = rest.includes('--keep')
if (!folder || !existsSync(join(folder, 'manifest.json'))) fail('pass a backup folder that contains manifest.json')
const manifest = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8'))
const exe = (dir, n) => (dir ? join(dir, process.platform === 'win32' ? `${n}.exe` : n) : n)
const PGBIN = process.env.PGBIN || ''
const SERVER_BIN = process.env.PG_SERVER_BIN || ''

function fail(msg) {
  console.error(`restore-test: ${msg}`)
  process.exit(1)
}

function run(cmd, argv, env = process.env, allowFail = false) {
  const r = spawnSync(cmd, argv, { env, encoding: 'utf8', maxBuffer: 1024 * 1024 * 256 })
  if (r.error) fail(`${cmd}: ${r.error.message}`)
  if (r.status !== 0 && !allowFail) fail(`${cmd} ${argv[0] ?? ''} failed (exit ${r.status}): ${(r.stderr || r.stdout).slice(0, 1200)}`)
  return r
}

const freePort = () =>
  new Promise((res) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => res(port))
    })
  })

// ── isolated server ─────────────────────────────────────────────────────────
let base
let stopServer = () => {}
let dataDir
if (process.env.RESTORE_TEST_URL) {
  const u = new URL(process.env.RESTORE_TEST_URL)
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname)) fail('RESTORE_TEST_URL must point at localhost; never restore into a shared or production server.')
  base = { host: u.hostname, port: u.port || '5432', user: decodeURIComponent(u.username), password: decodeURIComponent(u.password) }
} else {
  if (!SERVER_BIN) fail('set PG_SERVER_BIN (initdb/pg_ctl/postgres) or RESTORE_TEST_URL (localhost only)')
  dataDir = mkdtempSync(join(tmpdir(), 'mic-restore-'))
  const port = await freePort()
  run(exe(SERVER_BIN, 'initdb'), ['-D', join(dataDir, 'data'), '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--no-locale'])
  // stdio 'ignore': on Windows the server inherits pg_ctl's pipes, and a piped
  // spawnSync would wait for the server itself to exit.
  const started = spawnSync(exe(SERVER_BIN, 'pg_ctl'), ['-D', join(dataDir, 'data'), '-l', join(dataDir, 'server.log'), '-o', `-p ${port} -c listen_addresses=127.0.0.1`, '-w', 'start'], { stdio: 'ignore' })
  if (started.status !== 0) fail(`pg_ctl start failed (exit ${started.status}); see ${join(dataDir, 'server.log')}`)
  base = { host: '127.0.0.1', port: String(port), user: 'postgres', password: '' }
  stopServer = () => {
    spawnSync(exe(SERVER_BIN, 'pg_ctl'), ['-D', join(dataDir, 'data'), '-m', 'fast', '-w', 'stop'], { stdio: 'ignore' })
    if (!keep) rmSync(dataDir, { recursive: true, force: true })
  }
  console.log(`isolated PostgreSQL on 127.0.0.1:${port} (data folder ${keep ? 'kept at ' + dataDir : 'deleted afterwards'})`)
}
const env = { ...process.env, PGPASSWORD: base.password, PGSSLMODE: 'disable', PGOPTIONS: '' }
const cs = (db) => `host=${base.host} port=${base.port} user=${base.user} dbname=${db}`
const q = (db, sql) => run(exe(PGBIN, 'psql'), [cs(db), '-X', '-v', 'ON_ERROR_STOP=1', '-At', '-F', '\t', '-c', sql], env).stdout.trim()

const report = { testedAt: new Date().toISOString(), backup: folder, backupCreatedAt: manifest.createdAt, results: {} }
let ok = true

try {
  const serverVersion = q('postgres', `select current_setting('server_version')`)
  report.restoreServer = serverVersion
  for (const [key, src] of Object.entries(manifest.sources)) {
    const db = `restore_${key.replace(/-/g, '_')}`
    q('postgres', `create database ${db}`)
    const checks = []
    const check = (name, pass, detail = '') => {
      checks.push({ name, pass, detail })
      if (!pass) ok = false
    }

    // ── restore ──
    if (src.files[`${key}.dump`]) {
      if (src.extensions?.some((e) => e.startsWith('pgcrypto'))) q(db, 'create extension if not exists pgcrypto')
      const r = run(exe(PGBIN, 'pg_restore'), ['--no-owner', '--no-acl', '--dbname', cs(db), join(folder, `${key}.dump`)], env, true)
      // A restore may only warn about things this throwaway server does not have
      // (e.g. an extension that already exists). Anything else is a failure.
      const errs = (r.stderr || '').split(/\r?\n/).filter((l) => /error/i.test(l) && !/already exists|errors ignored on restore/i.test(l))
      check('pg_restore completed', r.status === 0 || errs.length === 0, errs.slice(0, 5).join(' | '))
    } else {
      const lines = readFileSync(join(folder, key, 'schema.sql'), 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('--'))
      const later = (l) => /FOREIGN KEY/.test(l) || /^CREATE (UNIQUE )?INDEX/.test(l)
      run(exe(PGBIN, 'psql'), [cs(db), '-X', '-v', 'ON_ERROR_STOP=1', '-q', '-c', lines.filter((l) => !later(l)).join('\n')], env)
      for (const t of Object.keys(src.rowCounts)) {
        const tmp = join(dataDir ?? tmpdir(), `${key}-${t}.csv`)
        writeFileSync(tmp, gunzipSync(readFileSync(join(folder, key, `${t}.csv.gz`))))
        run(exe(PGBIN, 'psql'), [cs(db), '-X', '-v', 'ON_ERROR_STOP=1', '-c', `\\copy "${t}" from '${tmp.replace(/\\/g, '/')}' with (format csv, header true)`], env)
        rmSync(tmp, { force: true })
      }
      run(exe(PGBIN, 'psql'), [cs(db), '-X', '-v', 'ON_ERROR_STOP=1', '-q', '-c', lines.filter(later).join('\n') || 'select 1'], env)
      // Move serial sequences past the restored ids so a restarted app cannot collide.
      q(db, `do $$ declare r record; begin for r in select c.relname t, a.attname col from pg_class c join pg_attribute a on a.attrelid=c.oid join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum where pg_get_expr(d.adbin,d.adrelid) like 'nextval(%' loop execute format('select setval(pg_get_serial_sequence(%L,%L), coalesce((select max(%I) from %I),0)+1, false)', r.t, r.col, r.col, r.t); end loop; end $$`)
      check('logical restore completed', true)
    }

    // ── row counts ──
    const mismatches = []
    for (const [t, n] of Object.entries(src.rowCounts)) {
      const got = Number(q(db, `select count(*) from "${t}"`))
      if (got !== n) mismatches.push(`${t}: backup ${n}, restored ${got}`)
    }
    check(`row counts match for all ${Object.keys(src.rowCounts).length} tables`, mismatches.length === 0, mismatches.join('; '))

    // ── relationships ──
    const fks = Number(q(db, `select count(*) from pg_constraint where contype='f'`))
    const unvalidated = Number(q(db, `select count(*) from pg_constraint where contype='f' and not convalidated`))
    check('foreign keys restored and validated', unvalidated === 0, `${fks} foreign keys`)

    // ── Prisma / application specifics ──
    if (src.migrations) {
      const [applied, last] = q(db, `select count(*) filter (where finished_at is not null and rolled_back_at is null), (select migration_name from _prisma_migrations where finished_at is not null order by finished_at desc limit 1) from _prisma_migrations`).split('\t').map((x) => x.trim())
      check('migration history intact', Number(applied) === src.migrations.applied && last === src.migrations.last, `${applied} applied, last ${last}`)
    }
    if (src.rowCounts.bookings !== undefined) {
      const [blank, dupDisplay, dupRef] = q(db, `select (select count(*) from bookings where display_id is null or display_id=''), (select count(*) from (select display_id from bookings group by 1 having count(*)>1) x), (select count(*) from (select booking_reference from bookings where booking_reference is not null group by 1 having count(*)>1) x)`).split('\t').map((x) => x.trim()).map(Number)
      check('booking references present and unique', blank === 0 && dupDisplay === 0 && dupRef === 0, `blank ${blank}, duplicate display ids ${dupDisplay}, duplicate references ${dupRef}`)
      const orphans = q(db, `select (select count(*) from bookings b left join customers c on c.id=b.customer_id where c.id is null) || ',' || (select count(*) from payments p left join bookings b on b.id=p.booking_id where b.id is null) || ',' || (select count(*) from deposit_requests d left join bookings b on b.id=d.booking_id where d.booking_id is not null and b.id is null)`)
      check('bookings→customers, payments→bookings, deposits→bookings have no orphans', orphans === '0,0,0', orphans)
    }
    if (src.rowCounts.crm_leads !== undefined) {
      const idx = q(db, `select count(*) from pg_indexes where indexname='crm_leads_open_booking_session_key'`)
      check('partial unique index crm_leads_open_booking_session_key exists', idx === '1')
    }
    if (src.extensions?.some((e) => e.startsWith('pgcrypto'))) {
      check('pgcrypto installed', q(db, `select count(*) from pg_extension where extname='pgcrypto'`) === '1')
    }
    if (src.rowCounts.email_suppressions !== undefined) {
      check('email suppression list complete', Number(q(db, 'select count(*) from email_suppressions')) === src.rowCounts.email_suppressions, `${src.rowCounts.email_suppressions} rows`)
    }

    report.results[key] = { database: db, checks }
    for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${key}: ${c.name}${c.detail ? ` (${c.detail})` : ''}`)
  }
} finally {
  stopServer()
}

report.passed = ok
writeFileSync(join(folder, 'restore-report.json'), JSON.stringify(report, null, 2))
console.log(`\n${ok ? 'RESTORE TEST PASSED' : 'RESTORE TEST FAILED'} — report: ${join(folder, 'restore-report.json')}`)
process.exit(ok ? 0 : 1)
