// ============================================================================
// stage5-staging-fixtures.ts — deterministic Stage 5 staging dataset.
//
// SAFETY: refuses to run unless DATABASE_URL points at localhost/127.0.0.1
// (override only with STAGE5_FIXTURES_FORCE=1 — never point this at Neon).
// Every row is prefixed `s5fix` and every email ends in `@staging.local`, so
// nothing here can reach a real worker or customer. Idempotent: upserts by
// fixed ids. Cleanup: `tsx scripts/stage5-staging-fixtures.ts --clean` deletes
// everything it created, children before parents.
//
// The dataset implements the Stage 5 rehearsal matrix (Part D of the plan):
//   Users     owner · manager · active crew (driver+lead, full skills) ·
//             inactive crew · pending invite · non-driver crew ·
//             missing-skill crew · expired-license driver
//   Jobs      unstaffed · fully staffed · understaffed · driver-required ·
//             skill-required · overlapping · outside-availability ·
//             warning-only · override-eligible · completed (profit) ·
//             completed (loss) · owner-labor
//   Rules     Mon–Fri 08:00–18:00 recurring (active crew) · vacation day ·
//             Sunday AVAILABLE_OVERRIDE · partial-day off
// ============================================================================

import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'

const prisma = new PrismaClient()

const url = process.env.DATABASE_URL ?? ''
const isLocal = /127\.0\.0\.1|localhost/.test(url)
if (!isLocal && process.env.STAGE5_FIXTURES_FORCE !== '1') {
  console.error('REFUSING: DATABASE_URL is not local. Staging fixtures never run against a shared database.')
  process.exit(1)
}

const PASSWORD = 'Stage5!staging' // every fixture account uses this password

// Fixed local dates (America/New_York = UTC-4 in July).
// 2026-07-27 is a Monday.
const ET = (day: string, hm: string) => new Date(`2026-07-${day}T${hm}:00-04:00`)

const U = {
  owner: 's5fix_u_owner',
  manager: 's5fix_u_manager',
  crewMax: 's5fix_u_crew_max', // active, driver+lead, all skills
  crewInactive: 's5fix_u_crew_inactive',
  crewNoDrive: 's5fix_u_crew_nodrive', // no driver eligibility
  crewNoSkill: 's5fix_u_crew_noskill', // missing HEAVY_ITEMS
  crewExpLic: 's5fix_u_crew_explic', // canDrive but license expired
}

const JOBS = [
  { key: 'unstaffed', day: '27', s: '09:00', e: '13:00' },
  { key: 'staffed', day: '27', s: '14:00', e: '18:00' },
  { key: 'understaffed', day: '28', s: '09:00', e: '13:00' },
  { key: 'driver', day: '28', s: '14:00', e: '17:00' },
  { key: 'skill', day: '29', s: '09:00', e: '12:00' },
  { key: 'overlapA', day: '30', s: '08:00', e: '11:00' },
  { key: 'overlapB', day: '30', s: '10:00', e: '13:00' }, // overlaps overlapA
  { key: 'sunday', day: '26', s: '09:00', e: '13:00' }, // outside recurring availability
  { key: 'override', day: '31', s: '08:00', e: '12:00' }, // override-eligible warning
  { key: 'profit', day: '20', s: '09:00', e: '13:00', completed: true }, // $1,000 revenue
  { key: 'loss', day: '21', s: '09:00', e: '17:00', completed: true }, // revenue below costs
  { key: 'ownerlabor', day: '22', s: '09:00', e: '13:00', completed: true },
] as const

type JobKey = (typeof JOBS)[number]['key']
const B = (k: JobKey) => `s5fix_b_${k}`
const J = (k: JobKey) => `s5fix_j_${k}`
const C = (k: JobKey) => `s5fix_c_${k}`

