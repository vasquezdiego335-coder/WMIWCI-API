# Stage 4 — overview

## Purpose

Turn a completed move into a **durable financial record**: what came in, what it
cost, what was left, and how the remainder is allocated between the business and
the two owners. The record must stay true after the settings that produced it
have changed.

## Scope

In scope: revenue reconciliation, direct job costs, labor costing (crew cash and
owner economic), overhead allocation, reserves, company net profit, the 40/30/30
allocation, blockers and overrides, finalization, immutable snapshots, reopening
and versioning, snapshot-backed reporting and exports, and the owner's
labor-rate configuration.

Explicitly **outside** Stage 4:

* itemized customer charges (a move is billed from the quote plus approved
  additional charges — not a line-item invoice)
* discounts, credits and write-offs as first-class objects (only a single
  `balanceWriteOffCents` with a reason exists)
* payroll execution — `LaborPayment` records that money moved; it does not move it
* crew scheduling, availability and assignment workflow — **Stage 5**
* tax filing of any kind. The retained share is a general company allocation and
  every surface that displays it says so.

## Completed functionality

| Area | Where |
| --- | --- |
| Financial hierarchy (revenue → costs → profit → overhead → reserves → distributable) | `src/lib/closeout-calc.ts` |
| Blockers, severities, finalize decision, derived status | `src/lib/closeout-blockers.ts` |
| Permission + state guards | `src/lib/closeout-guards.ts` |
| The one Prisma-touching composer | `src/lib/closeout-service.ts` |
| Owner split | `src/lib/owner-split.ts` |
| 40/30/30 presentation model | `src/lib/profit-allocation.ts` |
| Owner labor-rate configuration | `src/lib/labor-rates.ts`, `PATCH /api/admin/staff/[id]/rates` |
| Internal-test rehearsal gate | `src/lib/internal-rehearsal.ts` |
| Setup reporting | `src/lib/financial-setup.ts` |
| Snapshot-backed reporting | `src/lib/reporting-basis.ts`, `reporting-service.ts`, `report-builders.ts` |
| Exports (CSV / XLSX / PDF) | `src/lib/export-service.ts`, `report-permissions.ts` |
| Printable summary | `/admin/closeout-summary/[id]` |

## Dependencies

* Stage 1 labor system (`JobCrew`, `labor-*.ts`) — supplies every labor cost
* Stage 3 reporting (`reporting-*.ts`) — the surface snapshots feed
* `BusinessConfig` singleton — overhead method, retained share, owner split
* Postgres (Neon). No Redis, queue or provider dependency in the closeout path

## Status, stated precisely

| Claim | True? | Evidence |
| --- | --- | --- |
| Code complete | **Yes** | merged to `main` as `a4833a5b0` (#17) |
| Deployed | **Yes** | migrations applied to production Neon 2026-07-21; columns verified by introspection |
| Automated tests passing | **Yes** | 1068/1068 via `npm test` at the merge commit |
| Production end-to-end rehearsal | **NO — deferred** | 0 closeouts and 0 snapshots exist in production; `finalize → reopen → version two` has never run against real rows |

**Current status: `COMPLETE — DEPLOYED — END-TO-END REHEARSAL DEFERRED`.**

The rehearsal is deferred deliberately: it needs the whole
booking → job → scheduling → closeout pipeline, and scheduling is Stage 5. The
plan is written and ready (`docs/admin/stage4-rehearsal-plan.md`); it must not
be run against real financial reporting until the operator authorizes it.

## What "verified" means here

Everything in the closeout math is covered by offline unit tests: the formulas,
the blocker severities, the guards, the allocation, snapshot durability under
configuration change, versioning across a reopen, the reporting basis selection,
and the export field set. Those are genuine and repeatable.

What is **not** verified is behaviour that only appears with a live database and
a real workflow: that a real finalize writes exactly one snapshot row, that
reopening supersedes rather than replaces it in Postgres, that the audit chain is
complete end to end, and that the reporting layer agrees with the closeout screen
on real data. Unit tests cannot establish those, and this document does not
claim they do.
