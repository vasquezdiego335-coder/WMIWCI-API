// ════════════════════════════════════════════════════════════════════════════
//  migration-window.ts — ITEM P0-E. Surviving "code deployed, SQL not yet run".
//
//  Migrations here are applied BY HAND (docs/deployment.md), so the window
//  between a deploy and the migration is a NORMAL state that can last hours.
//  Two Prisma facts make that window dangerous:
//
//    1. An `include:` (or an omitted `select`) asks Postgres for `$scalars`
//       FROM THE GENERATED SCHEMA. A query that names no new column still
//       breaks, because the generated client knows about columns the database
//       has never heard of. → P2022.
//    2. A relation to a table the migration creates breaks the same way. →
//       P2021.
//
//  This module is the ONE place that knows which columns/tables are at risk and
//  how to read a booking without them. It is deliberately tiny and dependency-
//  free apart from `@prisma/client` itself, so a React server component, an
//  email renderer, the Stripe fulfillment path and an admin route can all
//  import it without dragging Stripe/BullMQ/permissions along.
//
//  DESIGN — why the degraded select is DERIVED, not hand-listed:
//  Round 3's lesson was that a hand-maintained list rots silently. The degraded
//  rung here is "every Booking scalar the GENERATED client declares, MINUS the
//  columns the pending migrations add". Every other column is guaranteed to
//  exist (its migration is applied), so the fallback can never omit a column a
//  consumer needs, and it can never ask for one the database lacks.
//  `src/lib/__tests__/migration-window.test.ts` reads the migration SQL files
//  and fails if MIGRATION_BOOKING_COLUMNS drifts from what they actually add,
//  or if a NEWER migration directory appears that nobody classified.
// ════════════════════════════════════════════════════════════════════════════
import { Prisma } from '@prisma/client'

/** The migrations a running deploy may be AHEAD of, oldest first. Update this
 *  (and MIGRATION_BOOKING_COLUMNS / MIGRATION_TABLES) when a new one lands —
 *  the test in __tests__/migration-window.test.ts fails until you do. */
export const PENDING_MIGRATIONS = [
  '20260811000000_moving_os_phase1',
  '20260812000000_staffing_plan',
  '20260812010000_start_time_known',
] as const

/** Booking columns those migrations ADD, as Prisma FIELD names (the keys a
 *  `select` uses). Pinned against the migration SQL by test. */
export const MIGRATION_BOOKING_COLUMNS = [
  // 20260811000000_moving_os_phase1
  'truckId',
  'priceOverrideReason',
  'originPropertyType',
  'destPropertyType',
  'serviceMode',
  'coiRequired',
  // 20260812000000_staffing_plan
  'staffingPlan',
  // 20260812010000_start_time_known
  'startTimeKnown',
] as const

/** Tables those migrations CREATE. A relation pointing at one of these is
 *  unreadable in the window (P2021), so a degraded read must drop it. */
export const MIGRATION_TABLES = ['trucks', 'inventory_catalog_items', 'booking_inventory_items'] as const

/** Booking RELATION fields backed by MIGRATION_TABLES. */
export const MIGRATION_BOOKING_RELATIONS = ['truck', 'inventoryItems'] as const

/** The one sentence an owner-facing surface says when it cannot proceed. It
 *  names the migrations so the fix is the next thing they read — never a bare
 *  500 and never a claim that something was saved. */
export const MIGRATION_MISSING_MESSAGE =
  `Moving OS tables/columns missing — apply migrations ${PENDING_MIGRATIONS.join(', ')}`

/** The same refusal said to a CUSTOMER (the public booking form). Deliberately
 *  names no migration, column, table or vendor: a customer cannot act on any of
 *  that, and an API that spells its schema out to the open internet is leaking.
 *  What it DOES say is the part they need — nothing was submitted, so retrying
 *  is safe and they have not been charged or half-booked. The owner-facing
 *  detail goes to the server log instead (test: this sentence leaks nothing). */
export const MIGRATION_CUSTOMER_MESSAGE =
  'Online booking is temporarily unavailable — nothing was submitted and you have not been charged. Please try again shortly, or contact us and we will book it for you.'

/**
 * Unapplied-migration signature: Prisma P2021 (missing table) / P2022 (missing
 * column), or a Postgres "does not exist". Deliberately narrow — a connection
 * failure, a timeout or a constraint violation is NOT this, and must never be
 * answered with a silently degraded read.
 *
 * `src/lib/booking-approval.ts` re-exports this (its historical home) so its
 * importers keep compiling; there is exactly one implementation.
 */
export function isMigrationMissing(err: unknown): boolean {
  const code = (err as { code?: string })?.code
  const msg = err instanceof Error ? err.message : String(err)
  return code === 'P2021' || code === 'P2022' || /does not exist/i.test(msg)
}

/** Every scalar/enum field the GENERATED client declares for a model. Throws if
 *  the DMMF is unavailable, which is louder — and safer — than guessing a
 *  column list: the caller is already inside a migration-error catch, so the
 *  worst case is the failure the caller was handling anyway. */
function scalarFieldNames(model: string): string[] {
  const dm = (Prisma as unknown as { dmmf?: { datamodel?: { models?: Array<{ name: string; fields: Array<{ name: string; kind: string }> }> } } }).dmmf
  const found = dm?.datamodel?.models?.find((m) => m.name === model)
  if (!found) {
    throw new Error(
      `migration-window: the generated Prisma DMMF has no model "${model}", so a degraded column list cannot be derived. Run \`npx prisma generate\`.`,
    )
  }
  return found.fields.filter((f) => f.kind === 'scalar' || f.kind === 'enum').map((f) => f.name)
}