async function clean(): Promise<void> {
  // children → parents; everything is prefix-scoped.
  const like = { startsWith: 's5fix' }
  await prisma.assignmentNotification.deleteMany({ where: { OR: [{ dedupeKey: { startsWith: 's5fix' } }, { jobCrewId: { startsWith: 's5fix' } }] } })
  await prisma.conflictOverride.deleteMany({ where: { jobId: { startsWith: 's5fix' } } })
  await prisma.jobCrew.deleteMany({ where: { id: { startsWith: 's5fix' } } })
  await prisma.jobCrew.deleteMany({ where: { jobId: { startsWith: 's5fix' } } })
  await prisma.jobStaffingRequirement.deleteMany({ where: { jobId: { startsWith: 's5fix' } } })
  await prisma.auditLog.deleteMany({ where: { bookingId: { startsWith: 's5fix' } } })
  await prisma.payment.deleteMany({ where: { bookingId: { startsWith: 's5fix' } } })
  await prisma.job.deleteMany({ where: { id: like } })
  await prisma.booking.deleteMany({ where: { id: like } })
  await prisma.customer.deleteMany({ where: { id: like } })
  await prisma.availabilityRule.deleteMany({ where: { userId: like } })
  await prisma.availabilityException.deleteMany({ where: { userId: like } })
  await prisma.crewInvitation.deleteMany({ where: { email: { endsWith: '@staging.local' } } })
  await prisma.auditLog.deleteMany({ where: { userId: like } })
  await prisma.user.deleteMany({ where: { id: like } })
  console.log('s5fix data removed')
}

