# Admin controls

_Last updated 2026-07-21._

## What exists

The **Email Marketing** section of the admin (`/admin/email-marketing`) is live.
Before 2026-07-21 there was no email admin UI at all: the email system recorded
everything correctly and none of it was readable outside a `psql` prompt.

| Page | Route | What it answers |
|---|---|---|
| Overview | `/admin/email-marketing` | Is email working? What was sent, delivered, blocked, deferred, bounced? What is the top reason mail is being refused? |
| Templates | `/admin/email-marketing/templates` | What emails exist, which are transactional vs promotional, and — the honest column — whether each is actually reachable |
| Template detail | `/admin/email-marketing/templates/[key]` | What fires it, which booking states make it truthful, what data it requires, what stops it, what it has actually done |
| Journeys | `/admin/email-marketing/journeys` | Every automated sequence, its anchor, its stage timings, its stop rules, and what it produced |
| Scheduled | `/admin/email-marketing/scheduled` | What is queued but not yet sent; cancel a pending stage |
| Send history | `/admin/email-marketing/sends` | Every send **and every refusal**, with the reason in plain English |
| Suppressions | `/admin/email-marketing/suppressions` | Who cannot be mailed and why; restore a restorable block |
| Deliverability | `/admin/email-marketing/deliverability` | Whether the provider, webhook, schema and compliance config work **in this container** |
| Campaigns | `/admin/email-marketing/campaigns` | Email → booking → collected revenue → finalized profit (owner only) |
| Settings | `/admin/email-marketing/settings` | Sender identity, caps, quiet hours, flags — read-only, see below |

A per-booking **Email Ledger** card also appears on the job detail page. It sits
beside the existing "Communications" card and is deliberately different:
Communications reads the legacy `Notification` table (what was handed off to be
sent), while the Email Ledger reads `email_sends` (what was *considered*,
including everything refused, with the reason).

## Why Settings is read-only

Every value on that page is an environment variable read by the running
container. A form would appear to save and change nothing until the next
deploy. Change them in Railway, redeploy, then re-check the page — it reads the
live process, which is the only way to prove the deployed container picked the
change up.

## Direct data access (still valid)

| Need | How |
|---|---|
| Turn journeys on/off | `EMAIL_JOURNEYS_ENABLED`, `EMAIL_JOURNEY_<NAME>_DISABLED` |
| Turn post-job follow-ups on/off | `MARKETING_FOLLOWUPS_ENABLED` |
| Turn the referral programme on/off | `REFERRAL_PROGRAM_ENABLED` |
| Change frequency caps / quiet hours | `EMAIL_CAP_*`, `EMAIL_QUIET_*` |
| Find sends stuck mid-flight | `staleClaims()` in `src/lib/email-guard.ts` |
| Sends with an unknown outcome | `ambiguousSends()` — surfaced on the Overview page |

## Operator actions and what they will NOT do

| Action | Permission | Refuses to |
|---|---|---|
| Cancel a scheduled send | `email.cancel_scheduled` | Cancel a job that is already running — the send-time eligibility recheck is what stops that |
| Retry a send | `email.retry_send` | Re-send anything already **delivered**; bypass suppression, eligibility or validation (the next attempt runs the full guard) |
| Restore a suppression | `email.manage_suppression` | Lift a **hard bounce** or a **spam complaint**, ever, from this UI |

Every one of these writes an `AuditLog` row
(`EMAIL_SCHEDULED_CANCELLED`, `EMAIL_SEND_RETRIED`, `EMAIL_SUPPRESSION_RESTORED`).

## What is still missing

Honest list, unchanged where nothing was built:

1. **Journey configuration UI** (editing delays and conditions). The delays are
   code constants today and the admin reads them; a structured config page would
   be enough. A visual journey builder is not supportable by this architecture
   and should not be attempted.
2. **Test-send workflow.** The `email.send_test` permission exists and
   `EMAIL_TEST_RECIPIENT` is reported on the Settings page, but no UI triggers a
   test send. `scripts/email-send-test.ts` is the current path.
3. **Campaign creation from this section.** Email campaigns are
   `MarketingCampaign` rows with `channel=EMAIL`, created on the existing
   Marketing report. The email section reads and scores them; it does not
   duplicate the campaign record.
4. **Audience segmentation / bulk composer.** Not built. Every send today is
   triggered by a real customer event, which is the safer model.
5. **A/B test results** — experiments are not implemented, so there is nothing
   to show.
6. **Open/click reporting** depends on provider tracking being enabled; the
   Overview page says so explicitly rather than rendering a misleading zero.

See [email-admin-permissions.md](./email-admin-permissions.md) and
[email-attribution.md](./email-attribution.md).
