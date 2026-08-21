# Deposit links

Owner spec 2026-08-15. A private admin tool for taking a deposit of any exact
amount from a customer quoted over Messenger or text, from a phone.

---

## What it is

1. Diego opens **`/admin/deposit-links`** on his phone, picks the booking (or
   goes standalone), types the amount, taps **Create & Copy Link**.
2. The customer opens **`/deposit/<token>`**, sees what they owe, and pays.
3. Stripe confirms the payment by **webhook**.
4. The payment is recorded, applied to the booking ledger, and **only then** a
   Discord card is posted to the payments channel.

The customer never chooses or edits the amount. It is decided on the server, in
integer cents, and read from the database at charge time.

---

## Which Stripe product this is (and is not)

| | `$49` booking flow | deposit link |
|---|---|---|
| helper | `createBookingCheckout` | `createDepositCheckout` |
| capture | `manual` — an **authorization**, held | automatic — a **charge** |
| released? | yes, if the booking is denied | no, money has moved |
| ledger | `Payment` created at approval | `Payment` created on the webhook |

They are separate on purpose. Conflating them would either hold money the owner
meant to collect, or collect money the owner meant to hold.

A booking that already has an uncaptured `$49` hold shows a warning on the admin
form, because taking a deposit as well collects twice.

---

## The money rules

* `parseAmountToCents` is the **only** conversion from dollars to cents. It is
  strict: `49.999`, `4,9` and `1e3` are refused rather than rounded or guessed.
* Bounds: `$1.00` … `$10,000.00`.
* **No processing fee is ever added.** `$495` quote − `$49` deposit = `$446`
  remaining. Never `$501`.
* A deposit **cannot exceed the unpaid balance** — there is no overpayment
  policy in this business. The one exception is a booking with no accepted quote
  total, where the "balance" is reconstructed from parts and is a floor, not the
  amount; the cap is skipped there and the admin is told why.
* Balances come from `customerBalance()` in `job-money.ts` — the one formula.
  Nothing here re-sums fee columns, and nothing here writes a price back.

---

## Payment confirmation

The **webhook is the source of truth.** Signature verified against the raw body
(`app/api/stripe/webhook/route.ts` → `stripe-events.ts`).

`checkout.session.completed` does **not** mean paid. For delayed payment methods
Stripe fires it with `payment_status: 'unpaid'` and confirms later with
`checkout.session.async_payment_succeeded`. `isConfirmedDepositSession()` is the
gate; both events run through it.

Order of operations, and it matters:

1. verify the Stripe signature
2. `markDepositPaid()` — one transaction: mark paid, write the `Payment` row,
   write the audit log, set `discordStatus = PENDING`
3. queue the Discord job
4. return 200 to Stripe
5. deliver the notification, with retries

The success redirect (`?return=1`) never marks anything paid. The page shows
*"Confirming your payment…"* and polls `/api/deposit/<token>/status`, which is
read-only.

### Exactly once

Four independent guards, any one of which is sufficient:

* `webhookLog.eventId` — a replayed Stripe event is dropped
* `depositRequest.paid_at IS NULL` — the conditional claim in `markDepositPaid`
* `payments.stripe_payment_intent_id` unique index
* `claimDiscordNotification()` — the notification lock, so a duplicate event, a
  BullMQ retry and the admin Retry button cannot produce a second message

---

## Discord

Transport is chosen at send time:

1. `DISCORD_PAYMENTS_WEBHOOK_URL` if set — carries the `Move It Clear It
   Payments` sender name and the logo avatar. **The URL is a secret.**
2. otherwise the existing bot (`DISCORD_BOT_TOKEN`) posting to
   `DISCORD_PAYMENTS_CHANNEL_ID`, default `1524853745064869990`.

A channel id alone authenticates nothing. With neither credential the payment
still completes and the admin page states that notifications are not configured.

* `allowed_mentions: { parse: [] }` on every send — a customer cannot make a
  payment card ping the server.
* 429 honours `Retry-After` (capped at 10s); 5xx and network errors back off
  exponentially, bounded at 3 attempts, then BullMQ retries 5 times.
* A Discord outage can never reverse, delay or invalidate a payment. The
  notification state is a column on the row: `PENDING → SENDING → SENT|FAILED`.
* **Send Test Discord Notification** on the admin page posts a card that says
  TEST in three places. That route does not import prisma at all.

---

## The public URL: `moveitclearit.com/deposit/…`

**Today, links work on `APP_URL`** — that host definitely serves the page, and
`DEPOSIT_LINK_BASE_URL` is deliberately unset. A pretty URL that 404s is worse
than an ugly one that works.

