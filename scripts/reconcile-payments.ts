// ════════════════════════════════════════════════════════════════════════
//  reconcile-payments.ts — durable payment reconciliation (owner spec 2026-07-15).
//  Cross-references recent Stripe charges with local Payment/Booking rows and
//  prints every money-integrity issue. Read-only — never mutates. Exit code 2
//  when a CRITICAL issue (captured money with no Payment row) is found, so it
//  can gate a cron / CI alert.
//
//  Usage:  npm run reconcile           (last 30 days)
//          npm run reconcile -- 60      (last 60 days)
// ════════════════════════════════════════════════════════════════════════
import 'dotenv/config'
import { runReconciliation } from '../src/lib/reconciliation'

async function main(): Promise<void> {
  const days = Number(process.argv[2]) || 30
  const report = await runReconciliation(days)
  console.log(JSON.stringify(report, null, 2))
  console.error(
    `\nReconciliation: ${report.issues.length} issue(s) across ${report.chargesChecked} charges / ` +
      `${report.paymentsChecked} payments / ${report.bookingsChecked} bookings (last ${report.windowDays}d).`,
  )
  const hasCritical = report.issues.some((i) => i.severity === 'critical')
  process.exit(hasCritical ? 2 : 0)
}

main().catch((e) => {
  console.error('reconcile-payments failed:', e instanceof Error ? e.message : String(e))
  process.exit(1)
})
