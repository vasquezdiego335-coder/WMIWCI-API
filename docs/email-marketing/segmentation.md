# Segmentation — what the data actually supports

_Last updated 2026-07-20._

The instruction this follows: **do not create fake precision when the database
does not contain the required information.**

## Supported today

| Segment | Source field | Notes |
|---|---|---|
| Booking status | `Booking.status` | drives every stop rule |
| Payment status | `Payment.status`, `refundedAmountCents` | referral eligibility |
| Internal test | `Booking.isInternalTest`, `Payment.isInternalTest` | excluded from all marketing |
| Move date window | `scheduledStart ?? confirmedDate ?? requestedDate` | 7 d / 30 d / 30 d+ derivable |
| Completed customer | `Booking.completedAt` | post-job journeys |
| Repeat vs first-time | `Customer.isFirstTime`, booking count | available, not yet used to vary copy |
| Language | `Customer.locale` | every template is EN/ES |
| Lead source | `Lead.source` (`LeadSource` enum) | website / phone / Facebook / QR / referral / other |
| Marketing attribution | `Lead.utmSource/Medium/Campaign/Content/Term`, `landingPage`, `referrer` | captured at ingestion, **not yet read back** |
| Lead stage | `contactedAt`, `quotedAt`, `bookedAt`, `lostAt` | quote journey anchor |
| Suppression | `EmailSuppression` | see suppression.md |
| Engagement | `Notification.isOpened/openCount`, `EmailEvent` | opens are unreliable (proxy prefetch) |
| Service area | `Booking` ZIP + `src/lib/service-area.ts` | NJ zones |

## NOT supported — and what each would need

| Requested segment | Missing |
|---|---|
| Quote amount / contents / validity | **a `Quote` model.** `Lead` has only `quotedAt`, `estimatedValue`, `jobType` |
| Apartment vs storage vs office vs marketplace | a normalized service-type enum. `Booking.itemsDescription` is free text; `Lead.jobType` is free text |
| Loading-only vs unloading-only | not captured as a field |
| Local vs out-of-state | destination state is inside a free-text address |
| Quote **viewed** | no quote-view event |
| Booking **started** vs abandoned | approximated by `status = PENDING_PAYMENT`; there is no partial-form event |
| Clicked but did not book | click tracking is not implemented |
| Review submitted | `Review` exists — usable, just not yet a segment |

## Recommended next schema step

A `Quote` model (`bookingId?`, `leadId`, `amountCents`, `serviceType`,
`crewSize`, `validUntil`, `status`, `viewedAt`) would unlock the full Stage-B
sequence, quote-viewed segmentation, and honest quote restatement in the email.
It is **not** added here: there is no UI that creates quotes, so the model would
ship unused. See the deferred list in the final report.
