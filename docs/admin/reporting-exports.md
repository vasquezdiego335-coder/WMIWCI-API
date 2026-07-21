# Reporting exports

```
GET /api/admin/reports/export?report=moves&format=CSV&period=this_month
```

CSV and XLSX are implemented. **PDF returns 422 with an explicit message** — it
is reserved but not rendered.

## Totals always match the screen

The export uses the **same builder** as the on-screen report (`report-builders`
returns both `data` and `exportRows`), so an exported total cannot disagree with
what the owner just looked at.

## Header block

Every file starts with business name, report title, period, **basis line**,
currency, record count, generated timestamp, the mixed-source warning when
applicable, and the applied filters including timezone and reporting mode.

## Safety

- **Formula injection**: every cell goes through `sanitizeCell()`, which looks
  past leading whitespace/control characters and prefixes a quote to the
  **original** value — lossless, so `=HYPERLINK(...)` opens inert and the text is
  still readable. A legitimate `-4500` number is untouched.
- **Columns** are allow-listed per report and filtered by role; requested columns
  can narrow but never widen.
- **Forbidden fields** (receipt/proof URLs, tokens, password hashes, access
  codes, card data) can never be exported under any role.
- **Row cap** 10,000 with a 413 and a helpful message.

## Audit

Each attempt writes a `ReportExport` row and a `REPORT_EXPORTED` audit entry
recording user, report, format, period, basis, filters, column keys, record count
and success — **never the exported contents**.
