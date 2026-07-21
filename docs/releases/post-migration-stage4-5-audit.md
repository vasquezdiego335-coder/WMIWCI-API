# Post-migration production audit — Stage 4 / Stage 5 definition

**Audited 2026-07-21 against the live Railway deployment and the production Neon
database.** Read-only inspection first; the code changes listed in §9 were made
only after the defects were confirmed against real rows.

---

## 1. Deployment status

```
CODE AND DATABASE CURRENT
```

| Fact | Value |
| --- | --- |
| Railway project / service | `earnest-solace` → `wonderful-strength` (production, sfo) |
| Railway URL | `https://wonderful-strength-production-a0f1.up.railway.app` |
| Deployed commit | `62e7cbfbdf4d55244bcf6521ea02f5c044fa67f1` (branch `main`, SUCCESS) |
| `origin/main` | `62e7cbfb` — **identical** |
| Local branch / HEAD | `claude/admin-stage3b-reporting-ui-staging` @ `ce60a5a8` (1 docs commit ahead) |
| PR #15 | **Merged** — squashed into `62e7cbfb` |
| Database | Neon `neondb`, `ep-polished-poetry-aq6tbdtp` |
| `npx prisma migrate status` | 33 migrations found · **"Database schema is up to date!"** |
| `/api/health` | `{"status":"ok","db":"connected"}`, 0 missing required env vars |

Railway is deploying `main`, `main` is the merged PR #15, and the schema the
application expects is the schema the database has. **No deployment work is
required.** Vercel projects `wmiwci-core` / `wmiwci-server` were not consulted
and were not touched; `wmiwci-site` was not touched.

---

## 2. The pricing / balance defect (the headline finding)

### The example, resolved

Production booking **WMIC-1015** (CONFIRMED) is exactly the row the owner
described:

| Field | Stored value | Where it comes from |
| --- | --- | --- |
| `baseRate` | `409` (DOLLARS) | `estimate.MOVE_SIZES['half-studio']` |
| `travelFee` | `5000` (CENTS) | service-area rule engine |
| `truckAddonAmount` | `5000` (CENTS) | `estimate.TRUCK_ADDON_DOLLARS`, `truckAddonDueOnMoveDay = true` |
| `totalEstimate` | `459` (DOLLARS) | `estimate.computeEstimate` = base + access add-ons + travel |
| collected | `4900` (CENTS) | the captured $49 deposit |

So `$409 + $50 travel = $459` is **correct** — `estimate.ts` deliberately puts
travel *inside* `estimatedTotal` and leaves the $50 truck add-on *outside* it.
The quote reconciles.

**"Due on move day: $100" does not.** It was
`travelFee + truckAddon + additionalTruckFees + waiting + stair + longCarry +
heavyItem + packing + assembly + disassembly + tax` — a sum of *fee columns*.
The unpaid **base-service balance was never in it**.

```
what the admin displayed:   $100.00
what the customer owes:     $459 quote + $50 truck − $49 deposit = $460.00
understatement:             $360.00
```

**Classification: calculation defect.** Not legacy behaviour, not display-only,
not a data inconsistency — the formula was wrong, and it was wrong on every
booking, not just this one.

### It was worse on the simple case

**WMIC-1014** (CONFIRMED, $699 quote, no travel, no truck, $49 deposit
captured) produced `moveDayDueCents = 0`. The admin told the owner the customer
owed **nothing** on a move with a **$650** unpaid balance.

### Blast radius

`moveDayDueCents()` was the shared helper, so the same understatement reached
four surfaces plus the reminder engine:

| Surface | Symptom |
| --- | --- |
| Job detail → Pricing Breakdown | "Due on move day: $100" |
| Jobs list → "Move-day due" column | $0.00 on most moves |
| Jobs list → `?view=unpaid` filter | moves with unpaid base labor were filtered *out* |
| Dashboard → "Outstanding Balances" KPI | company-wide receivable understated |
| Action Center → `job-balance-unpaid` | wrong amount in the title *and* wrong severity |

