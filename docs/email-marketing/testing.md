# Testing

_Last updated 2026-07-20._

## Commands

```bash
npx prisma validate           # DATABASE_URL must be set (a dummy value works)
npx prisma generate
npm run typecheck             # tsc --noEmit
npm test                      # tsx --test, files enumerated in package.json
npm run preview:emails        # renders every template to email-previews/
```

`npm run lint` is **not usable in this repo**: there is no ESLint config, so
`next lint` drops into an interactive setup prompt. Typecheck is the real gate.
Configuring ESLint was out of scope for this pass.

`npm run build` was not run — a Next.js production build needs the full env
(`DATABASE_URL`, Redis, Stripe, Cloudinary). Typecheck covers the same type
surface; the build should be run in CI/staging.

## New test files

| File | Checks | Covers |
|---|---|---|
| `src/lib/__tests__/email-tokens.test.ts` | 13 | sign/verify, tamper, expiry, purpose, no address in URL |
| `src/lib/__tests__/email-guard.test.ts` | 15 | classification, idempotency keys, address validation, quiet hours + DST |
| `src/lib/__tests__/email-events.test.ts` | 14 | Svix signature, replay, rotation, hard-vs-soft bounce |
| `src/lib/__tests__/referral-eligibility.test.ts` | 19 | every ineligible state |
| `src/lib/__tests__/journeys.test.ts` | 19 | stage tables, job ids, quote stop rules |
| `src/emails/__tests__/brand.test.ts` | 11 | palette (incl. the inline-HTML path), emoji-as-graphic, slogan, hard-coded $49, service claims, invented scarcity, dead CTA links |

All are **offline**: no database, no Redis, no network.

## What is NOT covered by automated tests

These need a live database and Redis, and belong in the staging run:

- suppression read/write against Postgres (only the pure rules are unit-tested)
- the idempotency claim actually blocking a second send
- frequency caps counting real `EmailSend` rows
- queue scheduling and cancellation
- webhook → suppression end-to-end
- the unsubscribe route end-to-end

See [staging-plan.md](./staging-plan.md).

## Results (2026-07-20)

```
npx prisma validate   → The schema at prisma\schema.prisma is valid
npx prisma generate   → Generated Prisma Client (v5.22.0)
npx tsc --noEmit      → exit 0
npm test              → 396 tests, 396 pass, 0 fail
npm run preview:emails→ 22/22 templates rendered
```
