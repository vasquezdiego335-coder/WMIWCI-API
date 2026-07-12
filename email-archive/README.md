# Email Archive

Deprecated email templates, **preserved for reference — nothing here is wired to the
live system**. This folder is excluded from the TypeScript build (`tsconfig.json` →
`exclude`), so the archived `.tsx` files are never compiled or imported.

The 15 live templates are listed in [`../EMAIL-REGISTRY.md`](../EMAIL-REGISTRY.md).

## What's here

### `react-legacy/` — 7 old React templates
Removed from `src/emails/` during the 2026-07-12 consolidation:

| File | Why archived |
|------|--------------|
| `booking-denied.tsx` | Replaced by the premium **booking-declined** |
| `reschedule-offer.tsx` | Merged into **booking-updated** |
| `booking-rescheduled.tsx` | Merged into **booking-updated** |
| `booking-confirmation.tsx` | Superseded by **pre-approval** (pre-confirmation) |
| `booking-confirmed.tsx` | Superseded by **final-confirmation** |
| `pending-approval.tsx` | Superseded by **pre-approval** |
| `contact-ack.tsx` | Not part of the 15-email customer journey |

> These files still `import from '../emails/_ui'`, which no longer resolves from this
> folder — that's fine, they're reference only. To revive one, move it back into
> `src/emails/` and re-add it to `ALLOWED_TEMPLATES` + the `EmailJobData` union.

### `marketing-library/dist/` — 29 static ESP templates
The old `01–22` numbered set + `m01–m07` weekly campaigns (HTML + TXT + JSON). This was a
build-output asset library with no live trigger and the wrong domain. Its best copy was
merged into the 4 rebranded Leadtracking marketing emails and the React referral template.

### `leadtracking-original/` — 4 pre-rebrand drip templates
Copies of `email1–4.html` as they were **before** the palette rebrand + content rewrite
(old palette `#0A1628 / #FF5A1F / #F5F1EA / #C9A961`). The live versions are in
`Leadtracking/backend/templates/`.

## Full 47-template snapshot
A zip of all 47 original templates (pre-consolidation) is at
`C:\Users\brown\Downloads\WMIWCI-email-templates.zip`.
