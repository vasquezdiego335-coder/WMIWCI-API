# Email deliverability — DNS records that must be fixed

**Inspected live on 2026-07-28.** Every finding below came from a real DNS
query, not from documentation. Nothing in this file has been applied — DNS is
not editable from the code repository, so these are the exact changes an
operator must make at the registrar / Cloudflare.

---

## The headline finding

`moveitclearit.com` has **two DMARC records**:

```
_dmarc.moveitclearit.com  TXT  "v=DMARC1; p=none;"
_dmarc.moveitclearit.com  TXT  "v=DMARC1; p=none; rua=mailto:dmarc@moveitclearit.com; fo=1"
```

**This is why DMARC reads as invalid, and it is worse than having no record.**

RFC 7489 §6.6.3 is explicit: when a resolver finds more than one DMARC record
for a domain, it **discards them all and treats the domain as having no DMARC
policy**. So the domain is currently unprotected *and* the reporting address in
the second record never receives anything — the aggregate reports that would
tell you whether your mail authenticates are not being generated.

This is a duplicate-record problem, not a missing-record problem. Adding a
third record makes it worse.

### The fix

**Delete the bare record. Keep the one with `rua`.**

| Action | Host | Value |
|---|---|---|
| **DELETE** | `_dmarc.moveitclearit.com` | `v=DMARC1; p=none;` |
| **KEEP** | `_dmarc.moveitclearit.com` | `v=DMARC1; p=none; rua=mailto:dmarc@moveitclearit.com; fo=1` |

Verify afterwards — exactly one line must come back:

```bash
dig +short TXT _dmarc.moveitclearit.com
```

---

## Current state of the sending domain

Sending identity is `…@moveitclearit.com` (from `EMAIL_FROM`).

| Record | Host | Current value | Verdict |
|---|---|---|---|
| MX | `moveitclearit.com` | `route1/2/3.mx.cloudflare.net` | OK — Cloudflare Email Routing, inbound only |
| SPF (root) | `moveitclearit.com` | `v=spf1 include:_spf.mx.cloudflare.net ~all` | **Inbound routing only — does not authorise Resend** |
| SPF (send) | `send.moveitclearit.com` | `v=spf1 include:amazonses.com ~all` | OK — Resend sends via Amazon SES |
| DKIM | `resend._domainkey.moveitclearit.com` | `p=MIGfMA0GCSqGSIb3DQEB…` | Present |
| DMARC | `_dmarc.moveitclearit.com` | **two conflicting records** | **BROKEN — see above** |

### On the root SPF record

The root `v=spf1 include:_spf.mx.cloudflare.net ~all` authorises Cloudflare's
*inbound* routing, not Resend's outbound servers. Whether that matters depends
on the exact envelope sender Resend uses:

- If Resend uses a `send.moveitclearit.com` return-path (its normal setup, and
  the reason that subdomain record exists), **SPF aligns there and the root
  record is irrelevant to sending.**
- If any mail is ever sent with a root-domain return path, it will **fail SPF**.

DKIM is present on the root, so DMARC can pass on the DKIM leg regardless. That
is the normal Resend arrangement and is fine — but it is worth confirming in the
Resend dashboard that the domain shows **Verified** for both DKIM and Return-Path
rather than assuming.

**Do not** add `include:amazonses.com` to the root SPF record reflexively. SPF
permits a maximum of 10 DNS lookups and the root record is also doing inbound
duty; changing it without checking the lookup count risks breaking a record that
currently works.

---

## `wemoveitweclearit.com` has no DNS at all

```
MX:    ENOTFOUND
SPF:   ENOTFOUND
DMARC: ENOTFOUND
```

`MARKETING_SITE_URL` points at `https://www.wemoveitweclearit.com`, so email
links resolve to a domain with no mail configuration. That is harmless while
nothing is *sent* from it — but it must never become a sending identity without
its own SPF, DKIM and DMARC, and a link domain that does not resolve for mail is
worth confirming is intentional.

---

## Recommended policy progression

Do **not** jump to `p=reject`. Tighten in stages, reading the `rua` reports
between each:

1. **Now** — `p=none` with `rua` (already the correct starting policy, once the
   duplicate is deleted). Collect reports for 2–4 weeks.
2. **Once reports show all legitimate mail passing** — `p=quarantine; pct=25`,
   then raise `pct` gradually.
3. **Only when quarantine is clean** — `p=reject`.

Moving to `reject` with a misconfigured source silently destroys real customer
mail, including booking confirmations. The staged path costs weeks; getting it
wrong costs deliverability that takes longer than that to rebuild.

---

## Verification

```bash
dig +short TXT _dmarc.moveitclearit.com
```

```bash
dig +short TXT send.moveitclearit.com
```

```bash
dig +short TXT resend._domainkey.moveitclearit.com
```

The agent also checks these automatically. `provider.dns_authentication` runs
every cycle and will clear itself once the duplicate is removed — no code change
is needed to re-verify, and the admin page will stop showing the finding.

---

## Do not enable promotions until

- [ ] the duplicate DMARC record is deleted and `dig` returns exactly one line
- [ ] the Resend dashboard shows the domain **Verified**
- [ ] a Discord test alert has actually been delivered
- [ ] `EMAIL_PROMOTIONS_ENABLED=true` is set deliberately

`EMAIL_PROMOTIONS_ENABLED` is currently **unset**, which means promotional
dispatch is blocked at the server. Transactional email is unaffected by that
switch — booking confirmations, receipts and reminders continue regardless.
