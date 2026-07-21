# Stage 3 — Reporting, analytics, marketing profitability, exports

**Owner spec 2026-07-20. Branch `claude/admin-stage3-reporting-analytics`, built
on Stage 2 (`claude/admin-phase2-financial-closeout`, commit 9099d4ff).**

Stage 3 turns move-level financial records into company-wide answers.

## Source-of-truth rules

| Report scope | Reads |
| --- | --- |
| `FINALIZED_ONLY` | the immutable `FinancialSnapshot` — **never recalculated** from current settings |
| `PROVISIONAL_ONLY` | live Stage 2 math, always labelled provisional |
| `COMBINED` | both, with counts and an explicit warning when mixed |

Every report also declares a **basis**: `CASH` (collected/paid) or `ACCRUAL`
(billed/owed). `describeBasis()` produces one disclosure line that the screen,
the CSV header, the XLSX header and the PDF all carry verbatim.

## Modules

| File | Role |
| --- | --- |
| `reporting-period.ts` | Timezone-safe period boundaries + DST + safe comparison |
| `reporting-basis.ts` | Finalized/provisional selection, aggregation, disclosure |
| `marketing-profitability.ts` | Profit ROAS, funnel, attribution resolution |
| `estimate-variance.ts` | Estimate vs actual, scope-change fairness |
| `pricing-intelligence.ts` | Comparables, confidence, break-even, quote range |
| `export-service.ts` | Formula-injection safety, column allow-listing, audit shape |
| `action-center-financial.ts` | Closeout blockers to Action Center, dedupe + auto-resolve |

## The chain the owner asked for

```
marketing spend -> leads -> quotes -> bookings -> completed moves
  -> collected revenue -> direct costs -> FINALIZED company profit
  -> Profit ROAS
```

Marketing is judged by `Profit ROAS = attributed FINALIZED net profit / spend`.
Revenue ROAS is shown beside it precisely so a high-revenue, loss-making campaign
is visible as such.

## Known limitations

- **No migration applied and no database verification.** Neon has exceeded its
  compute quota; Stage 1, 2 and 3 migrations are all unapplied.
- The reporting **service layer, schema and tests** are complete; the reporting
  **UI pages** (dashboard, P&L, move-profitability table, marketing, AR, saved
  views) and the HTTP report/export routes are NOT built in this branch.
- PDF export is specified and content-typed but the renderer is not implemented;
  CSV and XLSX are.
- `MONTHLY_POOL` overhead still assumes a caller-supplied period move count.
- Crew analytics metrics are defined in the spec but the aggregation service is
  deferred with the UI.
