# Email admin — staging runbook

_Prepared 2026-07-21 for branch `claude/email-admin-integration` @ `bd4e9e7e`._
_Neon restore branch `pre-stage4-20260721` exists._

Run the commands here in order. Nothing in this document rotates a password,
changes a Railway variable, or needs a connection string pasted anywhere.

---

## 0. READ THIS FIRST — superseded 2026-07-22

**The gap this section describes is CLOSED.** Branch
`claude/email-marketing-dispatch-complete` adds the campaign dispatch
executor, the automation enrollment/stage runtime, and their worker cases.
See `docs/email/dispatch-runtime.md` (architecture) and
`docs/email/dispatch-staging-rehearsal.md` (the rehearsal for the new layer —
run it IN ADDITION to this runbook). The table below is kept for the history
of what was true when this document was written.

**Original text (2026-07-21):** campaign dispatch and automation execution
have no worker.

Verified by grep against the branch: nothing in `src/` or `app/` calls
`resolveAudienceForDispatch()`, `canDispatch()`, or `automationJobId()`, and
nothing writes `EmailCampaignConfig.dispatchedAt` / `dispatchedCount`.

What **is** built and testable: the composer, the lifecycle state machine,
validation, owner approval, audience resolution and preview, automation
definitions and versioning, and the whole admin surface. What is **not** built
is the producer that takes an approved campaign and enqueues one guarded send
per eligible recipient, and the trigger wiring that fires an automation stage.

Consequences for the plan:

| Plan item | Reality |
|---|---|
| Scenario 3 — promotional campaign draft | Runnable (draft → validate → approve → schedule) |
| Scenario 17 — campaign click → booking | **Cannot run.** No campaign email can be sent. |
| Scenario 19 — campaign pause | Runnable as a **state transition only**; nothing is being stopped |
| Scenario 20 — campaign cancellation | Same — state + audit only |
| Scenario 23 — direct campaign relation | Runnable only via a **test send**, or by asserting the FK rule in preflight |
| Scenario 24 — test sends excluded from conversions | Runnable |
| "Campaign dispatch jobs" in Redis | **Will always be empty.** There is no producer. |
| "Automation rehearsal jobs" in Redis | **Will always be empty.** Same reason. |

This is a missing feature, not a bug, and it is better to know now than to spend
an afternoon looking for a job that cannot exist. Everything else in the plan is
real and runnable. Decide whether to build the dispatcher before or after this
staging pass; the runbook below assumes **after**.

---

## 1. Railway staging deployment

### 1.1 Services that must be running

| Service | Start command | Why |
|---|---|---|
| **API** (Next.js) | `npm run start` | Serves `/admin/**` and `/api/**`, including `/api/email/webhook` |
| **Worker host** | `npm run host:start` | ONE container running 5 BullMQ workers + the outbox poller + the Discord bot, and an HTTP health server on `$PORT` |

`host:start` is the single-container topology (`src/worker-host.ts`). Do **not**
also run `workers:start` and `outbox:start` separately — you would get two
consumers on the same queues.

### 1.2 Deploy order

```
1. Confirm the Neon restore branch pre-stage4-20260721 exists   (done)
2. Deploy the API service from claude/email-admin-integration
3. Run the migration (section 2) — safe to run before or after the deploy,
   because both migrations are purely additive
4. Deploy / restart the worker host on the same commit
5. Run section 6 (preflight + doctor)
6. Run section 3 (DNS), 4 (Resend), 5 (Redis), 7 (browser)
```

Both services must be on the **same commit**. A worker on an older commit will
not know the new columns and will throw on `isTest`.

### 1.3 Environment variables

These are every variable the email path actually reads, verified by grep.
**Do not change any of these — just confirm they exist.**

**Must be set or email is broken:**

