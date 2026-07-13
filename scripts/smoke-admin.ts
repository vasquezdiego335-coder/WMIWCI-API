// ════════════════════════════════════════════════════════════════════════
//  smoke-admin.ts — non-destructive admin smoke test (increment 2.1).
//  Read-only DB checks + optional HTTP auth-guard probes. Creates NO data.
//
//  Run:  npm run smoke:admin
//        SMOKE_BASE_URL=https://your-admin npm run smoke:admin   (adds HTTP probes)
//
//  The authenticated click-through flow is a documented MANUAL checklist (see
//  docs/deployment.md) — this script proves the plumbing without a session.
// ════════════════════════════════════════════════════════════════════════
import { prisma } from '../src/lib/db'
import { ROADMAP_SEED } from '../src/lib/roadmap-seed'

let fail = false
const ok = (label: string, pass: boolean, note = '') => { console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${note ? ` — ${note}` : ''}`); if (!pass) fail = true }

async function dbChecks() {
  console.log('── DB (read-only) ──')
  // New + core models queryable.
  const models: [string, () => Promise<number>][] = [
    ['reminders', () => prisma.reminder.count()],
    ['scan_runs', () => prisma.scanRun.count()],
    ['roadmap_items', () => prisma.roadmapItem.count()],
    ['expenses', () => prisma.expense.count()],
    ['owner_transactions', () => prisma.ownerTransaction.count()],
    ['bookings', () => prisma.booking.count()],
    ['payments', () => prisma.payment.count()],
    ['jobs', () => prisma.job.count()],
    ['customers', () => prisma.customer.count()],
    ['audit_logs', () => prisma.auditLog.count()],
  ]
  for (const [name, fn] of models) {
    try { const n = await fn(); ok(`${name} queryable`, true, `${n} rows`) } catch (e) { ok(`${name} queryable`, false, e instanceof Error ? e.message : '') }
  }

  // Dedupe integrity: no duplicate reminder dedupe keys (unique constraint holds).
  try {
    const dupes = await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT COUNT(*) AS n FROM (SELECT dedupe_key FROM "reminders" GROUP BY dedupe_key HAVING COUNT(*) > 1) d`)
    ok('no duplicate reminder dedupe keys', Number(dupes[0]?.n ?? 0) === 0)
  } catch { ok('no duplicate reminder dedupe keys', false) }

  // Seed idempotency: seed_keys present should never exceed the catalog.
  try {
    const seeded = await prisma.roadmapItem.count({ where: { seedKey: { in: ROADMAP_SEED.map((s) => s.seedKey) } } })
    ok('roadmap seed idempotent (<= catalog)', seeded <= ROADMAP_SEED.length, `${seeded}/${ROADMAP_SEED.length}`)
  } catch { ok('roadmap seed idempotent', false) }

  // No stuck RUNNING scans older than an hour (would indicate a crash + no supersede).
  try {
    const stuck = await prisma.scanRun.count({ where: { status: 'RUNNING', startedAt: { lt: new Date(Date.now() - 3_600_000) } } })
    ok('no scans stuck RUNNING > 1h', stuck === 0, stuck ? `${stuck} stuck` : '')
  } catch { ok('no scans stuck RUNNING', false) }
}

async function httpChecks(base: string) {
  console.log(`── HTTP auth guards (${base}) ──`)
  const probe = async (path: string, expect: number[]) => {
    try {
      const res = await fetch(`${base}${path}`, { method: 'GET', redirect: 'manual' })
      ok(`${path} → ${res.status}`, expect.includes(res.status), `expected ${expect.join('/')}`)
    } catch (e) { ok(`${path} reachable`, false, e instanceof Error ? e.message : '') }
  }
  await probe('/api/health', [200, 503]) // public liveness
  await probe('/api/admin/ops-health', [401, 403]) // protected without a session
  await probe('/admin/action-center', [307, 302, 401]) // redirect to login without a session
}

async function main() {
  console.log('══ ADMIN SMOKE TEST (non-destructive) ══')
  await dbChecks()
  if (process.env.SMOKE_BASE_URL) await httpChecks(process.env.SMOKE_BASE_URL.replace(/\/+$/, ''))
  else console.log('  (set SMOKE_BASE_URL to add HTTP auth-guard probes)')
  console.log('════════════════════════════════════════')
  console.log(fail ? 'RESULT: FAIL' : 'RESULT: PASS')
  await prisma.$disconnect()
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
