# Audience segments

_Last updated 2026-07-21._ Source: `src/lib/email-audience.ts`.
Admin: `/admin/email-marketing/audiences`.

## The design is closed, not open

An audience builder is the natural place for someone to reach for "just let the
owner write a query". That would put arbitrary database access behind a web
form, and a mistake in it mails the wrong people — which, unlike a bad report,
cannot be undone.

So:

* a segment is chosen from a **fixed list** of hand-written queries;
* filters are chosen from a **fixed list** of keys with validated value types;
* an unknown segment or filter is **rejected** on write and again on read —
  there is no pass-through branch, no string interpolation into a query, and no
  field a Prisma fragment could occupy;
* every query is **bounded** (`MAX_AUDIENCE = 5000`). There is no unbounded scan.

An unknown filter is rejected rather than ignored: silently dropping it would
let an owner believe their audience is narrower than the one that actually
sends.

## Approved segments

`new_leads_no_booking`, `quoted_leads_no_booking`, `abandoned_booking`,
`completed_customers`, `repeat_customers`, `first_time_customers`,
`review_eligible`, `referral_eligible`, `reengagement_eligible`.

## Approved filters

`serviceType`, `serviceAreaZone`, `originCity`, `originZip`, `marketingSource`,
`campaignSourceKey`, `locale`, `movedAfter`, `movedBefore`, `inactiveDays`.

Each declares the only shape its value may take. `locale` accepts `en`/`es` and
nothing else; `originZip` must be five digits; dates must parse; an inverted
date range is refused.

## Every preview names its exclusions

| Reported separately |
|---|
| Invalid email address |
| Unsubscribed |
| Hard bounce |
| Spam complaint |
| Other suppression |
| Marketing opt-out (TCPA `Customer.marketingOptOut`) |
| Duplicate address |

Internal test bookings are excluded at the query. When a segment hits the
candidate cap the preview says the real audience is larger — a truncated count
that looks complete is worse than no count.

## A preview is not authorization

`previewAudience()` and `resolveAudienceForDispatch()` are deliberately separate
functions. The audience is recomputed from scratch at dispatch, and every
individual message still passes the send guard. An audience previewed on Monday
can never be the list that mails on Friday.