To move to the brand domain, the path must be **proxied to this app**, and the
proxy must forward the request server-side (a redirect would break the unfurl,
because Discord and Facebook do not follow one before reading Open Graph).

WMIWCI-SITE is served by Vercel. Add to its `vercel.json`:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "rewrites": [
    { "source": "/deposit/:path*",     "destination": "https://APP_HOST/deposit/:path*" },
    { "source": "/api/deposit/:path*", "destination": "https://APP_HOST/api/deposit/:path*" }
  ]
}
```

`APP_HOST` is the deployed app's real hostname. **This is deliberately not
filled in**: `APP_URL` in `.env` still reads `wmiwci-backend.vercel.app` while
the app actually runs on Railway, and guessing wrong here 404s every deposit
link. Confirm the host, put it in both rules, then set
`DEPOSIT_LINK_BASE_URL=https://moveitclearit.com` on the API.

Both rules are needed: the page and the checkout POST it makes must be on the
same origin, or the route's same-origin guard rejects the request. The guard
compares the browser's `Origin` against `x-forwarded-host` (the ORIGINAL host)
rather than against the proxied `Host`, which is what a rewrite rewrites; the
old comparison 403'd every browser that does not send `Sec-Fetch-Site`.

Verify after configuring:

```bash
curl -sI https://moveitclearit.com/deposit/AAAAAAAAAAAA | head -1        # expect 200, not 3xx
curl -s -A 'Discordbot/2.0' https://moveitclearit.com/deposit/AAAAAAAAAAAA | grep 'og:image'
```

## Preflight

Read-only. Writes nothing, contacts nothing. Safe against production at any time.

```bash
node scripts/deposit-preflight.mjs
```

It checks the environment (including whether Stripe is live or test, and whether
Discord is configured at all), that the 1200x630 card exists, and that the
migration is still additive.

## The move date is a CALENDAR DATE (2026-08-20)

A move date is the day of the job, not an instant. `src/lib/move-date.ts` is the
only place that decides what day a stored value is, and the only place that turns
one into words.

**The bug this fixed.** The owner entered Saturday 22 August 2026; the customer's
page said "August 21, 2026". `<input type="date">` emits `"2026-08-22"`,
`new Date("2026-08-22")` is **UTC midnight** (ECMA-262 parses a date-ONLY form as
UTC and a date-TIME form without an offset as LOCAL, and that inconsistency is
the whole trap), and rendering that instant in `America/New_York` is 8 PM the day
before. The Discord card a crew is dispatched from had the same defect.

**The rules now:**

| Concept | Stored as | Read by |
| --- | --- | --- |
| Move date | `move_date`, anchored at **12:00 UTC** of that calendar day | `moveDateParts`, never a bare `toLocaleDateString` with a timezone |
| Move time | `move_time_minutes`, minutes after midnight **Eastern** (0-1439) | `formatMoveTime`; a time that is never inside a `Date` cannot be shifted by DST |
| Link expiry | `expires_at`, a real **instant** | `parseEtDateTimeLocal`; the admin picker's wall clock is Eastern, not the server's |

Rows written before the fix hold exactly `00:00:00.000Z`. That shape is treated
as a date-only value and read in UTC, so **every existing link was repaired by
the read rule** and no row was edited by hand.

Regression coverage: `src/lib/__tests__/move-date.test.ts` (33 checks, offline),
including every calendar day of 2026, both DST transitions, and the exact
reported case. It passes with the server clock set anywhere from UTC-11 to UTC+14.

## Who reads which field

One free-text column could not hold both the customer's summary and the crew's
instructions, so the crew's instructions reached a customer's payment page. The
audience is now a property of the column:

| Column | Audience | Where it appears |
| --- | --- | --- |
| `service_summary` | Customer | The page, the Stripe line item, the receipt, the Discord card |
| `move_details` (`TEXT[]`) | Customer | The page, as a bounded bullet list (max 6 x 90 chars) |
| `customer_note` | Customer | The page, as the "What we need from you" callout |
| `internal_note` | **Private** | The admin list and the Discord card only |

`internal_note` is absent from `PUBLIC_SELECT` in `app/deposit/[token]/page.tsx`,
so it is unreachable from the public page **by construction** rather than by
remembering to strip it. `publicDepositView` has no such field to populate, and
`move-date.test.ts` asserts the whole serialized view contains none of it.

The admin form renders a live **"What the customer sees"** preview built only
from the customer-facing fields. The surest way to keep them separate is to show
the owner the result before he sends it.

## The cancellation policy (resolved 2026-08-20)

