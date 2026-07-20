# Report permissions

| Action | OWNER | MANAGER | CREW |
| --- | :-: | :-: | :-: |
| `report.view_operational` | yes | yes | no |
| `report.view_marketing` | yes | yes | no |
| `report.view_financial` | yes | **no** | no |
| `report.view_owner_money` | yes | no | no |
| `report.view_worker_pay` | yes | no | no |
| `report.export` | yes | yes | no |
| `report.export_sensitive` | yes | no | no |
| `report.save_shared_view` | yes | no | no |
| `marketing.manage_campaign` | yes | yes | no |
| `marketing.record_spend` | yes | yes | no |
| `marketing.correct_attribution` | yes | no | no |
| `pricing.view_intelligence` | yes | yes | no |

A manager runs operations — move lists, estimate variance, marketing performance —
**without seeing what the company earns**, owner equity activity, or cross-worker
pay. Exports containing profit or pay are owner-only even where the on-screen
report is not.

Column-level enforcement is separate and additive: `visibleColumns()` filters by
role, so a permitted export still cannot leak an owner-only column.

**Not yet implemented:** ACCOUNTANT, CREW_LEADER and READ_ONLY are specified but
`UserRole` still has only OWNER/MANAGER/CREW. Adding them is a Stage 4 task.