And the **customer-facing portal** carried its own variant. `my-booking/[token]`
computed `remaining = estimateTotal − $49`, which omitted the truck add-on (it
sits outside the quote by design), ignored any discount, and ignored every
payment after the deposit. WMIC-1015's customer was shown **$410 remaining on a
$460 balance**.

### Two further money defects found in the same pass

1. **The travel fee was billed twice in the financial closeout.**
   `closeout-service.ts` composed
   `grossCustomerChargesCents = estimateCents + moveDayDueCents(booking)`, but
   `estimateCents` already contains the travel fee. Billed revenue — and the
   receivable derived from it — was over by exactly the travel fee on every
   move with one.

2. **Stored discounts were never applied to any total.** `discountPercent`
   (10% first-time, 30% approved door-hanger) was written at booking and
   approval time, rendered on the pricing card as a bare `"10%"`, and applied
   to **no** monetary figure anywhere in the system. Two CONFIRMED production
   bookings (WMIC-1000, WMIC-1001) carry an unapplied 10%.

### The model that replaced it

One function, `job-money.customerBalance()`, is now the only place a customer
amount owed is derived:

```
quoted            Booking.totalEstimate  (base + access add-ons + travel)
+ additional      charges NOT inside the quote — truck add-on, extra truck
                  fees, waiting fee, itemized stair/carry/heavy/packing/
                  assembly/disassembly/tax.  TRAVEL IS DELIBERATELY ABSENT.
− discount        discountPercent applied to quote + additional
= final billed

final billed
− collected       captured − refunds − lost chargebacks (money-rules)
= outstanding  =  due on move day
```

`outstanding` and `dueOnMoveDay` are the **same number by construction**: Stripe
only ever takes the $49 deposit, so everything still owed is collected in
person. They can no longer drift apart.

Verified by running the shipped function over every live production booking:

```
ref              status      quoted   +addons  −disc    billed   collected outstanding
WMIC-1015        CONFIRMED  $459.00   $50.00    $0.00  $509.00    $49.00     $460.00
WMIC-1014        CONFIRMED  $699.00    $0.00    $0.00  $699.00    $49.00     $650.00
WMIC-1001        CONFIRMED  $699.00    $0.00   $69.90  $629.10     $0.00     $629.10
WMIC-1000        CONFIRMED  $699.00    $0.00   $69.90  $629.10     $0.00     $629.10
cmrf5rpk7…       CONFIRMED  $509.00    $0.00    $0.00  $509.00     $0.00     $509.00
WMIC-1017        CONFIRMED    $0.00    $0.00    $0.00    $0.00     $0.00       $0.00  [no stored quote]
```

`WMIC-1017` has no stored quote at all. Rather than report a confident `$0.00`,
the model sets `quoteMissing` and the page prints *"No stored quote — rebuilt
from base labor + travel; confirm before collecting."*

---

## 3. Booking → Job workflow

### There is no split page

`/admin/jobs/[id]` is keyed on **`Booking.id`**, not `Job.id`
(`prisma.booking.findUnique({ where: { id: params.id } })`). Bookings,
Customers and Jobs all link to the same URL. There is **one** move detail page
and **no** separate booking page — the owner is never sent to the wrong screen,
and financial closeout is not hidden on some other route.

### Where a Job row is created

`prisma.job.upsert({ where: { bookingId } })` fires from four paths — Discord
approval, `booking-approval.ts` (the shared approve service), the admin status
route on `CONFIRMED`, and `labor-service.ensureJobForBooking()` on first crew
assignment. All are idempotent on the unique `bookingId`; duplicates are
impossible at the database level.

### Production reality

```
bookings 55  ·  jobs 2  ·  jobCrew 0  ·  closeouts 0  ·  leads 0
CONFIRMED-or-later bookings: 8  ·  of those, MISSING a Job row: 6
```

