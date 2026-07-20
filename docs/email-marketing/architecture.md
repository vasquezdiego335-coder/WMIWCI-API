# Email architecture — before and after

_Last updated 2026-07-20. Branch `claude/complete-email-marketing-system`._

This describes what is **actually wired**, verified by reading the code and
grepping for callers — not what the file tree suggests exists.

---

## The three systems

| System | Provider | Owns | Repo |
|---|---|---|---|
| **WMIWCI-API** | Resend | Transactional booking mail + post-job follow-ups + (new) lifecycle journeys | this repo |
| **Leadtracking** | SendGrid | The lead drip from the website discount popup (welcome / brand story / urgency / re-engagement) | `C:\Leadtracking` |
| `email-marketing/dist` | — | A 22-template static asset library | archived, wired to nothing |

They are **separate systems with separate databases**. Before this pass they
also had separate, non-communicating opt-out state. See
[suppression.md](./suppression.md) for how that is now bridged.

---

## Send paths

There are **three** code paths that can put a message in front of a customer.
Before this pass each called `resend.emails.send()` directly, and only one of
them had any validation:

| # | Path | Payload validation | Live recheck | Suppression | Text part | Compliance context | Idempotency | Provider retry |
|---|---|---|---|---|---|---|---|---|
| 1 | `src/workers/email.worker.ts` | yes | yes | yes | yes | yes | yes | yes |
| 2 | `src/outbox/services/emailService.ts` | yes | yes | yes | yes | n/a (transactional) | yes | yes |
| 3 | `src/lib/followups.ts` | yes | yes | yes | yes | yes | yes | yes |

**This table was previously wrong** (finding EMAIL-P3-20): it claimed "full
guard" on all three paths when the outbox passed neither a payload nor a
recheck, and follow-ups passed neither payload, text, nor compliance context.
The row values above are now asserted by
`src/lib/__tests__/send-path-conformance.test.ts` rather than maintained by
hand, so this table cannot drift again without a failing build.

All three now call `guardedSend()` in [`src/lib/email-guard.ts`](../../src/lib/email-guard.ts).

### What `guardedSend` does, in order

```
1.  recipient format
2.  suppression check                    ← fails CLOSED
3.  recheck() — LIVE state reload        ← stale queue jobs die here
4.  quiet hours + frequency caps         ← promotional only
5.  assertEmailPayload                   ← required fields + URL safety
5b. marketing context                    ← promotional only; fails CLOSED
6.  CLAIM OR RESUME (EmailSend row)      ← written BEFORE the provider call
7.  provider send (Resend)
8.  mark delivered + record provider id
```

Every refusal writes an `EmailSend` row with a machine-readable `blockedReason`
**and a classification** — `terminal`, `retryable` or `deferred`. That
classification is load-bearing: a quiet-hours deferral or a database outage
leaves the logical send RESUMABLE, while a hard bounce closes it for good.
Before this, every refusal permanently consumed the delivery key, so a
frequency cap silently meant "never".

Step 6 is `claimOrResumeSend()`, not a bare insert. A conflicting idempotency
key does **not** by itself mean "already sent" — only a terminal row stops the
attempt. See `src/lib/email-guard.ts` for the state table.

**A provider outcome we cannot determine** (timeout, crash mid-flight) becomes
`ambiguous` and is **never** auto-resent; `ambiguousSends()` surfaces it for a
human. A duplicate to a real customer is worse than a delayed one.

---

## Data model

Three additive tables (`prisma/migrations/20260720000100_email_lifecycle`):

| Model | Purpose | Key |
|---|---|---|
| `EmailSuppression` | the ONE do-not-send list | `email` unique |
| `EmailSend` | one row per attempted send | `idempotencyKey` unique |
| `EmailEvent` | provider + first-party events | `providerEventId` unique |

Pre-existing and still used: `Notification` (open-pixel tracking),
`FollowUpLedger` (exactly-once post-job follow-ups), `AuditLog`
(`RECEIPT_SENT` = the durable receipt signal), `Lead`, `Review`, `Receipt`.

**There is no `Quote` model.** A `Lead` has `quotedAt`, `estimatedValue`,
`jobType`, `moveDate` — no amount breakdown, no validity window. This
constrains the quote journey; see [segmentation.md](./segmentation.md).

**There is no `receiptSentAt` field.** The durable receipt signal is
`AuditLog where action = RECEIPT_SENT`; its `createdAt` is the time.

---

## Queues and workers

| Queue | Worker | Role |
|---|---|---|
| `email` | `src/workers/email.worker.ts` | renders + sends; `ALLOWED_TEMPLATES` is the choke point |
| `scheduled` | `src/workers/scheduled.worker.ts` | fires journey stages, digests, follow-ups |
| `sms` | `src/workers/sms.worker.ts` | Twilio (gated) |
| `discord` | `src/workers/discord.worker.ts` | owner alerts |
| `marketing` | `src/workers/marketing.worker.ts` | **STUB** — `enrollCustomer()` has a TODO and no provider call |

Journey scheduling lives in [`src/lib/journeys.ts`](../../src/lib/journeys.ts).

---

## Public routes

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/api/email/open` | GET | token | 1×1 open pixel → `Notification` |
| `/api/email/unsubscribe` | GET, POST | signed HMAC token | RFC 8058 one-click + human page |
| `/api/email/webhook` | POST | Svix signature | Resend bounce / complaint / delivery |
| `/api/email/suppression` | GET, POST | shared secret header | cross-system suppression (Leadtracking) |

---

## What is still a stub

- `src/lib/marketing.ts` — `enrollCustomer()` logs and returns. No ESP call.
- Admin email-marketing UI — does not exist. See [admin-controls.md](./admin-controls.md).
- A/B testing — no assignment, no experiment records. Not built.
- Revenue attribution — UTM tags are emitted on quote-journey links, but nothing
  reads them back. See [tracking-and-attribution.md](./tracking-and-attribution.md).
