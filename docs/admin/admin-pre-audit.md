# Admin Dashboard — Read-Only Pre-Audit

**Repository audited:** `C:/WMIWCI-API` (the Next.js admin + API + workers)
**Branch at audit time:** `claude/prelaunch-audit-phase1`
**Commit:** `287ffc0e4422a1f5f3c7f600171e23dacef9adac`
**Content state:** identical to `main` (0 commits ahead, 0 behind). All three
`admin-operating-system` / `admin-os-increment-2` / `admin-os-increment-2-1-hardening`
branches are already merged into `main`, so this audit describes shipped code, not a branch.
**Uncommitted work present (preserved, not touched):** `src/emails/_ui.tsx`,
`src/lib/i18n.ts`, `src/lib/resend.ts` modified; `email-marketing-html/`,
`email-marketing-html.zip`, `scripts/render-marketing-emails.tsx`,
`scripts/reset-password.ts` untracked. **None are admin-dashboard files.**
**Concurrent-agent check:** no other worktree or branch is touching
`app/(admin)/**`, `src/lib/profit.ts`, `src/lib/job-money.ts`, or
`src/lib/owner-ledger.ts`. Unmerged branches that *would* touch admin files:
`feat/leads-admin-page`, `claude/expense-readability`, `claude/owner-task-system`.

**Method:** read-only. Every claim below was traced through
`database → Prisma model → API route → page → user action → audit log`.
Nothing was modified. No migrations run. The offline unit suite was executed
read-only: **252/252 pass**.

**Date:** 2026-07-20

---

> ## ⚑ STATUS UPDATE — Phase 0 implemented 2026-07-20
>
> Branch `claude/admin-phase0-financial-integrity`. See
> **[phase0-financial-integrity.md](phase0-financial-integrity.md)** for the
> corrected formulas and **[phase1-jobcrew-plan.md](phase1-jobcrew-plan.md)** for
> what comes next.
>
> **Fixed:**
> - RISK 2 / RISK 3 — refund double-penalty, in `profit.ts` **and** on the Revenue page.
>   Refunds now net off revenue using `Payment.refundedAmountCents`; `PARTIALLY_REFUNDED`
>   is recognized everywhere; chargebacks and open disputes are modeled.
> - RISK 4 — expense-status inconsistency. One rule (`money-rules.ELIGIBLE_EXPENSE_WHERE`)
>   now serves the dashboard, Owner Money, the expenses page and job costs.
> - RISK 5 — paid labor now leaves the cash estimate, and reimbursements owed +
>   disputed money are held back. Paying a worker can no longer raise
>   "safe to distribute".
> - RISK 6 — tax reserve is now a percentage of operating profit (labor included), floored at 0.
> - RISK 8 (partial) — the per-job figure is relabelled **gross profit**, with
>   "before company overhead (not yet allocated)" stated on the card.
> - Release blockers 2, 3, 4, 5, 6 and (partially) 9 are cleared.
> - **New:** every profit figure now carries a `FinancialCompleteness` record, and
>   missing labor is stated loudly on the dashboard, jobs list and job detail.
>
> **Still open (unchanged by Phase 0):** RISK 1 (no labor entry path — the
> dominant defect), RISK 7 (Stripe fees remain an estimate), RISK 8 (no overhead
> allocation), RISK 9 (no owner-labor valuation), RISK 10 (mixed money units),
> RISK 11 (no invoice/aging model), RISK 12 (still no route-level tests).
> Release blockers **1** and **8** remain.

---

## 1. Executive result

The admin dashboard is **a genuinely well-built operations tool sitting on top of a
financially incomplete money model.** This is not a mockup problem — the code
quality is high, the money math is centralized in pure tested functions, the
permission matrix is real and server-enforced, and the audit log is wired into
every financial write. The problem is narrower and more serious than "pages are
fake": **the single largest cost in a moving business — labor — has no data-entry
path anywhere in the application.**

`JobCrew` is the schema's designated single source of truth for crew labor
(`docs/financial-architecture.md`, "Option A"). It has hours, clock-in/out,
rates, flat pay, tips, bonuses, deductions, pay status. Every profit formula
reads it. **Nothing in the codebase ever writes it.** There is no
`prisma.jobCrew.create`, no `.update`, no `.upsert`, in any route, worker,
Discord handler, script, or seed. Verified by exhaustive grep: the *only*
reference to `prisma.jobCrew` in the entire application is a read inside the
expense double-count guard.

The consequence for your stated goal is direct. Open the $2,000 move today and
the Profit card would read approximately:

```
Revenue collected      $2,000.00      (only if move-day cash was manually recorded)
− Crew pay                  $0.00      ← always zero; no way to enter it
− Job expenses              $0.00      ← only if someone logged each one by hand
− Stripe fees (est.)       $58.30
= Net profit            $1,941.70      ← wrong by ~$767
```

The true figure you cited is **$1,175**. The dashboard cannot reach it, and worse,
it will confidently display the wrong number with no warning that labor is
missing. That is the headline finding.

Three more defects produce *incorrect* numbers rather than missing ones, and they
are the reason this dashboard should not yet be trusted for a financial decision:

1. **Refunds are double-penalized.** A refunded payment is removed from revenue
   *and* subtracted again as a cost. A partially refunded payment is erased from
   revenue entirely while its full original amount is charged as a cost. A $2,000
   payment with a $200 refund reports **−$2,000 net profit** instead of **+$1,800**.
2. **Estimated business cash never subtracts labor that was actually paid.**
   Paying a worker *increases* "Safe to distribute."
3. **The dashboard's "Expenses This Month" includes REJECTED expenses**, while
   the Owner Money page excludes them. Two pages, two different totals, same data.

### What is working
Booking→approval→capture→job lifecycle; the expense ledger; the owner-money
ledger with real accounting separation; the Action Center rule engine (27
deterministic rules, genuinely impressive); the permission matrix; audit
logging; manual (cash) payment recording; Stripe reconciliation.

### What is missing
Labor entry, overhead allocation, owner-labor economics, move closeout,
estimate-vs-actual, reports/exports, and any mobile usability at all.

### Greatest business value, in order
1. Crew/labor entry UI (unblocks *every* profit number).
2. Fix the three arithmetic defects above.
3. Move closeout workflow (so "no expenses logged" stops reading as "high profit").
4. Overhead allocation + true-economic-profit view (owner labor).
5. Reports + CSV export.