| Variable | Consequence if missing |
|---|---|
| `DATABASE_URL` | Nothing works |
| `REDIS_URL` | Workers silently fall back to `localhost:6379` and connect to nothing |
| `RESEND_API_KEY` | No email can send (also fails if it equals `re_placeholder`) |
| `RESEND_WEBHOOK_SECRET` | `/api/email/webhook` returns **503** and **no bounce or complaint is ever processed** |
| `APP_URL` | No unsubscribe link can be built → **every promotional send is blocked** |
| `EMAIL_FROM` | No sender |
| `BUSINESS_POSTAL_ADDRESS` | **Every promotional send is blocked** (CAN-SPAM). Transactional is unaffected |
| `JWT_SECRET` | Admin login fails |

**Should be set for this staging pass:**

| Variable | Purpose |
|---|---|
| `EMAIL_TEST_RECIPIENT` | The one address a test send may reach without an override. **Set this before scenario 1.** |
| `EMAIL_TOKEN_SECRET` | Signs unsubscribe tokens. If unset it derives from `RESEND_API_KEY` — which works, but rotating Resend then silently breaks every live unsubscribe link. **Must be identical on the API and the worker host.** |
| `EMAIL_REPLY_TO` | Reply address |
| `OWNER_EMAIL` | Internal alerts |
| `GOOGLE_REVIEW_URL` | Without it, review requests never queue |
| `EMAIL_SUPPRESSION_API_KEY` | Only needed if Leadtracking must query suppression |

**Must stay OFF for this pass** (they default to off; confirm none is the string
`true`):

```
EMAIL_JOURNEYS_ENABLED
MARKETING_FOLLOWUPS_ENABLED
REFERRAL_PROGRAM_ENABLED
OUTBOX_ENABLED
```

**New in this branch — set during section 3 only:**

```
EMAIL_DNS_SPF
EMAIL_DNS_DKIM
EMAIL_DNS_DMARC
EMAIL_DNS_VERIFIED_AT
```

### 1.4 The secret-matching check

The single most common staging failure is the API and the worker host holding
**different** `EMAIL_TOKEN_SECRET` values. Unsubscribe links signed by one then
fail to verify in the other.

You do not need to reveal either value to check this. Run section 6's doctor on
both services and compare the **fingerprint** — a one-way hash the diagnostics
print. Same fingerprint = same secret.

---

## 2. Migration

Only these two commands. No `migrate dev`, no shadow database, no reset.

```bash
# 1. What does staging think is applied?
npx prisma migrate status

# 2. Apply
npx prisma migrate deploy

# 3. Confirm
npx prisma migrate status
```

### Expected

`migrate status` **before** should list two pending migrations:

```
20260721220000_email_admin_audit_actions
20260721230000_email_marketing_admin
```

`migrate deploy` should report `2 migrations applied`.
`migrate status` **after**: `Database schema is up to date!`

### If status reports drift or a failed migration

Stop. Do not run `migrate resolve` or `migrate reset`. Capture the output and
we diagnose it — you have the `pre-stage4-20260721` restore branch, so nothing
is lost, but a reset on a shared staging database is not recoverable by itself.

### Why this is safe to run before the code deploy

Both migrations are additive only: new nullable columns, new tables, and
`ALTER TYPE ... ADD VALUE IF NOT EXISTS`. No column is dropped and no type is
narrowed, so the currently-running code keeps working after they apply.

---

## 3. DNS verification

### 3.1 What to add at the registrar for `moveitclearit.com`

Resend gives you the exact SPF and DKIM records in **Domains → moveitclearit.com**.
Add what the dashboard shows — do not hand-copy from here, because the DKIM
selector and key are account-specific. The shapes are:

