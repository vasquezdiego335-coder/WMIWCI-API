# Reporting permissions

Enforced in three places, all server-side:

1. **Route access** — `canRunReport(role, report)`.
2. **Export access** — `canExportReport(role, report)`; sensitive exports are
   owner-only even where the on-screen report is not.
3. **Response shape** — `shapeForRole()` strips owner-only money from the JSON
   before it is serialized.

| Report | OWNER | MANAGER | CREW |
| --- | :-: | :-: | :-: |
| overview / profit-loss / revenue-profit | view + export | **no access** | no |
| moves / variance / customers | view + export | view + export | no |
| marketing | view + export | view, **no export** | no |
| pricing | view | view | no |

Owner-only fields stripped from every response for non-owners:
`companyNetProfitCents`, `economicNetProfitCents`, `economicProfitCents`,
`cashGrossProfitCents`, `ownerEconomicLaborCents`, `crewLaborCents`,
`taxReserveCents`, `businessReserveCents`, `retainedEarningsCents`,
`distributableProfitCents`, `marginBp`, `finalizedNetProfitCents`,
`provisionalNetProfitCents`, `profitRoasBp`, `netOfSpendCents`,
`averageProfitPerMoveCents`.

**Not implemented:** ACCOUNTANT, CREW_LEADER and READ_ONLY. `UserRole` still has
only OWNER / MANAGER / CREW. Adding them is a schema change plus a migration and
was deferred rather than half-done.
