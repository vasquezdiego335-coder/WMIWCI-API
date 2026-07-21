// ============================================================================
// financial-setup.ts — what the owner still has to configure before any move
// can be financially closed (D6, Stage 4).
//
// THE RULE THIS FILE PROTECTS: a missing rate is UNKNOWN, never $0. The
// software must never pick a number on the owner's behalf, and it must never
// let a move finalize while a cost is unknown. This module only REPORTS what
// is unset — it never supplies a default.
//
// Pure. No Prisma, no React.
// ============================================================================

export interface SetupInput {
  /** Active users, with the rates that are actually configured. */
  users: {
    role: string
    workerType?: string | null
    name?: string | null
    active: boolean
    /** Cash rate on the profile, in cents. Null = not configured. */
    payRate?: number | null
  }[]
  /** BusinessConfig.ownerEconomicRateCents; null when there is no config row. */
  ownerEconomicRateCents?: number | null
  /** True when a BusinessConfig row exists at all. */
  hasBusinessConfig: boolean
}

export interface SetupItem {
  key: string
  label: string
  /** Where the owner goes to fix it. */
  href: string
  done: boolean
}

export interface SetupStatus {
  /** True when every required item is configured. */
  ready: boolean
  items: SetupItem[]
  outstanding: SetupItem[]
  /** Banner headline; null when nothing is outstanding. */
  headline: string | null
}

export const SETUP_HEADLINE = 'Financial setup required'

/**
 * Evaluate what still has to be configured before a move can be closed out.
 *
 * Deliberately NOT a blocker itself — the hard blockers already exist at the
 * closeout (LABOR_MISSING_RATE). This is the owner-facing explanation of WHY
 * they will hit one, surfaced before they waste a move discovering it.
 */
export function evaluateFinancialSetup(i: SetupInput): SetupStatus {
  const owners = i.users.filter((u) => u.active && u.role === 'OWNER')
  const crew = i.users.filter((u) => u.active && u.role !== 'OWNER')

  const items: SetupItem[] = [
    {
      key: 'business_config',
      label: 'Set the profit policy (business retained %, owner split)',
      href: '/admin/owner-money',
      done: i.hasBusinessConfig,
    },
    {
      key: 'owner_economic_rate',
      label: "Set the owners' labor value — what an owner hour is worth if it had to be hired",
      href: '/admin/owner-money',
      done: (i.ownerEconomicRateCents ?? 0) > 0,
    },
    ...owners.map((o) => ({
      key: `owner_rate_${o.name ?? 'unknown'}`,
      label: `Set ${o.name ?? 'this owner'}'s cash labor rate (optional — leave unset if owners take no wage)`,
      href: '/admin/staff',
      // Optional by policy: an owner who takes no wage is a valid configuration.
      done: true,
    })),
    {
      key: 'crew_exists',
      label: 'Add at least one active crew member',
      href: '/admin/staff',
      done: crew.length > 0,
    },
    {
      key: 'crew_rates',
      label: 'Set a default pay rate for every active crew member',
      href: '/admin/staff',
      // Vacuously true with no crew; the crew_exists item carries that gap.
      done: crew.every((c) => (c.payRate ?? 0) > 0),
    },
  ]

  const outstanding = items.filter((x) => !x.done)
  return {
    ready: outstanding.length === 0,
    items,
    outstanding,
    headline: outstanding.length > 0 ? SETUP_HEADLINE : null,
  }
}