/**
 * A `select` naming every Booking column that certainly EXISTS in a database
 * the pending migrations have not reached yet: all generated scalars minus
 * `omit` (default = the pending columns).
 *
 * Use it as the SECOND rung of a read: try the natural `include`, and on a
 * migration-shaped failure retry with this. The row you get back is genuinely
 * missing those columns — every consumer of them already treats `undefined` as
 * "unknown" (e.g. booking-display.moveTimeKnown falls back to the 00:00 ET
 * anchor SHAPE), so nothing is invented to fill the gap.
 */
export function bookingScalarSelect(
  omit: readonly string[] = MIGRATION_BOOKING_COLUMNS,
): Record<string, true> {
  const skip = new Set<string>(omit)
  const select: Record<string, true> = {}
  for (const name of scalarFieldNames('Booking')) {
    if (!skip.has(name)) select[name] = true
  }
  return select
}

// ════════════════════════════════════════════════════════════════════════════
//  THE CREATE PREFLIGHT (H1)
//
//  A booking create cannot be laddered: `create` returns the row, so Prisma's
//  INSERT ... RETURNING asks for `$scalars` from the GENERATED schema whatever
//  the caller writes. In the window that is a P2022 — AFTER the statement, and
//  after everything the create already consumed on its way there.
//
//  Two things a rolled-back transaction does NOT give back:
//    • `nextBookingReference()` — a `SELECT nextval(...)`, which Postgres never
//      rolls back. Every refused create permanently burned a WMIC-#### number.
//    • a write that happens OUTSIDE the transaction at all — the public route's
//      `prisma.customer.upsert`, which created a real CRM row for a booking
//      that then failed.
//
//  So both creates probe FIRST with a pure read of exactly the at-risk columns
//  (plus the tables they would write into), before the sequence is touched and
//  before any row is written. The probe writes nothing and consumes nothing.
//
//  The probes are INJECTED rather than imported, for two reasons: this module
//  stays dependency-free (a React server component imports it), and the guard
//  is testable offline against a fake client with no database anywhere.
// ════════════════════════════════════════════════════════════════════════════

/** The Booking `select` a create preflight reads: `id` plus EXACTLY the columns
 *  the pending migrations add. DERIVED from the shared constant — a future
 *  migration cannot leave the probe stale (the constant is pinned to the
 *  migration SQL by test), and it can never accidentally probe a column that
 *  has always existed and prove nothing. */
export function bookingCreateProbeSelect(): Record<string, true> {
  const select: Record<string, true> = { id: true }
  for (const column of MIGRATION_BOOKING_COLUMNS) select[column] = true
  return select
}

/** The reads a create preflight performs. `booking` is mandatory; the other two
 *  are passed ONLY when this particular create would write those tables, so a
 *  booking with no inventory is never refused for a table it does not touch. */
export type CreatePreflightProbes = {
  /** Runs `findFirst({ select })` with the select handed to it. */
  booking: (select: Record<string, true>) => Promise<unknown>
  /** Pass only when inventory snapshots will be written. */
  inventoryItems?: (() => Promise<unknown>) | null
  /** Pass only when a CONFIRMED create will write a staffing requirement. */
  staffingRequirement?: (() => Promise<unknown>) | null
}

export type CreatePreflightResult = { ready: true } | { ready: false; reason: string }

/**
 * Probe the database for the columns/tables a booking create is about to write.
 * Returns `ready: false` on a MIGRATION-shaped failure only.
 *
 * A real outage (connection dropped, statement timeout) is RETHROWN: reporting
 * one as "apply the migrations" would send the owner to run SQL that is already
 * applied, and — worse — a caller that treats every failure as `ready: false`
 * would turn a transient blip into a permanent, silent refusal to take
 * bookings. Only P2021/P2022/"does not exist" refuses.
 */
export async function checkBookingCreateReady(
  probes: CreatePreflightProbes,
): Promise<CreatePreflightResult> {
  try {
    await probes.booking(bookingCreateProbeSelect())
    if (probes.inventoryItems) await probes.inventoryItems()
    if (probes.staffingRequirement) await probes.staffingRequirement()
    return { ready: true }
  } catch (err) {
    if (!isMigrationMissing(err)) throw err
    return { ready: false, reason: MIGRATION_MISSING_MESSAGE }
  }
}

/**
 * THE two-rung booking read. `read(args)` performs exactly ONE Prisma call with
 * the args it is given, so every caller is unit-testable with no database.
 *
 *   rung 1 — `{ include: relations }`: the complete row (production behaviour).
 *   rung 2 — `{ select: <existing scalars> + relations-minus-new-tables }`.
 *
 * A NON-migration error always propagates: a real outage must never be quietly
 * downgraded into a partial row.
 */
export async function readBookingWithMigrationFallback<T>(
  read: (args: { include?: Record<string, unknown>; select?: Record<string, unknown> }) => Promise<unknown>,
  relations: Record<string, unknown> = {},
): Promise<{ row: T | null; degraded: boolean; reason?: string }> {
  try {
    return { row: (await read({ include: relations })) as T | null, degraded: false }
  } catch (err) {
    if (!isMigrationMissing(err)) throw err
    const safeRelations: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(relations)) {
      if ((MIGRATION_BOOKING_RELATIONS as readonly string[]).includes(key)) continue
      safeRelations[key] = value
    }
    const row = (await read({ select: { ...bookingScalarSelect(), ...safeRelations } })) as T | null
    return {
      row,
      degraded: true,
      reason: `read without ${MIGRATION_BOOKING_COLUMNS.join('/')} — ${MIGRATION_MISSING_MESSAGE}`,
    }
  }
}
