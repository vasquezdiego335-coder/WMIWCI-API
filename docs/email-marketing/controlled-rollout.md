# Controlled rollout — turning the lifecycle on without a bad week

_Owner spec 2026-08-06. Companion to [production-rollout.md](./production-rollout.md)
(which covers the infrastructure) and [lifecycle-matrix.md](./lifecycle-matrix.md)
(which covers the rules)._

Merging PR #32 changed nothing about what sends. Every sequence it touches is
behind a flag that is off, and the flags that already existed only ever got
**tighter**. This document is about the step after that.

---

## The problem this solves

Before today a journey had two settings: **off**, and **on for every eligible
person**. `EMAIL_JOURNEYS_ENABLED=true` is one keystroke that turns a sequence
loose on the whole eligible database, and the first evidence that a link is
wrong or the copy reads badly arrives as replies from real customers.

There is now a third setting: **on, for these addresses only.**

```
EMAIL_PROMOTIONAL_ALLOWLIST=diego@moveitclearit.com,@moveitclearit.com
```

- **Unset means no restriction.** An empty variable must never mean "block
  everything" — a typo, or a value that failed to reach one of the two Railway
  services, would become a silent and total marketing outage. Restriction is
  opt-in.
- **Promotional only.** A canary never delays a receipt, a booking confirmation
  or a move-day reminder.
- An entry is a full address, or `@domain` for the whole team.
- A refusal is recorded as `not_in_rollout_allowlist` and is **retryable**, not
  terminal: a real lead captured during the canary does not have its idempotency
  key burned, so widening the list can still let the send happen.

It is enforced in **two** places, like every other rule here — the schedulers
refuse to enqueue, so the queue does not fill with certain refusals, and
`guardedSend` refuses again immediately before the provider call.

---

## Before anything: run the preflight

```bash
npx tsx scripts/email-rollout-preflight.ts
```

Read-only — it opens no queue, enqueues nothing, sends nothing, writes nothing,
and never prints a customer address. It reports the switches, the canary, the
configuration a promotional send actually requires, how many real people are on
the other side of each flag, and any stuck state worth clearing first.

**Run it on the server, not just locally.** Sections 1–3 describe the process
it runs in; only sections 4–8 describe the shared database.

```bash
railway run --service <api-service> npx tsx scripts/email-rollout-preflight.ts
```

### What it said here, on 2026-08-06

Against the production database, from a laptop:

| | |
|---|---|
| Leads opted in | **5** (0 declined, 1 never asked) |
| Customers opted in | **1** (0 declined, 6 never asked) |
| Suppressed addresses | 1 |
| Eligible for Sequence A on next capture | 0 |
| Eligible for Sequence B on next capture | 4 |
| Sends in the last 7 days | 1, transactional, delivered |
| Ambiguous / dead-lettered / stuck | none |

**The audience is five people.** That is the single most useful fact in this
document: there is no scenario where flipping these flags produces a blast. It
also means a canary of one or two addresses is a meaningful fraction of the
list, and a full launch is a small event — plan accordingly, and do not talk
yourself into skipping stages because "it's only five".

The three blockers it reported were in the **local** `.env`
(`BUSINESS_POSTAL_ADDRESS`, `EMAIL_TOKEN_SECRET`, `RESEND_WEBHOOK_SECRET`).
Whether they are set on Railway is a separate question, and the reason step 0
below exists.

---

## The stages

Do not compress these. Each one exists because something can only be observed
at that stage.

### Stage 0 — verify the server, change nothing

```bash
railway run --service <api> npx tsx scripts/email-rollout-preflight.ts
railway run --service <workers> npx tsx scripts/email-rollout-preflight.ts
```

Both must report **no blockers**. In particular:

- `BUSINESS_POSTAL_ADDRESS` — without it *every* promotional send is refused
  with `missing-configuration:marketing-context:…`. That is correct behaviour
  (we do not ship a non-compliant email), but it looks exactly like an outage
  if you are not expecting it.
- `EMAIL_TOKEN_SECRET` — without it the unsubscribe link cannot be signed.
- `RESEND_WEBHOOK_SECRET` — without it bounces and complaints are never
  suppressed, and the domain degrades quietly.

Deploy `main` to both services. Confirm `/api/health` is green. **Nothing new
sends at this point** — this is a safe resting place, and it is worth sitting
in it for a day.

