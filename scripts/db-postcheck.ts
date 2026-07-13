// ════════════════════════════════════════════════════════════════════════
//  db-postcheck.ts — READ-ONLY verification AFTER `prisma migrate deploy`
//  (increment 2.1). Confirms the new tables/enums/indexes exist and are
//  queryable, and that the core tables still are. Mutates NOTHING. Exit 1 if
//  anything expected is missing.
//
//  Run:  npm run db:postcheck
// ════════════════════════════════════════════════════════════════════════
import { prisma } from '../src/lib/db'

async function tableExists(name: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<{ exists: boolean }[]>(`SELECT to_regclass('public."${name}"') IS NOT NULL AS exists`)
  return !!rows[0]?.exists
}
async function indexExists(name: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<{ exists: boolean }[]>(`SELECT to_regclass('public."${name}"') IS NOT NULL AS exists`)
  return !!rows[0]?.exists
}

async function main() {
  let fail = false
  const ok = (label: string, pass: boolean) => { console.log(`  ${pass ? 'OK ' : 'MISSING'}  ${label}`); if (!pass) fail = true }

  console.log('── DB POSTCHECK (read-only) ──────────────────────────────')

  // New tables queryable.
  for (const t of ['reminders', 'scan_runs', 'roadmap_items']) {
    try { await prisma.$queryRawUnsafe(`SELECT 1 FROM "${t}" LIMIT 1`); ok(`table ${t} queryable`, true) }
    catch { ok(`table ${t} queryable`, false) }
  }

  // Prisma-model queryability (proves the client matches the deployed schema).
  try { await prisma.reminder.count(); ok('prisma.reminder.count()', true) } catch { ok('prisma.reminder.count()', false) }
  try { await prisma.scanRun.count(); ok('prisma.scanRun.count()', true) } catch { ok('prisma.scanRun.count()', false) }
  try { await prisma.roadmapItem.count(); ok('prisma.roadmapItem.count()', true) } catch { ok('prisma.roadmapItem.count()', false) }

  // Critical constraints / indexes.
  ok('reminders.dedupe_key unique index', await indexExists('reminders_dedupe_key_key'))
  ok('reminders (entity type,id) index', await indexExists('reminders_source_entity_type_source_entity_id_idx'))
  ok('scan_runs status index', await indexExists('scan_runs_status_idx'))

  // Core tables still present.
  for (const t of ['bookings', 'payments', 'jobs', 'customers', 'users', 'audit_logs', 'expenses', 'owner_transactions']) {
    ok(`core table ${t}`, await tableExists(t))
  }

  console.log('──────────────────────────────────────────────────────────')
  console.log(fail ? 'RESULT: FAIL — schema is not fully migrated.' : 'RESULT: PASS — schema is consistent.')
  await prisma.$disconnect()
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
