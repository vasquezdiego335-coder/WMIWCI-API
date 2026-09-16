# Form submissions → existing marketing sequences

Owner direction (2026-09-16): every genuine Move It Clear It form submission with an email enters the most relevant EXISTING sequence. There is no separate opt-in and no confirmation step; the form shows a notice that submitting may lead to promotional email and how to stop it. The submission is recorded as having seen that notice (`notice_accepted`), never as an opt-in. Existing templates and cadence are used unchanged. The one copy change is the lead-nurture footer, which no longer claims an opt-in.

Everything below is dark until `EMAIL_NOTICE_BASIS_ENABLED=true` (API and worker) and, for the popup, `OFFER_SIGNUP_ENABLED=true` (API).

## Trigger map

| Form | Route | What records the notice | Sequence (existing templates, cadence) | Requested reply (separate, transactional) |
|---|---|---|---|---|
| Quick quote, priced | `POST /api/leads/quote-capture` | submit, surface `quote` | `quote_followup`: quote-followup-1/2/final at quotedAt +24h/+3d/+7d, each stage held until the quote reply is webhook-delivered to the lead's current address (2h steps, stop after 48h + ops alert), rendered in the submission's language | `quote-request-received`, immediately |
| Quick quote, no price (hand-planned / in-person) | same | submit, surface `quote` | `lead_nurture`: lead-nurture-1/2/final at +4h/+24h/+72h | `quote-request-received` |
| Booking form, contact step | `POST /api/leads/partial` | ONLY the trusted Continue click with an address typed on this page load (trigger `continue`); typing pauses, blur, beacons, drafts, prefill never | `lead_nurture` | none |
| Booking submitted, unpaid | `POST /api/bookings` | submit, surface `booking` (an email carried from the quote page is accepted) | `abandoned_checkout`: abandoned-checkout 1/2/3 at +45m/+24h/+72h while PENDING_PAYMENT; stops on payment, cancellation, or a LATER booking by the same customer that was paid/approved | none before payment; the booking emails after payment |
| Contact form, every topic | `POST /api/contact` | submit; surface `contact` (topic quote) or `contact_support` (existing booking / other) | `lead_nurture`, started only after the Discord team alert is queued | none (team replies) |
| 10% popup | `POST /api/leads/offer-signup` | submit, surface `popup` | `lead_nurture` (the code is shown on screen, never emailed) | none |
| Tracker landing (`go.moveitclearit.com/quote`) | tracker → `POST /api/notify/lead` (token) | submit, surface `tracker`; forwarded only from a page that rendered the current notice; source code and opt-out preserved | `lead_nurture`, started after the acknowledgement | `lead-acknowledgement` auto-reply |

Hops for every path: route → `src/lib/capture-basis.ts` `applyCaptureBasis` (opt-out box first, trigger, registry, safeguards, `notice_accepted`, basis stored) → `startCaptureScenario` → `src/lib/journeys.ts` `onNoticeSubmission` → `ensureQuoteJourney` / `ensureLeadNurture` / `scheduleAbandonedRecovery` (eligibility → booking-on-record / quote / state rules → enrollment claim) → queue `scheduled` (stable job ids) → `src/workers/scheduled.worker.ts` (re-checks eligibility, the lead's own active enrollment, booking state) → queue `email` → `src/workers/email.worker.ts` (renders the existing template, live recheck) → `src/lib/email-guard.ts` `guardedSend` (suppression, permission, caps, quiet hours, List-Unsubscribe) → Resend.

## Hard stops

- Opt-out box (any trigger, any form), unsubscribe, spam complaint, hard bounce, admin block, customer opt-out: no promotional email of any kind; every sequence row stops; a later form never lifts it. Only the person's own short-lived resubscribe link can, and never over a later withdrawal.
- The lead nurture refuses anyone with a booking on record (a move taken before, or a booking still waiting for payment or approval within 90 days) and any lead with a real quote.
- One active copy of a sequence per person; a notice person gets one of each kind per 30 days; a lead that already received a sequence is not enrolled again.
- A booking stops the person's lead sequences; payment/cancellation closes the booking's recovery row.

## Abuse limits (API service, read per request)

`CONSENT_IP_DISTINCT_EMAILS_24H` (default 5, IPv6 grouped by /64), `CONSENT_GLOBAL_GRANTS_24H` (default 100 distinct addresses, one ops alert per trip), `CONSENT_POPUP_GRANTS_24H` (default 30). A withheld grant still saves the lead and sends the requested reply, and is recorded as `basis_withheld` with its reason.

## Known limits (owner decisions)

- The lead-nurture body copy talks about pricing a move ("we got your message", "to give you a real number"); it now also reaches popup and booking-Continue submitters. Only the footer was changed, per the owner's rule.
- The contact notice says the message is answered first; the only guarantee is ordering (team alert queued first) plus the nurture's +4h first stage — a weekend message could get stage 1 before a human reply.
- Campaigns (owner-approved broadcasts) are separate from these automated flows; `contact_lead_reactivation` / `quick_quote_reactivation` do not exclude people who already received the same final template.
