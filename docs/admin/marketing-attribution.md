# Marketing attribution

## Models

| Model | Resolves to |
| --- | --- |
| `FIRST_TOUCH` | how the customer originally found the business |
| `LAST_TOUCH` | the final known interaction before booking |
| `BOOKING` | owner-assigned source if set, else booking, else last, else first |
| Profit attribution | FINALIZED company net profit on moves credited to that source |

## Rules

- **First touch is IMMUTABLE.** `canCorrectAttribution()` refuses to overwrite it
  and directs the correction to `ownerAssignedSource`. Overwriting it would
  destroy the only evidence of where a customer came from.
- **Nothing is invented.** An absent source resolves to `UNKNOWN`; `DIRECT` and
  `OWNER_ASSIGNED` are the other honest values.
- A fallback to an older touch is FLAGGED `inferred: true`.
- Every correction requires a reason and is audited (`ATTRIBUTION_CORRECTED`).

## Fields

first/last touch source + campaign, booking source + campaign, owner-assigned
source, UTM source/medium/campaign/content, QR campaign — all additive and
nullable on `Booking`. Historical bookings were seeded once from the existing
`source`/`foundUs` at migration time.