### Verdict on readiness
The foundation is real and worth building on. It is **not** ready to be relied on
for money decisions today. See §17.

---

## 2. Architecture found

| Layer | What is actually there |
| --- | --- |
| **Frontend** | Next.js 14 App Router, React Server Components. `app/(admin)/admin/(dashboard)/*`. **Inline `React.CSSProperties` objects only** — no CSS modules, no Tailwind in the admin (Tailwind is configured but unused here), **zero `@media` queries**. Two style vocabularies coexist: newer pages import a shared `_ui.tsx` / `_labels.ts` kit; older pages (dashboard, payments, customers, bookings, schedule, staff, queues, discounts) hand-roll their own `const h1`, `const td`, etc. |
| **Backend** | Next.js route handlers under `app/api/admin/*` (24 files). No server actions — all mutations are `fetch` from small `'use client'` panels through a shared `_client.ts` helper. |
| **Database** | PostgreSQL on **Neon** (production branch), Prisma ORM. 32 models, 25 enums, 1,275-line schema. 19 migrations, newest `20260715000200_payment_refund_dispute`. Migrations are applied **manually** (`db:migrate:prod`), not on deploy. |
| **Authentication** | JWT (`jose`, HS256) in an httpOnly cookie `moveit_session`, 7-day expiry, issuer/audience pinned. `middleware.ts` gates `/admin/*` and `/api/admin/*` to OWNER+MANAGER, redirects CREW. CSRF via double-submit cookie on all non-GET `/api/*` except Stripe/Discord webhooks. |
| **Authorization** | `src/lib/permissions.ts` — a named-action → allowed-roles matrix (`can()` / `denyReason()`), 40 actions, OWNER-only list of 16. Server-enforced in routes, unit-tested. |
| **APIs** | Admin: bookings (list/detail/status/details/review/offer-reschedule), expenses, owner-money, payments, business-config, discounts, staff, reminders, roadmap, reconciliation, receipts/resend, ops-health, availability, test-booking. Public: bookings, contact, stripe checkout+webhook, discord interactions, customer portal, files/upload, service-area, sms inbound, notify/lead, health. |
| **Jobs & queues** | BullMQ over Redis. Queues: `email`, `sms`, `discord`, `webhook-retry`, `scheduled`. Workers in `src/workers/`, hosted separately on Railway (`worker-host.ts`, Procfile). Admin `/admin/queues` reads raw Redis keys (`bull:<name>:wait` etc.) directly — no Bull Board. |
| **Payments** | Stripe. $49 deposit **authorized** at checkout, **captured** on owner approval. Move-day money (truck add-on, travel fee, waiting fee, itemized fees) is **never** in Stripe — collected in cash and recorded manually. Refund/dispute fields exist on `Payment`; there is **no refund-initiation UI** — refunds arrive via webhook only. `src/lib/reconciliation.ts` compares Stripe ⇄ local. |
| **Files** | Cloudinary, signed upload preset (`moveit_signed`), `POST /api/files/upload`. `File` and `Receipt` models. Stored `receiptUrl` is a **delivery URL rendered directly in an `<a href>`** — see §12. |
| **Email** | Resend + React Email (`src/emails/`), plus an outbox state machine (`src/outbox/`) with idempotency keys. Open tracking via `/api/email/open`. Not admin-facing; the admin only *displays* `Notification` rows. |
| **Reporting** | **None.** No report pages, no CSV/XLSX/PDF export, no charting library. Verified: zero matches for `csv`/`xlsx` across `app/` and `src/`. |
| **Testing** | `node --test` via `tsx`, 28 offline suites, 252 assertions, all pure-function. **No integration tests, no route tests, no DB tests, no E2E.** |

---

## 3. Current navigation audit

Source of truth: `app/(admin)/admin/(dashboard)/Sidebar.tsx`. Items marked `soon`
render as muted non-links (a deliberate, honest choice — they do not 404).

| Group | Item | Route | Real status |
| --- | --- | --- | --- |
| Overview | Dashboard | `/admin` | Live, DB-backed. Missing net profit by design (documented decision). |
| Overview | Action Center | `/admin/action-center` | Live and genuinely strong. 27 rules. |
| Overview | Calendar | `/admin/schedule` | Live, read-only week grid. No drag/drop, no crew assignment. |
| Operations | Jobs | `/admin/jobs` | Live pipeline + per-job money. |
| Operations | Bookings | `/admin/bookings` | Live list, status filter, search, pagination. |
| Operations | Customers | `/admin/customers` | Live list. **No customer detail page**; "Actions" links to their last booking. No financial rollup. |
| Operations | Leads | — | **`soon`.** `Lead` model + ingestion exist; the page lives unmerged on `feat/leads-admin-page`. |
| Operations | Crew | `/admin/staff` | Live list + activate/role toggle. **No pay rate editing, no crew assignment, no hours.** Invite flow is a disabled chip. |
| Money | Financial Overview | — | **`soon`.** Nothing built. |
| Money | Revenue | `/admin/payments` | Live list. Summary cards contain a real arithmetic bug (§8). |
| Money | Expenses | `/admin/expenses` | Live and the most complete money page. |
| Money | Owner Money | `/admin/owner-money` | Live, owner-gated, real accounting separation. Cash estimate has a labor hole (§8). |
| Money | Payroll | — | **`soon`.** This is the P0 gap. |
| Money | Reports | — | **`soon`.** Nothing built, no export anywhere. |
| Growth | Email Marketing | — | **`soon`.** (Assets exist in `email-marketing/`, not admin-wired.) |
| Growth | Discounts | `/admin/discounts` | Live, door-hanger approve/deny. |
| Growth | Referrals | — | **`soon`.** |
| Growth | Marketing Sources | — | **`soon`.** `Lead.source` + `Booking.source`/`foundUs` collect the data; nothing reports on it. |
| System | Ideas & Roadmap | `/admin/roadmap` | Live, board + table, seedable. |
| System | Activity Log | `/admin/logs` | Live, owner-only, filtered, paginated. |
| System | Documents | — | **`soon`.** |
| System | Queues | `/admin/queues` | Live Redis stats. Read-only — cannot retry or drain a failed job. |
| System | Settings | — | **`soon`.** (Business config is buried inside Owner Money.) |

**Two navigation truthfulness issues.** The sidebar brand block still reads
`WE MOVE IT. / WE CLEAR IT.` — the retired slogan (`Sidebar.tsx:107-108`). And
"Revenue" points at `/admin/payments`, which lists *transactions*, not revenue —
mislabeling that matters once you also have expenses and profit.