async function seed(): Promise<void> {
  const passwordHash = await bcrypt.hash(PASSWORD, 10)
  const farFuture = new Date('2030-01-01T00:00:00Z')

  // ── Users ──────────────────────────────────────────────────────────────────
  const users: Array<Record<string, unknown> & { id: string }> = [
    {
      id: U.owner, email: 'owner@staging.local', name: 'Staging Owner', role: 'OWNER',
      workerType: 'OWNER', active: true, canDrive: true, canLeadCrew: true,
      skills: ['LEAD', 'DRIVING', 'LOADING', 'UNLOADING', 'HEAVY_ITEMS'],
      ownerEconomicRateCents: 5000, licenseExpiresAt: farFuture,
    },
    { id: U.manager, email: 'manager@staging.local', name: 'Staging Manager', role: 'MANAGER', workerType: 'EMPLOYEE', active: true },
    {
      id: U.crewMax, email: 'crew-max@staging.local', name: 'Crew Max', role: 'CREW',
      workerType: 'EMPLOYEE', active: true, payRate: 2500, canDrive: true, canLeadCrew: true,
      skills: ['DRIVING', 'LEAD', 'LOADING', 'UNLOADING', 'HEAVY_ITEMS'], licenseExpiresAt: farFuture,
    },
    {
      id: U.crewInactive, email: 'crew-inactive@staging.local', name: 'Crew Inactive', role: 'CREW',
      workerType: 'EMPLOYEE', active: false, workerStatus: 'INACTIVE', payRate: 2400,
      deactivatedAt: new Date('2026-07-01T12:00:00Z'), deactivationReason: 'Fixture: left the company',
    },
    {
      id: U.crewNoDrive, email: 'crew-nodrive@staging.local', name: 'Crew NoDrive', role: 'CREW',
      workerType: 'EMPLOYEE', active: true, payRate: 2300, canDrive: false,
      skills: ['LOADING', 'UNLOADING'],
    },
    {
      id: U.crewNoSkill, email: 'crew-noskill@staging.local', name: 'Crew NoSkill', role: 'CREW',
      workerType: 'EMPLOYEE', active: true, payRate: 2200, canDrive: false, skills: ['PACKING'],
    },
    {
      id: U.crewExpLic, email: 'crew-explic@staging.local', name: 'Crew ExpiredLicense', role: 'CREW',
      workerType: 'EMPLOYEE', active: true, payRate: 2600, canDrive: true,
      skills: ['DRIVING', 'LOADING'], licenseExpiresAt: new Date('2026-07-01T00:00:00Z'), // already expired
    },
  ]
  for (const u of users) {
    const { id, ...rest } = u
    await prisma.user.upsert({
      where: { id },
      create: { id, passwordHash, ...(rest as object) } as never,
      update: { passwordHash, ...(rest as object) } as never,
    })
  }

  // ── Pending invitation (safe address; token is a fixture constant) ─────────
  await prisma.crewInvitation.upsert({
    where: { token: 's5fix-invite-token-crew-invited' },
    create: {
      email: 'crew-invited@staging.local', name: 'Crew Invited', role: 'CREW', workerType: 'EMPLOYEE',
      initialRateCents: 2100, initialSkills: ['LOADING'], canDrive: false,
      token: 's5fix-invite-token-crew-invited', status: 'PENDING',
      expiresAt: new Date('2026-08-15T00:00:00Z'), invitedById: U.owner,
    },
    update: { status: 'PENDING', expiresAt: new Date('2026-08-15T00:00:00Z') },
  })

  // ── Availability (Crew Max): Mon–Fri 08:00–18:00, ET ──────────────────────
  await prisma.availabilityRule.deleteMany({ where: { userId: U.crewMax } })
  for (const dow of [1, 2, 3, 4, 5]) {
    await prisma.availabilityRule.create({
      data: { userId: U.crewMax, dayOfWeek: dow, startMinute: 8 * 60, endMinute: 18 * 60, timezone: 'America/New_York', createdById: U.owner },
    })
  }
  await prisma.availabilityException.deleteMany({ where: { userId: { startsWith: 's5fix' } } })
  // Vacation Wednesday 2026-07-29 (full day off — beats the recurring rule).
  await prisma.availabilityException.create({
    data: { userId: U.crewMax, kind: 'VACATION', date: new Date('2026-07-29T00:00:00Z'), reason: 'Fixture vacation', createdById: U.owner },
  })
  // Sunday 2026-08-02 explicitly available 09:00–17:00 (override beats default-unavailable).
  await prisma.availabilityException.create({
    data: { userId: U.crewMax, kind: 'AVAILABLE_OVERRIDE', date: new Date('2026-08-02T00:00:00Z'), startMinute: 9 * 60, endMinute: 17 * 60, createdById: U.owner },
  })
  // Partial-day off Thursday 2026-07-30 afternoon (12:00–18:00 unavailable).
  await prisma.availabilityException.create({
    data: { userId: U.crewMax, kind: 'UNAVAILABLE_PARTIAL', date: new Date('2026-07-30T00:00:00Z'), startMinute: 12 * 60, endMinute: 18 * 60, reason: 'Fixture appointment', createdById: U.owner },
  })
  // NoDrive crew: Mon-Sat 07:00–19:00 so they are an eligible non-driver candidate.
  await prisma.availabilityRule.deleteMany({ where: { userId: U.crewNoDrive } })
  for (const dow of [1, 2, 3, 4, 5, 6]) {
    await prisma.availabilityRule.create({
      data: { userId: U.crewNoDrive, dayOfWeek: dow, startMinute: 7 * 60, endMinute: 19 * 60, timezone: 'America/New_York', createdById: U.owner },
    })
  }

  // ── Customers / bookings / jobs ────────────────────────────────────────────
  for (const j of JOBS) {
    const completed = 'completed' in j && j.completed
    await prisma.customer.upsert({
      where: { id: C(j.key) },
      create: { id: C(j.key), name: `Staging Customer ${j.key}`, email: `customer-${j.key}@staging.local`, phone: '555-0100' },
      update: {},
    })
    await prisma.booking.upsert({
      where: { id: B(j.key) },
      create: {
        id: B(j.key), displayId: `S5FIX-${j.key.toUpperCase()}`, bookingReference: `S5-${j.key.toUpperCase()}`,
        customerId: C(j.key), status: completed ? 'COMPLETED' : 'CONFIRMED',
        originAddress: `10 Load St, Newark, NJ`, destAddress: `20 Unload Ave, Jersey City, NJ`,
        originCity: 'Newark', destCity: 'Jersey City',
        scheduledStart: ET(j.day, j.s), scheduledEnd: ET(j.day, j.e),
        confirmedDate: ET(j.day, j.s),
        customerToken: `s5fix-tok-${j.key}`, customerTokenExpiry: farFuture,
        depositPaid: true, isInternalTest: false,
      },
      update: { scheduledStart: ET(j.day, j.s), scheduledEnd: ET(j.day, j.e), status: completed ? 'COMPLETED' : 'CONFIRMED' },
    })
    await prisma.job.upsert({
      where: { id: J(j.key) },
      create: { id: J(j.key), bookingId: B(j.key), status: completed ? 'COMPLETED' : 'SCHEDULED' },
      update: { status: completed ? 'COMPLETED' : 'SCHEDULED' },
    })
  }

  // ── Staffing requirements ──────────────────────────────────────────────────
  const req = async (key: JobKey, data: Record<string, unknown>) => {
    await prisma.jobStaffingRequirement.upsert({
      where: { jobId: J(key) },
      create: { jobId: J(key), createdById: U.owner, ...(data as object) } as never,
      update: data as never,
    })
  }
  await req('unstaffed', { requiredWorkers: 2, requiredDrivers: 1, requiresLead: true })
  await req('staffed', { requiredWorkers: 1, requiredDrivers: 0, requiresLead: false })
  await req('understaffed', { requiredWorkers: 3, requiredDrivers: 1, requiresLead: true })
  await req('driver', { requiredWorkers: 2, requiredDrivers: 1, requiresLead: false, drivingRequired: true })
  await req('skill', { requiredWorkers: 1, requiredDrivers: 0, requiresLead: false, requiredSkills: ['HEAVY_ITEMS'], heavyItems: true })
  await req('overlapA', { requiredWorkers: 1, requiredDrivers: 0, requiresLead: false })
  await req('overlapB', { requiredWorkers: 1, requiredDrivers: 0, requiresLead: false })
  await req('sunday', { requiredWorkers: 1, requiredDrivers: 0, requiresLead: false })
  await req('override', { requiredWorkers: 1, requiredDrivers: 0, requiresLead: false })

  // ── Assignments that exist before the rehearsal ────────────────────────────
  // staffed: Crew NoDrive fully staffs the 1-person Monday afternoon job.
  await prisma.jobCrew.upsert({
    where: { id: 's5fix_jc_staffed_nodrive' },
    create: {
      id: 's5fix_jc_staffed_nodrive', jobId: J('staffed'), userId: U.crewNoDrive,
      workerType: 'EMPLOYEE', role: 'CREW_MEMBER', assignmentStatus: 'ASSIGNED',
      payModel: 'HOURLY', hourlyRateCentsSnapshot: 2300, rateSnapshotAt: new Date(),
      scheduledStartAt: ET('27', '14:00'), scheduledEndAt: ET('27', '18:00'),
      acknowledgedAt: new Date('2026-07-23T12:00:00Z'), createdByName: 'fixtures',
    },
    update: {
      assignmentStatus: 'ASSIGNED', cancelledAt: null, cancelReason: null, declinedAt: null,
      clockIn: null, clockOut: null, breakStartedAt: null, actualBreakMinutes: null,
      workedMinutes: null, acknowledgedAt: new Date('2026-07-23T12:00:00Z'), acknowledgmentStaleAt: null,
    },
  })
  // understaffed: 1 of 3 assigned.
  await prisma.jobCrew.upsert({
    where: { id: 's5fix_jc_under_noskill' },
    create: {
      id: 's5fix_jc_under_noskill', jobId: J('understaffed'), userId: U.crewNoSkill,
      workerType: 'EMPLOYEE', role: 'CREW_MEMBER', assignmentStatus: 'ASSIGNED',
      payModel: 'HOURLY', hourlyRateCentsSnapshot: 2200, rateSnapshotAt: new Date(),
      scheduledStartAt: ET('28', '09:00'), scheduledEndAt: ET('28', '13:00'), createdByName: 'fixtures',
    },
    update: { assignmentStatus: 'ASSIGNED', cancelledAt: null, cancelReason: null, declinedAt: null },
  })
  // overlapA: Crew Max is booked 08:00–11:00 Thursday, so overlapB conflicts.
  await prisma.jobCrew.upsert({
    where: { id: 's5fix_jc_overlapA_max' },
    create: {
      id: 's5fix_jc_overlapA_max', jobId: J('overlapA'), userId: U.crewMax,
      workerType: 'EMPLOYEE', role: 'CREW_MEMBER', assignmentStatus: 'ASSIGNED',
      payModel: 'HOURLY', hourlyRateCentsSnapshot: 2500, rateSnapshotAt: new Date(),
      scheduledStartAt: ET('30', '08:00'), scheduledEndAt: ET('30', '11:00'), createdByName: 'fixtures',
    },
    update: { assignmentStatus: 'ASSIGNED', cancelledAt: null, cancelReason: null, declinedAt: null },
  })

  // ── Completed Stage 4 jobs ────────────────────────────────────────────────
  // profit: $1,000 collected, crew labor 4h @ $25/h = $100.
  await prisma.payment.upsert({
    where: { id: 's5fix_pay_profit' },
    create: { id: 's5fix_pay_profit', bookingId: B('profit'), amount: 100000, status: 'COMPLETED', method: 'CASH', description: 'Fixture: full payment' },
    update: {},
  })
  await prisma.jobCrew.upsert({
    where: { id: 's5fix_jc_profit_max' },
    create: {
      id: 's5fix_jc_profit_max', jobId: J('profit'), userId: U.crewMax,
      workerType: 'EMPLOYEE', role: 'CREW_MEMBER', assignmentStatus: 'COMPLETED',
      payModel: 'HOURLY', hourlyRateCentsSnapshot: 2500, rateSnapshotAt: new Date('2026-07-19T12:00:00Z'),
      clockIn: ET('20', '09:00'), clockOut: ET('20', '13:00'),
      workedMinutes: 240, paidMinutes: 240, calculatedPayCents: 10000,
      approvalStatus: 'APPROVED', approvedAt: ET('20', '14:00'), approvedById: U.owner,
      scheduledStartAt: ET('20', '09:00'), scheduledEndAt: ET('20', '13:00'), createdByName: 'fixtures',
    },
    update: {},
  })
  // loss: $150 collected, labor 8h @ $26/h = $208 → negative margin.
  await prisma.payment.upsert({
    where: { id: 's5fix_pay_loss' },
    create: { id: 's5fix_pay_loss', bookingId: B('loss'), amount: 15000, status: 'COMPLETED', method: 'CASH', description: 'Fixture: partial payment' },
    update: {},
  })
  await prisma.jobCrew.upsert({
    where: { id: 's5fix_jc_loss_explic' },
    create: {
      id: 's5fix_jc_loss_explic', jobId: J('loss'), userId: U.crewExpLic,
      workerType: 'EMPLOYEE', role: 'CREW_MEMBER', assignmentStatus: 'COMPLETED',
      payModel: 'HOURLY', hourlyRateCentsSnapshot: 2600, rateSnapshotAt: new Date('2026-07-19T12:00:00Z'),
      clockIn: ET('21', '09:00'), clockOut: ET('21', '17:00'),
      workedMinutes: 480, paidMinutes: 480, calculatedPayCents: 20800,
      approvalStatus: 'APPROVED', approvedAt: ET('21', '18:00'), approvedById: U.owner,
      scheduledStartAt: ET('21', '09:00'), scheduledEndAt: ET('21', '17:00'), createdByName: 'fixtures',
    },
    update: {},
  })
  // ownerlabor: $600 collected; the owner works it at the $50/h economic rate.
  await prisma.payment.upsert({
    where: { id: 's5fix_pay_ownerlabor' },
    create: { id: 's5fix_pay_ownerlabor', bookingId: B('ownerlabor'), amount: 60000, status: 'COMPLETED', method: 'CASH', description: 'Fixture: full payment' },
    update: {},
  })
  await prisma.jobCrew.upsert({
    where: { id: 's5fix_jc_ownerlabor_owner' },
    create: {
      id: 's5fix_jc_ownerlabor_owner', jobId: J('ownerlabor'), userId: U.owner,
      workerType: 'OWNER', role: 'OWNER_OPERATOR', assignmentStatus: 'COMPLETED',
      payModel: 'UNPAID_OWNER', economicRateCentsSnapshot: 5000, rateSnapshotAt: new Date('2026-07-19T12:00:00Z'),
      clockIn: ET('22', '09:00'), clockOut: ET('22', '13:00'),
      workedMinutes: 240, paidMinutes: 240,
      approvalStatus: 'APPROVED', approvedAt: ET('22', '14:00'), approvedById: U.owner,
      scheduledStartAt: ET('22', '09:00'), scheduledEndAt: ET('22', '13:00'), createdByName: 'fixtures',
    },
    update: {},
  })

  console.log('s5fix staging dataset ready')
  console.log(`  login password for every fixture account: ${PASSWORD}`)
}

const main = process.argv.includes('--clean') ? clean : seed
main()
  .catch((e) => { console.error(e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
