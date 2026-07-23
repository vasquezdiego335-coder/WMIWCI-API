# Automation builder

_Last updated 2026-07-21._ Source: `src/lib/email-automation.ts`.
Admin: `/admin/email-marketing/automations`.

An automation is a **trigger**, an optional approved **audience**, and ordered
**stages** (delay → approved template), with stop rules, caps and quiet hours.
Declarative, validated, versioned. Not a scripting surface.

## What an automation cannot do — structurally, not by policy

* Name a trigger outside `APPROVED_TRIGGERS`.
* Name a template outside the registry.
* Send a **transactional** template (those state a fact about one specific
  booking; broadcasting one is how a customer gets a receipt for a payment that
  never happened).
* Express a condition — there is no expression field, only an approved segment.
* Bypass suppression, eligibility, frequency caps, the postal-address rule, the
  unsubscribe requirement, the live booking-state recheck, or idempotency. It
  does not send: it schedules through the same journey machinery, which sends
  through `guardedSend`.

## Approved triggers

`lead_created`, `quote_created`, `booking_started`, `booking_abandoned`,
`booking_confirmed`, `payment_captured`, `move_date_approaching`,
`move_completed`, `move_finalized`, `review_eligible`, `referral_eligible`,
`customer_inactive`.

## States

```
DRAFT → VALIDATING → TEST → ACTIVE ⇄ PAUSED → ARCHIVED
```

`DRAFT → ACTIVE` and `VALIDATING → ACTIVE` are refused. An automation must be
rehearsed in **TEST** first: validation proves the shape, TEST proves a human
looked at the resulting email. Activation re-validates the stored definition.

## Versioning

Definitions are **immutable**. Saving writes a new `EmailAutomationVersion` row;
a version row is never updated (asserted by test). The queue job id carries the
version — `automation:<id>:v<version>:<stage>:<subject>` — so a new version
cannot silently overwrite a job scheduled under different rules, while a
re-fired trigger under the *same* version still dedupes.

**Saving a new version of an ACTIVE automation pauses it.** A rule change must
never take effect on live customers without a deliberate re-activation.

## Read-time validation

Stored definitions are validated when they are read. One that became invalid is
reported as invalid in the admin rather than described as if it would run.
