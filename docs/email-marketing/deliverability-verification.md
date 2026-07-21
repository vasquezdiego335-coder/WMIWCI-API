# Deliverability verification status

_Last updated 2026-07-20. Classification is deliberate: nothing is marked
`verified` without direct evidence gathered in this environment._

| Item | Status | Note |
|---|---|---|
| HMAC-signed unsubscribe tokens | **verified** | `email-tokens.test.ts`, 13 checks incl. tamper/expiry/purpose |
| RFC 8058 one-click POST | **verified (code)** | route + header emission; not exercised against a real mail client |
| Visible unsubscribe in body | **verified** | `marketing-context.test.ts` asserts the rendered HTML |
| Physical postal address | **implemented, fails closed** | `BUSINESS_POSTAL_ADDRESS` is **unset** — promotional sends are BLOCKED until it is set to the real registered address. No default exists and none was invented. |
| Reason-for-contact line | **verified** | asserted in rendered EN + ES output |
| Plain-text multipart | **verified** | all three send paths return `text` |
| Webhook signature verification | **verified (offline)** | `email-events.test.ts`, incl. replay + rotation |
| Hard vs soft bounce | **verified (offline)** | only permanent bounces suppress |
| Suppression fail-closed reads | **verified (offline)** | pure-logic tests |
| Durable webhook side effects | **implemented but unverified** | needs a real provider event |
| Provider retry / resume | **implemented but unverified** | needs Postgres + a failing provider |
| Cross-system suppression API | **implemented but unverified** | Leadtracking does not yet CALL it |
| SPF | **requires DNS access** | not checked |
| DKIM | **requires DNS access** | reported OK for `moveitclearit.com` in a 2026-07-15 audit; **not re-verified here** |
| DMARC | **requires DNS access** | not checked |
| Return-path alignment | **requires provider access** | not checked |
| Tracking domain | **requires provider access** | not checked |
| Real bounce/complaint staging | **requires provider access** | `bounced@resend.dev` / `complained@resend.dev` |
| Preference centre | **missing** | token purpose exists; no route |
| Regulated claims (pricing, licensing, insurance) | **requires legal/compliance review** | unsupported claims removed; remaining copy not legally reviewed |

## What blocks promotional sending right now

1. `BUSINESS_POSTAL_ADDRESS` unset → every promotional send is blocked by design.
2. SPF / DMARC unverified.
3. No staging scenario has been executed.
