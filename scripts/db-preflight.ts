// ════════════════════════════════════════════════════════════════════════
//  db-preflight.ts — READ-ONLY migration safety check (increment 2.1).
//  Run BEFORE `prisma migrate deploy` in production. Reports the connection
//  target (host only, never the password), pending/failed migrations, and
//  whether the tables/enums this app version expects already exist. Mutates
//  NOTHING. Exit code 1 on a hard problem (failed migration / unreachable DB).
//
//  Run:  npm run db:preflight
// ════════════════════════════════════════════════════════════════════════
import { prisma } from '../src/lib/db'

function safeTarget(): string {
  const url = process.env.DATABASE_URL ?? ''
  try {
    const u = new URL(url)
    return `${u.host}${u.pathname}` // host + db name only — no user/password
  } catch {
    return '(DATABASE_URL not parseable)'
  }
}

async function tableExists(name: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<{ exists: boolean }[]>(`SELECT to_regclass('public."${name}"') IS NOT NULL AS exists`)
  return !!rows[0]?.exists
}

async function enumExists(name: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<{ exists: boolean }[]>(`SELECT EXISTS (SELECT 1 FROM pg_type WHERE typname = '${name}') AS exists`)
  return !!rows[0]?.exists
}

async function main() {
  let hardFail = false
  console.log('── DB PREFLIGHT (read-only) ──────────────────────────────')
  console.log('Target:', safeTarget())

  try {
    await prisma.$queryRaw`SELECT 1`
    console.log('Connectivity: OK')
  } catch (e) {
    console.error('Connectivity: FAILED —', e instanceof Error ? e.message : String(e))
    process.exit(1)
  }

  // Prisma migration ledger.
  try {
    const migrations = await prisma.$queryRawUnsafe<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }[]>(
      `SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY started_at`,
    )
    const failed = migrations.filter((m) => !m.finished_at && !m.rolled_back_at)
    const rolledBack = migrations.filter((m) => m.rolled_back_at)
    console.log(`Applied migrations: ${migrations.filter((m) => m.finished_at).length}`)
    if (rolledBack.length) console.log('Rolled-back (need attention):', rolledBack.map((m) => m.migration_name).join(', '))
    if (failed.length) {
      hardFail = true
      console.error('IN-PROGRESS/FAILED migrations:', failed.map((m) => m.migration_name).join(', '))
    }
  } catch {
    console.log('Migration ledger: _prisma_migrations not found (fresh DB?)')
  }

  // What THIS app version expects to exist after deploy. Missing => the
  // migration for it is pending (informational, not a failure pre-deploy).
  const expectTables = ['reminders', 'scan_runs', 'roadmap_items', 'expenses', 'owner_transactions', 'leads', 'business_config']
  const expectEnums = ['ScanStatus', 'ScanTrigger', 'DismissalScope', 'ReminderSeverity', 'RoadmapStatus']
  console.log('── Expected schema objects ──')
  for (const t of expectTables) console.log(`  table ${t}: ${(await tableExists(t)) ? 'present' : 'MISSING (pending migration)'}`)
  for (const e of expectEnums) console.log(`  enum  ${e}: ${(await enumExists(e)) ? 'present' : 'MISSING (pending migration)'}`)

  // Core tables that must NEVER disappear.
  for (const t of ['bookings', 'payments', 'jobs', 'customers', 'users', 'audit_logs']) {
    if (!(await tableExists(t))) { hardFail = true; console.error(`  CORE table ${t}: MISSING — abort deploy`) }
  }

  console.log('──────────────────────────────────────────────────────────')
  console.log(hardFail ? 'RESULT: STOP — resolve the issues above before deploying.' : 'RESULT: OK to run `npx prisma migrate deploy`.')
  await prisma.$disconnect()
  process.exit(hardFail ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
