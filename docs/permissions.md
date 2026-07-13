# Permissions matrix (increment 2.1)

Source of truth: `src/lib/permissions.ts#can(role, action)`. Enforced
**server-side** on every route; UI hiding is convenience only. CREW and
unauthenticated are denied all admin actions (middleware also blocks them).

Policy: **OWNER** does everything. **MANAGER** runs day-to-day operations but has
no owner-financial authority (no owner-money, no company profit, no finalized
edits, no permanent dismissals, no overrides, no seeding, no audit log).

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