Six confirmed bookings predate the upsert paths. **This is not a blocker**: the
detail page reads `booking.job?.…` everywhere and renders fine without one, and
`ensureJobForBooking` creates the row the moment crew is assigned. The visible
cost is cosmetic — the "Crew assigned" / "Move started" timeline rows and the
Job status block stay blank until then. No backfill was run; fabricating job
history for old moves is worse than leaving it honest.

`jobCrew = 0` is the important number: **labor has never been recorded for any
move**, so every profit figure in production is the "incomplete" variety the
Phase 0 warnings were built to disclose. The warnings are working; the data
entry has not happened.

### Where the owner enters each thing

| What | Where |
| --- | --- |
| Customer payments | Move detail → **Payment Information** → *Record payment* |
| Crew assignment, hours, breaks, approval, labor payments | Move detail → **Crew & Labor** |
| Job expenses | Move detail → **Job Expenses**, or `/admin/expenses` |
| Owner-paid / reimbursable money | `/admin/owner-money` |
| Closeout, overhead, reserves, finalize, reopen, distribute | Move detail → **Financial Closeout** |
| Final profit | Same panel — and `/admin/reports/*` across moves |

**The one workflow gap:** the Financial Closeout panel only renders when
`isSettledForMoney(status)`, and `SETTLED_STATUSES = ['IN_PROGRESS',
'COMPLETED']`. A CONFIRMED move shows *no* closeout and *no* completeness badge.
That is defensible (a move that hasn't happened has nothing to close), but it
means the corrected Pricing Breakdown is the **only** balance figure visible
before move day — which is precisely why the $100 was so damaging.

---

## 4. Navigation inventory

Every `soon` label was checked against the filesystem. **All eight are correct** —
none of these routes exists:

| Sidebar item | Route dir | API | Verdict |
| --- | --- | --- | --- |
| Leads | ✗ | `/api/notify/lead` + `Lead` model + `leads.ts` | `soon` **correct** — data layer only, no page |
| Financial Overview | ✗ | — | `soon` **correct** (Reports covers the need) |
| Payroll | ✗ | labor payments live inside a move | `soon` **correct** |
| Email Marketing | ✗ | asset library only | `soon` **correct** |
| Referrals | ✗ | `referral-eligibility.ts` | `soon` **correct** |
| Marketing Sources | ✗ | `/api/admin/marketing/{campaigns,spend}` | `soon` **correct** — API-only write path; **read** is live at `/admin/reports/marketing` |
| Documents | ✗ | — | `soon` **correct** |
| Settings | ✗ | Business config lives in Owner Money | `soon` **correct** |

**The premise that Financial Overview, Leads and Marketing Sources are complete
but mislabelled is false.** No stale `soon` labels exist.

Two genuine navigation defects were found and fixed instead:

- The sidebar still rendered the **retired slogan** "WE MOVE IT. / WE CLEAR IT."
  (the owner retired it 2026-07-17 and the rest of the repo was swept).
- The dashboard banner claimed labor **"cannot be entered in the admin yet"** —
  false since Phase 1 shipped the Crew & Labor panel, and it actively
  discouraged the data entry the profit figures depend on.

All 7 report sub-pages are reachable from `/admin/reports` and permission-gated
(`report.view_financial` is OWNER-only; MANAGER gets operational reports).

---

## 5. Feature inventory

**Fully deployed and usable** — refund handling · expense eligibility ·
missing-labor warnings · safe-to-distribute · provisional-vs-finalized profit ·
crew assignment · hours · breaks · overtime · rate snapshots · labor approval ·
partial + full labor payment · owner economic labor value · revenue
reconciliation · expense review · labor review · truck costs (as expenses) ·
owner reimbursement · overhead · tax reserve · business reserve · owner split ·
finalization · reopening · snapshot history · Financial Overview (as Reports) ·
P&L · move profitability · revenue-vs-profit · estimate variance · marketing
profitability · customer profitability · pricing intelligence · saved views ·
CSV · XLSX (+ PDF) · calendar/schedule · worker availability (API) · audit log ·
lifecycle timeline · action center · roadmap · queues.

**Deployed but never exercised** — every Stage 1–3 table is empty in
production: `jobCrew 0`, `closeouts 0`, `snapshots 0`, `distributions 0`,
`leads 0`, `campaigns 0`, `savedViews 0`. The code paths are tested offline
(909 checks) and against a real database (26 integration checks), but no real
move has been closed out.

**Database + API only, no UI** — Leads (`Lead` model, ingest route, no admin
page) · marketing campaign/spend **write** path (API only).

**Missing entirely** — worker/crew portal (middleware blocks `CREW` from all of
`/admin`; `/admin/staff` is an admin roster, not a portal) · assignment
acknowledgement · dispatch · mobile clock-in · vehicles · equipment · supplies ·
maintenance · documents · incidents · signatures (only a typed agreement
signature exists) · push notifications. **None of these have Prisma models** —
`EQUIPMENT` and `DOCUMENTS` in the schema are *expense categories*, not
entities.

---

## 6. Immediate corrections applied

All flow through one model; no page re-derives money.

| # | Fix | Files |
| --- | --- | --- |
| P0-1 | **`customerBalance()`** — the one balance model (quoted → billed → collected → outstanding). Replaces `moveDayDueCents()`, which is deleted. | `src/lib/job-money.ts` |
| P0-2 | Job detail Pricing Breakdown rebuilt: quoted, add-ons, discount, **final billed**, deposit, collected, refunded, **outstanding balance** + an explicit note that Stripe only holds the deposit. | `app/(admin)/…/jobs/[id]/page.tsx` |
| P0-3 | Jobs list "Move-day due" → **"Outstanding"**; the `?view=unpaid` filter now catches unpaid base labor. | `app/(admin)/…/jobs/page.tsx` |
| P0-4 | Dashboard "Outstanding Balances" KPI reads the model (select widened to carry the quote + payments). | `app/(admin)/…/page.tsx` |
| P0-5 | **Travel-fee double count removed** from closeout billed revenue; the closeout now composes `quoted + additional` and passes the discount into `discountsCents` honestly. | `src/lib/closeout-service.ts` |
| P0-6 | Action Center `job-balance-unpaid` reports the true balance; `RuleBooking.moveDayDueCents` renamed `outstandingBalanceCents`. | `src/lib/reminder-{rules,sync}.ts` |
| P0-7 | Customer portal "Remaining balance" reads the model — truck add-on and discount lines added, later payments respected, no number shown when no quote is stored. | `app/my-booking/[token]/page.tsx` |
| P1-1 | **Discounts now reduce money.** `discountPercent` applies to quote + add-ons everywhere. | `src/lib/job-money.ts` |
| P1-2 | `pricing.ts` contract corrected — `dueOnMoveDayDollars` is the full balance; fee-only figure kept as `moveDayFeesDollars`; unit contract documents that `totalEstimate` already contains travel. | `src/lib/pricing.ts` |
| P1-3 | Missing quote is **disclosed** (`quoteMissing`) instead of silently reported as $0. | `job-money.ts`, job detail page |
| P1-4 | Retired slogan removed from the sidebar. | `Sidebar.tsx` |
| P1-5 | False dashboard claim ("labor cannot be entered yet") replaced with the real instruction. | `app/(admin)/…/page.tsx` |

No migration, no schema change, no production data mutation.

---

## 7. Actual Stage 4

```
OPTION B — FINANCIAL WORKFLOW COMPLETION
```

Not Option A: field operations have **no models at all**, so they are a new
build, not a completion — and the business cannot yet close out a single move,
which outranks dispatch.
Not Option C: the deployment is in sync and the code is mounted.

Everything Stage 4 needs already has a model and a route. What is missing is the
last mile between "the owner can enter data" and "the owner can trust the
answer".

1. **Charge management on a move.** There is no UI to add an approved customer
   charge; the itemized fee columns are only settable through
   `/api/admin/bookings/[id]/details`. Add an itemized-charge editor (add,
   amend, void) writing to those columns with an audit trail.
2. **Credits, write-offs and a real discount action.** `closeout-calc` accepts
   `creditsCents` and `balanceWriteOffCents`; nothing writes either. Discounts
   are set only by the door-hanger flow. Give the owner explicit
   apply-discount / issue-credit / write-off-balance actions.
3. **Extend the balance view before move day.** Show the outstanding balance —
   and a completeness badge — on `CONFIRMED` and `SCHEDULED` moves, not just
   `IN_PROGRESS` / `COMPLETED`.
4. **Close one real move end to end.** Zero `jobCrew` rows and zero closeouts
   mean the entire Phase 1–2 chain is unproven against reality. Assign crew,
   enter hours, approve labor, record move-day cash, log expenses, finalize,
   verify the snapshot, reopen, verify supersede.
5. **Leads admin page.** The model and ingest route exist; the owner cannot see
   a single lead. One list page closes the loop.
6. **Marketing campaign / spend UI.** The write API exists; without a form,
   Profit ROAS can never have data.
7. **Backfill decision on the 6 job-less bookings** — owner's call, not the
   agent's.

Items 1–4 are the release-critical set.

---

## 8. Stage 5 decision

```
STAGE 5 RECOMMENDED AFTER STAGE 4
```

Stage 4 finishes the *financial* admin system, and that is the business-critical
part. But field operations — worker portal, availability, acknowledgement,
dispatch, mobile clock-in, vehicles, equipment, documents, incidents,
notifications — is a genuinely distinct category with **no models, no routes and
no UI**, and it is what turns crew hours from owner-typed into worker-captured.
It is not "development for its own sake"; it is simply not urgent until moves
are being closed out.

Stage 5 = field operations (the old Option A), with customer invoicing and
automatic quote generation as follow-ons.

---

## 9. Tests

```
npx prisma migrate status   → 33 migrations, "Database schema is up to date!"
npx tsc --noEmit            → 0 errors
npm test                    → 912/912 pass, 0 fail, 0 skipped   (was 887 before)
npm run build               → exit 0
```

New: `src/lib/__tests__/customer-balance.test.ts` — **25 checks**, registered in
the real `npm test` script. It pins the reported defect by name (WMIC-1015 owes
$460 and explicitly *not* $100; WMIC-1014 owes $650 and not $0), plus base-labor
only, travel fee, truck add-on selected/unselected, itemized charges, waiting
fee, waived waiting fee, discount on quote, discount on add-ons, deposit,
multiple payments, move-day cash settling to zero, partial refund, full refund,
uncaptured authorization, internal test payments, overcollection clamped at
zero, missing quote disclosed, the closeout composition (no travel double
count), the customer portal's remaining balance (add-on included, later payments
respected, suppressed when no quote exists), and both directions of the
balance-due warning.

Two assertions in `pricing.test.ts` were **updated, not deleted** — they pinned
the old behaviour (`dueOnMoveDayDollars === 50` on a $749 unpaid move;
`=== 0` on a $359 unpaid move). Each now carries a comment naming the defect it
used to protect.

---

## 10. Release readiness

The deployed application is healthy and schema-compatible. The corrections in
§6 are **not yet deployed** — they sit on
`claude/admin-stage3b-reporting-ui-staging`, which is 1 commit ahead of the
merged `main`.

Until they ship, the live admin understates every customer balance by the
unpaid base-service amount. On the current book of business that is **$360 on
WMIC-1015, $650 on WMIC-1014, $509 / $629 / $629 shown as $0** — roughly
**$3,600 of receivable invisible to the owner**.

Verdict:

```
STAGES 0–3 DEPLOYED — IMMEDIATE FINANCIAL FIXES REQUIRED
```