### Stage 1 — the canary, one address, one sequence

```
EMAIL_PROMOTIONAL_ALLOWLIST=<your own address>
EMAIL_JOURNEYS_ENABLED=true
EMAIL_JOURNEY_ABANDONED_DISABLED=true
EMAIL_JOURNEY_REMINDERS_DISABLED=true
EMAIL_JOURNEY_LEAD_NURTURE_DISABLED=true
```

Quote follow-up only, to you only. Then **be the customer**:

1. Open the quick quote, tick the consent box, submit with your own address.
2. Confirm the immediate `quote-request-received` arrives, and that the number
   in it is the number the page showed.
3. Confirm the lead now has `quotedAt` set and three jobs are queued.
4. Wait for stage 1 of the follow-up (24h — or temporarily shorten the delay in
   the admin's journey config if you would rather not wait a day).
5. **Click the unsubscribe link.** Confirm the confirmation page, then confirm
   the remaining stages stop and a `quote-request-received` for a *new* quote
   still arrives. That is the two-scope suppression list doing its job, and it
   is the single most important thing to see with your own eyes.

Check the ledger after each step:

```sql
select template, status, blocked_reason, created_at
from email_sends order by created_at desc limit 20;
```

### Stage 2 — widen to the team, add the second sequence

```
EMAIL_PROMOTIONAL_ALLOWLIST=@moveitclearit.com
EMAIL_JOURNEY_LEAD_NURTURE_DISABLED=   (remove it)
```

Submit the **contact form** with a team address and the box ticked; confirm the
nurture sequence starts and that its copy mentions no price and no checkout.
Submit it again with the box **unticked**; confirm nothing schedules and the
log says `no_marketing_consent`.

Then submit as a **previous customer** — an address with a completed booking —
and confirm the refusal is `previous_customer`, not a welcome email.

### Stage 3 — one real customer at a time

Add individual customer addresses to the allowlist as you gain confidence.
This is the stage that has no fixed length; it ends when you stop learning
anything from each addition.

### Stage 4 — remove the allowlist

```
EMAIL_PROMOTIONAL_ALLOWLIST=   (unset)
```

Promotional mail now reaches every eligible person — which today is about five
people, and grows only as new leads opt in.

### Stage 5 — the post-move sequence, last

```
MARKETING_FOLLOWUPS_ENABLED=true
```

Requires `GOOGLE_REVIEW_URL` to be a real destination, and a genuinely
completed booking whose customer opted in. Keep the allowlist narrow again for
this one: it is the sequence most likely to reach somebody at an emotionally
loaded moment, and the referral ask has money attached.

---

## Aborting

One variable stops everything, transactional included:

```
EMAIL_SENDING_ENABLED=false
```

It is recorded as a **deferral**, not a failure, so every held send resumes
when you set it back. Use it if something is visibly wrong and you need to
think. To stop only marketing, narrow the allowlist instead — e.g. back to your
own address — which leaves receipts and move-day details flowing.

To stop **one** sequence, use its own flag
(`EMAIL_JOURNEY_QUOTE_DISABLED=true`) rather than the master switch.

---

## What deliberately does not happen

- **No historical enrolment.** Both new sequences are anchored to a live event
  — a quote being recorded, a lead being captured. Turning a flag on does not
  reach back into the database. The 4 leads the preflight lists as "eligible on
  next capture" will not receive anything until that person acts again.
- **No consent backfill.** The 6 customers and 1 lead at `null` stay `null`.
  They are not "unconsented" — they were never asked, and the only way that
  changes is a form they tick themselves.
- **No re-subscription by form.** A suppressed address that ticks a box on a
  new form stays suppressed.

---

## Verifying afterwards

The question the ledger should always be able to answer is *why did this person
get this email, or not*:

```sql
-- everything about one address
select template, email_class, journey, status, blocked_reason, outcome_class,
       attempts, provider_id, sent_at, created_at
from email_sends where email = $1 order by created_at desc;

-- the shape of refusals across the rollout
select blocked_reason, count(*) from email_sends
where created_at > now() - interval '7 days' and blocked_reason is not null
group by 1 order by 2 desc;
```

`not_in_rollout_allowlist` appearing in that second query is the canary
working. `no_marketing_consent` appearing is the consent gate working. Neither
is a bug; a week with **neither** of them and a wide allowlist is worth a
second look.
