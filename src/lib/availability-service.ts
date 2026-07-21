// ============================================================================
// availability-service.ts — the Prisma bridge for the availability engine.
//
// Loads a worker's recurring rules and date exceptions, folds in the business
// DayBlock, converts a real UTC window into the worker's local minutes, and
// hands the pure engine a decision to make. All logic lives in
// availability-engine.ts; this only fetches and adapts.
// ============================================================================

import { prisma } from './db'
import {
  evaluateAvailability, availableBlocksForDate, toLocalParts,
  type RecurringRule, type DateException, type AvailabilityDecision, type DayBlockView,
} from './availability-engine'

export const DEFAULT_TZ = 'America/New_York'

interface LoadedAvailability {
  rules: RecurringRule[]
  exceptions: DateException[]
  timezone: string
}

/** One worker's availability inputs, ready for the engine. */
export async function loadWorkerAvailability(userId: string): Promise<LoadedAvailability> {
  const [rules, exceptions] = await Promise.all([
    prisma.availabilityRule.findMany({ where: { userId, active: true } }),
    prisma.availabilityException.findMany({ where: { userId }, orderBy: { date: 'asc' } }),
  ])
  const timezone = rules[0]?.timezone ?? DEFAULT_TZ
  return {
    timezone,
    rules: rules.map((r) => ({
      dayOfWeek: r.dayOfWeek,
      startMinute: r.startMinute,
      endMinute: r.endMinute,
      active: r.active,
      effectiveFrom: r.effectiveFrom ? r.effectiveFrom.toISOString().slice(0, 10) : null,
      effectiveTo: r.effectiveTo ? r.effectiveTo.toISOString().slice(0, 10) : null,
    })),
    exceptions: exceptions.map((e) => ({
      kind: e.kind as DateException['kind'],
      date: e.date.toISOString().slice(0, 10),
      startMinute: e.startMinute,
      endMinute: e.endMinute,
      reason: e.reason,
    })),
  }
}

/** Is the business closed on this local date? (company-wide DayBlock). */
async function businessBlockedOn(localDate: string): Promise<boolean> {
  const row = await prisma.dayBlock.findFirst({ where: { date: new Date(`${localDate}T00:00:00Z`), blocked: true } }).catch(() => null)
  return !!row
}

/**
 * Evaluate one worker for a real UTC window. Returns the engine's decision plus
 * the local date/minute it was evaluated at, for the UI.
 */
export async function evaluateWorkerForWindow(
  userId: string,
  startAt: Date,
  endAt: Date,
): Promise<AvailabilityDecision & { localDate: string; startMinute: number; endMinute: number }> {
  const { rules, exceptions, timezone } = await loadWorkerAvailability(userId)
  const s = toLocalParts(startAt, timezone)
  const e = toLocalParts(endAt, timezone)
  // A window that crosses local midnight is evaluated on the start date against
  // the end minute wrapped past 24h, so an overnight shift is not silently split.
  const endMinute = e.date === s.date ? e.minute : e.minute + 24 * 60
  const businessBlocked = await businessBlockedOn(s.date)
  const decision = evaluateAvailability({
    window: { date: s.date, startMinute: s.minute, endMinute },
    rules,
    exceptions,
    businessBlocked,
  })
  return { ...decision, localDate: s.date, startMinute: s.minute, endMinute }
}

/** The available blocks for one local date — drives the availability tab. */
export async function blocksForDate(userId: string, localDate: string): Promise<DayBlockView[]> {
  const { rules, exceptions } = await loadWorkerAvailability(userId)
  const businessBlocked = await businessBlockedOn(localDate)
  return availableBlocksForDate({ date: localDate, rules, exceptions, businessBlocked })
}

/** Upcoming unavailable dates (exceptions), for the profile summary. */
export async function upcomingUnavailable(userId: string, limit = 10): Promise<{ date: string; kind: string; reason: string | null }[]> {
  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)
  const rows = await prisma.availabilityException.findMany({
    where: {
      userId,
      date: { gte: today },
      kind: { in: ['ADMIN_BLOCK', 'UNAVAILABLE_FULL', 'UNAVAILABLE_PARTIAL', 'VACATION', 'LEAVE'] },
    },
    orderBy: { date: 'asc' },
    take: limit,
  })
  return rows.map((r) => ({ date: r.date.toISOString().slice(0, 10), kind: String(r.kind), reason: r.reason }))
}
