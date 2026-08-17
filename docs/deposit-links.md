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

Both rules are needed — the page and the checkout POST it makes must be on the
same origin, or the route's same-origin guard rejects the request.

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

## Deployment checklist

- [ ] `npx prisma migrate deploy` — applies
      `20260815120000_deposit_links` (one new table, three audit-action values;
      no existing table is altered and nothing is back-filled)
- [ ] `npx prisma generate`
- [ ] Add `DISCORD_PAYMENTS_WEBHOOK_URL` **or** confirm `DISCORD_BOT_TOKEN` is
      set and the bot can post in `1524853745064869990`
- [ ] Add the Stripe webhook events, if not already enabled on the endpoint:
      `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
      `checkout.session.async_payment_failed`
- [ ] Optional: set `DEPOSIT_LINK_BASE_URL=https://moveitclearit.com` **only
      after** `/deposit/*` is proxied to this app. Until then links correctly
      use `APP_URL`.
- [ ] Verify: paste a test deposit link and the homepage into Discord and
      Messenger, and confirm the large card renders.

## Re-exporting the social cards

    python design/render-social-preview.py            # both cards
    python design/render-social-preview.py deposit    # deposit only

Sources live in the marketing-site repo (`WMIWCI-SITE/design/`). The deposit card
is copied into this repo's `public/assets/social/` automatically, so the
`og:image` ships with the page that references it.

Facebook caches an image per **image URL**. Redesigning a card means bumping the
filename (`-v2`) and the metadata together — editing in place leaves the stale
bytes cached forever.