There were TWO Terms of Service documents saying different things, and the
deposit page summarised the one customers cannot reach:

| | `app/terms/page.tsx` (this repo) | `WMIWCI-SITE/public/terms` (PUBLISHED) |
| --- | --- | --- |
| Reschedule notice | 72 hours | **48 hours** |
| Free reschedule | not mentioned | **once within 90 days** |
| Same-day cancellation | fee = 2 hours of labor | **hold forfeited, no additional charge** |

`/terms` is root-relative, and on moveitclearit.com only `/deposit`,
`/api/deposit` and `/_next` are rewritten to this app — so a customer tapping
the link from the deposit page lands on the MARKETING SITE's document. The page
was therefore printing a cancellation fee directly above a link to the document
saying no such fee applies.

**The published document is the one customers agreed to, so it is the truth**
(owner decision). `app/terms/page.tsx` section 3 was corrected to match it, and
the deposit page now summarises 48 hours / 90 days / no additional charge in both
languages. `src/lib/__tests__/deposit-terms-parity.test.ts` fails if the three
surfaces drift apart again; it reads the marketing site when it is checked out
beside this repo and skips those assertions when it is not.

NO DOLLAR FIGURE appears in the page summary, deliberately. Copy in
`deposit-copy.ts` may never state a price, and on this page a literal `$49` would
sit beside a deposit that is often a different number — reading as though the
deposit itself were the forfeited booking fee. They are separate instruments; the
Terms name the figure in context.

STILL ENFORCED AT 72 HOURS: `app/api/customer/booking/[token]/route.ts` refuses a
self-service reschedule inside 72 hours. That is an OPERATIONAL threshold, not a
document, and was deliberately left alone — but it now allows less than the Terms
promise, so it is the owner's call whether to relax it to 48.


## Deployment checklist

- [ ] `npx prisma migrate deploy` — applies
      `20260815120000_deposit_links` (one new table, three audit-action values;
      no existing table is altered and nothing is back-filled) **and**
      `20260820120000_deposit_move_time_and_notes` (five nullable/defaulted
      columns on `deposit_requests`: `move_time_minutes`, `move_details`,
      `customer_note`, `internal_note`, plus a range CHECK on the time)
- [ ] `npx prisma generate`
- [ ] Add `DISCORD_PAYMENTS_WEBHOOK_URL` **or** confirm `DISCORD_BOT_TOKEN` is
      set and the bot can post in `1524853745064869990`
- [ ] Add the Stripe webhook events, if not already enabled on the endpoint:
      `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
      `checkout.session.async_payment_failed`
- [ ] Optional: set `DEPOSIT_LINK_BASE_URL=https://www.moveitclearit.com`
      **only after** `/deposit/*` is proxied to this app. Note the `www.`:
      that is the host the rewrite in `WMIWCI-SITE/vercel.json` serves and
      the host printed links actually use. Until it is set, links correctly
      use `APP_URL`. The Stripe RETURN url no longer depends on this at all:
      it is derived from the host the customer is actually on (validated
      against an allowlist), so someone who pays on the brand domain comes
      back to the brand domain rather than to a raw railway.app hostname.
- [ ] Verify: paste a test deposit link and the homepage into Discord and
      Messenger, and confirm the large card renders.

**DEPLOY ORDER IS SAFE EITHER WAY.** Migrations are deliberately not run during
the build (`nixpacks.toml` — build-time Neon connections are flaky), so there is
always a window where new code runs against an old schema. On this page that
window would be a customer holding a payment link that 500s, so `fetchRow` falls
back to the pre-migration projection on Postgres 42703 / Prisma P2022 and serves
the page without the move time or the bullets. Once the migration is applied the
fallback never fires again.

## Looking at the page

    npx tsx --tsconfig scripts/tsconfig.preview.json scripts/deposit-preview.mjs

Renders the real component with the real stylesheet to `.preview/deposit/` —
ten cases (English, Spanish, long text, missing fields, paid, expired, outage)
and an `index.html` showing each at 320 / 360 / 390 / 430 / 768 / 1440px. No
database, no Stripe, no network. This is how the layout is checked against the
in-app browser widths the link is actually opened in.

## Re-exporting the social cards

    python design/render-social-preview.py            # both cards
    python design/render-social-preview.py deposit    # deposit only

Sources live in the marketing-site repo (`WMIWCI-SITE/design/`). The deposit card
is copied into this repo's `public/assets/social/` automatically, so the
`og:image` ships with the page that references it.

Facebook caches an image per **image URL**. Redesigning a card means bumping the
filename (`-v2`) and the metadata together — editing in place leaves the stale
bytes cached forever.
