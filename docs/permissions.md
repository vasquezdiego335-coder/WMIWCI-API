# Permissions matrix (increment 2.1)

Source of truth: `src/lib/permissions.ts#can(role, action)`. Enforced
**server-side** on every route; UI hiding is convenience only. CREW and
unauthenticated are denied all admin actions (middleware also blocks them).

## Founders

**Diego and Sebastian are BOTH co-owners / co-founders and use the same `OWNER`
role with identical access.** There is no `PRIMARY_OWNER` / `CO_OWNER`
distinction — the `UserRole` enum is `OWNER | MANAGER | CREW`, and the permission
model is role-based, so any two OWNER accounts are provably identical
(`permissions.test.ts` asserts founder parity). **`MANAGER` is reserved for
future non-owner employees** (operational access only); there are no manager
accounts among the founders.

> **Seed defect fixed (2.1):** `prisma/seed.ts` previously created Sebastian as
> `MANAGER`. It now creates him as `OWNER`. The live production account was
> `MANAGER` at audit time — correct it with the non-automatic procedure below
> (owner-run). Until then, Sebastian is restricted by the matrix even though the
> model is correct.

### Production role fix (owner-run — not automatic)
```
# dry run (read-only, shows the change):
npx tsx scripts/set-user-role.ts --email sebastian@moveitclearit.com --role OWNER
# apply:
npx tsx scripts/set-user-role.ts --email sebastian@moveitclearit.com --role OWNER --apply
```
Idempotent, audited (before→after), touches only the `role` field — never
passwords. Equivalent SQL if you prefer:
`UPDATE users SET role = 'OWNER' WHERE email = 'sebastian@moveitclearit.com';`

## Policy
**OWNER** (both founders) does everything. **MANAGER** (future employees) runs
day-to-day operations but has no owner-financial authority (no owner-money, no
company profit, no finalized edits, no permanent dismissals, no overrides, no
seeding, no audit log).

| Action | OWNER | MANAGER |
| --- | :---: | :---: |
| View Action Center | ✅ | ✅ |
| Run reminder scan | ✅ | ✅ |
| Assign / claim reminder | ✅ | ✅ |
| Resolve / snooze / note reminder | ✅ | ✅ |
| Dismiss occurrence (with reason) | ✅ | ✅ |
| **Dismiss permanently (rule+entity)** | ✅ | ❌ |
| **Restore dismissed reminder** | ✅ | ❌ |
| View roadmap | ✅ | ✅ |
| Create / edit roadmap item | ✅ | ✅ |
| Reject / archive roadmap item | ✅ | ✅ |
| **Seed roadmap** | ✅ | ❌ |
| View job profit | ✅ | ✅ |
| **View company profit** | ✅ | ❌ |
| **View owner ledger (Owner Money)** | ✅ | ❌ |
| **Create / approve owner transaction** | ✅ | ❌ |
| Create expense | ✅ | ✅ |
| Approve / reject expense | ✅ | ✅ |
| Record payment | ✅ | ✅ |
| **Edit finalized expense (adjustment)** | ✅ | ❌ |
| **Delete expense** | ✅ | ❌ |
| **WORKER_PAY double-count override** | ✅ | ❌ |
| **Edit business config (split/reserves)** | ✅ | ❌ |
| View payroll | ✅ | ✅ |
| Edit crew hours (non-finalized) | ✅ | ✅ |
| **Approve crew pay / mark paid** | ✅ | ❌ |
| **View audit logs** | ✅ | ❌ |

Bold rows are owner-only (`OWNER_ONLY` in `permissions.ts`). Payroll edit/approve
UIs are roadmap items; the permissions are defined now so they enforce the day
those editors ship.

### Authorization test coverage
`src/lib/__tests__/permissions.test.ts` asserts OWNER-allow-all, the full
MANAGER allow/deny split, and CREW/unauthenticated denial. Routes additionally
return 401 (no session), 403 (wrong role), 422 (bad input), 404 (not found).
