# Release — quick-quote pricing parity (price book `2026-08-22.3`)

**Status: NOT DEPLOYED.** This is the order to deploy in, not a record that
anyone did. No migration has been applied and no branch merged.

Branches (both `fix/quick-quote-pricing-parity`):

| Repo | Contains |
|---|---|
| WMIWCI-API | price book, routes, snapshot columns, two migrations, CI |
| WMIWCI-SITE | regenerated mirror, quote page, `?v=9` cache key |

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
| 3BR/4BR wording | looked like a flat rate | "subject to review", with the reason |

**2BR/3BR/4BR quotes drop by $100/$150/$150.** That is the correction, not a
side effect: the site has always published the base price and the server was
adding a surcharge for the truck the package already includes.

---

## Environment flags — verify BEFORE and AFTER deploying

`QUOTE_LEAD_CAPTURE_ENABLED` used to short-circuit the whole handler, so with
the flag unset — its default — a retired Studio got a bare `200` and the page
revealed the stale price. **The flag now gates PERSISTENCE ONLY.** Retired
pricing is refused in every state of it.

| Variable | Value | What it does now |
|---|---|---|
| `QUOTE_LEAD_CAPTURE_ENABLED` | `true` to store quick-quote leads | Off/unset ⇒ the quote is still PRICED and a retired package is still refused; nothing is written and the response says `captured:false, reason:'feature_disabled'` |
| `PARTIAL_BOOKING_EMAIL_CAPTURE_ENABLED` | `true` to store booking-form step-1 leads | Off/unset ⇒ that route writes nothing |

Verify on the deployed API, in **both** directions:

```bash
# 1. A retired package is refused whatever the flag says.
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$API/api/leads/quote-capture" \
  -H 'Content-Type: application/json' \
  -d '{"firstName":"A","lastName":"B","phone":"8625550000","email":"a@b.com","moveSize":"little-studio"}'
# expect: 409   (NOT 200 — a 200 here means the flag is gating pricing again)

# 2. Capture is actually on, if you intend it to be.
curl -s -X POST "$API/api/leads/quote-capture" -H 'Content-Type: application/json' \
  -d '{"firstName":"A","lastName":"B","phone":"8625550000","email":"a@b.com","moveSize":"1br"}' \
  | grep -o '"captured":[a-z]*'
# expect: "captured":true   ("captured":false means QUOTE_LEAD_CAPTURE_ENABLED is not 'true'
#                            — the price is still correct, the lead is simply not stored)
```

---

## Order of operations

Each step is independently reversible until the one after it. The API must be
able to refuse retired keys *before* the SITE starts handing out a new mirror.

### 0 · A restore point you have actually verified

```bash
pg_dump "$DATABASE_URL" --format=custom --file=pre-2026-08-22.3.dump
pg_restore --list pre-2026-08-22.3.dump | head          # proves it is readable
```

A dump you have not listed is not a backup. Note its byte size and the row
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

### 2 · Deploy the API, with the flags verified

The API goes first. From this moment a retired key is refused with
`409 pricing_expired` — which is what protects every browser still holding an
old mirror, which is all of them until step 4. **Run both flag checks above.**

### 3 · Retired-package API smoke, BEFORE the SITE moves

```bash
for body in \
  '{"moveSize":"little-studio"}' \
  '{"moveSize":"little-studio","priceBookVersion":null}' \
  '{"moveSize":"half-studio"}' ; do
  curl -s -X POST "$API/api/leads/quote-capture" -H 'Content-Type: application/json' \
    -d "$(node -e 'const e=JSON.parse(process.argv[1]);console.log(JSON.stringify({firstName:"A",lastName:"B",phone:"8625550000",email:"a@b.com",...e}))' "$body")"
  echo
done
# expect every line: {"ok":false,...,"error":"pricing_expired","priceBookVersion":"2026-08-22.3"}
# and NO occurrence of 379, 439, 549 or 649 anywhere in the output.
```

### 4 · Deploy the SITE — the branch Vercel actually serves

**Deploy `fix/quick-quote-pricing-parity` into whatever branch Vercel builds.**
Verified 2026-08-22 by fetching production and byte-comparing:

```
live https://www.moveitclearit.com/quote.html          sha256 18280974ba106413…
     == origin/claude/quick-quote-email-flow           sha256 18280974ba106413…
     != origin/master                                  (no public/quote.html at all)

live https://www.moveitclearit.com/js/pricing-config.js sha256 8a6dd7baabaa8318…
     == origin/claude/quick-quote-email-flow            sha256 8a6dd7baabaa8318…
```

