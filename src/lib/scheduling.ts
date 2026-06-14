import { prisma } from './db'

const TZ = process.env.TIMEZONE ?? 'America/New_York'
const MAX_JOBS = parseInt(process.env.MAX_JOBS_PER_DAY ?? '3', 10)
const BUFFER_MINS = parseInt(process.env.TRAVEL_BUFFER_MINUTES ?? '60', 10)

// ── Check if a given date has capacity ────────────────────────
export async function isDayAvailable(date: Date): Promise<boolean> {
  const start = new Date(date)
  start.setHours(0, 0, 0, 0)
  const end = new Date(date)
  end.setHours(23, 59, 59, 999)

  // Check admin blocks first
  const block = await prisma.dayBlock.findFirst({
    where: { date: { gte: start, lte: end }, blocked: true },
  })
  if (block) return false

  const count = await prisma.booking.count({
    where: {
      scheduledStart: { gte: start, lte: end },
      status: {
        in: ['CONFIRMED', 'SCHEDULED', 'IN_PROGRESS'],
      },
    },
  })

  return count < MAX_JOBS
}

// ── Check if both Diego + Sebastian are available ─────────────
export async function isCrewAvailable(date: Date): Promise<{
  available: boolean
  unavailableUsers: string[]
}> {
  const dateOnly = new Date(date)
  dateOnly.setHours(0, 0, 0, 0)

  // Get all staff
  const staff = await prisma.user.findMany({
    where: { active: true, role: { in: ['OWNER', 'MANAGER'] } },
  })

  const unavailableUsers: string[] = []

  for (const member of staff) {
    const avail = await prisma.availability.findUnique({
      where: { userId_date: { userId: member.id, date: dateOnly } },
    })
    if (avail?.isDayOff) {
      unavailableUsers.push(member.name)
    }
  }

  return {
    available: unavailableUsers.length === 0,
    unavailableUsers,
  }
}

// ── Find next N available slots from a given date ─────────────
export async function findAvailableSlots(
  fromDate: Date,
  count = 3
): Promise<Date[]> {
  const slots: Date[] = []
  const check = new Date(fromDate)
  check.setHours(9, 0, 0, 0) // 9 AM start

  let attempts = 0
  const maxAttempts = 60 // don't loop forever

  while (slots.length < count && attempts < maxAttempts) {
    // Skip weekends (0 = Sunday, 6 = Saturday) — edit as needed
    const day = check.getDay()
    if (day !== 0 && day !== 6) {
      const dayOk = await isDayAvailable(check)
      const crewOk = await isCrewAvailable(check)
      if (dayOk && crewOk.available) {
        slots.push(new Date(check))
      }
    }
    check.setDate(check.getDate() + 1)
    attempts++
  }

  return slots
}

// ── Format a Date in Eastern Time for display ─────────────────
export function formatEastern(date: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}

// ── Calculate end time given start + estimated hours ──────────
export function calculateEndTime(start: Date, estimatedHours: number): Date {
  const end = new Date(start)
  end.setMinutes(end.getMinutes() + estimatedHours * 60 + BUFFER_MINS)
  return end
}
