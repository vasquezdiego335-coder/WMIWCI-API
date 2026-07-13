// ════════════════════════════════════════════════════════════════════════
//  flag-test-identities.ts — flag every booking + payment belonging to the
//  owner's TEST identities as internal tests, so they drop out of revenue and
//  operational counts. NON-DESTRUCTIVE: sets is_internal_test = true (a flag
//  the whole app already filters on). Never deletes, never changes status,
//  never touches Stripe (see mark-internal-tests.ts for the Stripe metadata).
//
//  DRY-RUN by default; --apply writes. Idempotent (only flips false → true).
//
//  Run:  npx tsx scripts/flag-test-identities.ts           (dry run + report)
//        npx tsx scripts/flag-test-identities.ts --apply   (write flags)
// ════════════════════════════════════════════════════════════════════════
import { prisma } from '../src/lib/db'

// Objective test-identity signals. Add future test emails/names here.
const TEST_EMAILS = ['vasquezdiego335@gmail.com']
const TEST_NAME_FRAGMENTS = ['diego orcon', 'sebastian galvez']

async function main() {
  const apply = process.argv.includes('--apply')
  console.log(`Mode: ${apply ? 'APPLY' : 'DRY RUN (no writes)'}\n`)

  const customers = await prisma.customer.findMany({
    where: {
      OR: [
        ...TEST_EMAILS.map((e) => ({ email: { equals: e, mode: 'insensitive' as const } })),
        ...TEST_NAME_FRAGMENTS.map((n) => ({ name: { contains: n, mode: 'insensitive' as const } })),
      ],
    },
    select: { id: true, name: true, email: true, bookings: { select: { id: true } } },
  })

  if (customers.length === 0) {
    console.log('No customers matched the test identities. Nothing to do.')
    await prisma.$disconnect()
    return
  }

  const bookingIds = customers.flatMap((c) => c.bookings.map((b) => b.id))
  for (const c of customers) console.log(`  ${c.name} <${c.email}> — ${c.bookings.length} bookings`)

  // What still needs flagging (idempotent).
  const bookingsToFlag = await prisma.booking.count({ where: { id: { in: bookingIds }, isInternalTest: false } })
  const paymentsToFlag = await prisma.payment.count({ where: { bookingId: { in: bookingIds }, isInternalTest: false } })
  const completedRevenue = await prisma.payment.aggregate({ where: { bookingId: { in: bookingIds }, status: 'COMPLETED' }, _sum: { amount: true } })

  console.log(`\nBookings to flag: ${bookingsToFlag}`)
  console.log(`Payments to flag: ${paymentsToFlag}`)
  console.log(`Completed test money that will leave revenue: $${((completedRevenue._sum.amount ?? 0) / 100).toFixed(2)}`)

  if (!apply) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply to flag these as internal tests.')
    await prisma.$disconnect()
    return
  }

  const [b, p] = await prisma.$transaction([
    prisma.booking.updateMany({ where: { id: { in: bookingIds }, isInternalTest: false }, data: { isInternalTest: true } }),
    prisma.payment.updateMany({ where: { bookingId: { in: bookingIds }, isInternalTest: false }, data: { isInternalTest: true } }),
  ])
  // Provenance (reuses the generic admin audit action; details carry specifics).
  await prisma.auditLog.create({
    data: {
      action: 'BOOKING_DETAILS_UPDATED',
      details: { kind: 'flag_test_identities', customers: customers.map((c) => c.email), bookingsFlagged: b.count, paymentsFlagged: p.count, via: 'scripts/flag-test-identities.ts' },
    },
  })
  console.log(`\n✅ Applied. Bookings flagged: ${b.count}. Payments flagged: ${p.count}. They are now excluded from all revenue + counts.`)
  await prisma.$disconnect()
}

main().catch((e) => { console.error(e); process.exit(1) })
