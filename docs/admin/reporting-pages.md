# Reporting pages

| Route | Report | Required permission |
| --- | --- | --- |
| `/admin/reports` | Overview + index | `report.view_financial` (index links degrade by role) |
| `/admin/reports/profit-loss` | P&L vs previous period | `report.view_financial` |
| `/admin/reports/revenue-profit` | Revenue vs profit per move | `report.view_financial` |
| `/admin/reports/moves` | Move profitability table | `report.view_operational` |
| `/admin/reports/variance` | Estimate vs actual | `report.view_operational` |
| `/admin/reports/marketing` | Profit ROAS by source | `report.view_marketing` |
| `/admin/reports/customers` | Customer profitability | `report.view_operational` |
| `/admin/reports/pricing` | Comparables + break-even | `pricing.view_intelligence` |

All are behind the middleware matcher and the admin layout redirect.

## Shared behavior

Every page renders `FilterBar` (a plain GET form, so filters survive reload,
bookmarking and sharing and work without JavaScript), then `BasisStrip`, then
either an `EmptyState` or the data.

## Mobile and accessibility

- Metric grids use `auto-fill / minmax`, so cards stack on a phone.
- Tables scroll inside their own container; the page body never scrolls sideways.
- Inputs and buttons are **44px minimum** with 16px text (no iOS zoom-on-focus).
- `<th scope="row">` on row headers; `role="alert"` on warnings and failures.
- Loss is shown with a sign and the word "(loss)", never colour alone.
- A glossary `<details>` on the overview explains finalized, provisional, cash
  basis, accrual basis, cash profit, economic profit, Profit ROAS and break-even.

## Empty, loading and error states

| State | Rendering |
| --- | --- |
| `OK` | the data |
| `EMPTY` | "Nothing in this period" |
| `NO_VERIFIED_DATA` | "No verified data available" — moves exist, none finalized |
| `UNAVAILABLE` | red alert; the report could not be calculated |
| permission denied | explanatory panel, no numbers |