| Type | Host | Value |
|---|---|---|
| TXT | `send` (or as Resend shows) | `v=spf1 include:amazonses.com ~all` |
| TXT | `resend._domainkey` (Resend shows the exact selector) | the long `p=...` key from the dashboard |
| MX | `send` | `feedback-smtp.us-east-1.amazonses.com` priority 10 |
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:dmarc@moveitclearit.com` |

Start DMARC at `p=none`. It reports without quarantining, so a
misconfiguration costs you a report rather than your mail.

### 3.2 Verify

1. In Resend → Domains, click **Verify**. Wait for **Verified** on SPF and DKIM.
2. Independently confirm from a terminal:

```bash
nslookup -type=TXT send.moveitclearit.com
nslookup -type=TXT resend._domainkey.moveitclearit.com
nslookup -type=TXT _dmarc.moveitclearit.com
```

3. Send yourself a message and check the receiving headers show
   `spf=pass`, `dkim=pass`, `dmarc=pass`.

### 3.3 Record the result

Only after you have actually seen the records:

```
EMAIL_DNS_SPF=VERIFIED
EMAIL_DNS_DKIM=VERIFIED
EMAIL_DNS_DMARC=VERIFIED
EMAIL_DNS_VERIFIED_AT=2026-07-21
```

Accepted values are `VERIFIED`, `MISSING`, `INVALID`. Anything else — including
unset — renders as `UNVERIFIED`.

**A `VERIFIED` claim with no `EMAIL_DNS_VERIFIED_AT` is deliberately downgraded
to `UNVERIFIED`.** An attestation nobody can date is not one anybody can audit.
If the Deliverability page still shows `UNVERIFIED` after you set the three
values, that is the missing date, not a bug.

---

## 4. Resend provider verification

### 4.1 Test send (scenario 1)

Admin → **Email Marketing → Test send**. Choose `final-confirmation`, preview
HTML and plain text, then send.

| Where | Expected |
|---|---|
| Inbox | Subject begins `[TEST] ` |
| UI result panel | `Sent`, with a provider id |
| UI ledger line | `status: delivered · test=true` |
| `email_sends` row | `is_test = true`, `journey = 'admin-test'`, `idempotency_key` contains `test:` |
| `audit_logs` | one `EMAIL_TEST_SENT` row |
| Overview page | counts **unchanged** — test sends are excluded |

Then try a **promotional** template (e.g. `review-request`). If
`BUSINESS_POSTAL_ADDRESS` or `APP_URL` is unset, the preview names the missing
compliance context and the send is **blocked** with
`missing-configuration:marketing-context:…`. That refusal is the correct
result, not a failure.

### 4.2 Webhook configuration

Resend → **Webhooks → Add endpoint**:

```
URL     https://<staging-api-domain>/api/email/webhook
Secret  → set RESEND_WEBHOOK_SECRET to the whsec_… value
Events  email.sent, email.delivered, email.delivery_delayed,
        email.bounced, email.complained, email.opened, email.clicked
