# Deliverability

_Last updated 2026-07-20._

## Verified in code

| Item | State |
|---|---|
| Plain-text multipart | ✅ every queued send renders a `text` part |
| `List-Unsubscribe` + `List-Unsubscribe-Post` | ✅ on promotional mail, link derived from the recipient |
| One-click unsubscribe endpoint | ✅ `POST /api/email/unsubscribe` (RFC 8058) |
| Bounce webhook | ✅ `/api/email/webhook`, Svix-signature-verified |
| Complaint webhook | ✅ same route |
| Webhook signature validation | ✅ constant-time, replay-guarded (±5 min) |
| Hard vs soft bounce | ✅ only permanent bounces suppress |
| Consistent sender name / reply-to | ✅ `EMAIL_FROM`, `EMAIL_REPLY_TO` |
| No secrets in source | ✅ all via env |
| Reasonable HTML size | ✅ 14–37 KB per template (previews) |
| Image host | hosted PNG/GIF at `EMAIL_ASSET_BASE_URL` |
| Unsafe-URL rejection | ✅ `unsafeUrlReason` blocks `#`, empty, `javascript:`, localhost, `*.vercel/ngrok/railway.app`, non-https |

## NOT verified — treat as unknown

These require access to the DNS zone and the Resend dashboard, which this pass
did not have. **The presence of an env var is not evidence that DNS is correct.**

| Item | Status | How to verify |
|---|---|---|
| SPF | ❓ unverified | `dig TXT moveitclearit.com` — expect a `v=spf1` record including Resend |
| DKIM | ⚠️ previously reported OK for `moveitclearit.com` outbound (2026-07-15 audit), **not re-checked** | Resend dashboard → Domains |
| DMARC | ❓ unverified | `dig TXT _dmarc.moveitclearit.com` |
| Return-path alignment | ❓ unverified | Resend dashboard |
| Tracking domain | ❓ unverified | Resend dashboard |
| `RESEND_WEBHOOK_SECRET` configured | ❓ **must be set or the webhook returns 503** | env + Resend dashboard |

Known from a prior audit: **`wemoveitweclearit.com` has no MX record**, so mail
to `info@` there bounces. The live sending domain is `moveitclearit.com`.

## Required environment

| Var | Purpose | Failure mode if unset |
|---|---|---|
| `RESEND_API_KEY` | provider | placeholder key → sends fail |
| `RESEND_WEBHOOK_SECRET` | webhook auth | webhook 503s; bounces/complaints **never processed** |
| `EMAIL_TOKEN_SECRET` | unsubscribe token signing | derived from the Resend key; **throws in production** if both are placeholders |
| `APP_URL` | public link base | unsubscribe + continuation URLs cannot be built → those sends are skipped |
| `EMAIL_SUPPRESSION_API_KEY` | cross-system API | endpoint disabled (503) |
| `EMAIL_FROM` / `EMAIL_REPLY_TO` | identity | defaults to `hello@moveitclearit.com` |
| `EMAIL_ASSET_BASE_URL` | hosted images | defaults to `https://moveitclearit.com/email` |

## Postal address

CAN-SPAM requires a physical postal address on promotional mail. The footer
renders `postalAddress` **only when supplied** — no template hard-codes one, and
no sender currently passes it. **This is an open compliance gap**: it must be
set before promotional sending is enabled. Recommended: a `BUSINESS_POSTAL_ADDRESS`
env var read once and passed by `guardedSend`.
