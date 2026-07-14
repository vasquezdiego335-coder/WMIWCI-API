import 'dotenv/config'
import { prisma } from '../src/lib/db'
import { formatBookingReference } from '../src/lib/booking-reference'

// ════════════════════════════════════════════════════════════════════════
//  backfill-booking-reference.ts — assign WMIC-#### references to existing
//  bookings that predate the booking_reference column.
//
//  SAFE BY DEFAULT: dry-run unless --apply is passed.
//    npx tsx scripts/backfill-booking-reference.ts            # dry-run (default)
//    npx tsx scripts/backfill-booking-reference.ts --apply    # write to the DB
//
//  Properties:
//    • Deterministic order (createdAt asc, then id) → stable numbering.
//    • Idempotent: only rows with bookingReference = NULL are touched; the write
//      is guarded on `bookingReference: null` so a re-run (or a concurrent live
//      insert) can never double-assign.
//    • Atomic + collision-free: references come from the SAME Postgres sequence
//      the live insert default uses (booking_reference_seq), so backfilled rows
//      and new bookings share one monotonic series.
//    • POLICY: historical internal-test bookings (isInternalTest=true) are
//      SKIPPED — they keep bookingReference = NULL and never consume a real
//      customer number. Real bookings receive normal WMIC-#### references.
//    • Mirrors the reference into displayId (replacing the old cuid) so every
//      customer/owner surface shows the friendly reference.
// ════════════════════════════════════════════════════════════════════════

const APPLY = process.argv.includes('--apply')

async function main(): Promise<void> {
  const rows = await prisma.booking.findMany({
    where: { bookingReference: null },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      displayId: true,
      isInternalTest: true,
      status: true,
      createdAt: true,
      customer: { select: { email: true } },
    },
  })

  const eligible = rows.filter((r) => !r.isInternalTest)
  const skippedTest = rows.filter((r) => r.isInternalTest)

  console.log(`\n═══ Booking-reference backfill — ${APPLY ? 'APPLY (writing)' : 'DRY-RUN (no writes)'} ═══`)
  console.log(`  rows without a reference : ${rows.length}`)
  console.log(`  skipped (internal test)  : ${skippedTest.length}`)
  console.log(`  to assign (real bookings): ${eligible.length}\n`)

  if (!APPLY) {
    for (const r of eligible) {
      console.log(`  WOULD ASSIGN  ${r.id}  ${r.createdAt.toISOString().slice(0, 10)}  ${r.customer?.email ?? '—'}  [${r.status}]`)
    }
    for (const r of skippedTest) {
      console.log(`  SKIP (test)   ${r.id}  ${r.customer?.email ?? '—'}`)
    }
    console.log(`\nDry-run only. Exact WMIC numbers are minted from the sequence on --apply.`)
    console.log(`Re-run with --apply to write ${eligible.length} reference(s).`)
    return
  }

  let assigned = 0
  for (const r of eligible) {
    const seq = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT nextval('booking_reference_seq') AS n`
    const ref = formatBookingReference(seq[0].n)
    // Guarded on bookingReference: null → idempotent + safe against a concurrent
    // live insert that may have referenced this row first.
    const res = await prisma.booking.updateMany({
      where: { id: r.id, bookingReference: null },
      data: { bookingReference: ref, displayId: ref },
    })
    if (res.count === 1) {
      assigned++
      console.log(`  ASSIGNED  ${ref}  ←  ${r.id}  (${r.customer?.email ?? '—'})`)
    } else {
      console.log(`  already set, skipped  ${r.id}`)
    }
  }
  console.log(`\nDone. Assigned ${assigned} reference(s); skipped ${skippedTest.length} internal-test row(s).`)
}

main()
  .catch((e) => {
    console.error('backfill failed:', e instanceof Error ? e.message : e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