---

## 4. Fully functional features

Proven end-to-end (DB → API → page → action → DB → audit log):

| Feature | Path traced |
| --- | --- |
| **Admin auth + role gate** | login → JWT cookie → `middleware.ts` → `layout.tsx` redirect → `can()` in routes. CREW cannot reach `/admin`. |
| **Booking approval + deposit capture** | `booking-approval.ts` → Stripe capture → `Payment` row (COMPLETED) → `Job` upsert (SCHEDULED) → `PAYMENT_RECEIVED` audit — all in one transaction. OWNER-only. |
| **Booking decline** | releases the uncaptured hold; OWNER+MANAGER (correctly, since no money moves). |
| **Booking status lifecycle** | `/api/admin/bookings/[id]/status` → `Job` upsert/updateMany → audit. |
| **Operational details editing** | `OperationsPanel` → `/api/admin/bookings/[id]/details` → `BOOKING_DETAILS_UPDATED` audit. |
| **Expense create** | form → `POST /api/admin/expenses` → Zod validation → WORKER_PAY guard → transactional create + `EXPENSE_CREATED` audit. |
| **Expense approve/reject/delete** | `PATCH`/`DELETE /api/admin/expenses/[id]`, delete OWNER-only, finalized amount/category edits require an owner + reason and write `FINANCIAL_ADJUSTMENT` with before→after. |
| **Owner transaction ledger** | create/approve/delete, 5 transaction types, correct accounting separation, rejected rows excluded everywhere. |
| **Manual (cash) payment recording** | `RecordPaymentPanel` → `POST /api/admin/payments` → `Payment` (COMPLETED, no Stripe id → no processor fee) + audit. This is the only way move-day cash enters the ledger. |
| **Waiting-time policy** | four Discord-logged timestamps → `waiting-time.ts` → derived fee, override, waiver → job card. |
| **Action Center** | `reminder-rules.ts` (pure, tested) → `reminder-sync.ts` (advisory-locked, cooldown-gated scan) → `Reminder` rows → page with assign/claim/resolve/snooze/dismiss/restore, dismiss+restore OWNER-only. Fails **open**. |
| **Ideas & Roadmap** | full CRUD, board/table, never hard-deletes. |
| **Activity Log** | OWNER-only, filters by action/date/text, paginated, whitelisted detail rendering (no secret leakage). |
| **Business config** | split %, tax reserve %, emergency reserve — OWNER-only, audited. |
| **Discount approval** | door-hanger pending → approve/deny → audit. |
| **Stripe reconciliation** | `reconciliation.ts` diffs Stripe charges vs local `Payment` rows, flags refund/dispute drift. |

---

## 5. Partial or disconnected features

| Feature | What exists | What is missing / broken |
| --- | --- | --- |
| **Crew & payroll** | Full `JobCrew` model (18 payroll columns), `crewPayOwedCents()` (tested), `CrewPayStatus` enum, 4 `payroll.*` permissions, 3 audit actions (`CREW_ASSIGNED`, `CREW_PAY_UPDATED`, `CREW_PAID`), 4 Action Center rules that read crew data. | **No write path of any kind.** Rows can only appear via raw SQL/Prisma Studio. The permissions, enum, and audit actions are all dead. The `Crew & Payroll` card on the job page never renders. |
| **Job profit** | Centralized, shared by dashboard/list/detail, tested. | Excludes overhead, excludes owner labor, mishandles refunds (§8), and silently reports `$0` labor. |
| **Customers** | List + search + pagination + `isFirstTime`. | No detail page, no lifetime profit, no repeat/referral tracking, no CAC/LTV. Lifetime revenue is computed *inside the job page* for one customer only. |
| **Marketing attribution** | `Lead.source`, `Booking.source`/`foundUs`, ad click-id capture (unmerged on `feat/lead-notify-attribution`). | No leads page, no source reporting, no conversion or ROI math. |
| **Reconciliation** | Working library + API route. | No admin page renders it. Reachable only by calling the endpoint. |
| **Receipts** | `Receipt` model + resend endpoint + Cloudinary. | No documents page; receipts only appear as a link on the job page. |
| **Queues** | Live counts. | No retry/remove/drain; a failed email is visible but not actionable. |
| **Schedule** | Week grid of scheduled bookings. | Read-only. No crew assignment, no conflict detection (the `evaluateCrewOverlaps` rule exists but has no data), no availability editing (`Availability`/`DayBlock` models unused by any UI). |
| **WORKER_PAY double-count guard** | Correctly implemented and tested. | **Currently inert** — `bookingHasCrewLabor()` can never return true, because no crew pay data can exist. It will start working the moment payroll entry ships. |
| **`finalAmount`** | Column exists, read by the Discord card. | **Never written anywhere.** There is no final-invoice workflow. |
| **`User.payRate`** | Column exists, used as the fallback rate. | No UI writes it. The Action Center rule "no pay rate set" will fire for everyone forever. |

---

## 6. Placeholder and "soon" features

| Item | What it needs to become real |
| --- | --- |
| **Payroll** | `JobCrew` create/edit UI, crew assignment on the job page, hours entry, approve → mark-paid workflow, `User.payRate` editing. **The single highest-value build in this document.** |
| **Financial Overview** | Company-level P&L on the definitions already locked in `docs/financial-architecture.md`, plus overhead allocation and period selection. |
| **Reports** | Any report at all + CSV/XLSX export. No export code exists anywhere in the repo. |
| **Leads** | Page exists unmerged on `feat/leads-admin-page`; needs review + merge, then source-profitability reporting. |
| **Marketing Sources** | Join `Lead.source` → `convertedBookingId` → job profit. Data is being collected; the report is not written. |
| **Referrals** | No model, no code. Referral codes exist only in the email system. |
| **Email Marketing** | Templates exist in `email-marketing/`; no admin surface. |
| **Documents** | `File`/`Receipt` models exist; needs a browse/upload/associate page + private access (§12). |
| **Settings** | Currently only the business-config panel inside Owner Money. Needs users/permissions/business profile/defaults. |
| **Invite team member** | Disabled chip. Users are added via `npm run hash-password` + script. |

---

## 7. Missing critical features (P0–P4)

