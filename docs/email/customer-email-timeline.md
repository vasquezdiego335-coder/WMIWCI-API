# Customer email timeline

_Last updated 2026-07-21._
Admin: `/admin/customers/[id]` and the Email Ledger card on `/admin/jobs/[id]`.

## The questions it answers

```
What has this customer received?
Why did they receive it?
What was blocked, and why?
What did they engage with?
Did any email lead to a booking?
Did that booking generate collected revenue and finalized profit?
```

## Why it is not the "Communications" card

The job page already had a Communications card. It reads the legacy
`Notification` table, which records what was **handed off** to be sent. The
timeline reads `email_sends` — the guard's own ledger — which also records every
email that was **considered and refused**, with the machine-readable reason
translated into a sentence.

Communications can answer "what did we send?". Only the timeline can answer "why
didn't they get the reminder?".

## What it shows

Per send: template, journey, campaign, subject, scheduled and sent times,
attempt status, delivery/open/click/bounce/complaint events, block reason,
deferral reason and next attempt time. Per customer: all related leads, all
bookings, collected revenue and finalized profit.

Filters: booking, campaign, journey, template, status, date range — as plain
links, so the page works without JavaScript.

## Role protection

* Recipient addresses are masked (`di••••@gmail.com`) unless the viewer holds
  `email.view_recipients`. Masking happens on the **server**, so devtools does
  not reveal the address, and the API applies the same rule.
* Revenue and finalized-profit attribution require `email.view_attribution`.

## One thing it deliberately will not claim

An empty engagement column means the provider recorded no open or click. That
can mean the customer did not open it **or** that tracking is not enabled. The
page says so rather than presenting absence as evidence.
