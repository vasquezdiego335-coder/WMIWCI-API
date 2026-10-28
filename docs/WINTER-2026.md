# Winter 2026–2027 shutdown and restart runbook — Move It Clear It

Prepared 2026-10-28. Nothing in this document has been done in production yet.
**Billing savings start only after the production steps in section 4 are completed.**

Code that supports it:

| Repo | Branch | What it adds |
|---|---|---|
| WMIWCI-API | `winter/2026-seasonal-closure` | `SEASONAL_CLOSURE=true` switch (API + worker), `scripts/winter/backup.mjs`, `restore-test.mjs`, `queue-review.mjs`, this runbook |
| WMIWCI-SITE | `winter/2026-seasonal-closure` (from the live `fix/lead-state-v3-production-gate`) | Static winter site: closure banner, closed booking/quote pages, no backend calls, Vercel + Cloudflare configs |

---

## 1. What runs today (audited 2026-10-28)

| Service | Purpose | Monthly cost now | Winter action | Winter cost | Restart |
|---|---|---|---|---|---|
| Railway `earnest-solace / wonderful-strength` | Next.js API + admin | **$1.98** usage (verified) | Remove deployment | $0 | Redeploy (step R4) |
| Railway `patient-communication / discord workers` | BullMQ workers, crons, Discord bot | **$3.09** (verified) | Remove deployment | $0 | Redeploy (R5) |
| Railway `passionate-education / Redis` (+0.19 GB volume) | BullMQ queues | **$0.25** (verified) | Remove deployment, keep volume | ~$0.03 inside the $5 minimum | Redeploy (R3) |
| Railway `secure-energy / Qr code` (go.moveitclearit.com) | QR / door-hanger tracker (Flask) | **$0.99** (verified) | Remove deployment; point go.* at the static site | $0 | Redeploy + DNS back (R6) |
| Railway `adequate-ambition / Postgres` (0.22 GB) | QR tracker DB (108 scans) | **$0.50** (verified) | Back up, remove deployment, keep volume | ~$0.03 | Redeploy |
| Railway `stellar-warmth / Lead-tracking` | Old popup-lead app (SendGrid key dead) | **$0.55** (verified) | Remove deployment | $0 | Optional; the site no longer uses it |
| Railway `exemplary-hope / Postgres` (0.17 GB) | Lead-tracking DB (13 leads, 29 events) | **$0.49** (verified) | Back up, remove deployment, keep volume | ~$0.03 | Redeploy |
| Railway `worthy-analysis` | Empty project (no live services) | $0 | Leave (or delete later) | $0 | — |
| **Railway Hobby plan (SHARED)** | Also runs flipmytuition-admin + its Postgres and the ADHD bot | $5 minimum; bill = max($5, usage). Period to date $4.95 in 12 days ≈ **$12.40/month** | **Do not cancel**: other projects use it | **$5.00** (others use ~$4.54) | — |
| Neon `neondb` (ep-polished-poetry, us-east-1, PG 17, 42 MB) | Production database | **Not visible** (no Neon access). Paid plan indicated (16 TB size limit). Repo estimate ~$13.50/month compute with the 15-min crons | Stop every client so compute scales to zero; keep the project | ≈ $0.03 storage/history (Neon does not collect invoices under $0.50) | Nothing to restart; first connection wakes it |
| Vercel (www.moveitclearit.com) | Static website | **Not visible** (CLI not signed in). Hobby = $0 but non-commercial only; Pro = $20/seat | Deploy winter branch, then move to Cloudflare (free) | $0 | Redeploy normal branch (R7) |
| Cloudflare | DNS, Registrar, Email Routing (hello@ inbox) | $0 (free features; dashboard not checked) | Keep; export DNS zone | $0 | — |
| Domain moveitclearit.com | Cloudflare Registrar | Paid to **2027-05-23**; renews at cost | Keep auto-renew + a valid card | $0 during winter | — |
| Stripe (live account) | Booking holds, deposits | $0 fixed fee; balance $0, no holds, disputes, links or subscriptions (verified) | Disable webhook endpoint after the API is off | $0 | Re-enable endpoint (R8) |
| Resend (moveitclearit.com verified) | Sending email | **Plan not visible**. ~30 emails/month fits Free (3,000/month) | Keep domain; downgrade if on Pro; disable webhook | $0 on Free | Re-enable webhook |
| Twilio (Trial account) | App SMS (already `TWILIO_ENABLED=false`) | $1.15/month number **…5371** paid from trial credit ($9.69 left). **Not the business number** | Leave. Twilio may reclaim an unused trial number after 90 days | $0 cash | Only if SMS is wanted again |
| Business number (862) 640-0625 | Public phone / text | Not on Twilio. A Drive note says "my number is 862-640-0625": **appears to be the owner's own line**. No business-phone bill found | Keep. Set the seasonal voicemail (section 6) | Owner to confirm $0 | — |
| OpenAI + DeepSeek | Email operations agent (read-only) | ≈ $0.05/month (from the app's cost ledger) | Stops with the worker | $0 | — |
| Google Maps Platform | Address checks (API) + autocomplete (site) | Not visible | No calls in winter mode | $0 | — |
| Cloudinary | Job photos | Not visible; the Railway credentials are **rejected** (api_secret mismatch) | Back up media from the dashboard | Likely $0 (Free) | Fix credentials before reopening |
| SendGrid | Old Lead-tracking email | Keys rejected (401/403) | Nothing | $0 | — |
| GitHub Actions (WMIWCI-SITE, private) | keep-warm every 10 min (155 runs in Oct), QR + biweekly reports | Inside free minutes | Disable the three workflows | $0 | Re-enable |
| Discord | Crew/owner notifications | $0 | Bot stops with the worker | $0 | — |

**Move It Clear It savings that can actually be achieved:** Railway about **$7.40/month** ($12.40 → the $5 minimum the other projects need anyway), plus the Neon compute (≈ $5–14/month, *unverified*), plus Vercel ($20/month **only if** on Pro). Expected winter cost attributable to Move It Clear It: **≈ $0/month**. One-time fees: **$0**.

Other findings:
- `SHADOW_DATABASE_URL` on both Railway services points at the **production** Neon database. Never run `prisma migrate dev` or `npm run db:reset` with production variables; give it a separate database before spring.
- The QR service has `NEXT_PUBLIC_APP_URL` set to the production Neon connection string (with password). The Flask app does not read it; delete the variable.
- WMIWCI-API is a **public** repository and `docs/phase2-3-infra-and-providers.md` contains a real `TRACKER_INGEST_TOKEN`. Rotate it in spring.
- The live site has no town landing pages (`movers-*-nj.html` exist only on `master` and return 404 live).
- Stale data: 18 bookings in PENDING/CONFIRMED with June–July move dates, 8 ACTIVE deposit links (move dates in the past), 7 unsent July email rows. No money is held for any of them.

## 2. Database decision

| Option | Monthly | Effort | Risk |
|---|---|---|---|
| **A. Keep Neon project as is, stop all clients (recommended)** | ≈ $0.03, below Neon's $0.50 collection threshold | None | Lowest. No migration; restore window and branches stay |
| B. Downgrade the Neon org to Free | $0 | One dashboard change if nothing exceeds Free limits | Restore window drops to 6 h; Free inactivity rules for AWS not documented |
| C. Export and delete Neon | $0 | Rebuild + reconfigure in spring | Highest; saves ≈ $0.03 |

Neon bills compute only while it runs and suspends after inactivity, so once the API, worker, crons and the email agent are off, compute cost is zero. Keep the project. Take an independent backup first (section 3) anyway.

## 3. Backups (scripts in `scripts/winter/`)

Status on 2026-10-28: a **rehearsal** backup of all three databases was taken (read-only) to
`C:\Users\brown\Documents\mic-db-backups\mic-winter-rehearsal-20261028T170312Z` and **restored and checked in an isolated
local PostgreSQL 18: 15/15 checks passed** (row counts for 73 + 2 + 8 tables, 40 foreign keys, 73 migrations, booking
references, partial unique index, pgcrypto, suppression list). **This is not the final backup.** The final one is taken in step S6,
after writes have stopped.

```bash
export MIC_BACKUP_DIR="$HOME/Documents/mic-db-backups"   # private, outside Git
export PGBIN="$HOME/pgclient/bin"                         # pg_dump/psql/pg_restore 17
export NEON_DIRECT_URL='…'        # Neon DIRECT host (remove "-pooler")
export LEADTRACKING_DB_URL='…'    # Railway exemplary-hope DATABASE_PUBLIC_URL
export QRTRACKER_DB_URL='…'       # Railway adequate-ambition DATABASE_PUBLIC_URL
node scripts/winter/backup.mjs --label final
export PG_SERVER_BIN='<folder with initdb, pg_ctl, postgres; PG 17 or newer>'
node scripts/winter/restore-test.mjs "<folder printed above>"
```

The two Railway databases run PostgreSQL 18, newer than the local pg_dump 17, so the script exports them logically
(schema.sql + one CSV per table) and the restore test rebuilds them from that.

Keep two copies of the final backup folder, each independent of Neon and Railway: the laptop folder above **and** an
encrypted copy (e.g. a password-protected 7-Zip archive) in private cloud storage. Never commit dumps, never put them in a public folder.

Also save privately, next to the backup:
- `railway-variables-<service>.env` for the API, worker, QR and Lead-tracking services (Railway → service → Variables → Raw editor → copy). These are secrets.
- Cloudflare DNS zone export (DNS → Records → Export).
- Cloudinary media: Media Library → select all → Download, or note that photos also live in Discord.
- Stripe: nothing to export; history stays in Stripe.

## 4. Ordered shutdown checklist (each step needs the owner's approval)

| # | Step | How |
|---|---|---|
| S1 | Resolve customer money | Stripe has **no** held authorizations, open checkouts, disputes or balance (verified 2026-10-28). Owner confirms the 5 paid $49 deposits (Aug 22–Sep 22 moves) were for completed jobs, so no refund is owed. Nothing is captured, refunded or cancelled automatically. |
| S2 | Merge and deploy the API winter branch with `SEASONAL_CLOSURE=true` on **both** Railway services | Railway → each service → Variables → add `SEASONAL_CLOSURE=true` → deploy branch `winter/2026-seasonal-closure` (or merge to `main`). Check: `curl -s -X POST https://wonderful-strength-production-a0f1.up.railway.app/api/bookings -H 'content-type: application/json' -d '{}'` returns 503 `SEASONAL_CLOSURE`. |
| S3 | Deploy the winter website | Vercel → Project → Settings → Git → deploy branch `winter/2026-seasonal-closure` to Production (or `vercel deploy --prod` from `public/`). Check www.moveitclearit.com shows the banner. |
| S4 | Stop marketing and noise | Email marketing, follow-ups, the AI agent and every recurring sweep already stop under `SEASONAL_CLOSURE` (S2), so no other variables need changing. GitHub: `gh workflow disable keep-warm.yml -R vasquezdiego335-coder/WMIWCI-SITE`, same for `qr-report.yml` and `biweekly-report.yml`. Google Business Profile → Edit profile → Hours → **Temporarily closed**. Pause any ads (none found in the code; check Google Ads/Meta if used). |
| S5 | Record the queue | `node scripts/winter/queue-review.mjs > queue-at-shutdown.txt` (read-only). |
| S6 | **Final backup + restore test** | Section 3 with `--label final`. Must print `RESTORE TEST PASSED`. Copy the folder to the second location. |
| S7 | Stop the backend | Railway → remove the active deployment (⋯ → Remove) for: discord workers, wonderful-strength, Qr code, Lead-tracking, then Redis and both Railway Postgres services. **Do not delete services or volumes.** Do not touch flipmytuition-admin, its Postgres, or the Adhd worker. |
| S8 | Webhooks | Stripe Dashboard → Developers → Webhooks → the railway.app endpoint → **Disable**. Resend → Webhooks → disable the railway.app endpoint. |
| S9 | Free static hosting | `npx wrangler@4 login`, then `npx wrangler@4 deploy` in WMIWCI-SITE (winter branch). Dashboard → Workers & Pages → moveitclearit-site → Domains & Routes → add `www.moveitclearit.com`, `go.moveitclearit.com`. Add a Redirect Rule `moveitclearit.com/*` → `https://www.moveitclearit.com/${1}` (301), as Vercel does today. Check pages, then remove the domains from Vercel and (if on Pro) downgrade Vercel. |
| S10 | Neon | Neon console → Monitoring: confirm compute is Idle/Suspended within an hour of S7. Set a billing alert. Optional: downgrade to Free (section 2). |
| S11 | Resend / Twilio | Resend → Billing: if on Pro, switch to Free (keep the verified domain). Twilio: nothing. |
| S12 | Phone and inbox | Set voicemail (section 6). Send a test email to hello@ and info@moveitclearit.com and confirm both arrive (Cloudflare Email Routing). |

## 5. Spring restart (in this order)

| # | Step |
|---|---|
| R1 | Neon: nothing to do (if deleted, restore the final dump with `pg_restore --no-owner --no-acl` into a new project and update `DATABASE_URL`). |
| R2 | Fix before going live: give `SHADOW_DATABASE_URL` its own database; rotate `TRACKER_INGEST_TOKEN`; fix the Cloudinary secret; delete `NEXT_PUBLIC_APP_URL` from the QR service. |
| R3 | Railway: redeploy Redis, then the two Postgres services. |
| R4 | Redeploy the API **with `SEASONAL_CLOSURE=true` still set**. Smoke test: `/api/health` 200, admin login works, `POST /api/bookings` still 503. |
| R5 | Redeploy the worker with `SEASONAL_CLOSURE=true`. Run `node scripts/winter/queue-review.mjs`. With the switch on, stale sweeps skip and any stale email is dropped for good (`seasonal_closure`). Review the 7 July email rows, the 8 old deposit links and the 18 stale bookings in admin; cancel what should not continue. |
| R6 | QR tracker: redeploy, point `go.moveitclearit.com` back to Railway, re-enable the GitHub workflows. |
| R7 | Website: deploy the normal branch (`fix/lead-state-v3-production-gate` or its successor) to Vercel **or** to Cloudflare by deploying that branch's `public/` with the same `wrangler.jsonc`. |
| R8 | Stripe: re-enable the webhook endpoint; Resend: re-enable its webhook. |
| R9 | Set `SEASONAL_CLOSURE=false` on API + worker (redeploy). Turn the marketing switches from S4 back on only if wanted. |
| R10 | End-to-end test with a test booking (owner's test-booking flow) and one real email to the owner. Google Business Profile → Open with main hours. |

## 6. Drafts for owner review

**Voicemail (≈ 20 s):** "Hi, you've reached Move It Clear It. We're closed for the winter season and aren't booking moves
right now. Thank you for a great season! If your question is about a move we already did, please email
hello@moveitclearit.com and we'll get back to you."

**Email auto-reply (only if the inbox provider supports it; Cloudflare Email Routing only forwards, so set it in the destination
Gmail as a filter-based canned response for mail to hello@/info@):**
Subject: Move It Clear It — closed for the winter season
"Thanks for reaching out to Move It Clear It. We're closed for the winter season and aren't taking new bookings or quotes right
now. If you're writing about a move we already completed, we read this inbox occasionally and will reply. Thank you for your
patience. — Move It Clear It"