```

### 4.3 Expected HTTP responses

The route is deliberately strict, because the provider retry is load-bearing:

| Response | Meaning |
|---|---|
| **200** | Consumed **and** every side effect settled |
| **500** | Recorded, but a required suppression did not complete. **The provider must retry.** Returning 200 here was the original bug. |
| **400** | Bad signature or unparseable body — retrying will never help |
| **503** | `RESEND_WEBHOOK_SECRET` unset |

### 4.4 Bounce (scenario 7)

Send a test to `bounced@resend.dev`.

Expected: `email_events` row `type='bounced'`, `processing_status='processed'`;
`email_suppressions` row `reason=HARD_BOUNCE`, `scope='all'`; the address now
appears on the Suppressions page as **not restorable**; a further send to it is
refused with `hard_bounce`.

### 4.5 Complaint (scenario 8)

Send a test to `complained@resend.dev`.

Expected: `reason=SPAM_COMPLAINT`, `scope='all'`, not restorable, and the
Suppressions page shows "Not restorable" with the domain-damage explanation.

### 4.6 Replay (scenario 9)

In Resend → Webhooks → the delivery log, click **Resend** on an event already
processed.

Expected: **200**, no new `email_events` row, no duplicate suppression. Dedupe
is on `provider_event_id`, which is the `svix-id` header.

### 4.7 Provider failure (scenario 10)

Temporarily point `RESEND_API_KEY` at an invalid key **on the worker host only**
— or simply observe a real rejection if one occurs.

Expected: `email_sends.status = 'provider_rejected'`, `outcome_class='retryable'`,
`next_attempt_at` set, error recorded. The Send-history page explains it in
English. Restore the key afterwards.

**Never test this by sending to a real customer address.**

---

## 5. Redis verification

Queue names (BullMQ, key prefix `bull:`):
`email`, `sms`, `discord`, `webhook-retry`, `scheduled`, `marketing`.

Admin → **Queues** (`/admin/queues`) shows waiting / active / completed /
failed / delayed per queue, and links to Bull Board.

### 5.1 Connectivity

Open `/admin/email-marketing/scheduled`.

* Numbers or an empty state → Redis is reachable.
* The red "**The queue could not be read**" banner → Redis is **not** reachable.
  This is the important distinction: the page never shows an empty list when it
  cannot look, because that would read as "nothing is scheduled".

### 5.2 Scheduled jobs (scenario 11, 12, 14)

Journeys are flag-gated off, so the `scheduled` queue will be **empty** unless
you deliberately enable one. If you want to exercise it:

1. Set `EMAIL_JOURNEYS_ENABLED=true` on the worker host **only**, on staging.
2. Create a staging booking that parks in `PENDING_PAYMENT`.
3. `/admin/email-marketing/scheduled` should list three
   `abandoned-checkout-recovery*` jobs with job ids
   `journey:abandoned:<stage>:<bookingId>`.
4. Pay the deposit → the stages disappear (`onBookingPaid` cancels them).
5. **Turn the flag back off** when you are done.

### 5.3 Cancel path

With a job listed, click **Cancel**.

Expected: confirm prompt → job removed → an `EMAIL_SCHEDULED_CANCELLED` audit
row. Cancelling a job that is already running returns **409 "already running"** —
an in-flight job is stopped by the send-time recheck, not by the queue.

### 5.4 Automation and campaign jobs

**Skip.** See section 0 — there is no producer, so these queues cannot contain
such jobs. The versioned job-id format
(`automation:<id>:v<version>:<stage>:<subject>`) is asserted by unit test
instead.

---

## 6. `npm run email:preflight`

```bash
npm run email:preflight     # schema drift — read-only, exit 1 on drift
npm run email:doctor        # running-container configuration
```

Both need `DATABASE_URL` in the environment they run in. Run them **on the
Railway service** (shell into it), not locally — the whole point is to check
what the deployed container sees.

### What preflight checks

Every table, column, index and constraint the email system depends on, read from
`information_schema` / `pg_catalog`. It exists because the migrations use
`IF NOT EXISTS`, which means a partially-created table is accepted in silence and
then fails at runtime in the middle of sending mail.

**I extended it in this pass** (it previously knew nothing about the new schema
and would have reported "no drift" even if the migration never applied). It now
additionally verifies:

* `email_sends.campaign_id`, `.is_test`, `.journey_config_version` + their indexes
* all five new tables with their unique indexes and CHECK constraints
* `CampaignStatus` carries `VALIDATING, READY, SCHEDULED, CANCELLED, FAILED`
* `AuditAction` carries all 14 email actions
* **`email_sends_campaign_id_fkey` has delete rule `SET NULL`** — if a migration
  were ever hand-edited to `CASCADE`, deleting a campaign would erase the record
  that real people were emailed

### Expected output

```
EMAIL SCHEMA PREFLIGHT — read-only drift check
  OK    email_suppressions …
  …
  OK    CampaignStatus carries the email campaign lifecycle states
  OK    AuditAction carries every email admin action
  OK    email_sends.campaign_id deletes SET NULL (send history survives campaign deletion)

