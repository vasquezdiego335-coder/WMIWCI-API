# Email admin integration — architecture

_Last updated 2026-07-21. Branch `claude/email-admin-integration`._

## Where the documentation lives

This directory holds the **admin integration** built on 2026-07-21. The email
*engine* was documented earlier and those documents are still current:

| Topic | Document |
|---|---|
| Send-path architecture, the guard, the state machine | [../email-marketing/architecture.md](../email-marketing/architecture.md) |
| Triggers and stop rules | [../email-marketing/triggers-and-stop-rules.md](../email-marketing/triggers-and-stop-rules.md) |
| Suppression + unsubscribe | [../email-marketing/suppression.md](../email-marketing/suppression.md) |
| Provider webhooks | [../email-marketing/deliverability.md](../email-marketing/deliverability.md) |
| Rollback | [../email-marketing/rollback.md](../email-marketing/rollback.md) |

They are **not** duplicated here. A second copy of a document is a second thing
to keep true.

## What this pass added

| Layer | File |
|---|---|
| Template + journey registry | `src/lib/email-registry.ts` |
| Admin read queries | `src/lib/email-admin.ts` |
| Attribution (read-only over finance) | `src/lib/email-attribution.ts` |
| Audience builder | `src/lib/email-audience.ts` |
| Campaign lifecycle | `src/lib/email-campaign.ts` |
| Journey configuration | `src/lib/email-journey-config.ts` |
| Automation definitions | `src/lib/email-automation.ts` |
| Test sends | `src/lib/email-test-send.ts` |
| Template rendering (admin-side) | `src/lib/email-render.ts` |
| 14 admin pages | `app/(admin)/admin/(dashboard)/email-marketing/**` |
| Customer timeline | `app/(admin)/admin/(dashboard)/customers/[id]/page.tsx` |
| Per-booking ledger | `app/(admin)/admin/(dashboard)/jobs/[id]/EmailTimeline.tsx` |
| 9 admin API routes | `app/api/admin/email-marketing/**` |

## The rule every module here follows

**Nothing invents a fact another module owns.** Transactional/promotional
classification comes from `email-guard.classifyTemplate`; truthful booking
states from `emails/status.ts`; required fields from `emails/validation.ts`;
journey timings from the `journeys.ts` constants; campaign identity and
attribution from the Stage 3 models. The admin adds the editorial layer nothing
else owned — the trigger in English, the stop rules, and whether a template is
actually reachable.

## Honesty rules the read layer enforces

1. **Never invent a denominator.** A delivery rate over zero sends is `null`,
   rendered `—`, and every rate carries its counts.
2. **Unavailable is not empty.** A queue that cannot be read is reported as
   unreadable and the API returns 503. An empty list would read as "nothing is
   scheduled" — the opposite of the truth.
3. **An unmapped block reason is shown verbatim**, never paraphrased.
4. **DNS is never inferred.** SPF/DKIM/DMARC are `VERIFIED | UNVERIFIED |
   MISSING | INVALID`, and `VERIFIED` requires an operator attestation *with a
   date*. A `VERIFIED` claim with no `EMAIL_DNS_VERIFIED_AT` is downgraded.
5. **Test sends are excluded** from every conversion, revenue, profit and
   frequency-cap figure.

## Why the admin has its own renderer

`src/workers/email.worker.ts` constructs a BullMQ Worker at import time.
Importing it from a Next.js route would open Redis and start consuming the email
queue inside the web process. `email-render.ts` holds the component map instead,
and a conformance test asserts it covers every key in the worker's
`ALLOWED_TEMPLATES`.
