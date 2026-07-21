# Reporting API

```
GET /api/admin/reports/[report]
GET /api/admin/reports/export?report=…&format=CSV|XLSX
```

Reports: `overview`, `profit-loss`, `moves`, `revenue-profit`, `variance`,
`marketing`, `customers`, `pricing`, `action-center`.

## Parameters (all validated server-side by Zod)

`period` (today … custom) · `start` / `end` (YYYY-MM-DD, end INCLUSIVE) ·
`basis` (CASH|ACCRUAL) · `scope` (FINALIZED_ONLY|PROVISIONAL_ONLY|COMBINED) ·
`page` · `pageSize` (max 200) · `sort` · `dir` · plus report filters.

Rejected: unknown enum values, a custom range missing a date or out of order, a
range over 800 days, page sizes out of bounds. **Role never comes from the
request** — it is read from the session.

## Response

```jsonc
{
  "meta": {
    "accountingBasis": "CASH",
    "reportingMode": "COMBINED",
    "timezone": "America/New_York",
    "periodStart": "...", "periodEndExclusive": "...",
    "finalizedMoveCount": 3, "provisionalMoveCount": 1, "incompleteMoveCount": 0,
    "basisLabel": "Cash basis … · finalized and provisional combined",
    "warnings": ["Includes 1 move that has not been financially finalized…"]
  },
  "dataState": "OK" | "EMPTY" | "NO_VERIFIED_DATA" | "UNAVAILABLE",
  "data": { },
  "page": { }
}
```

The frontend never has to guess whether a number is finalized — that is the
whole reason `meta` is mandatory.

## Failure

A calculation failure returns **503** with `dataState: "UNAVAILABLE"` and no
figures. A report must never render zeros because it failed.
