# Release — quick-quote pricing parity (price book `2026-08-22.2`)

**Status: NOT DEPLOYED.** This document is the order to deploy in, not a record
that anyone did. Nothing in this release has been applied to production.

Branches (both `fix/quick-quote-pricing-parity`):

| Repo | Contains |
|---|---|
| WMIWCI-API | price book, routes, snapshot columns, two migrations, CI |
| WMIWCI-SITE | regenerated mirror, quote page, `?v=8` cache key |

---

## What changes for a customer

| | Before | After |
|---|---|---|
| Studio tiers | offered, priced ($379/$439/$549) | refused; `409 pricing_expired` |
| 1 Bedroom | $550 | $550 |
| 2 Bedrooms | **$879** (base + 15ft truck) | **$779** — the included truck adds $0 |
| 3 Bedrooms | **$1,199** | **$1,049**, flagged for review |
| 4 Bedrooms | **$1,599** | **$1,449**, flagged for review |
| 5 Bedrooms | manual plan | manual plan, with a stated reason |
| Larger truck | applied automatically | only when explicitly chosen, review-gated |
| The figure shown | "your estimate" | "package subtotal", transportation pending |

**2BR/3BR/4BR quotes drop by $100/$150/$150.** That is the correction, not a
side effect: the site has always published the base price and the server was
adding a surcharge for the truck the package already includes.

---

## Order of operations

Each step is independently reversible until the one after it. Do them in
order — the API must be able to refuse retired keys *before* the SITE starts
handing out a new mirror.

### 0 · A restore point you have actually verified

```bash
pg_dump "$DATABASE_URL" --format=custom --file=pre-2026-08-22.2.dump
pg_restore --list pre-2026-08-22.2.dump | head          # proves it is readable
```

A dump you have not listed is not a backup. Note the byte size and the row
count of `leads` so the post-migration check has something to compare against.

### 1 · Apply the migrations, then verify them

Two, both additive and nullable — no backfill, no rewrite, no lock beyond the
catalogue update:

- `20260822120000_quote_price_snapshot` — base / truck / total / included truck
  / mileage status / price-book version
- `20260822130000_quote_review_and_mileage` — mileage cents + billable miles,
  review flag + reasons

```bash
npx prisma migrate deploy
```

Verify before moving on:

```sql
-- all ten columns present
SELECT column_name FROM information_schema.columns
 WHERE table_name = 'leads' AND column_name LIKE 'quote_%'
 ORDER BY column_name;

-- and NO existing lead was touched: every historical row reads NULL
SELECT count(*) AS total,
       count(quote_total_cents) AS with_snapshot   -- expect 0 immediately after
  FROM leads;
```

If `with_snapshot` is anything but 0, stop: something wrote during the
migration and this document's assumptions no longer hold.

### 2 · Deploy the API

The API must go first. From this moment a retired key is refused with
`409 pricing_expired` — which is what protects every browser still holding an
old mirror, including all of them until step 3 propagates.

Smoke it before continuing:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$API/api/leads/quote-capture" \
  -H 'Content-Type: application/json' \
  -d '{"firstName":"A","lastName":"B","phone":"8625550000","email":"a@b.com","moveSize":"little-studio"}'
# expect: 409
```

### 3 · Deploy the SITE

Ships the regenerated mirror and moves every consumer to
`pricing-config.js?v=8`. The new URL is what actually evicts the cached price
book; the file alone would keep being served from cache.

### 4 · Smoke the deployed pair

```bash
# the mirror the browser will really load
curl -s "$SITE/js/pricing-config.js?v=8" | grep -o '"PRICE_BOOK_VERSION": "[^"]*"'
# expect: "PRICE_BOOK_VERSION": "2026-08-22.2"

# every page asks for v=8
for p in quote booking-form pricing services; do
  curl -s "$SITE/$p.html" | grep -o 'pricing-config\.js?v=[0-9]*'
done
```

Then, by hand on the live quote page: pick 2 Bedrooms and confirm it reads
**$779**, labelled a package subtotal, with transportation stated as pending.

### Rollback

- **SITE** — redeploy the previous commit. Safe on its own: the API refuses
  retired keys either way.
- **API** — redeploy the previous commit. The new columns stay; they are
  nullable and nothing older reads them.
- **Migrations** — do NOT roll back. They add nullable columns and remove
  nothing; dropping them would discard snapshots written since step 1.

---

## CI

`.github/workflows/ci.yml` verifies API↔SITE pricing parity by checking out the
SITE branch and running the tests against it. It **fails rather than skips**
when the mirror cannot be verified.

- **Requires a repository secret `SITE_REPO_TOKEN`** — a fine-grained PAT with
  *Contents: read* on WMIWCI-SITE. WMIWCI-SITE is private and WMIWCI-API is
  public, so the default `GITHUB_TOKEN` cannot read it. **Until this secret
  exists, CI fails by design.**
- The fallback branch is pinned to `claude/quick-quote-email-flow`, the branch
  Vercel actually deploys — *not* `master`, which is a different tree.
  **If the deployed branch changes in Vercel, change `PRODUCTION_SITE_BRANCH`
  in the workflow in the same breath**, or CI will verify a tree nobody ships.

---

## Not done, deliberately

- The reported lead `cmt4ia8ot0000sthe46dxfvgg` is untouched. There is no
  automated review flag for leads; flagging it is a manual admin action
  (status → `FOLLOW_UP` with a note).
- No historical lead is recalculated. Retired packages keep their original
  label and amount everywhere history is displayed.
- `mileageStatus: 'calculated'` is supported by the schema
  (`quote_mileage_cents`, `quote_billable_miles`) but nothing writes it yet:
  the quick quote has ZIP codes, and a routed mile needs full addresses. Every
  quote this release produces is `'pending'`.
