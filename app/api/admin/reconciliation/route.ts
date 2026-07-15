import { NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { can, type Role } from '@/lib/permissions'
import { runReconciliation } from '@/lib/reconciliation'

export const runtime = 'nodejs'
export const revalidate = 0

// GET /api/admin/reconciliation?days=30 — owner-only payment integrity report.
// Cross-references recent Stripe charges with local Payments + Bookings and
// returns every mismatch (captured-no-row, confirmed-no-payment, amount drift,
// duplicates, refund/dispute state). Read-only — never mutates.
export async function GET(req: Request): Promise<NextResponse> {
  const session = await getSession()
  if (!session || !can(session.role as Role, 'audit.view')) {
    return NextResponse.json({ error: 'Owner only.' }, { status: 403 })
  }
  const days = Math.min(90, Math.max(1, parseInt(new URL(req.url).searchParams.get('days') ?? '30', 10) || 30))
  try {
    const report = await runReconciliation(days)
    return NextResponse.json(report)
  } catch (err) {
    return NextResponse.json(
      { error: 'Reconciliation failed', detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}
