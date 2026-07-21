# Email production runbook

_Last updated 2026-07-21._

## Deployment order

1. Merge the branch **after** rebasing on the latest `main` (see below).
2. `npx prisma migrate deploy` — applies the two additive migrations.
3. Deploy the API + workers on Railway.
4. `npm run email:preflight` and `npm run email:doctor` against production.
5. Open `/admin/email-marketing/deliverability` and confirm the running
   container's configuration.

Both migrations are additive: new nullable columns, new tables, `ADD VALUE IF
NOT EXISTS` enum additions. No column is dropped and no type is narrowed, so the
migration can be applied **before** the code deploy without breaking the running
version.

## Environment variables added

| Variable | Purpose |
|---|---|
| `EMAIL_TEST_RECIPIENT` | The one address a test send may reach without an override |
| `EMAIL_DNS_SPF` / `EMAIL_DNS_DKIM` / `EMAIL_DNS_DMARC` | `VERIFIED` / `MISSING` / `INVALID` — an operator attestation |
| `EMAIL_DNS_VERIFIED_AT` | When the DNS check was performed. **A `VERIFIED` claim without this is downgraded to `UNVERIFIED`.** |

## Rollback

The admin is **read-mostly**; reverting the application code removes the pages
and leaves the data intact.

* **Do not roll back the migrations.** The new tables and columns are additive
  and unused by the previous version. Dropping `email_sends.campaign_id` would
  destroy attribution recorded since deploy.
* To disable the section without a deploy: no flag does this — revoke the
  owner's access or revert `Sidebar.tsx`. The pages are permission-gated, not
  flag-gated, by design (a flag that hides an audit surface is a liability).
* To stop all promotional sending immediately: set `EMAIL_JOURNEYS_ENABLED`,
  `MARKETING_FOLLOWUPS_ENABLED` and `REFERRAL_PROGRAM_ENABLED` to anything but
  `true` and redeploy. Transactional mail is unaffected.
* Engine rollback: [../email-marketing/rollback.md](../email-marketing/rollback.md).

## Stage 4 coordination

This branch was built from `origin/main` while `claude/stage4-financial-workflow`
was in progress. Shared files that may need reconciliation:

| File | Nature of the overlap |
|---|---|
| `prisma/schema.prisma` | Both append to `AuditAction`. Keep both blocks. |
| `prisma/migrations/` | Both add `ADD VALUE IF NOT EXISTS` migrations — they **commute**, either order yields the same enum. |
| `src/lib/permissions.ts` | Both append to `Action` and `OWNER_ONLY`. Keep both blocks. |
| `package.json` | Both append test files to the `test` script. **Keep both lists** — dropping either suite is not an acceptable conflict resolution. |
| `Sidebar.tsx` | Email changed one line. |
| `app/(admin)/admin/(dashboard)/jobs/[id]/page.tsx` | Email added two imports and one component; Stage 4 edits the financial panels. |

After rebasing, re-run the **combined** validation:

```
npx prisma validate && npx prisma generate && npx tsc --noEmit && npm test && npm run build
```

## Monitoring

* `/admin/email-marketing` — unfinished suppression side effects must be **0**.
* Ambiguous sends must be reconciled by a human, never auto-resent.
* `/admin/email-marketing/deliverability` — webhook last-event time.
