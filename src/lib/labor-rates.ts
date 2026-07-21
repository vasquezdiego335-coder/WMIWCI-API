// ============================================================================
// labor-rates.ts — the owner's labor-rate CONFIGURATION model (Stage 4, D6).
//
// D6 shipped detection: `financial-setup.ts` reports what is unset. This module
// is the other half — deciding what a rate change is allowed to do, and how the
// configuration reads back to the owner. The editing UI and the API route both
// go through here, so a rate can never be set by two different sets of rules.
//
// THE FOUR RULES THIS FILE PROTECTS:
//
//  1. A MISSING RATE IS UNKNOWN, NEVER $0. Nothing here ever supplies a number
//     on the owner's behalf. `resolveOwnerEconomicRateCents` returns null when
//     nobody has typed one in, and null keeps LABOR_MISSING_RATE hard.
//  2. AN EMPTY RATE IS A VALID CONFIGURATION STATE. Owners are allowed not to
//     have decided yet — it blocks a closeout that needs to value labor, and it
//     blocks nothing else.
//  3. HISTORY DOES NOT MOVE. Changing a profile rate never touches a JobCrew
//     rate snapshot; that freeze happens once, at assignment.
//  4. RATES ARE OWNER-FINANCIAL AUTHORITY. Only an OWNER may change one, and
//     every change is audited with both the old and the new value.
//
// Pure — no Prisma, no React. Offline-tested (labor-rates.test.ts).
// ============================================================================

import { can, type Role } from './permissions'

export type PayModelChoice = 'HOURLY' | 'FLAT' | 'DAY_RATE'

/** One staff profile, as this module needs to see it. */
export interface RateProfile {
  id: string
  name: string
  role: 'OWNER' | 'MANAGER' | 'CREW'
  active: boolean
  workerType?: string | null
  /** What an owner hour is WORTH. Null = not configured. */
  ownerEconomicRateCents?: number | null
  /** Cash hourly rate. Null = no cash wage configured. */
  payRateCents?: number | null
  /** Flat pay per move, when the pay model is FLAT. */
  defaultFlatRateCents?: number | null
  defaultPayModel?: PayModelChoice | null
  rateEffectiveOn?: Date | string | null
  rateNotes?: string | null
  rateUpdatedByName?: string | null
  rateUpdatedAt?: Date | string | null
  canDrive?: boolean
  canLeadCrew?: boolean
  preferredRole?: string | null
}

// ── Resolution: what an owner hour is worth, if anything ────────────────────

/**
 * The economic value of one owner hour, in cents — or NULL when nobody has
 * configured it.
 *
 * Order: the person's own configured rate wins, then the business-wide default.
 * There is no third fallback. The old `?? 3000` fallback in buildRateSnapshot
 * was exactly the "invented rate" the owner ruled out: it produced a $30/h cost
 * nobody had agreed to and made an unconfigured business look configured.
 */
export function resolveOwnerEconomicRateCents(i: {
  profileRateCents?: number | null
  businessDefaultCents?: number | null
}): number | null {
  if (i.profileRateCents != null && i.profileRateCents > 0) return Math.round(i.profileRateCents)
  if (i.businessDefaultCents != null && i.businessDefaultCents > 0) return Math.round(i.businessDefaultCents)
  return null
}

/** True when this profile can price the labor it is about to record. */
export function hasUsableRate(p: RateProfile): boolean {
  if (p.role === 'OWNER') return (p.ownerEconomicRateCents ?? 0) > 0
  if (p.defaultPayModel === 'FLAT') return (p.defaultFlatRateCents ?? 0) > 0
  return (p.payRateCents ?? 0) > 0
}

// ── Change control ──────────────────────────────────────────────────────────

/** The editable fields. Everything is optional — a partial edit is normal. */
export interface RatePatch {
  ownerEconomicRateCents?: number | null
  payRateCents?: number | null
  defaultFlatRateCents?: number | null
  defaultPayModel?: PayModelChoice | null
  rateEffectiveOn?: string | null
  rateNotes?: string | null
  active?: boolean
  canDrive?: boolean
  canLeadCrew?: boolean
  preferredRole?: string | null
}

