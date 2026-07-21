# Export system

## Formats

CSV and XLSX (SpreadsheetML, no new dependency) are implemented. PDF is
content-typed and reserved for monthly summary, finalized closeout, distribution
summary and accountant summary — **renderer not implemented in Stage 3**.

## Formula-injection safety

A customer note of `=HYPERLINK("http://evil","click")` is text in our database
but Excel and Sheets EXECUTE it. `sanitizeCell()`:

- looks PAST leading whitespace/control characters (`\t`, zero-width, BOM), so a
  padded payload cannot slip through;
- prefixes a single quote to the **ORIGINAL** string — lossless, so the export
  stays a faithful record;
- never strips a leading `-`, which is itself a formula prefix.

Applied identically on the CSV and XLSX paths; XLSX additionally XML-escapes.

## Permissions and privacy

- Columns are **allow-listed per report** and filtered by role. Requested columns
  can narrow access, never widen it.
- `FORBIDDEN_EXPORT_KEYS` can never be exported under any role: password hashes,
  tokens, receipt/proof URLs, gate access codes, card data.
- Row cap `MAX_EXPORT_ROWS` (10,000) with a helpful 413.
- Every export carries a header block: business name, report title, period,
  **basis line**, currency, record count, generated timestamp, and the mixed-source
  warning when applicable.

## Audit

`ReportExport` + a `REPORT_EXPORTED` audit row record user, report type, format,
period, basis, filters, column keys, record count and success. **The exported
content is never logged** — that would recreate the disclosure the controls exist
to prevent.