No drift. Email schema matches what the application expects.
```

Exit 0 clean · 1 drift · 2 could not connect.

### Common failures

| Output | Fix |
|---|---|
| `could not run: Environment variable not found: DATABASE_URL` | You ran it outside the service shell |
| `table … MISSING` | `migrate deploy` did not run, or ran against a different database |
| `enum AuditAction is missing EMAIL_…` | The `20260721190000` / `20260721210000` migration did not apply |
| `campaign_id has delete rule 'c'` | Someone edited the migration to CASCADE. **Do not proceed** — fix it before any campaign exists |

### `email:doctor`

Prints configuration, token round-trip, schema reachability, journey flags and
7-day activity. Secrets appear only as a length + a 6-character hash
fingerprint. Run it on **both** the API and the worker host and compare the
`EMAIL_TOKEN_SECRET` fingerprint.

---

## 7. Browser walkthrough

Sign in as an **OWNER**. Base path `/admin/email-marketing`.

### Scenario 25 first — deny before you trust anything else

1. Sign in as a MANAGER (or temporarily set a test user to MANAGER).
2. Sidebar: **Email Marketing must not appear**.
3. Navigate directly to `/admin/email-marketing` → the "You do not have access"
   card, not the dashboard.
4. In devtools, `fetch('/api/admin/email-marketing').then(r=>r.status)` → **403**.
   Repeat for `/sends`, `/scheduled`, `/suppressions`, `/test-send`,
   `/campaigns`, `/audiences`, `/journey-config`, `/automations` → all **403**.
5. Repeat as CREW → blocked by middleware before the page renders.
6. Return to OWNER.

If any of these returns 200, stop the walkthrough — nothing else matters.

### Overview

* Sidebar shows **Email Marketing** with an orange **BETA** chip and is clickable.
* The page opens with the amber Beta banner.
* Stat cards render. Rates show `—` where there is no denominator, never `0.0%`.
* If `RESEND_WEBHOOK_SECRET` is unset you get the webhook warning banner.
* Provider health block: postal address, App URL, Google review URL, SPF, DKIM,
  DMARC, suppression health.
* **Unfinished suppression side effects must read 0.** Anything else is a red
  banner and a stop.

### Templates (scenario 22 support)

* 23 templates grouped by category; each shows class, wiring, trigger, send count.
* Click one → detail page: identity, allowed booking statuses, required data,
  stop rules, recent activity.
* Nothing from `email-archive/` appears.

### Journeys + configuration (scenario 21)

1. `/admin/email-marketing/journeys` — six journeys with stage timelines and stop rules.
2. Open **Abandoned booking recovery → settings**.
3. Change stage 1 from `0.75` hours to `1` hour. Save.
4. Expected: `Saved as version N`. Banner appears: "1 setting differs from the
   safe defaults". An `EMAIL_JOURNEY_CONFIG_UPDATED` audit row is written.
5. **Version stability:** any send scheduled before the save keeps its
   `journey_config_version`. Confirm in the database:
   `SELECT journey_config_version, created_at FROM email_sends ORDER BY created_at DESC LIMIT 5;`
6. Try to break it: open the **Booking lifecycle** journey and set any stage
   delay above 0 → **refused**, "this email fires the moment its event happens
   and cannot be delayed". That is the receipt-delay guard.
7. Click **Reset to safe defaults** → row deleted, badge returns to "Using safe
   defaults", `EMAIL_JOURNEY_CONFIG_RESET` audited.

### Audiences (scenarios 4, 5)

1. `/admin/email-marketing/audiences`.
2. Segment **Customers whose move is complete** → **Preview audience**.
3. Expected: Matched / Will receive it / Excluded, plus a per-reason exclusion
   table. Suppressed, unsubscribed, hard-bounce, complaint, marketing opt-out and
   duplicate each counted **separately**.
4. Cross-check one number:
   `SELECT COUNT(DISTINCT c.email) FROM bookings b JOIN customers c ON c.id=b.customer_id WHERE b.status IN ('COMPLETED','ARCHIVED') AND b.is_internal_test=false;`
   should equal **Matched**.
5. **Scenario 5:** the address you bounced in §4.4 must appear in the
   *Hard bounce* exclusion count and **not** in *Will receive it*.
6. Save it as `staging-completed-customers`.
7. There is no free-text query box anywhere. That is the design.

### Campaigns (scenarios 3, 19, 20)

1. `/admin/email-marketing/campaigns` → **+ New campaign draft**.
2. Name `Staging smoke`, source key `staging-smoke`, template **Review request**,
   audience `staging-completed-customers`. Create.
3. Expected status **DRAFT**. The available buttons must **not** include ACTIVE
   or SCHEDULED.
4. **Validate** → passes, or names exactly what is unconfigured.
5. Try **Approve** with a failing validation → refused.
6. Fix, re-validate, **Approve** → status **READY**, "Approved by …",
   `EMAIL_CAMPAIGN_APPROVED` audited.
7. **SCHEDULED** → **ACTIVE** → **PAUSED** → **ACTIVE**. Each writes
   `EMAIL_CAMPAIGN_STATE_CHANGED`.
8. **CANCELLED** → a reason is demanded and recorded.
9. Negative test: pick a transactional template (Payment receipt) on a new draft
   → validation **fails** with the transactional message.
10. Remember: no email is dispatched by any of this (section 0).

### Automations

1. `/admin/email-marketing/automations` → **+ New automation**.
2. Name `Staging review ask`, trigger **A completed move with no review
   recorded**, one stage: Review request at 24 hours. Save.
3. Expected: **DRAFT**, version 1.
4. Try **ACTIVE** directly → refused; the path is VALIDATING → TEST → ACTIVE.
5. Walk it to TEST, then ACTIVE.
6. Save an edit while ACTIVE → it **drops to PAUSED** with the note explaining
   why. Version becomes 2.
7. Negative test: a transactional template in a stage → rejected.

### Test send (scenarios 1, 24)

Covered in §4.1. Additionally confirm **scenario 24**: note the campaign
conversion count on the overview, send a test, reload — the number is unchanged.

### Suppressions (scenario 6)

1. `/admin/email-marketing/suppressions`.
2. The bounce and complaint rows show **Not restorable**.
3. **Scenario 6 — unsubscribe:** open the `List-Unsubscribe` URL from a
   promotional test email (or `{APP_URL}/api/email/unsubscribe?token=…`).
   Expected: a clear success page, an `UNSUBSCRIBED` row with
   `scope='promotional'`.
4. Confirm the split: a promotional send to that address is now refused with
   `unsubscribed`; a **transactional** send still goes through. This is the
   single most important behaviour on this page.
5. Restore the unsubscribe with a reason → `EMAIL_SUPPRESSION_RESTORED` audited.
6. Try to restore the complaint → **409** with the domain-damage explanation.

### Send history (scenarios 10, 13)

1. `/admin/email-marketing/sends`. Filter chips work without JavaScript.
2. Every non-delivered row carries an English explanation.
3. **Scenario 13:** cancel a booking that has a queued transactional email, let
   it fire → the row reads `status_not_allowed:CANCELLED` and explains that the
   email would have been untrue.
4. Retry: on a non-delivered row → re-opened, `EMAIL_SEND_RETRIED` audited.
   On a **delivered** row → **409**, refuses to send a second copy.

### Customer timeline (scenario 22)

1. `/admin/customers` → click a customer with several bookings.
2. Expected: KPI row, bookings, leads, and the full email timeline with
   refusals visible beside deliveries.
3. Filter by status / journey / template.
4. As OWNER the address is full; as MANAGER the page is inaccessible during Beta.
5. Revenue and finalized profit appear only for closed-out moves, with the
   caveat line when some completed moves are not finalized.

### Booking ledger

`/admin/jobs/<id>` → the **Email Ledger** card sits below Communications and
shows what was refused, which Communications cannot.

### Deliverability

`/admin/email-marketing/deliverability` — after section 3, SPF/DKIM/DMARC should
read **VERIFIED** with the date. If they still say UNVERIFIED, check
`EMAIL_DNS_VERIFIED_AT`.

---

## 8. Merge plan

### 8.1 Order

1. Stage 4 merges to `main` first.
2. `git fetch origin && git rebase origin/main` on `claude/email-admin-integration`.
3. Resolve (below).
4. Re-run the **combined** validation.
5. Force-push with lease: `git push --force-with-lease`.
6. Merge the PR.

### 8.2 Conflict resolution — keep both, every time

| File | Conflict | Resolution |
|---|---|---|
| `prisma/schema.prisma` | Both append to `AuditAction` | Keep **both** blocks. They are disjoint. |
| `prisma/migrations/` | Both add `ADD VALUE IF NOT EXISTS` | **No conflict** — separate directories, and the statements commute. Either order gives the same enum. |
| `src/lib/permissions.ts` | Both append to `Action` and `OWNER_ONLY` | Keep **both** blocks. Verify afterwards that `EMAIL_BETA_OWNER_ONLY` still contains exactly `email.view`, `email.cancel_scheduled`, `email.send_test`. |
| `package.json` | Both append test files to `test` | **Keep both lists.** Dropping either suite is not an acceptable resolution. Confirm the merged script contains `email-registry`, `email-admin`, `email-admin-features` **and** every Stage 4 suite. |
| `Sidebar.tsx` | Email changed one line | Keep the email version (`href` + `beta: true`). |
| `jobs/[id]/page.tsx` | Email added 2 imports + 1 component; Stage 4 edits financial panels | Keep both. The `<EmailTimeline …>` block sits between Communications and Crew & Labor. |

### 8.3 Post-rebase validation (all must pass)

```bash
npx prisma validate
npx prisma generate
npx tsc --noEmit
npm test
npm run build
npm run preview:emails
```

The test count must be **≥ 1018 plus Stage 4's suites**. A drop means a suite
was lost in the merge.

---

## 9. Merge-ready checklist

Tick only what you have actually observed.

**Code (already true on `bd4e9e7e`)**
- [x] `git diff --check` clean
- [x] `npx prisma validate` valid
- [x] `npx tsc --noEmit` clean
- [x] `npm test` 1018/1018
- [x] `npm run build` green
- [x] `npm run preview:emails` 22/22

**Staging**
- [ ] API + worker host deployed on the same commit
- [ ] Required env vars confirmed present
- [ ] `EMAIL_TOKEN_SECRET` fingerprint matches on both services
- [ ] Journey flags confirmed OFF
- [ ] `npx prisma migrate status` → up to date
- [ ] `npm run email:preflight` → no drift, including the SET NULL check
- [ ] `npm run email:doctor` → no `fail` rows

**DNS**
- [ ] SPF verified in Resend + independent lookup
- [ ] DKIM verified
- [ ] DMARC published at `p=none`
- [ ] `EMAIL_DNS_*` and `EMAIL_DNS_VERIFIED_AT` set; page reads VERIFIED

**Provider**
- [ ] 1 test send delivered, `is_test=true`, overview unchanged
- [ ] Webhook endpoint configured, events subscribed
- [ ] Bounce → HARD_BOUNCE, scope all
- [ ] Complaint → SPAM_COMPLAINT, not restorable
- [ ] Replay → 200, no duplicate
- [ ] Provider failure → `provider_rejected`, retryable

**Redis**
- [ ] `/admin/email-marketing/scheduled` reads the queue (or reports unreadable)
- [ ] Scheduled jobs appear when a journey flag is on
- [ ] Cancel works and audits; running job returns 409
- [ ] Journey flag turned back OFF

**Browser**
- [ ] Scenario 25 (manager + crew denied, all 9 APIs 403)
- [ ] Scenarios 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 19, 20, 21, 22, 24
- [ ] Scenario 23 via preflight FK check + a test send
- [ ] Scenario 17 — **deferred, no dispatcher** (section 0)

**Merge**
- [ ] Stage 4 merged to `main`
- [ ] Rebased; all six shared files resolved keeping both
- [ ] Combined `npm test` ≥ 1018 + Stage 4
- [ ] Force-pushed with lease
- [ ] PR approved

**Only after every box above**
- [ ] Decide whether to build the campaign dispatcher before enabling any
      promotional flag in production
