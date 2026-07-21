// ════════════════════════════════════════════════════════════════════════════
//  stage4-closeout-rehearsal.ts — drive ONE move through the entire financial
//  workflow and report every place the workflow breaks.
//
//  Owner spec 2026-07-21, Stage 4 step 1: "Begin Stage 4 by closing one move end
//  to end. Use the real workflow to discover what is broken."
//
//  SAFETY — this script is bounded by construction:
//    * The move it creates is `isInternalTest: true`, so money-rules excludes it
//      from every revenue aggregate, report and dashboard figure.
//    * It NEVER calls Stripe. No PaymentIntent, no capture, no refund.
//    * It NEVER sends email or SMS (it does not touch notify/outbox at all).
//    * It NEVER reads or writes a real customer booking. Every row it creates
//      carries the STAGE4_TAG below, and --cleanup removes exactly those rows.
//    * Figures are SYNTHETIC and labelled as such. Nothing here is a claim
//      about real money.
//
//  Usage:
//    npx tsx scripts/stage4-closeout-rehearsal.ts --seed-config
//    npx tsx scripts/stage4-closeout-rehearsal.ts --run
//    npx tsx scripts/stage4-closeout-rehearsal.ts --cleanup
// ════════════════════════════════════════════════════════════════════════════

import { PrismaClient } from '@prisma/client'
import { customerBalance, JOB_MONEY_PAYMENT_SELECT } from '../src/lib/job-money'
import { buildCloseoutView } from '../src/lib/closeout-service'
import { ensureJobForBooking } from '../src/lib/labor-service'

const prisma = new PrismaClient()

/** Every row this rehearsal creates is tagged so cleanup is exact. */
const STAGE4_TAG = 'STAGE4-REHEARSAL'
const TEST_EMAIL = 'stage4-rehearsal@moveitclearit.internal'

const d = (c: number | null | undefined) => `$${((c ?? 0) / 100).toFixed(2)}`
const step = (n: string) => console.log(`\n─── ${n} ${'─'.repeat(Math.max(0, 60 - n.length))}`)
const ok = (m: string) => console.log(`  ✓ ${m}`)
const bad = (m: string) => { console.log(`  ✗ DEFECT: ${m}`); DEFECTS.push(m) }
const note = (m: string) => console.log(`  · ${m}`)
const DEFECTS: string[] = []

// ── Owner-specified business config (2026-07-21): 40% business reserve,
//    30% to each owner. Splits apply to DISTRIBUTABLE profit, so 50/50 of the
//    remaining 60% == 30% each of company net profit.
async function seedConfig(): Promise<void> {
  step('SEED BusinessConfig (owner-specified 40/30/30)')
  const before = await prisma.businessConfig.findUnique({ where: { id: 'singleton' } })
  note(before ? 'existing row found — updating' : 'NO row existed (production had none)')
  const cfg = await prisma.businessConfig.upsert({
    where: { id: 'singleton' },
    update: {},
    create: {
      id: 'singleton',
      diegoSplitPercent: 50,      // of DISTRIBUTABLE → 30% of net profit
      sebastianSplitPercent: 50,  // of DISTRIBUTABLE → 30% of net profit
      taxReservePercent: 0,       // owner allocation totals 100% (40+30+30)
      generalReserveBp: 4000,     // 40% business reserve
    },
  })
  ok(`config: diego ${cfg.diegoSplitPercent}% / sebastian ${cfg.sebastianSplitPercent}% of distributable`)
  ok(`tax reserve ${cfg.taxReservePercent}% · business reserve ${cfg.generalReserveBp / 100}%`)
  ok(`owner economic rate ${d(cfg.ownerEconomicRateCents)}/h · OT after ${cfg.overtimeThresholdMinutes}min at ${cfg.overtimeMultiplierPct}%`)
  if (cfg.taxReservePercent === 0) {
    note('TAX RESERVE IS 0 — the 40% business reserve is the only buffer. Owner decision, flagged for review.')
  }
}