export type RateDecision =
  | { allow: true; patch: RatePatch }
  | { allow: false; status: 403 | 422; error: string }

/** $1,000/h. Not a policy — a typo guard, so a stray keystroke cannot price a
 *  move at fifty thousand dollars of labor. */
export const MAX_RATE_CENTS = 100_000
/** $10,000 flat per move — the same guard for flat-rate workers. */
export const MAX_FLAT_CENTS = 1_000_000

/**
 * May this person make this change?
 *
 * OWNER-only, because a labor rate decides what every future move costs. A
 * manager runs operations; the owners decide the money (permissions.ts —
 * `labor.set_owner_labor_value`).
 *
 * CLEARING a rate is allowed and meaningful: `null` records "we have not
 * decided", which is honest. It is NOT the same as `0`, which would assert that
 * the work is free — so an explicit 0 is refused on the economic rate.
 */
export function evaluateRateChange(i: { role: Role | null | undefined; patch: RatePatch }): RateDecision {
  if (!can(i.role, 'labor.set_owner_labor_value')) {
    return { allow: false, status: 403, error: 'Only an owner can change pay and owner-labor rates.' }
  }

  const p = i.patch

  if (p.ownerEconomicRateCents != null) {
    if (!Number.isInteger(p.ownerEconomicRateCents) || p.ownerEconomicRateCents < 0) {
      return { allow: false, status: 422, error: 'Enter a whole dollar amount for the owner labor rate.' }
    }
    if (p.ownerEconomicRateCents === 0) {
      return {
        allow: false, status: 422,
        error: 'An owner labor rate of $0 would say owner work costs nothing. Leave it blank instead — blank means "not decided yet".',
      }
    }
    if (p.ownerEconomicRateCents > MAX_RATE_CENTS) {
      return { allow: false, status: 422, error: `That owner labor rate looks like a typo (over $${MAX_RATE_CENTS / 100}/hour).` }
    }
  }

  for (const [key, label] of [['payRateCents', 'hourly rate']] as const) {
    const v = p[key]
    if (v != null) {
      if (!Number.isInteger(v) || v < 0) return { allow: false, status: 422, error: `Enter a valid ${label}.` }
      if (v > MAX_RATE_CENTS) return { allow: false, status: 422, error: `That ${label} looks like a typo (over $${MAX_RATE_CENTS / 100}/hour).` }
    }
  }

  if (p.defaultFlatRateCents != null) {
    if (!Number.isInteger(p.defaultFlatRateCents) || p.defaultFlatRateCents < 0) {
      return { allow: false, status: 422, error: 'Enter a valid flat rate.' }
    }
    if (p.defaultFlatRateCents > MAX_FLAT_CENTS) {
      return { allow: false, status: 422, error: `That flat rate looks like a typo (over $${MAX_FLAT_CENTS / 100} per move).` }
    }
  }

  if (p.defaultPayModel != null && !['HOURLY', 'FLAT', 'DAY_RATE'].includes(p.defaultPayModel)) {
    return { allow: false, status: 422, error: 'Choose a pay type of hourly, flat or day rate.' }
  }

  if (p.rateEffectiveOn != null && p.rateEffectiveOn !== '' && Number.isNaN(Date.parse(p.rateEffectiveOn))) {
    return { allow: false, status: 422, error: 'Enter a valid effective date.' }
  }

  if (Object.keys(p).length === 0) {
    return { allow: false, status: 422, error: 'Nothing to change.' }
  }

  return { allow: true, patch: p }
}

/**
 * What the audit log records for a rate change: BOTH values for every field
 * that actually moved. A rate change that cannot be reconstructed from the
 * audit log is a rate change nobody can explain later.
 */
