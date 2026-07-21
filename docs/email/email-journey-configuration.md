# Journey configuration

_Last updated 2026-07-21._ Source: `src/lib/email-journey-config.ts`.
Admin: `/admin/email-marketing/journeys/[key]`.

Owners can change journey delays, caps, quiet-hour behaviour and stop rules.
Three properties make that safe.

## 1. The code constants remain the safe defaults

`src/lib/journeys.ts` is still the source of truth. A **missing** row, a
**disabled** row and an **invalid** row all mean "use the defaults" — never
"send with whatever is in the database".

## 2. It fails closed

Validation runs on write *and again on read*. A row edited directly in the
database to set every delay to zero does not produce an instant four-email
burst: it fails validation, the journey degrades to the code defaults, and the
admin shows the reason.

## 3. It is versioned

`version` increments on every save and is stamped onto sends scheduled under it
(`EmailSend.journeyConfigVersion`). Editing a delay never rewrites why a send
already in flight was scheduled when it was.

## Three kinds of stage

| Kind | Rule |
|---|---|
| **Immediate** (default delay 0) | Must stay at 0. A confirmation or receipt fires the moment its event happens; a delayed receipt reads to a customer as a broken system. |
| **Countdown** (default delay negative) | Negative, between 5 minutes and 30 days before the anchor. |
| **Follow-up** (default delay positive) | Between 5 minutes and 180 days, and each stage must be later than the one before. |

A stage type the worker cannot dispatch, or a template that is not registered,
is rejected.

## Locked stop rules

`stopAfterUnsubscribe`, `stopAfterHardBounce` and `stopAfterComplaint` are
**forced on** regardless of what is submitted. They are enforced by the
suppression list inside the send guard, so a toggle that appeared to disable
them would be showing the owner something untrue. They are displayed as locked
rather than hidden, so the protection is visible.

## Reset

`DELETE` removes the row. With no row, `effectiveConfig()` returns the code
defaults — so "reset" and "never configured" are the same state rather than two
subtly different ones.

## Nothing executable is stored

Stop rules are booleans from a fixed list, each mapping to a real check in the
send path. There is no expression language and no field to put one in.