async function run(): Promise<void> {
  // ── A. Create the synthetic move ──────────────────────────────────────────
  step('A. CREATE synthetic internal-test move')
  const customer = await prisma.customer.upsert({
    where: { email: TEST_EMAIL },
    update: {},
    create: { email: TEST_EMAIL, name: `${STAGE4_TAG} Customer`, phone: '', isFirstTime: false },
  })
  let booking = await prisma.booking.findFirst({ where: { customerId: customer.id } })
  if (!booking) {
    booking = await prisma.booking.create({
      data: {
        customerId: customer.id,
        bookingReference: `${STAGE4_TAG}-1`,
        displayId: `${STAGE4_TAG}-1`,
        status: 'CONFIRMED',
        isInternalTest: true,
        originAddress: '1 Test St, Newark, NJ 07102',
        destAddress: '2 Test Ave, Jersey City, NJ 07302',
        itemsDescription: `${STAGE4_TAG} — synthetic move for Stage 4 workflow verification. Not a real job.`,
        requestedDate: new Date(),
        baseRate: 599,          // DOLLARS — 1BR
        totalEstimate: 649,     // DOLLARS — base 599 + travel 50
        travelFee: 5000,        // CENTS
        travelFeeDueOnMoveDay: true,
        truckAddonDueOnMoveDay: true,
        truckAddonAmount: 5000, // CENTS
        depositAmount: 4900,
        depositPaid: false,
        customerTokenExpiry: new Date(Date.now() + 7 * 24 * 3600_000),
      },
    })
    ok(`created ${booking.displayId} (isInternalTest=true)`)
  } else {
    ok(`reusing ${booking.displayId}`)
  }
  const id = booking.id

  // ── B. Job record ─────────────────────────────────────────────────────────
  step('B. ENSURE Job record (idempotent)')
  const jobId1 = await ensureJobForBooking(id)
  const jobId2 = await ensureJobForBooking(id)
  jobId1 === jobId2 ? ok('ensureJobForBooking is idempotent — no duplicate Job') : bad('ensureJobForBooking created a second Job')
  const jobCount = await prisma.job.count({ where: { bookingId: id } })
  jobCount === 1 ? ok('exactly one Job for the booking') : bad(`${jobCount} Jobs for one booking`)

  // AUDIT-LOG GAP CHECK: does Job creation write an audit entry?
  const jobAudit = await prisma.auditLog.count({ where: { bookingId: id, action: { in: ['JOB_STARTED', 'BOOKING_STATE_CHANGED'] } } })
  if (jobAudit === 0) bad('AUDIT GAP: ensureJobForBooking writes no audit-log entry when it creates a Job')

  // ── C. Charge reconciliation (pre-payment) ────────────────────────────────
  step('C. RECONCILE customer charges')
  const withPayments = async () => prisma.booking.findUniqueOrThrow({
    where: { id }, include: { payments: { select: JOB_MONEY_PAYMENT_SELECT } },
  })
  let b = await withPayments()
  let bal = customerBalance(b as never)
  note(`quoted ${d(bal.quotedCents)} · add-ons ${d(bal.additionalChargeCents)} · discount ${d(bal.discountCents)}`)
  note(`final billed ${d(bal.finalBilledCents)} · collected ${d(bal.collectedCents)} · outstanding ${d(bal.outstandingCents)}`)
  bal.finalBilledCents === 69_900 ? ok('billed = 649 quote + 50 truck = $699.00') : bad(`billed ${d(bal.finalBilledCents)}, expected $699.00`)

  // ── D. Payments ───────────────────────────────────────────────────────────
  step('D. RECORD payments (synthetic — never Stripe)')
  const mkPayment = async (amount: number, method: string, ref: string) => {
    const existing = await prisma.payment.findFirst({ where: { bookingId: id, description: { contains: ref } } })
    if (existing) { note(`payment "${ref}" already recorded — duplicate prevented`); return existing }
    // NOTE: Payment has NO `method` column. The real route stores the method in
    // a JSON blob + the description string. Mirrored here so the rehearsal
    // exercises the actual production shape.
    return prisma.payment.create({
      data: {
        bookingId: id, amount, status: 'COMPLETED', description: `${method} — ${ref}`,
        metadata: { manual: true, method, recordedBy: STAGE4_TAG }, isInternalTest: true,
      },
    })
  }
  await mkPayment(4_900, 'CASH', `${STAGE4_TAG} deposit`)
  await mkPayment(65_000, 'CASH', `${STAGE4_TAG} move-day balance`)
  b = await withPayments(); bal = customerBalance(b as never)
  note(`collected ${d(bal.collectedCents)} · outstanding ${d(bal.outstandingCents)}`)
  bal.outstandingCents === 0 ? ok('balance settles to $0.00 after full collection') : bad(`outstanding ${d(bal.outstandingCents)} after full payment`)

  // NOTE: internal-test payments are excluded from revenue by design. Check
  // whether that makes closeout impossible for a test move.
  const capturedReal = b.payments.filter((p) => p.status === 'COMPLETED' && !p.isInternalTest).length
  if (capturedReal === 0) note('all payments are isInternalTest — expect NO_PAYMENT_DATA blocker (by design)')

  // ── E. Crew + labor ───────────────────────────────────────────────────────
  step('E. ASSIGN crew and record labor')
  const owner = await prisma.user.findFirst({ where: { role: 'OWNER', active: true } })
  if (!owner) { bad('no active OWNER user to assign'); return }
  if (owner.payRate == null) bad('DATA: the OWNER user has no payRate — labor cannot be priced (LABOR_MISSING_RATE)')

  const jobId = jobId1
  let crew = await prisma.jobCrew.findFirst({ where: { jobId, userId: owner.id } })
  if (!crew) {
    const start = new Date(Date.now() - 6 * 3600_000)
    crew = await prisma.jobCrew.create({
      data: {
        jobId, userId: owner.id,
        role: 'OWNER_OPERATOR' as never, workerType: 'OWNER' as never, payModel: 'HOURLY' as never,
        assignmentStatus: 'COMPLETED' as never, approvalStatus: 'APPROVED' as never, paymentStatus: 'UNPAID' as never,
        clockIn: start, clockOut: new Date(),
        hourlyRateCentsSnapshot: 3000, economicRateCentsSnapshot: 3000,
        rateSnapshotAt: new Date(),
      },
    })
    ok('assigned 1 owner-worker, 6h, rate snapshot $30.00/h frozen at assignment')
  } else { ok('crew already assigned') }
  const dupe = await prisma.jobCrew.count({ where: { jobId, userId: owner.id } })
  dupe === 1 ? ok('duplicate assignment prevented by unique index') : bad(`${dupe} assignments for one worker`)

  // ── F. Expenses ───────────────────────────────────────────────────────────
  step('F. RECORD expenses')
  const mkExpense = async (category: string, amount: number, label: string) => {
    const ex = await prisma.expense.findFirst({ where: { bookingId: id, purpose: label } })
    if (ex) { note(`expense "${label}" exists`); return ex }
    return prisma.expense.create({
      data: { bookingId: id, category: category as never, amount, status: 'APPROVED' as never, purpose: label, incurredOn: new Date() },
    })
  }
  await mkExpense('TRUCK_RENTAL', 8_900, `${STAGE4_TAG} truck rental`)
  await mkExpense('GAS', 4_200, `${STAGE4_TAG} fuel`)
  await mkExpense('TOLLS', 1_600, `${STAGE4_TAG} tolls`)
  const rejected = await prisma.expense.findFirst({ where: { bookingId: id, purpose: `${STAGE4_TAG} rejected` } })
  if (!rejected) {
    await prisma.expense.create({
      data: { bookingId: id, category: 'MISC' as never, amount: 9_999, status: 'REJECTED' as never, purpose: `${STAGE4_TAG} rejected`, incurredOn: new Date() },
    })
  }
  ok('3 approved expenses ($147.00) + 1 REJECTED ($99.99) to prove exclusion')

  // ── G. Status transition to a closeout-eligible state ─────────────────────
  step('G. ADVANCE status to COMPLETED')
  await prisma.booking.update({ where: { id }, data: { status: 'COMPLETED', completedAt: new Date() } })
  await prisma.job.update({ where: { id: jobId }, data: { status: 'COMPLETED', completedAt: new Date() } })
  ok('booking + job COMPLETED — closeout is now eligible')

  // ── H. Closeout view ──────────────────────────────────────────────────────
  step('H. BUILD closeout view')
  const view = await buildCloseoutView(id)
  if (!view) { bad('buildCloseoutView returned null for a COMPLETED move'); return }
  const f = view.financials
  console.log(`  net billed        ${d(f.netBilledRevenueCents)}`)
  console.log(`  net collected     ${d(f.netCollectedRevenueCents)}`)
  console.log(`  outstanding       ${d(f.outstandingBalanceCents)}`)
  console.log(`  crew labor        ${d(f.crewLaborCents)}`)
  console.log(`  direct expenses   ${d(f.directExpenseCents)}`)
  console.log(`  processing fees   ${d(f.processingFeeCents)}`)
  console.log(`  direct job cost   ${d(f.directJobCostCents)}`)
  console.log(`  cash gross profit ${d(f.profit.cashGrossProfitCents)}`)
  console.log(`  owner econ labor  ${d(f.ownerEconomicLaborCents)}`)
  console.log(`  overhead          ${d(f.overhead.amountCents)} (${f.overhead.method})`)
  console.log(`  company net       ${d(f.profit.companyNetProfitCents)}`)
  console.log(`  tax reserve       ${d(f.reserves.taxReserveCents)}`)
  console.log(`  business reserve  ${d(f.reserves.businessReserveCents)}`)
  console.log(`  DISTRIBUTABLE     ${d(f.reserves.distributableProfitCents)}`)

  if (f.directExpenseCents !== 14_700) bad(`expenses ${d(f.directExpenseCents)} — expected $147.00 (REJECTED must be excluded)`)
  else ok('REJECTED expense correctly excluded from cost')

  if (f.reserves.businessReserveCents === 0 && f.profit.companyNetProfitCents > 0) {
    bad('BUSINESS RESERVE IS $0 despite generalReserveBp=4000 — the column is not wired into closeout-service')
  }

  console.log(`\n  BLOCKERS (${view.blockers.length}):`)
  for (const bl of view.blockers) console.log(`    [${bl.severity}] ${bl.code} — ${bl.message}`)
  console.log(`  canFinalize: ${view.decision.canFinalize}`)
  if (view.split) {
    console.log(`  split (${view.split.method}): ${view.split.shares.map((s) => `${s.owner} ${d(s.amountCents)}`).join(' · ')}`)
    if (!view.split.ok) bad(`split failed: ${view.split.error}`)
  } else {
    bad('no split computed — owners cannot see their allocation')
  }

  console.log(`\n═══ DEFECTS FOUND: ${DEFECTS.length} ═══`)
  DEFECTS.forEach((x, i) => console.log(` ${i + 1}. ${x}`))
}

