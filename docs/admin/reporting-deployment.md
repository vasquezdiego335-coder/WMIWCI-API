# Reporting deployment

## Order

1. Restore Neon compute; create a **staging branch** (never verify on production).
2. Back up / branch the database.
3. `npx prisma migrate status` — confirm the three pending migrations.
4. Apply **one at a time**, verifying after each:
   `20260720000100_phase1_jobcrew_labor` →
   `20260720000200_phase2_financial_closeout` →
   `20260720000300_stage3_reporting_analytics`
5. `npx prisma generate`.
6. Deploy the app.
7. Configure before reporting means anything:
   - staff pay rates (Stage 1)
   - overhead method + rate, tax reserve %, receipt threshold, ownership split (Stage 2)
   - marketing campaigns and their spend rows (Stage 3)
8. Close out at least one move so `FINALIZED_ONLY` has something to show.
9. Walk the staging scenarios for all three stages.

## Environment

`APP_URL` must be correct — reporting pages fetch their own API through it. If
unset it falls back to `http://localhost:3000`, which will fail in production.
