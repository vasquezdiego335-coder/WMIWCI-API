// ════════════════════════════════════════════════════════════════════════
//  flag-test-bookings.ts — classify the owner's checkout-test bookings so the
//  dashboard reflects REAL operational state (fixes the inflated "53").
//
//  This does NOT hardcode a number. It flags bookings that match objective
//  internal-test SIGNALS, and prints the resulting real counts so the owner can
//  verify. Signals (any one → internal test):
//    • customer email in TEST_EMAILS (placeholder + owner's own address), or
//    • the booking's only completed payment is an internal-test payment.
//  DRY-RUN by default; --apply writes booking.is_internal_test = true.
//  Never deletes, never changes status, never touches Stripe. Idempotent.
//
//  Run:  npx tsx scripts/flag-test-bookings.ts           (dry run + report)
//        npx tsx scripts/flag-test-bookings.ts --apply   (write flags)
// ════════════════════════════════════════════════════════════════════════
import { prisma } from '../src/lib/db'
import { BookingStatus } from '@prisma/client'

// Objective test signals. Add real friends-and-family test emails here if any.
const TEST_EMAILS = ['vasquezdiego335@gmail.com', 'test@example.com', 'you@example.com']

const OPERATIONAL: BookingStatus[] = ['PENDING_APPROVAL', 'CONFIRMED', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED']

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply')
  console.log(`Mode: ${apply ? 'APPLY' : 'DRY RUN (no writes)'}\n`)

  // Candidates: email match OR every completed payment is an internal test.
  const candidates = await prisma.booking.findMany({
    where: {
      isInternalTest: false,
      OR: [
        { customer: { email: { in: TEST_EMAILS } } },
        { payments: { some: { status: 'COMPLETED', isInternalTest: true } } },
      ],
    },
    select: { id: true, status: true, customer: { select: { email: true } } },
  })

  console.log(`Test-signal bookings found: ${candidates.length}`)
  for (const b of candidates) console.log(`  ${b.status.padEnd(16)} ${b.customer.email}`)

  if (apply && candidates.length) {
    const res = await prisma.booking.updateMany({
      where: { id: { in: candidates.map((b) => b.id) } },
      data: { isInternalTest: true },
    })
    console.log(`\nFlagged ${res.count} booking(s) as internal tests.`)
  }

  // ── Report the REAL operational state the dashboard will show (accurate in
  //    both modes: subtract the candidates from the not-yet-flagged set). ──
  const candidateIds = new Set(candidates.map((b) => b.id))
  const [operational, abandoned] = await Promise.all([
    prisma.booking.findMany({ where: { status: { in: OPERATIONAL }, isInternalTest: false }, select: { id: true, status: true } }),
    prisma.booking.count({ where: { status: 'PENDING_PAYMENT' } }),
  ])
  const byStatus: Record<string, number> = {}
  for (const b of operational) if (!candidateIds.has(b.id)) byStatus[b.status] = (byStatus[b.status] ?? 0) + 1
  console.log('\n── After' + (apply ? '' : ' (projected, run --apply to persist)') + ' ──')
  console.log('Real operational bookings by status:', Object.entries(byStatus).map(([s, n]) => `${s}=${n}`).join(', ') || '(none)')
  console.log(`Internal-test bookings flagged: ${candidates.length}`)
  console.log(`Abandoned checkouts (PENDING_PAYMENT, excluded by design): ${abandoned}`)
  await prisma.$disconnect()
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
