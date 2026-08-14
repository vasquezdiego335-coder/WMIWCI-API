# Moving OS — P0 hardening (close the verified residuals; 2026-08-14)

The P0 round returned ZERO FAILs: truck holds now use the real estimated window,
Discord surfaces no longer print an invented hour, approval can never capture money and
skip staffing, the Action Center is honest during the migration window, and the gate
(`npm run test:moving-os`, 17 files / 337 tests) exists and blocks. Do not re-open any
of that.

What remains are guards that are WEAKER THAN THEY CLAIM. Each was proven by the
verifier through mutation — the defect was introduced, the suite stayed green. That is
the exact failure class this project has lost four rounds to, so it gets closed rather
than documented.

Standing rules unchanged: no git, no database commands, no price constants, no Phase 2,
never edit package.json (already updated: `test:moving-os` exists and both new test
files are in `npm test`). Build fixtures with the shipped writer. Mutation-test your own
assertions: introduce the defect, confirm red, restore.

---

## H1 — the create preflight is untested, and the PUBLIC create is not protected
**Proven:** deleting the ENTIRE create-preflight block from
`app/api/admin/bookings/route.ts` (leaving `nextBookingReference()` first) left the whole
gate green — 17 files, 337 tests, 0 fail. The guarantee "booking create fails BEFORE
writing anything when a required migration column is absent" has no test at all.

**Also proven:** the guarantee is FALSE on the public path. `app/api/bookings/route.ts`
does `prisma.customer.upsert` (:282), then `nextBookingReference()` (:377 — a
`SELECT nextval`, which is NOT rolled back), then `prisma.booking.create({ include })`
(:379) — the same `$scalars` shape this whole item is about. So in the migration window
a customer row is written and a WMIC-#### number is burned before the create fails. That
path is every customer booking, and it is absent from the doc's "not covered" list.

**Fix**
1. Cover the ADMIN preflight with a test that fails if the block is removed or reordered
   — assert the preflight runs BEFORE `nextBookingReference()` and before any write, and
   that a missing column yields the honest 503 with nothing written.
2. Apply the same preflight to the PUBLIC create, ordered before the customer upsert and
   before the reference is drawn. It must fail honestly (the public route's existing
   error contract — do NOT leak internals to a customer) without burning a reference or
   writing a Customer.
3. If any write genuinely cannot be moved after the probe, say so explicitly in the doc
   rather than leaving the claim overstated.

## H2 — the scan predicate is a presence-whitelist, not an equivalence
**Proven (M10):** adding `manualReviewRequired: false` to `performSync`'s `where`
(`reminder-sync.ts:74`) keeps the suite green at 25/25 while `scanCoversBooking`
(`scan-lock.ts:118-121`) starts over-claiming. This is not contrived: the shipped writer
sets `manualReviewRequired: true` for a default-path booking carrying a piano — exactly
the rows the owner most needs on the list. **Proven (M11):** `take: 500` → `take: 5` is
also green; the predicate models no row cap.

**Fix:** make the guard equivalence-shaped rather than presence-shaped — parse the
`where` object in `reminder-sync.ts` and FAIL on any key the coverage predicate does not
model (allowlist `{isInternalTest, OR}`), and tie `take`/`orderBy` to the claim. If a
future filter is added deliberately, the guard should force the predicate to be updated
in the same commit.

## H3 — the phrase guard has three named escapes
**Proven:** the guard is line-scoped, blacklist-scoped and file-scoped.
(M14) the retired sentence straddling a JSX line break in a LISTED file — green
(Prettier wraps JSX text at printWidth, so this is realistic, not exotic).
(M15) an unlisted near-variant, "This booking is on the list." — green.
(M13) the sentence verbatim in a NEW owner-facing page — green (the test file admits
this one itself).

**Fix:** match against whitespace-normalized WHOLE-FILE text instead of per-line; walk
`app/**/*.tsx` (plus the scan libs) repo-wide instead of a six-file list, with an
allowlist for the one earned constant; widen the phrase set to cover the near-variants
("on the list", "accounted for", "covered", "nothing missing"). Also check the unguarded
owner-facing string the verifier flagged at
`app/(admin)/admin/(dashboard)/trucks/page.tsx:101`.

## H4 — gate completeness and stale documented numbers
1. Six green, gate-eligible tests covering P0-modified modules sit OUTSIDE the runner
   list: `booking-approval`, `scan-lock`, `booking-display`, `scheduling-guards`,
   `reminder-rules`, `conflict-engine`. Add them (they are green today, so this is
   protection, not debt) and re-measure.
2. `docs/deployment.md` states the gate is "16 files, 308 tests" (it is 17/337 before
   this change) and a baseline of "2494 tests / 2476 pass" (measured: 2516 / 2498). The
   load-bearing facts — 18 failures across 8 named files — are correct; fix the stale
   counts and state the measurement date, or make the doc print no count it cannot
   verify.

## Definition of done
Every mutation named above (M10, M11, M13, M14, M15, and preflight deletion) must turn
the relevant suite RED. `npx tsc --noEmit` clean. `npm run test:moving-os` green.
`npm test` shows only the 18 known baseline failures.
