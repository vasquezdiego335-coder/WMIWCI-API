#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════════
//  scripts/winter/backup.mjs — winter backup of every Move It Clear It database.
//  ------------------------------------------------------------------------
//  READ-ONLY against the source databases: every session is opened with
//  default_transaction_read_only=on, and pg_dump only reads.
//
//  For each database it writes, into a NEW folder under MIC_BACKUP_DIR:
//    • <label>.dump          pg_dump custom format (when the local pg_dump is at
//                            least the server's major version), or
//    • <label>/schema.sql +  a logical export (tables, constraints, indexes,
//      <label>/<table>.csv.gz  one CSV per table) when the server is newer than
//                            the local pg_dump (pg_dump refuses that case);
//    • manifest.json         server version, exact row count per table,
//                            migration summary, sha256 + size of every file.
//
//  The connection strings come from environment variables and are NEVER printed
//  or written to the manifest (only the host name is recorded).
//
//  REFUSES to write inside a Git working tree: dumps contain customer data and
//  must never be committed.
//
//  Usage (Git Bash):
//    export MIC_BACKUP_DIR="$HOME/Documents/mic-db-backups"
//    export PGBIN="$HOME/pgclient/bin"
//    export NEON_DIRECT_URL='postgresql://…'          # Neon DIRECT host (not -pooler)
//    export LEADTRACKING_DB_URL='postgresql://…'      # optional, Railway public URL
//    export QRTRACKER_DB_URL='postgresql://…'         # optional, Railway public URL
//    node scripts/winter/backup.mjs [--label final]
//
//  Then run scripts/winter/restore-test.mjs on the folder it prints.
// ════════════════════════════════════════════════════════════════════════════
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'

const args = process.argv.slice(2)
const label = args.includes('--label') ? args[args.indexOf('--label') + 1] : 'rehearsal'
if (!/^[a-z0-9-]+$/.test(label)) die('--label must be lowercase letters, digits or dashes')

const OUT_ROOT = process.env.MIC_BACKUP_DIR
if (!OUT_ROOT) die('Set MIC_BACKUP_DIR to a private folder outside any Git repository.')
const PGBIN = process.env.PGBIN || ''
const bin = (name) => (PGBIN ? join(PGBIN, process.platform === 'win32' ? `${name}.exe` : name) : name)

const SOURCES = [
  { key: 'neon-main', env: 'NEON_DIRECT_URL', url: process.env.NEON_DIRECT_URL, required: true, note: 'Production API + worker database (Neon)' },
  { key: 'lead-tracking', env: 'LEADTRACKING_DB_URL', url: process.env.LEADTRACKING_DB_URL, required: false, note: 'Lead-tracking app (Railway Postgres)' },
  { key: 'qr-tracker', env: 'QRTRACKER_DB_URL', url: process.env.QRTRACKER_DB_URL, required: false, note: 'QR / door-hanger tracker (Railway Postgres)' },
]

function die(msg) {
  console.error(`backup: ${msg}`)
  process.exit(1)
}

function insideGitTree(p) {
  let d = resolve(p)
  for (;;) {
    if (existsSync(join(d, '.git'))) return d
    const up = dirname(d)
    if (up === d) return null
    d = up
  }
}

const repo = insideGitTree(OUT_ROOT)
if (repo) die(`MIC_BACKUP_DIR is inside the Git working tree ${repo}. Choose a private folder outside any repository.`)

// Strip sslmode/channel_binding params psql may not understand on Windows and
// pass the password through PGPASSWORD so it never appears in a process list.
function connEnv(url) {
  const u = new URL(url)
  const env = { ...process.env, PGPASSWORD: decodeURIComponent(u.password), PGCONNECT_TIMEOUT: '20' }
  env.PGSSLMODE = u.searchParams.get('sslmode') || (/\.rlwy\.net$|railway\.internal$/.test(u.hostname) ? 'prefer' : 'require')
  env.PGOPTIONS = '-c default_transaction_read_only=on'
  const cs = `host=${u.hostname} port=${u.port || 5432} dbname=${decodeURIComponent(u.pathname.slice(1))} user=${decodeURIComponent(u.username)}`
  return { env, cs, host: u.hostname }
}

function run(cmd, argv, env, opts = {}) {
  const r = spawnSync(cmd, argv, { env, encoding: opts.binary ? 'buffer' : 'utf8', maxBuffer: 1024 * 1024 * 512 })
  if (r.error) die(`${cmd}: ${r.error.message}`)
  if (r.status !== 0) die(`${cmd} failed (exit ${r.status}): ${String(r.stderr).replace(/password[^\s]*/gi, 'password=***').slice(0, 600)}`)
  return r.stdout
}

const psql = (c, sql, opts) => run(bin('psql'), [c.cs, '-X', '-v', 'ON_ERROR_STOP=1', '-At', '-F', '\t', '-c', sql], c.env, opts)

function sha256(file) {
  return new Promise((res, rej) => {
    const h = createHash('sha256')
    createReadStream(file).on('data', (d) => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej)
  })
}

function majorOf(v) {
  return Number(String(v).match(/(\d+)/)?.[1] ?? 0)
}