async function cleanup(): Promise<void> {
  step('CLEANUP — removing every STAGE4-REHEARSAL row')
  const c = await prisma.customer.findUnique({ where: { email: TEST_EMAIL } })
  if (!c) { ok('nothing to clean'); return }
  const bookings = await prisma.booking.findMany({ where: { customerId: c.id }, select: { id: true } })
  for (const bk of bookings) {
    const jobs = await prisma.job.findMany({ where: { bookingId: bk.id }, select: { id: true } })
    for (const j of jobs) {
      await prisma.laborPayment.deleteMany({ where: { jobCrew: { jobId: j.id } } })
      await prisma.jobCrew.deleteMany({ where: { jobId: j.id } })
    }
    await prisma.financialSnapshot.deleteMany({ where: { closeout: { bookingId: bk.id } } })
    await prisma.reserveAllocation.deleteMany({ where: { closeout: { bookingId: bk.id } } })
    await prisma.ownerDistribution.deleteMany({ where: { bookingId: bk.id } })
    await prisma.moveCloseout.deleteMany({ where: { bookingId: bk.id } })
    await prisma.job.deleteMany({ where: { bookingId: bk.id } })
    await prisma.payment.deleteMany({ where: { bookingId: bk.id } })
    await prisma.expense.deleteMany({ where: { bookingId: bk.id } })
    await prisma.auditLog.deleteMany({ where: { bookingId: bk.id } })
    await prisma.notification.deleteMany({ where: { bookingId: bk.id } })
    await prisma.booking.delete({ where: { id: bk.id } })
  }
  await prisma.customer.delete({ where: { id: c.id } })
  ok(`removed ${bookings.length} rehearsal booking(s) and every linked record`)
}

async function main(): Promise<void> {
  const a = process.argv.slice(2)
  if (a.includes('--cleanup')) return cleanup()
  if (a.includes('--seed-config')) return seedConfig()
  if (a.includes('--run')) return run()
  console.log('usage: --seed-config | --run | --cleanup')
}
main().finally(() => prisma.$disconnect())
