# Deployment Guide — wmiwci-backend.vercel.app

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
```

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