### P0 — financial or data-integrity risk
1. **Crew/labor entry UI.** Without it every profit number in the product is wrong by the largest cost line. *(Large)*
2. **Refund arithmetic fix.** Double-penalty on full refunds; total revenue erasure on partial refunds. *(Small)*
3. **Consistent expense-status filtering** across dashboard / Owner Money / any future report. *(Small)*
4. **Cash estimate must subtract paid labor.** Today paying someone raises distributable cash. *(Small)*
5. **Move closeout / financial finalization.** Nothing distinguishes "this job made $1,175" from "nobody has entered the costs yet." *(Medium)*
6. **Owner labor recording** — cash view and true-economic view. Owners do most of the labor; it is currently invisible. *(Medium)*

### P1 — critical operational need
7. Overhead allocation model + company net profit. *(Medium)*
8. Company Financial Overview page (P&L, period filters). *(Medium)*
9. Hours / time-tracking page with the warning set you specified. *(Medium)*
10. Mobile-usable admin — currently unusable on a phone (§13). *(Medium)*
11. Reports + CSV export. *(Medium)*
12. Estimate-vs-actual per move. *(Medium)*
13. Crew assignment on the job page + schedule. *(Medium)*

### P2 — major improvement
14. Customer detail page with profitability/LTV. 15. Marketing-source profitability.
16. Profit-split calculator with retained-earnings buckets. 17. Documents page + private receipt access.
18. Refund/adjustment workflow in-app. 19. Queue retry actions.
20. Payment-method + `paidBy` structuring (today `paidBy` is free text).
21. Expense subcategories / item titles (built on unmerged `claude/expense-readability`).

### P3 — useful future
22. Pricing calculator driven by historical actuals. 23. Crew performance reporting.
24. Shared-expense splitting across moves. 25. Vehicle cost allocation (per-mile/per-hour).
26. Saved views on the move list. 27. Tax-category tagging on expenses.

### P4 — cosmetic / optional
28. Retire the old slogan in the sidebar. 29. Unify the two styling vocabularies.
30. Rename "Revenue" → "Payments". 31. Replace pagination-renders-every-page-number with a windowed pager.

---

## 8. Financial accuracy risks

These are the calculations that will hand you a wrong number. Each was traced to
a line.

### RISK 1 — Labor cost is structurally always zero (P0)
`src/lib/profit.ts:101` sums `crewPayOwedCents` over `input.crew`.
`src/lib/job-money.ts:82` supplies `b.job?.crew ?? []`. `JobCrew` rows are never
created. **Every job's crew pay is `$0.00`, forever, silently.**
There is no "labor not entered" warning on the Profit card — only a deposit-related
hint (`jobs/[id]/page.tsx:333`). On your $2,000 move this overstates profit by
roughly $767.

### RISK 2 — Refunds are counted twice (P0)
`src/lib/profit.ts:96-107`:
- Revenue = payments with `status === 'COMPLETED'`. A refunded payment's status is
  `REFUNDED` or `PARTIALLY_REFUNDED`, so **it is already excluded from revenue.**
- Costs then add `refundedCents` = the **full `amount`** of those same payments.

| Scenario | Reported net | Correct net | Error |
| --- | ---: | ---: | ---: |
| $2,000 collected, fully refunded | −$2,000 | $0 | −$2,000 |
| $2,000 collected, $200 refunded | −$2,000 | +$1,800 | −$3,800 |

The partial case is the dangerous one: the payment vanishes from revenue *and*
its whole face value becomes a cost. Note `Payment.refundedAmountCents` — the
actual refunded amount, correctly maintained by `payment-events.ts` — **is never
read by the profit math.** `docs/financial-architecture.md:217-223` documents this
behavior as intended; the documentation describes arithmetic that does not
balance. `profit.test.ts:95` pins the wrong behavior.

### RISK 3 — Same defect on the Revenue page (P0)
`app/(admin)/admin/(dashboard)/payments/page.tsx:44-62`: "Net Revenue" =
`COMPLETED total − REFUNDED total`. The refunded amounts were never in the
COMPLETED total. Net Revenue is understated by the full refunded amount.
`PARTIALLY_REFUNDED` appears in **neither** aggregate and is absent from the
status filter chips — a partially refunded $2,000 payment contributes **$0** to
displayed revenue and is hard to even find in the list.

### RISK 4 — Dashboard counts rejected expenses (P0)
`app/(admin)/admin/(dashboard)/page.tsx:37`:
`prisma.expense.aggregate({ where: { incurredOn: { gte: monthStart } } })` — **no
status filter**. Owner Money (`owner-money/page.tsx:35`) uses
`status: { not: 'REJECTED' }`. Same underlying data, two different totals,
depending on which page you open. A rejected $500 expense reduces reported
monthly performance on one screen and not the other.

### RISK 5 — Cash estimate ignores labor entirely (P0)
`src/lib/owner-ledger.ts:52-58`: cash = contributions + revenue − expenses −
withdrawals − distributions − reimbursements. Crew labor is deliberately **not**
an expense row (Option A), and paid `JobCrew` labor is never subtracted here.
Meanwhile `safeToDistributeCents` holds back only **unpaid** crew pay. So the
moment you mark a worker PAID, their pay leaves the reserve, never enters the
cash calculation, and **"Safe to distribute" goes up by exactly the amount you
just paid out.** Today this is masked by labor always being $0; it becomes a
live cash-overstatement bug the same day payroll entry ships.

### RISK 6 — Tax reserve is computed from the wrong base (P1)
`owner-money/page.tsx:59`: `taxReserve = (lifetime revenue − lifetime expenses) × taxPct`.
It uses **all-time** figures with no period boundary, ignores labor, ignores
refunds, and is recomputed on every page load rather than stored as a liability.
It is a rough hint presented with the authority of a number.

### RISK 7 — Stripe fees are an estimate presented as a cost (P2)
`profit.ts:17-18, 38-41` — 2.9% + 30¢ per captured charge. Real fees are never
imported from Stripe payouts. Labeled "(est.)" on the job page, which is honest,
but it flows unlabeled into net profit and margin.

### RISK 8 — No overhead anywhere (P1)
Insurance, software, phone, advertising, licenses are recorded as general
expenses but **never allocated to a job**. "Net profit" on the job page is really
gross profit. The label is wrong.

### RISK 9 — Owner labor is free (P1)
No concept of owner labor value exists. `OwnerTransactionType` has no
`LABOR_PAYMENT`. A move where two owners each worked 8 hours shows the same
profit as one where nobody worked. Your requested cash-view vs true-economic-view
split has no data model behind it.

