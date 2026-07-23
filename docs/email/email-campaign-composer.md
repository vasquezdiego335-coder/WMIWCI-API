# Campaign composer

_Last updated 2026-07-21._ Source: `src/lib/email-campaign.ts`,
`app/api/admin/email-marketing/campaigns/route.ts`.
Admin: `/admin/email-marketing/campaigns`.

An email campaign is a **`MarketingCampaign` with `channel = EMAIL`** plus a 1:1
`EmailCampaignConfig`. There is no second campaign record, so every channel is
reported by one attribution system.

## Lifecycle

```
DRAFT → VALIDATING → READY → SCHEDULED → ACTIVE → COMPLETED
                       ↑         ↓          ↓
                    (owner    PAUSED ←──────┘
                   approval)     ↓
                              CANCELLED / FAILED → ARCHIVED
```

**Creation and dispatch are different events.** `POST` always creates a `DRAFT`;
there is no `status` parameter and no code path that creates an ACTIVE campaign.
A test asserts this against the route source, because it is the single most
dangerous possible regression.

`DRAFT → ACTIVE` and `DRAFT → SCHEDULED` are **not** legal transitions.

## Validation

Errors block; warnings do not. Blocking on preferences trains people to bypass
the validator.

**Errors:** missing name / source key / audience; unregistered template; a
**transactional** template (a receipt states that one specific person paid —
broadcasting it tells people about payments that did not happen); malformed
source key; `BUSINESS_POSTAL_ADDRESS` unset for a promotional template; `APP_URL`
unset or failing the production URL gate; a scheduled time in the past.

**Warnings:** the template's flag is off in this environment; no UTM values; a
very long subject.

## Approval

Separate from validation. Validation asks "is this well-formed?"; approval asks
"does a human with authority accept sending it?" Approval requires a **passing
and recent** validation — a pass older than 24 hours is refused, because
configuration, suppression and the audience all move, and approving on a stale
check approves a campaign that no longer exists.

Any edit clears the approval and the validation result.

`SCHEDULED` and `ACTIVE` are refused server-side without `approvedAt`.

## Arbitrary HTML

Not accepted, anywhere. A campaign names a registered template and validated
variables.
