# Email Marketing — Beta release

_Last updated 2026-07-21._

## What Beta means here

The section is **code-complete and owner-only**. Every page is live and reading
real data. What has *not* happened is a rehearsal against a real provider,
queue, webhook and database.

The sidebar shows:

```
Email Marketing   BETA
```

Unlike the previous `soon` label, this is a **working link** — the badge sets an
expectation, it does not disable the page. A banner on the overview states the
restriction in the product itself.

## Restrictions in force

* Managers, crew and read-only users have **no access**, enforced server-side.
* **Promotional campaign sending stays disabled** behind its existing feature
  flags (`EMAIL_JOURNEYS_ENABLED`, `MARKETING_FOLLOWUPS_ENABLED`,
  `REFERRAL_PROGRAM_ENABLED`) until the staging scenarios pass.
* **Transactional email is unaffected** and continues on its existing safe
  configuration. Nothing in this pass changed how a confirmation, receipt or
  move-day reminder sends.

## Build success is not production verification

The build passing, 1018 tests passing and TypeScript being clean prove the code
is internally consistent. They prove nothing about Resend, Redis, Neon or DNS.
See [email-staging-plan.md](./email-staging-plan.md).

## Exiting Beta

1. Run all 25 staging scenarios.
2. Record DNS verification (`EMAIL_DNS_SPF|DKIM|DMARC` + `EMAIL_DNS_VERIFIED_AT`).
3. Delete the three `EMAIL_BETA_OWNER_ONLY` entries from `OWNER_ONLY` if manager
   access is wanted.
4. Set `EMAIL_MARKETING_BETA = false` and drop the `beta` flag in `Sidebar.tsx`.
5. Update the test that asserts the Beta lockdown.