### RISK 10 — Mixed money units in one model (P2)
`Booking.baseRate` / `totalEstimate` / `finalAmount` are **Float dollars**;
everything else is **integer cents**. `src/lib/pricing.ts:7-10` documents the
contract explicitly (it exists because of a past "$409 vs $4.09" bug) and the
code currently honors it — but it is a permanent trap, and Floats should not hold
money at all.

### RISK 11 — Unpaid balances are treated as owed, never as revenue (correct) but never aged (P2)
`moveDayDueCents()` is a *computed* expectation, not an invoice. There is no
`Invoice` record, no due date, no aging, no partial-collection tracking. If a
customer pays half the move-day balance in cash, you record a payment and the
"due" figure does not change — it is derived from the fee columns, not from
what remains uncollected.

### RISK 12 — Test coverage does not protect the risky paths (P1)
252 tests, all pure functions, and they encode RISK 2 as correct. There are no
tests for any API route, permission enforcement at the HTTP layer, or aggregate
consistency across pages.

---

## 9. Move profitability system — gap analysis

Against your specification in §6–§7 of the request.

### A. Customer revenue
| Required | Status |
| --- | --- |
| Quoted amount / original booking price | ✅ `totalEstimate`, `baseRate` (dollars) |
| Final invoice amount | ⚠️ column `finalAmount` exists, **never written** |
| Deposit / authorization | ✅ `depositAmount`, `depositPaid`, auth-vs-capture correctly modeled |
| Extra hours / extra stops | ❌ no fields |
| Stair / elevator / long-carry / heavy-item fees | ✅ columns exist; ⚠️ no admin UI edits them |
| Truck add-on / travel fee / out-of-state | ✅ / ✅ / ❌ |
| Packing supplies sold | ❌ |
| Tips (from customer) | ❌ **no customer-tip field at all** (`JobCrew.tips` is tips *paid to* crew) |
| Discounts / promo codes | ✅ `discountCode/Type/Percent` + approval |
| Refunds | ⚠️ tracked on `Payment`, **mis-computed** (§8 RISK 2) |
| Chargebacks / disputes | ⚠️ `stripeDisputeId`/`disputeStatus` stored, **not in any profit math** |
| Taxes collected | ⚠️ `taxAmount` column; no retained-vs-remitted distinction |
| Amount paid / balance due | ⚠️ paid ✅; balance is derived from fees, not an invoice |
| Payment method / provider / status / date | ✅ (method only via `metadata` on manual payments) |
| **`Gross − discounts − refunds − taxes = net job revenue` presentation** | ❌ not shown anywhere |

### B. Direct move expenses
18 `ExpenseCategory` values exist. Mapping to your 30+ list:

**Covered:** truck rental, fuel (GAS), tolls, parking, worker pay, crew food,
moving blankets, straps/dollies, moving equipment, supplies, refunds, misc.
**Missing:** truck mileage fee, truck insurance, tickets, contractor labor,
owner labor, overtime, bonuses, tips paid to workers *as an expense*, water/
electrolytes (fold into crew food), plastic wrap, tape, mattress bags, floor
protection, equipment rental, equipment damage, replacement supplies, lodging,
out-of-state travel, storage fees, disposal fees, damage claim, processing fees,
Stripe fees *as an expense row*.

Per-expense fields — required vs present:
✅ amount, category, vendor, date, payment method, paid by, reimbursable, receipt
URL, notes, purpose, related move, status, created by, timestamps.
❌ **title** (the clickable "Rental truck" / "Crew food" label you asked for —
the list shows only the category), **description separate from notes**,
**reimbursement status as its own field** (conflated into `ExpenseStatus`),
**related owner** (only free-text `paidBy`), **related worker**, **tax category**,
**updatedBy**.
*(Note: `claude/expense-readability` — unmerged — adds item titles + subcategories +
a details drawer, and is the closest existing work to this requirement.)*

### C. Labor cost
The `JobCrew` model already covers: worker, crew leader flag, scheduled hours,
actual hours, clock-in, clock-out, break minutes, pay rate, flat pay, tips, bonus,
deductions, pay method, pay status, paid-at, notes. **This is a good model.**
Missing fields: role, travel hours, overtime hours (no OT rule anywhere),
reimbursement, worker-type (employee / contractor / temp / driver).
**Missing entirely: any way to create or edit a row.** Cash view vs true-economic
view: not modeled.

### D. Truck and vehicle costs
✅ `truckProvider`, `truckSize`, reservation number/status, pickup time/location,
return responsibility/address, driver name/phone/license, fuel policy,
`additionalTruckFees`, `truckAddonAmount`.
❌ mileage, rental duration, base-vs-per-mile split, fuel used/cost as structured
fields, insurance, damage, cleaning, late fee, additional-driver fee.
❌ **No company-owned-vehicle model at all** — no vehicle table, no maintenance,
depreciation, registration, loan, tires, repairs, and no allocation method
(direct / per-mile / per-hour / monthly / manual).
⚠️ "Customer provided → company truck cost $0" is *implied* by `truckProvider`
but never stated explicitly; the job page shows `'Customer-provided'` as a
fallback string, not a recorded fact.

### E. Profit calculations
| Required | Status |
| --- | --- |
| Net job revenue (with the subtraction chain shown) | ⚠️ computed as collected-only; chain not displayed |
| Direct job cost | ⚠️ labor always $0; no fuel/toll structure beyond generic expenses |
| Company gross profit | ⚠️ `netProfitCents` is really gross profit, mislabeled |
| Allocated overhead | ❌ |
| Company net profit | ❌ |
| True economic profit | ❌ |
| Owner distributable profit | ⚠️ only company-wide on Owner Money, not per move; reserves are tax + emergency only (no truck/equipment/licensing/growth funds) |
| Profit margin | ✅ per job |
| Profit per total move hour / crew hour / owner hour | ❌ |
| Revenue per crew hour / labor cost per hour / profit per mile | ❌ |
| **Formulas centralized and tested** | ✅ genuinely — `profit.ts` + `owner-ledger.ts` are pure and shared. This is the best part of the system and the right foundation. |

