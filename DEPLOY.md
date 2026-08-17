# Deployment Guide — wmiwci-backend.vercel.app

> **The authoritative runbook is [`docs/deployment.md`](docs/deployment.md).**
> It describes the current Railway admin service (`nixpacks.toml`) and carries
> the **pre-deploy verification** order — typecheck → `npm run test:moving-os` →
> migration preflight → backup → migrate → postcheck. This file predates that
> and still describes a Vercel target; use it only for the environment-variable
> and secret-generation reference below.

## Overview
- **Framework:** Next.js 14 (App Router)
- **Hosting:** Vercel → `wmiwci-backend.vercel.app`
- **Database:** PostgreSQL (Supabase / Neon recommended)
- **Redis:** Upstash (serverless Redis for Vercel compatibility)
- **Workers:** Separate VPS or Railway.app (BullMQ needs a persistent process)
- **Static marketing site:** `moveitclearit.com` (separate, existing HTML site)

---

## Pre-Deployment Checklist     

### 1. Generate secrets
```bash
# JWT secret (64 chars)
openssl rand -base64 64

# CSRF secret (32 chars hex)
openssl rand -hex 32

# CRON secret (32 chars hex) — authenticates the daily payment reconciliation
openssl rand -hex 32
```

**`CRON_SECRET` is not optional if you want the money check to run.** See
[§ 7. Scheduled jobs](#7-scheduled-jobs-cron_secret) below for what stops
working without it.

### 2. Hash passwords for Diego and Sebastian
```bash
cd backend
npm run hash-password yourPasswordHere
```
Copy the output hash into `.env.local` as `OWNER_PASSWORD_HASH` and `MANAGER_PASSWORD_HASH`.

### 3. Provision services
| Service | Purpose | URL |
|---------|---------|-----|
| Supabase or Neon | PostgreSQL database | supabase.com / neon.tech |
| Upstash | Redis (Vercel-compatible) | upstash.com |
| Stripe | Payments | dashboard.stripe.com |
| Resend | Email | resend.com |
| Cloudinary | File storage | cloudinary.com |
| Discord | Bot + channels | discord.com/developers |
| Vercel | App hosting | vercel.com |

### 4. Configure Discord bot
1. Create app at https://discord.com/developers/applications
2. Under **Bot**: enable `SERVER MEMBERS INTENT` and `MESSAGE CONTENT INTENT`
3. Under **General Information**: note `Application ID` and `Public Key`
4. Generate bot token
5. Set **Interactions Endpoint URL** to: `https://wmiwci-backend.vercel.app/api/discord/interactions`
6. Invite bot to your server with permissions: `Send Messages`, `Manage Channels`, `Embed Links`, `Add Reactions`
7. Enable Developer Mode in Discord → right-click channels/users to copy IDs

### 5. Register Discord slash commands
```bash
npm run register-commands
```

### 6. Set Stripe webhook
In Stripe Dashboard → Developers → Webhooks → Add endpoint:
- URL: `https://wmiwci-backend.vercel.app/api/stripe/webhook`
- Events: `checkout.session.completed`, `checkout.session.expired`, `payment_intent.payment_failed`

### 7. Scheduled jobs (`CRON_SECRET`)

**Set `CRON_SECRET` on the deployment.** `vercel.json` declares one schedule —
`GET /api/admin/reconciliation`, daily at 13:00 UTC — and the platform sends
`Authorization: Bearer $CRON_SECRET` **only when that variable is set**. With it
unset, the schedule fires and is refused, every day.

**What does not run until it is set** (this is the whole reason it matters — a
refused schedule looks exactly like a quiet day):

| Not detected | Consequence |
|---|---|
| Stripe captured the $49 and no `Payment` row exists | revenue under-counted; the customer's move-day balance is $49 too high, and the Action Center later asks Diego to collect it *again* |
| Booking `CONFIRMED` but the hold was never captured | the authorization expires in ~7 days and the deposit is never collected |
| amount drift / duplicate payments / refund + dispute state mismatches | only ever seen by someone who remembers to run `npm run reconcile` by hand |

Rules, enforced in `src/lib/reconciliation.ts` (`isScheduledRunAuthorized`):
- **minimum 16 characters**; shorter refuses.
- placeholder-shaped values (`REPLACE…`, `PASTE…`, `YOUR…`, `TODO…`) refuse, so
  an unconfigured deployment looks unconfigured rather than half-working.
- unset ⇒ scheduled access is impossible. The owner session still works, and
  `npm run reconcile` still works.

A refused scheduled run raises an **ops alert** on the Discord alerts channel
(falling back to operations) — `src/lib/scheduled-run-guard.ts`. That needs
`DISCORD_BOT_TOKEN` plus `DISCORD_CHANNEL_ALERTS` or
`DISCORD_CHANNEL_OPERATIONS`; without them the refusal is logged as an ERROR and
the alert records that it could not be delivered.

**Not deploying on Vercel?** `vercel.json` crons only run on Vercel. The admin
runbook (`docs/deployment.md`) describes a Railway service — on that platform the
schedule must be created there (a cron service / scheduled job calling the same
URL with the same header). Setting `CRON_SECRET` alone does not create a
schedule; it only makes one possible.

Verify after deploy — a correct secret returns the JSON report, a wrong one 403s:
```bash
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $CRON_SECRET" \
  https://<your-host>/api/admin/reconciliation
# 200 = the schedule can run. 403 = it cannot, and the daily money check is dead.
```

---

## Deploy to Vercel

```bash
# Install Vercel CLI
npm i -g vercel

# Login and link project
vercel login
vercel link

# Set environment variables (or set via Vercel dashboard)
# Copy all values from .env.example and fill in real values

# Deploy
vercel --prod
```

Or connect your GitHub repo in the Vercel dashboard for automatic deploys on push.

**Build command:** `prisma generate && next build`  
**Output directory:** `.next`  
**Node.js version:** 20.x

---

## Database Setup

```bash
# Run migrations against production DB
DATABASE_URL="your_prod_url" npx prisma migrate deploy

# Seed initial admin users
DATABASE_URL="your_prod_url" npm run db:seed
```

---

## Workers (BullMQ)

Workers must run as a **persistent process** — they cannot run on Vercel (serverless).

**Options:**
1. **Railway.app** — Dockerfile-based worker service (recommended)
2. **Render.com** — Background worker tier
3. **VPS (DigitalOcean, Hetzner)** — `pm2 start dist/workers/index.js`

```bash
# On your worker server:
NODE_ENV=production \
DATABASE_URL="..." \
REDIS_URL="..." \
RESEND_API_KEY="..." \
# ... all other env vars ...
node dist/workers/index.js
```

**Bull Board UI** (queue inspector):
```bash
BULL_BOARD_PORT=3001 node dist/workers/bull-board.js
# Access at http://localhost:3001/bull-board (tunnel or VPN in production)
```

---

## Custom Domain on Vercel

1. Go to Vercel project → Settings → Domains
2. Add `wmiwci-backend.vercel.app`
3. Update DNS at your registrar: `CNAME app → cname.vercel-dns.com`
4. Wait for SSL certificate issuance (~minutes)

---

## After Deploy — Activate Optional Services

### Twilio SMS
1. Add real Twilio credentials to Vercel env vars
2. Set `TWILIO_ENABLED=true`
3. Redeploy

### Cloudflare Turnstile (CAPTCHA)
1. Create Turnstile widget at dash.cloudflare.com
2. Add site key + secret key to env vars
3. Set `TURNSTILE_ENABLED=true`
4. Redeploy

### Sentry (Error Monitoring)
1. Create project at sentry.io
2. Add DSN to env vars
3. Set `SENTRY_ENABLED=true`
4. Redeploy

---

## Database Backups

```bash
# Manual backup
BACKUP_DIR=./backups DATABASE_URL="..." bash scripts/backup-db.sh

# Scheduled (cron on worker server)
# 0 3 * * * /path/to/backend/scripts/backup-db.sh
```

---

## Health Check

```bash
curl https://wmiwci-backend.vercel.app/health
# {"status":"ok","db":"connected","timestamp":"..."}
```