The live page currently requests `pricing-config.js?v=6` and the live mirror
carries **no `PRICE_BOOK_VERSION` and zero `legacy` flags** — i.e. production is
still serving the pre-fix price book in which the studios are sellable.

Note: `fix/retire-truck-addon` and `fix/brand-palette` hold byte-identical
copies of both files, so the hashes cannot single out one of those three by
themselves. What they DO establish conclusively is that **`master` is not the
deployed tree.**

### 5 · Cache, pricing, review, notification and page smoke

```bash
# the mirror the browser will really load
curl -s "$SITE/js/pricing-config.js?v=9" | grep -o '"PRICE_BOOK_VERSION": "[^"]*"'
# expect: "PRICE_BOOK_VERSION": "2026-08-22.3"

# EVERY page moved together — no page may still ask for an older token
grep -rho 'pricing-config\.js?v=[0-9]*' public/ | sort | uniq -c
# expect: one line, ?v=9
```

By hand on the live quote page:

- **2 Bedrooms** reads **$779**, labelled a package subtotal, transportation
  stated as pending at $3 per routed mile.
- **3 Bedrooms** reads **$1,049** and says **subject to review**, with the
  inventory/access/truck-plan reason.
- Submitting a retired Studio (via a cached bundle, or by hand) reveals **no**
  price and fires **no** conversion.
- The owner's Discord card for a new 3BR lead shows the subtotal caption, the
  pending-transportation line, and the manual-review reasons.

### Rollback

- **SITE** — redeploy the previous commit. Safe on its own: the API refuses
  retired keys either way.
- **API** — redeploy the previous commit. The new columns stay; they are
  nullable and nothing older reads them.
- **Migrations** — do NOT roll back. They add nullable columns and remove
  nothing; dropping them would discard snapshots written since step 1.

---

## CI — two jobs, and the secret one of them needs

`.github/workflows/ci.yml` runs TWO jobs. Both must be green on the exact
commit being released:

| Job | Needs the SITE? | What its failure tells you |
|---|---|---|
| `verify` — "typecheck · lint · tests · build" | no | this repo does not compile, lint, test or build |
| `pricing-parity` | yes | the cross-repository gate could not be verified |

They are separate because the previous version put the SITE checkout at step 2
of a SINGLE job: when the token was missing the run died there, and typecheck,
lint, tests and build never ran. A red run then carried no information about
whether the code even compiled. Run `32605306351` is exactly that failure.

### Configure the token — required, once, by a repo admin

WMIWCI-SITE is PRIVATE and WMIWCI-API is PUBLIC, so the workflow's built-in
`GITHUB_TOKEN` cannot read it. Create a **fine-grained, READ-ONLY** PAT:

- Repository access: **only** `vasquezdiego335-coder/WMIWCI-SITE`
- Permissions: **Contents = Read**. Nothing else.
- Expiry: set one and diarise the renewal. An expired token fails the parity
  job exactly like a missing one, which is the correct behaviour.

Then store it and re-run:

    gh secret set SITE_REPO_TOKEN --repo vasquezdiego335-coder/WMIWCI-API
    gh secret list --repo vasquezdiego335-coder/WMIWCI-API
    gh run list --repo vasquezdiego335-coder/WMIWCI-API \
      --branch fix/quick-quote-pricing-parity --limit 1

**A secret that exists but is empty is not configured.** `gh secret list` only
proves the NAME exists; it cannot show the value. The workflow's first parity
step rejects an empty `GH_TOKEN` with a stated reason rather than attempting a
clone that would fail obscurely — so an empty secret still fails loudly, and it
now fails in `pricing-parity` only, leaving `verify` free to report the truth
about the code.

**Until a real token is stored, `pricing-parity` fails by design.** An
unverifiable release must never look like a passing one.

The fallback branch is pinned to `claude/quick-quote-email-flow` (byte evidence
in step 4). **If the branch Vercel builds ever changes, change
`PRODUCTION_SITE_BRANCH` in the workflow in the same breath**, or CI will
verify a tree nobody ships and call it green.

---

## Not done, deliberately

- The reported lead `cmt4ia8ot0000sthe46dxfvgg` is untouched. There is no
  automated review flag for leads; flagging it is a manual admin action
  (status → `FOLLOW_UP` with a note).
- No historical lead is recalculated. Retired packages keep their original
  label and amount everywhere history is displayed, and a lead with no snapshot
  keeps its original notification wording.
- `mileageStatus: 'calculated'` is fully implemented and invariant-checked, but
  **nothing writes it yet**: the quick quote has ZIP codes, and a routed mile
  needs full addresses. Every quote this release produces is `'pending'`.