### F. Owner money
✅ Contribution, withdrawal, reimbursement, distribution, personal purchase — with
correct guardrails (contributions ≠ revenue, distributions ≠ expenses, rejected
rows ignored, personal purchase doesn't move cash until reimbursed).
✅ Per-owner contributed / withdrawn / reimbursement-owed rollup.
✅ Ownership split %, tax reserve %, emergency reserve in `BusinessConfig`.
❌ Owner labor payment type; hours worked; labor value; labor actually paid;
owner→company loan and repayment; **% ownership is only a split %, not modeled
as ownership**; YTD withdrawals / distributions / labor earnings; "amount owner
owes company".
❌ Profit-split calculator (equal / percentage / labor-first / custom with reason
+ approval + audit). Only a single flat `safe × split%` line exists
(`owner-money/page.tsx:110`).
❌ Retained-earnings buckets (truck fund, equipment fund, licensing, growth).

### G. Move financial breakdown page
Existing job page has: Overview, Customer, Addresses, Move info, Truck, Notes,
Internal ops, Pricing, Profit, Expenses, Payments, Waiting time, Photos,
Communications, Crew (never renders), Timeline, Audit log. **It is a long single
scroll, not tabs.**
❌ Hours tab, Equipment tab, Documents tab, waterfall visualization, collected-vs-
outstanding split, overhead line, true-economic-profit line, owner-distribution
line, retained/tax-reserve lines. Negative profit *is* shown in red (good).

### H. Move list
Present: customer, date, status, from→to city, crew names, quoted, collected,
move-day due, recorded profit, warning badges, stage pills, 5 quick views.
❌ Missing columns: move ID, service type, number of stops, crew size, scheduled
vs actual hours, outstanding balance as its own column, direct cost, margin,
truck source, payment status, profitability status, crew leader, marketing
source, review status.
❌ Missing filters: date range, service, customer, crew member/leader, truck
source, payment status, profitable/break-even/loss, marketing source, city,
state, repeat customer, review received, referral generated.
❌ **No sorting at all.** ❌ **No saved views.** ⚠️ `take: 200` with no pagination;
two views (`attention`, `unpaid`) filter *after* that cap, so they can silently
miss records.

### I. Hours page, estimate-vs-actual, pricing calculator, closeout workflow, customer profitability, marketing profitability, crew performance, reports, documents
**None exist.** `src/lib/estimate.ts` is a customer-facing quote calculator with
fixed price tables — it is not a cost-based internal pricing tool and has no
notion of labor cost, target margin, or break-even price.

### J. Validation & data integrity
✅ Zod on every admin write; positive-integer amounts with a $100k cap; date
validation; booking existence checks; finalized-record adjustment workflow;
WORKER_PAY double-count block; transactional write+audit.
❌ Of your 17 required safeguards, these have **no** enforcement: negative hours,
invalid clock ranges, duplicate expenses, duplicate payments, refund > payment,
distribution > available profit, reimbursement without an expense, finalized move
with unpaid balance, finalized move missing hours, missing worker rate (detected
by a reminder, not blocked), move revenue < refunds, ownership split ≠ 100%
(`diegoSplitPercent` + `sebastianSplitPercent` are **not constrained to sum to
100** — verified, no check in schema or route), deleting a financialized record.
❌ **Almost no DB-level constraints**: no `CHECK` constraints anywhere, no
non-negative guards, no partial unique indexes. All validation is application-layer.

---

## 10. Database changes required

**No migrations were run. This is a proposal.**

### New models
```
CrewTimeEntry (or extend JobCrew)   role, workerType, travelHours, overtimeHours,
                                    reimbursement, adjustedBy, adjustmentReason,
                                    previousValue/newValue on edit
Vehicle                             name, type (OWNED|RENTAL|CUSTOMER|TRAILER),
                                    plate, active
VehicleCost                         vehicleId, category, amount, incurredOn,
                                    allocationMethod, receiptUrl
JobVehicle                          bookingId, vehicleId, source, mileage,
                                    rentalDurationHours, baseRentalCents,
                                    perMileCents, fuelCents, insuranceCents,
                                    tollsCents, parkingCents, damageCents,
                                    cleaningCents, lateFeeCents
OverheadPool                        period, category, amountCents,
                                    allocationMethod (PCT_REVENUE | PER_MOVE |
                                    PER_LABOR_HOUR | MANUAL)
OverheadAllocation                  bookingId, overheadPoolId, amountCents, basis
MoveCloseout                        bookingId (unique), status, checklist JSON,
                                    finalizedById, finalizedAt, reopenedById,
                                    reopenedAt, reopenReason
ProfitSnapshot                      bookingId, computedAt, every line item in
                                    cents, formulaVersion  ← immutable record so
                                    a finalized move's profit cannot drift when
                                    a formula changes
DistributionDecision                bookingId?, periodStart/End, method,
                                    retainedBuckets JSON, perOwner JSON,
                                    approvedById, reason
RetainedEarningsBucket              name, targetCents, currentCents
Invoice + InvoiceLine               so "balance due" is a record, not a derivation
CustomerTip                         or a Booking.customerTipCents column
ExpenseAllocation                   expenseId, bookingId, amountCents, basis
                                    (for shared expenses across moves)
```

### Field additions
```
Booking          finalAmountCents Int?      (retire the Float finalAmount)
                 customerTipCents Int?
                 numberOfStops Int?
                 outOfStateFee Int?
                 suppliesSoldCents Int?
                 taxRetained Boolean?
                 estimatedCrewSize Int?
                 actualCrewHours Float?     (denormalized for list/sort)
Expense          title String                ← the clickable label you asked for
                 subcategory String?
                 description String?
                 reimbursementStatus enum
                 ownerId TaskOwner?
                 workerId String?
                 taxCategory String?
                 updatedById String?
                 isShared Boolean
JobCrew          role, workerType, travelHours, overtimeHours, reimbursement
User             workerType, defaultFlatRate, overtimeMultiplier
OwnerTransaction add LABOR_PAYMENT + LOAN_TO_COMPANY + LOAN_REPAYMENT to
                 OwnerTransactionType; ownershipPercent on BusinessConfig
BusinessConfig   ownerLaborRateCents (for true-economic profit),
                 targetMarginPct, reserve bucket configuration
Payment          use refundedAmountCents in profit math (no schema change —
                 a code fix, listed here because it is the fix for RISK 2)
```

### Constraints and indexes
```
CHECK (amount >= 0)                       expenses, owner_transactions, payments
CHECK (clock_out > clock_in)              job_crew
CHECK (actual_hours >= 0 AND actual_hours <= 24)   job_crew
CHECK (diego_split_percent + sebastian_split_percent = 100)   business_config
CHECK (refunded_amount_cents <= amount)   payments
UNIQUE (booking_id)                       move_closeout, profit_snapshot(latest)
INDEX (booking_id, incurred_on)           expenses
INDEX (status, scheduled_start)           bookings   ← the Jobs list scan
INDEX (job_id, user_id)                   job_crew (exists)
```

### Enum additions
`ExpenseCategory`: `TRUCK_MILEAGE`, `TRUCK_INSURANCE`, `TICKETS`,
`CONTRACTOR_LABOR`, `OWNER_LABOR`, `OVERTIME`, `BONUSES`, `WORKER_TIPS`,
`PACKING_MATERIALS`, `FLOOR_PROTECTION`, `EQUIPMENT_RENTAL`, `EQUIPMENT_DAMAGE`,
`LODGING`, `TRAVEL`, `STORAGE`, `DISPOSAL`, `DAMAGE_CLAIM`, `PROCESSING_FEES`.
*(Careful: `WORKER_PAY` must be preserved — `worker-pay-guard.ts` keys off it.)*

---

## 11. Admin page changes required

**New pages:** `/admin/payroll` (hours + pay approval), `/admin/hours`
(all labor across moves), `/admin/financial-overview` (company P&L),
`/admin/reports`, `/admin/leads` (merge existing branch),
`/admin/customers/[id]`, `/admin/marketing`, `/admin/documents`,
`/admin/settings`, `/admin/pricing-calculator`.

**Job page → convert the single scroll into tabs:** Overview · Customer ·
Schedule · Crew · Hours · Revenue · Expenses · **Profit** · Payments · Equipment ·
Documents · Communication · Activity.

**New components:** profit waterfall; estimate-vs-actual variance table; closeout
checklist with status chips; crew assignment picker; hours entry row with
clock-in/out; expense detail drawer (title → receipt/notes/payment/move);
profit-split calculator with per-step display; overhead allocation editor;
mobile quick-action bar (add expense / upload receipt / clock in / clock out /
add toll / add fuel / add tip / mark paid / complete move / start closeout).

**Move list:** the columns, filters, sorting, and saved views from §9-H, plus
real pagination replacing `take: 200`.

**Reports:** move profitability, P&L, revenue, expenses, labor hours, labor
payments, owner money, reimbursements, distributions, outstanding balances,
estimate-vs-actual, marketing source, customer LTV, crew performance, tax
categories, monthly summary, YTD — each honoring active filters, each exportable.

---

## 12. Permissions and security risks

**Strong:** the `can()` matrix is real, server-enforced, and unit-tested; owner-only
actions are correctly scoped (company profit, owner ledger, distributions,
finalized edits, worker-pay override, business config, audit view, booking
approval/capture); Owner Money renders a non-leaky refusal for managers rather
than hiding a rendered ledger; CSRF is enforced; the Activity Log whitelists
detail fields so secrets never render; both current users are OWNER, so today's
exposure surface is small.

**Risks found:**

1. **Job profit is visible to MANAGER (P2).** `money.view_job_profit` is not
   owner-only, and `jobs/[id]/page.tsx:66` calls `await getSession()` and
   **discards the result** — no `can()` check on the page at all. Per-job net
   profit, crew pay totals, and margin render for any admin session. Your spec
   says profit is a sensitive field.
2. **Crew pay amounts render without a permission check (P2).** Same page, the
   Crew & Payroll card. When payroll ships, every manager sees every worker's pay.
3. **No ACCOUNTANT, CREW-LEADER, or READ-ONLY role (P1).** `UserRole` has only
   OWNER / MANAGER / CREW, and CREW is blocked from `/admin` entirely. Your
   requested six-role model cannot be expressed.
4. **Workers cannot submit their own hours (P1)** — a direct consequence of #3
   plus the missing payroll UI. Any future crew-facing submission path needs
   "worker can edit only their own hours" enforcement, which has no precedent
   in the codebase yet.
5. **Receipt/document URLs are effectively public (P2).** `cloudinary.ts` has a
   `signedAccessUrl` helper (1-hour expiry), but expenses, owner transactions,
   and job files all store and render a plain `receiptUrl` in
   `<a href=...>` / `<img src=...>`. Anyone with the URL — no session — can fetch
   a receipt or move photo. Unguessable, but not private. Your spec explicitly
   requires private documents.
6. **Access codes render to any admin (P3).** `originAccessCode` / `destAccessCode`
   are gate/lockbox codes; the schema comments call them SENSITIVE and the
   Discord path is owner-gated, but `AddressCard` renders them to OWNER **and**
   MANAGER with no `can()` check.
7. **`revalidate` on session-dependent pages (P3).** Dashboard/customers/schedule
   set `revalidate = 30|60`. `getSession()` reads cookies, which forces dynamic
   rendering, so no cross-user cache leak occurs today — but it is a
   footgun one refactor away from serving one admin's page to another.
8. **No rate limiting on admin mutation routes (P3).** `rate-limit.ts` covers
   login/bookings/contact/notify only.
9. **No IP/session context in the audit log (P3).** `AuditLog` stores user,
   action, record, details — your spec asks for IP/session on financial edits.

---

## 13. Mobile usability result

**The admin is unusable during an active move.** This is a factual finding, not
an aesthetic one.

- `layout.tsx:24-26`: sidebar is `position: fixed; width: 230px`, main content is
  `marginLeft: 230px; padding: 32px`. On a 375px-wide phone the content column is
  **375 − 230 − 64 = 81px wide.** On a 390px iPhone, 96px.
- **Zero `@media` queries exist in the entire admin** (verified across all 34
  files). No breakpoints, no responsive grid fallbacks, no mobile nav, no
  hamburger, no sidebar collapse-on-small-screen.
- The job detail page uses a hard `gridTemplateColumns: '1fr 1fr'` two-column
  grid that never collapses.
- Tables use `tableStyles.scroll` for horizontal overflow on newer pages; the
  older pages (dashboard, payments, customers, bookings) have no scroll wrapper
  at all and will overflow the viewport.
- No quick-action affordances of any kind: no "add fuel," no "add toll," no
  clock-in/out, no camera-first receipt capture.

Practical effect: Diego standing at a truck cannot record a $60 fuel stop. Every
expense must be entered later at a desk — which is exactly the failure mode that
produces the missing-cost problem this project is meant to solve.

---

## 14. Recommended implementation phases

Ordered so nothing is built on a number that is still wrong.

**Phase 0 — Correctness first (before any new feature).**
Fix RISK 2/3 (refunds, using `refundedAmountCents`), RISK 4 (expense status
filter), RISK 5 (paid labor in the cash estimate). Rewrite `profit.test.ts` to
assert the corrected arithmetic. Add cross-page aggregate-consistency tests.
Rename the job-page "Net profit" to "Gross profit" until overhead exists.
*Small. Highest value per hour of work in this entire document.*

**Phase 1 — Financial foundation.**
Crew assignment + hours entry + pay approval UI (`JobCrew` write path).
`User.payRate` editing. Owner-labor recording with cash vs true-economic views.
`ProfitSnapshot`. DB `CHECK` constraints. Tests for every formula and every
new route.

**Phase 2 — Move profitability interface.**
Job page → tabs. Profit tab with the full waterfall and both profit views.
Hours tab. Expenses tab with titles + detail drawer. Estimate-vs-actual.
Closeout workflow with the checklist and statuses you specified, owner-only
finalize/reopen. Missing-data warnings that make "$0 labor" impossible to
mistake for "profitable."

**Phase 3 — Company dashboard.**
Overhead pools + allocation. Financial Overview / P&L. Net profit, true economic
profit, margin, cash, AR, unreimbursed owner expenses. Period filters.
Reports + CSV/XLSX export. Profit-split calculator with retained-earnings buckets.

**Phase 4 — Operational expansion.**
Mobile-first pass (this could move earlier if field entry is blocking you).
Advanced move list. Action Center financial rules. Leads merge + marketing-source
profitability. Customer detail + LTV. Documents with private access. New roles
(ACCOUNTANT / CREW_LEADER / READ_ONLY) + crew self-service hours.

**Phase 5 — Optimization.**
Cost-based pricing calculator from historical actuals. Crew performance.
Automatic overhead allocation. Forecasting. Alerts.

---

## 15. Estimated complexity

| Work | Complexity |
| --- | --- |
| Phase 0 arithmetic fixes | **Small** |
| Crew/payroll entry UI + owner labor | **Large** |
| Move closeout workflow | **Medium** |
| Overhead allocation + company P&L | **Large** |
| Job page → tabs + profit waterfall | **Medium** |
| Estimate vs actual | **Medium** |
| Move list (columns/filters/sort/saved views/pagination) | **Medium** |
| Hours page | **Medium** |
| Reports + export infrastructure | **Large** |
| Mobile responsive pass | **Medium** |
| Role expansion + crew self-service | **Large** |
| Vehicle cost model | **Medium** |
| Profit-split calculator + retained earnings | **Medium** |
| Documents + private file access | **Medium** |
| Pricing calculator from historicals | **Large** |
| Customer + marketing profitability | **Medium** |
| **Whole program** | **Very large** |

---

## 16. Quick wins

Each is small, independent, and needs no restructuring:

1. Fix the refund double-count in `profit.ts` (use `refundedAmountCents`).
2. Fix "Net Revenue" on the payments page; add `PARTIALLY_REFUNDED` to the filter chips.
3. Add `status: { not: 'REJECTED' }` to the dashboard expense aggregate.
4. Add a red "⚠ No crew hours recorded — labor cost missing" banner on the Profit
   card whenever a COMPLETED job has no crew rows. **This alone stops the
   dashboard from lying**, even before payroll entry exists.
5. Rename job-page "Net profit" → "Gross profit (before overhead)".
6. Rename sidebar "Revenue" → "Payments".
7. Fix the retired slogan in `Sidebar.tsx:107-108` → "Move It Clear It."
8. Add a `can(role, 'money.view_job_profit')` check to the job page and gate the
   profit + crew cards on it.
9. Gate `originAccessCode` / `destAccessCode` rendering to OWNER.
10. Add `@media (max-width: 900px)` to collapse the sidebar and the job-page
    two-column grid — a genuinely small change with a large usability payoff.
11. Add `overflow-x: auto` wrappers to the four legacy tables.
12. Surface `/api/admin/reconciliation` on a page (the library already works).
13. Add a `CHECK` that the two owner split percentages sum to 100.
14. Merge `feat/leads-admin-page` after review — it removes a "soon" for free.

---

## 17. Release blockers

Do not rely on this dashboard's financial output until all of these are true:

1. **Crew labor can be entered and appears in job profit.** Until then every
   profit figure is overstated by the largest cost in the business.
2. **Refund arithmetic is corrected and re-tested.** Currently produces
   catastrophically wrong numbers on any refunded or partially refunded move.
3. **Expense-status filtering is consistent across every aggregate.**
4. **The cash estimate accounts for paid labor** before payroll entry ships,
   or "Safe to distribute" will start overstating cash.
5. **Any job whose costs are incomplete is visibly flagged**, so a `$0` cost
   never reads as profit. (Quick win #4 satisfies this on day one; the closeout
   workflow satisfies it properly.)
6. **"Net profit" is not called net profit until overhead is allocated.**
7. **Owner labor is at least visible**, in whichever of the two views you choose
   to trust — otherwise moves where the owners did the work look better than
   they were.
8. **Financial pages have permission checks matching the sensitivity rules**
   (profit, crew pay, distributions).
9. **At least one integration test proves a real job's profit end-to-end** —
   today 252 pure-function tests pass while the product-level number is wrong.

---

## 18. Final verdict

**ADMIN AUDIT COMPLETE — IMPLEMENTATION NOT READY**

The architecture, permission model, audit logging, and centralized money math are
a legitimately good foundation — better than most systems at this stage, and the
existing `docs/financial-architecture.md` shows the accounting decisions were
made deliberately rather than accidentally. But the money model has a hole where
labor should be, and three live arithmetic defects. Phase 0 (small) plus Phase 1
(large) turn this from "not ready" into a system that can actually answer your
eight questions. Until then, the dashboard should be treated as an operations
tool, not a financial one.

---

### Appendix — the eight questions, answerable today?

| Question | Today |
| --- | --- |
| 1. What did the customer pay? | ✅ if move-day cash was manually recorded |
| 2. What did the move cost? | ❌ labor always $0; no overhead |
| 3. How many hours did everyone work? | ❌ no entry path |
| 4. How much profit did the company make? | ❌ overstated; wrong on any refund |
| 5. How much did each owner earn? | ❌ no owner labor, no per-move split |
| 6. How much stayed in the business? | ⚠️ company-wide estimate only, labor-blind |
| 7. Was the move worth accepting? | ❌ |
| 8. What should be quoted differently? | ❌ no estimate-vs-actual |
