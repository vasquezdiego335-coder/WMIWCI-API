# Email ↔ admin integration

_Last updated 2026-07-21. Branch `claude/email-admin-integration`._

## What this pass did — and did not — change

**It changed no send behaviour.** Not one customer email sends differently as a
result of this work. The send guard, the templates, the journeys, the
suppression list and the webhook were already built and audited (merged to
`main` in `c9ee9d87`). What was missing was any way to *read* them.

Verified before writing code: the email tree on `main` is **byte-identical** to
`claude/complete-email-marketing-system` in `C:\WMIWCI-API-fixes`. That branch is
fully merged; nothing was ported from it.

### Added

| Layer | File |
|---|---|
| Template + journey registry | `src/lib/email-registry.ts` |
| Admin read queries | `src/lib/email-admin.ts` |
| Attribution (read-only over finance) | `src/lib/email-attribution.ts` |
| Admin pages (10) | `app/(admin)/admin/(dashboard)/email-marketing/**` |
| Per-booking email ledger | `app/(admin)/admin/(dashboard)/jobs/[id]/EmailTimeline.tsx` |
| Admin API (4 routes) | `app/api/admin/email-marketing/**` |
| Permissions (10 actions) | `src/lib/permissions.ts` |
| Audit actions (4) | `prisma/migrations/20260721190000_email_admin_audit_actions` |
| Tests (45 checks) | `src/lib/__tests__/email-registry.test.ts`, `email-admin.test.ts` |

### Changed in shared files (minimal, for merge safety)

- `src/lib/permissions.ts` — one appended `Action` block, one appended
  `OWNER_ONLY` block.
- `prisma/schema.prisma` — four appended `AuditAction` enum values.
- `Sidebar.tsx` — one line: `Email Marketing` gained an `href` and lost `soon`.
- `jobs/[id]/page.tsx` — two imports and one component insertion.

## The registry is the load-bearing idea

`email-registry.ts` never restates a fact another module owns:

| Fact | Owner |
|---|---|
| transactional vs promotional | `email-guard.classifyTemplate` |
| which booking states are truthful | `emails/status.TEMPLATE_ALLOWED_STATUSES` |
| required payload fields | `emails/validation.REQUIRED_FIELDS` |
| journey stages and delays | `lib/journeys` constants |

What it adds is the editorial metadata nothing else owns: the trigger in plain
English, the stop rules, and `wiring` — whether a template is `wired`,
`flag-gated` or `manual`.

**A file is not a feature.** `email-archive/` holds nine legacy React templates
no send path can reach. They are absent from the registry rather than listed as
active, and a test asserts no registry entry points into that directory.

`email-registry.test.ts` asserts the registry against the worker's
`ALLOWED_TEMPLATES` by reading the worker source as text (it constructs a BullMQ
Worker on import, so it cannot be imported into a test). A template added to the
worker without a registry entry **fails the build** rather than appearing in the
admin as a mystery row.

## Honesty rules the read layer enforces

1. **Never invent a denominator.** A delivery rate over zero sends is `null`,
   rendered `—`. Every rate carries the counts it came from.
2. **Data completeness is part of the answer.** "No `delivered` webhook events"
   and "tracking is off" are stated in a note rather than being rendered as a
   zero that looks like a fact.
3. **Unavailable ≠ empty.** If Redis cannot be read, the Scheduled page says the
   queue is unreadable and the API returns **503**. An empty list would read as
   "nothing is scheduled", the opposite of the truth.
4. **An unmapped block reason is shown verbatim**, never paraphrased into
   something that might be wrong.
5. **SPF/DKIM/DMARC are always `unverified`.** They live in DNS; this process
   cannot see them, and inferring "configured" from an env var is the exact
   false green the page exists to prevent.

## Concurrency with Stage 4

Built in a separate worktree (`C:\WMIWCI-API-email`) branched from
`origin/main`, so the live Stage 4 tree in `C:\WMIWCI-API` was never touched.

The only schema change is four `ALTER TYPE ... ADD VALUE IF NOT EXISTS`
statements. Stage 4 also appends to `AuditAction`. Both migrations are pure
additive enum adds, so they **commute** — applying them in either order produces
the same enum.

Merge order does not matter. If both branches touched `permissions.ts` or
`schema.prisma`, resolve by **keeping both blocks**; they are disjoint.

## Verification

```
npx prisma validate     # valid (needs DATABASE_URL set)
npx prisma generate     # ok
npx tsc --noEmit        # clean
npm test                # 957/957 pass
npm run build           # green; 10 pages + 4 API routes emitted
```

See [email-admin-permissions.md](./email-admin-permissions.md),
[email-attribution.md](./email-attribution.md),
[admin-controls.md](./admin-controls.md).
