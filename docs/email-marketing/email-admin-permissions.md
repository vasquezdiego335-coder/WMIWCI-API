# Email admin permissions

_Last updated 2026-07-21._

Enforced in `src/lib/permissions.ts` and asserted by
`src/lib/__tests__/email-admin.test.ts`. Every rule is checked on the **server**
— in the section layout, in each page, and again in each API route. Hidden
navigation is never the gate.

## The principle

A **manager runs email operations**. They can see what was sent, what bounced,
and why something did not go out — that is what they need to answer a customer
on the phone. They do **not** hold the controls that change what customers
receive, expose the full customer email list, or reveal company profit.

## Matrix

| Action | Owner | Manager | Crew |
|---|---|---|---|
| `email.view` — overview, templates, journeys, delivery state | ✅ | ✅ | ❌ |
| `email.cancel_scheduled` — cancel a pending queued send | ✅ | ✅ | ❌ |
| `email.send_test` — send to the approved test recipient | ✅ | ✅ | ❌ |
| `email.view_recipients` — full recipient addresses | ✅ | ❌ | ❌ |
| `email.view_attribution` — revenue and finalized profit | ✅ | ❌ | ❌ |
| `email.manage_journey` — pause or resume a journey | ✅ | ❌ | ❌ |
| `email.retry_send` — re-drive a non-delivered send | ✅ | ❌ | ❌ |
| `email.manage_suppression` — restore a restorable block | ✅ | ❌ | ❌ |
| `email.manage_campaign` — create/activate/pause a campaign | ✅ | ❌ | ❌ |
| `email.configure` — sender identity, caps, quiet hours | ✅ | ❌ | ❌ |

## Why each owner-only line is owner-only

- **`email.view_recipients`** — the full recipient list *is* the customer list.
  A manager sees the complete operational record (template, status, block
  reason) with addresses masked as `di••••@gmail.com`. Masking happens on the
  **server**, before the data reaches the page, so opening devtools does not
  reveal the address. The API routes apply the same rule, so they are not a way
  around the UI.
- **`email.view_attribution`** — this reporting ends in **finalized company net
  profit**. It sits on the authority line already drawn by
  `money.view_company_profit` and `report.view_financial`.
- **`email.manage_journey`** — pausing a journey silently stops customer
  communication, including move-day reminders. That is a business decision.
- **`email.retry_send`** — a retry can put a second copy of an email in a real
  customer's inbox.
- **`email.manage_suppression`** — lifting a suppression re-opens mail to
  someone who asked us to stop.
- **`email.configure`** — these settings govern every customer send.

## Crew

Crew are blocked from `/admin` and `/api/admin` by middleware, and `can()`
returns false for every email action regardless. Both layers are tested.

## Suppression restore is narrower than the permission

Holding `email.manage_suppression` is **not** enough to lift any block. The
server refuses `HARD_BOUNCE` and `SPAM_COMPLAINT` outright:

- a complaint is the recipient telling a mailbox provider we are spam, and
  re-sending damages the sending domain for every other customer;
- a hard bounce means the mailbox does not exist, so the fix is correcting the
  address on the customer record.

Restorable reasons are `UNSUBSCRIBED`, `ADMIN_BLOCK` and `INVALID_ADDRESS`, a
reason string is required, and the action writes an
`EMAIL_SUPPRESSION_RESTORED` audit row recording the previous reason and scope.

The delete is a **conditional** `deleteMany` filtered on the reason that was
read. If a hard bounce or complaint lands between the check and the delete, the
row no longer matches and the stronger block survives — the same race-guard
pattern `resubscribe()` uses.
