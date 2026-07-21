# Email admin permissions

_Last updated 2026-07-21._ Source: `src/lib/permissions.ts`.
Tests: `email-admin.test.ts`, `email-admin-features.test.ts`.

## BETA: owner-only

While `EMAIL_MARKETING_BETA` is true, **every** `email.*` action is owner-only.
Managers, crew and signed-out visitors are denied — server-side, in the section
layout, in each page, and again in each of the nine API routes. A test asserts
all four roles against all ten actions.

## Lifting Beta

`EMAIL_BETA_OWNER_ONLY` names the three actions that are owner-only *only*
because of Beta:

```
email.view · email.cancel_scheduled · email.send_test
```

When the staging scenarios pass, delete those three entries from `OWNER_ONLY`.
Managers then gain exactly that much — view operational state, cancel a queued
send, send a test to the approved recipient — and no more.

## Permanently owner-only

| Action | Why |
|---|---|
| `email.view_recipients` | The full recipient list *is* the customer list. Managers see the complete operational record with addresses masked. |
| `email.view_attribution` | Ends in finalized company net profit — the line already drawn by `money.view_company_profit`. |
| `email.manage_journey` | Pausing a journey silently stops customer communication, including move-day reminders. |
| `email.retry_send` | A retry can put a second copy in a real inbox. |
| `email.manage_suppression` | Re-opens mail to someone who asked us to stop. |
| `email.manage_campaign` | Activating a campaign mails a whole audience. |
| `email.configure` | Governs every customer send. |

## Narrower than the permission

Holding `email.manage_suppression` is **not** enough to lift any block. The
server refuses `HARD_BOUNCE` and `SPAM_COMPLAINT` outright, requires a reason,
and audits the change. The delete is conditional on the reason that was read, so
a complaint landing mid-request survives.

Similarly, `email.retry_send` cannot re-send a **delivered** email, and
`email.send_test` cannot reach an arbitrary address without an explicit
acknowledged override.
