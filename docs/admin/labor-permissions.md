# Labor permissions

Enforced server-side via `can(role, action)` in `src/lib/permissions.ts`, plus
row-ownership checks in the routes (a matrix cannot express "own").

| Action | OWNER | MANAGER | CREW |
| --- | :-: | :-: | :-: |
| `labor.assign_crew` | ✅ | ✅ | ❌ |
| `labor.edit_assignment` | ✅ | ✅ | ❌ |
| `labor.enter_hours` (anyone) | ✅ | ✅ | ❌ |
| `labor.clock_self` (own row only) | ✅ | ✅ | ✅ |
| `labor.submit_hours` | ✅ | ✅ | ✅ |
| `labor.view_own_labor` | ✅ | ✅ | ✅ |
| `labor.view_all_labor` | ✅ | ✅ | ❌ |
| `payroll.approve` | ✅ | ❌ | ❌ |
| `labor.record_payment` | ✅ | ✅ | ❌ |
| `labor.void_payment` | ✅ | ❌ | ❌ |
| `labor.edit_rate_snapshot` | ✅ | ❌ | ❌ |
| `labor.confirm_zero_labor` | ✅ | ❌ | ❌ |
| `labor.set_owner_labor_value` | ✅ | ❌ | ❌ |
| `labor.finalize_override` | ✅ | ❌ | ❌ |

## The rules that matter most

- **Nobody approves their own pay** — not a worker, not a manager, **not even an
  owner on their own assignment**. With two owners there is always someone else.
- **A worker acts only on their own row.** `labor.clock_self` is granted to CREW,
  but every route also checks `assignment.userId === session.userId`.
- **A locked-in rate is owner-only to change, and needs a reason** — it rewrites
  what a past move cost, and lands in the audit log as before → after.
- **A manager runs operations but holds no owner-financial authority**: no
  approval, no void, no rate rewrite, no $0 confirmation, no owner-labor value,
  no finalize override.

CREW still has no `/admin` access at all (middleware). These permissions exist so
the Phase 4 crew portal is built on an already-correct, already-tested rule
rather than a new one invented later.