export function buildRateAudit(i: {
  targetUserId: string
  targetUserName: string
  before: RateProfile
  patch: RatePatch
  byName: string
}): Record<string, unknown> {
  const changes: Record<string, { from: unknown; to: unknown }> = {}
  const compare = (key: string, from: unknown, to: unknown) => {
    if (to !== undefined && to !== from) changes[key] = { from: from ?? null, to: to ?? null }
  }
  compare('ownerEconomicRateCents', i.before.ownerEconomicRateCents ?? null, i.patch.ownerEconomicRateCents)
  compare('payRateCents', i.before.payRateCents ?? null, i.patch.payRateCents)
  compare('defaultFlatRateCents', i.before.defaultFlatRateCents ?? null, i.patch.defaultFlatRateCents)
  compare('defaultPayModel', i.before.defaultPayModel ?? null, i.patch.defaultPayModel)
  compare('active', i.before.active, i.patch.active)
  compare('canDrive', i.before.canDrive ?? false, i.patch.canDrive)
  compare('canLeadCrew', i.before.canLeadCrew ?? false, i.patch.canLeadCrew)
  compare('preferredRole', i.before.preferredRole ?? null, i.patch.preferredRole)
  compare('rateNotes', i.before.rateNotes ?? null, i.patch.rateNotes)

  return {
    targetUserId: i.targetUserId,
    targetUserName: i.targetUserName,
    changes,
    // Stated in the entry itself so nobody has to remember the rule when they
    // are reading the log a year from now.
    historicalRatesUnchanged: true,
    by: i.byName,
  }
}

// ── The owner-facing settings panel ─────────────────────────────────────────

export const LABOR_SETUP_TITLE = 'Financial labor setup'
export const OWNER_RATE_EXPLANATION =
  'Owner labor rates estimate the economic cost of owner work. ' +
  'They are separate from the 30% owner profit allocations.'
export const NOT_CONFIGURED = 'Not configured'

export interface LaborSetupLine {
  /** e.g. "Diego owner labor rate" */
  label: string
  /** e.g. "$45.00/hour" or "Not configured" */
  value: string
  configured: boolean
  /** The profile to edit, when there is one. */
  userId?: string
}

export interface LaborSetupView {
  title: string
  explanation: string
  ownerLines: LaborSetupLine[]
  activeCrewLine: LaborSetupLine
  /** True when every OWNER has an economic rate. Crew count is reported, not
   *  required — a two-owner business with no employees is a real business. */
  ownerRatesReady: boolean
  /** Every line, in display order, for a plain-text or printed rendering. */
  lines: LaborSetupLine[]
}

const rateLabel = (cents: number | null | undefined): string =>
  cents != null && cents > 0 ? `$${(cents / 100).toFixed(2)}/hour` : NOT_CONFIGURED

/**
 * The panel the owner reads:
 *
 *   Financial labor setup
 *   Diego owner labor rate: Not configured
 *   Sebastian owner labor rate: Not configured
 *   Active crew members: 0
 *
 * Reports only. It never fills a gap with a number, and an unset rate reads as
 * "Not configured" rather than as a dollar figure.
 */
export function describeLaborSetup(users: RateProfile[]): LaborSetupView {
  const owners = users.filter((u) => u.role === 'OWNER').sort((a, b) => a.name.localeCompare(b.name))
  const activeCrew = users.filter((u) => u.role !== 'OWNER' && u.active)

  const ownerLines: LaborSetupLine[] = owners.map((o) => ({
    label: `${o.name} owner labor rate`,
    value: rateLabel(o.ownerEconomicRateCents),
    configured: (o.ownerEconomicRateCents ?? 0) > 0,
    userId: o.id,
  }))

  const activeCrewLine: LaborSetupLine = {
    label: 'Active crew members',
    value: String(activeCrew.length),
    // A count is always "known", even when it is zero — that is a fact about
    // the business, not a missing setting.
    configured: true,
  }

  return {
    title: LABOR_SETUP_TITLE,
    explanation: OWNER_RATE_EXPLANATION,
    ownerLines,
    activeCrewLine,
    ownerRatesReady: ownerLines.length > 0 && ownerLines.every((l) => l.configured),
    lines: [...ownerLines, activeCrewLine],
  }
}

/** The panel as plain text — used by the settings page's copy block and by
 *  tests that assert the owner sees exactly the agreed wording. */
export function renderLaborSetupText(view: LaborSetupView): string {
  return [view.title, '', ...view.lines.map((l) => `${l.label}: ${l.value}`)].join('\n')
}
