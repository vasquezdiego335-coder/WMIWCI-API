# Suppression and unsubscribe

_Last updated 2026-07-20._

## Before

The only opt-out signal in this API was `Customer.marketingOptOut`, set
**exclusively** by the inbound-SMS `STOP` webhook. There was:

- no way to record an **email** unsubscribe (the route did not exist);
- no processing of **bounces** or **spam complaints** at all — Resend's webhook
  was never configured and no handler existed;
- no shared state with Leadtracking, so one unsubscribe stopped one system.

Promotional mail with no working unsubscribe is a CAN-SPAM violation. This was
the single largest release blocker.

## Now

### The list

`EmailSuppression`, keyed on the **lowercased address** — not a Customer or Lead
id — so one list covers Customers, Leads, and contacts only Leadtracking knows.

| Reason | Scope | Set by |
|---|---|---|
| `UNSUBSCRIBED` | `promotional` | unsubscribe link, SMS STOP, Leadtracking |
| `HARD_BOUNCE` | `all` | Resend webhook |
| `SPAM_COMPLAINT` | `all` | Resend webhook |
| `INVALID_ADDRESS` | `all` | admin / provider |
| `ADMIN_BLOCK` | `all` | admin |
| `PROVIDER_REJECTED` | `all` | provider |

**Two scopes, deliberately.** `promotional` stops marketing but still allows
booking receipts and move-day details — that distinction is the law's, not a
loophole: a receipt is not an offer. `all` stops everything, transactional
included, because writing to a dead or complaining address damages sending
reputation for every other customer.

### Rules

- **Reads fail CLOSED.** A database error returns `suppressed: true`
  (`suppression_read_failed`). A transient outage never becomes a send.
- **Escalation is one-way.** A later, more severe signal widens the scope; an
  unsubscribe can never downgrade an existing `all` block.
- **Idempotent.** Re-suppressing is a no-op that never rewrites the original reason.
- **`resubscribe()` refuses to lift an `all` block.** A hard bounce or complaint
  is not something a customer can click their way out of; that needs an admin.

### Mirroring

`unsubscribeEmail()` also sets `Customer.marketingOptOut = true`, so the older
guards that read that flag (SMS follow-ups) agree with the new list. One opt-out,
honoured by every path.

## Unsubscribe

`GET|POST /api/email/unsubscribe?token=…`

- **No login.** The signed HMAC token *is* the authorization.
- **Not enumerable.** The token binds to the address; the address never appears
  in the URL, so it cannot leak via referrer headers or server logs.
- **POST** = RFC 8058 one-click (what Gmail/Yahoo call from the client's own
  "unsubscribe" button). Succeeds with no page and no confirmation step.
- **GET** = the human page, with a resubscribe option.
- **Idempotent.** Unsubscribing twice is a success.
- Tokens last ~13 months (`DEFAULT_MAX_AGE_MS`) — an unsubscribe link in a
  year-old email must still work; that is a legal expectation, not a convenience.

`List-Unsubscribe` + `List-Unsubscribe-Post` headers are attached by
`guardedSend` to every promotional message, using a link derived from the
**recipient**, not from the payload — a queued job cannot smuggle in someone
else's link.

## Cross-system

`/api/email/suppression` (shared secret in `x-suppression-key`):

- `GET ?email=` — Leadtracking asks before every promotional send.
- `POST {email, reason}` — Leadtracking pushes its own unsubscribes/bounces in.

Disabled (503) unless `EMAIL_SUPPRESSION_API_KEY` is set. An unauthenticated
suppression endpoint would be both a customer-enumeration oracle and a way to
silence real customers.

**Not yet done:** Leadtracking has its own `backend/lib/suppression.js` with the
same fail-closed shape, but it does **not yet call** this API. Wiring that is a
one-function change in Leadtracking's `check()`; it is listed as a limitation,
not claimed as complete.