// Logical schema for a server newer than the local pg_dump. Small Flask
// databases only: tables, column types, NOT NULL, defaults, constraints and
// indexes — enough to rebuild and verify, not a replacement for pg_dump.
const SCHEMA_SQL = `
with t as (
  select c.oid, n.nspname, c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where c.relkind = 'r' and n.nspname = 'public'
)
select 1 as ord, t.relname, 'CREATE TABLE IF NOT EXISTS "' || t.relname || '" (' ||
  string_agg('"' || a.attname || '" ' ||
    case when pg_get_expr(d.adbin, d.adrelid) like 'nextval(%' then
      case format_type(a.atttypid, a.atttypmod) when 'bigint' then 'bigserial' else 'serial' end
    else format_type(a.atttypid, a.atttypmod) ||
      coalesce(' DEFAULT ' || pg_get_expr(d.adbin, d.adrelid), '') end ||
    case when a.attnotnull then ' NOT NULL' else '' end, ', ' order by a.attnum) || ');'
from t join pg_attribute a on a.attrelid = t.oid and a.attnum > 0 and not a.attisdropped
left join pg_attrdef d on d.adrelid = t.oid and d.adnum = a.attnum
group by t.relname
union all
select 2, t.relname, 'ALTER TABLE "' || t.relname || '" ADD CONSTRAINT "' || con.conname || '" ' || pg_get_constraintdef(con.oid) || ';'
from t join pg_constraint con on con.conrelid = t.oid where con.contype in ('p','u','c')
union all
select 3, t.relname, pg_get_indexdef(i.indexrelid) || ';'
from t join pg_index i on i.indrelid = t.oid
where not exists (select 1 from pg_constraint con where con.conindid = i.indexrelid)
union all
select 4, t.relname, 'ALTER TABLE "' || t.relname || '" ADD CONSTRAINT "' || con.conname || '" ' || pg_get_constraintdef(con.oid) || ';'
from t join pg_constraint con on con.conrelid = t.oid where con.contype = 'f'
order by 1, 2`

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
const outDir = join(OUT_ROOT, `mic-winter-${label}-${stamp}`)
mkdirSync(outDir, { recursive: true })

const pgDumpVersion = run(bin('pg_dump'), ['--version'], process.env).trim()
const manifest = { createdAt: new Date().toISOString(), label, tool: pgDumpVersion, sources: {} }

for (const s of SOURCES) {
  const url = s.url
  if (!url) {
    if (s.required) die(`${s.env} is not set`)
    console.log(`- ${s.key}: skipped (${s.env} not set)`)
    continue
  }
  const c = connEnv(url)
  const serverVersion = psql(c, `select current_setting('server_version')`).trim()
  const tables = psql(c, `select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind = 'r' and n.nspname = 'public' order by 1`)
    .split(/\r?\n/).filter(Boolean)
  const rowCounts = {}
  for (const t of tables) rowCounts[t] = Number(psql(c, `select count(*) from "${t.replace(/"/g, '""')}"`).trim())
  const entry = { note: s.note, host: c.host, serverVersion, tableCount: tables.length, rowCounts, files: {} }

  if (tables.includes('_prisma_migrations')) {
    const [applied, lastName] = psql(c, `select count(*) filter (where finished_at is not null and rolled_back_at is null), (select migration_name from _prisma_migrations where finished_at is not null order by finished_at desc limit 1) from _prisma_migrations`).trim().split('\t').map((x) => x.trim())
    entry.migrations = { applied: Number(applied), last: lastName }
  }
  entry.extensions = psql(c, `select extname || ' ' || extversion from pg_extension order by 1`).split(/\r?\n/).filter(Boolean)

  if (majorOf(pgDumpVersion) >= majorOf(serverVersion)) {
    const file = join(outDir, `${s.key}.dump`)
    run(bin('pg_dump'), [c.cs, '--format=custom', '--no-owner', '--no-acl', '--file', file], c.env)
    entry.method = 'pg_dump custom format'
    entry.files[`${s.key}.dump`] = { bytes: statSync(file).size, sha256: await sha256(file) }
  } else {
    const dir = join(outDir, s.key)
    mkdirSync(dir)
    const ddl = psql(c, SCHEMA_SQL).split(/\r?\n/).filter(Boolean).map((l) => l.split('\t').map((x) => x.trim()).slice(2).join('\t'))
    writeFileSync(join(dir, 'schema.sql'), `-- ${s.key}: logical schema exported ${manifest.createdAt} from PostgreSQL ${serverVersion}\n${ddl.join('\n')}\n`)
    entry.files[`${s.key}/schema.sql`] = { bytes: statSync(join(dir, 'schema.sql')).size, sha256: await sha256(join(dir, 'schema.sql')) }
    for (const t of tables) {
      const csv = run(bin('psql'), [c.cs, '-X', '-v', 'ON_ERROR_STOP=1', '-c', `\\copy (select * from "${t.replace(/"/g, '""')}") to stdout with (format csv, header true)`], c.env, { binary: true })
      const f = join(dir, `${t}.csv.gz`)
      writeFileSync(f, gzipSync(csv))
      entry.files[`${s.key}/${t}.csv.gz`] = { bytes: statSync(f).size, sha256: await sha256(f) }
    }
    entry.method = `logical export (server ${serverVersion} is newer than ${pgDumpVersion})`
  }
  manifest.sources[s.key] = entry
  const total = Object.values(rowCounts).reduce((a, b) => a + b, 0)
  console.log(`- ${s.key}: ${entry.method}; ${tables.length} tables, ${total} rows${entry.migrations ? `, ${entry.migrations.applied} migrations (last ${entry.migrations.last})` : ''}`)
}

writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
console.log(`\nBackup written to: ${outDir}`)
console.log(`Files: ${readdirSync(outDir).join(', ')}`)
console.log('Next: node scripts/winter/restore-test.mjs "' + outDir + '"')
