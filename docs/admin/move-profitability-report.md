# Move-profitability report

## Columns

Move ID - customer - move date - financial status - service type - pickup city -
destination city - stops - crew size - scheduled hours - actual hours - net
billed - net collected - outstanding - direct expenses - labor - truck - cash
gross profit - economic profit - allocated overhead - company net profit -
margin - profit per crew hour - revenue per crew hour - estimate variance -
marketing source - repeat customer - finalized/provisional.

Every money column comes from the snapshot for finalized moves and from live
Stage 2 math for provisional ones, with the row's status shown.

## Filters and sorting

Filters: date - financial status - job status - service - city - state - crew
member - crew size - truck source - marketing source - customer type -
profitable/break-even/loss - missing closeout - missing labor - outstanding
balance - refund - dispute.

Sorts: highest revenue/profit/margin - lowest profit/margin - highest labor cost -
longest move - largest estimate variance - largest outstanding balance - most
recent - oldest unclosed.

## Saved views

Stored as validated FILTER OBJECTS in `SavedReportView` — never raw query code.
Suggested: loss-making moves, high-profit moves, missing closeout, missing labor,
outstanding balances, large refunds, low-margin moves, owner review required.

**Status:** the filter/sort/saved-view model and storage exist; the table UI and
its HTTP route are deferred (see stage3-reporting-analytics.md limitations).
