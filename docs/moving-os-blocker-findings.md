# Release blockers — VERIFIED findings (2026-08-14)

Independent verification of the external reviewer's nine blockers, against the real
code at commit a4b5d7a2. Every finding below was established by reading the shipped
code and, where noted, by RUNNING the shipped functions offline.

**Result: 9/9 confirmed. 8 are WORSE than described.** The reviewer was right, and
in nearly every case conservative. Fixers: work from THIS document, not the
reviewer's summary — several prescribed fixes are wrong or dangerous (see B5, B6).

---

## B1 â€” "Stripe can capture the deposit while local approval remains incomplete" (src/lib/booking-approval.ts ~790-873, ~1142-1175)

**VERDICT: WORSE_THAN_DESCRIBED**

### Evidence
THE ORDER IS EXACTLY AS DESCRIBED. approveBooking (src/lib/booking-approval.ts:722-911) runs: step 0 staffing-readiness probe (765-788, probes only the booking read + jobStaffingRequirement table); step 1 ATOMIC CLAIM (792-808) -> store.claimConfirm -> prismaApprovalStore.claimConfirm (1110-1127) writes `status:'CONFIRMED', depositPaid:true, customerTokenExpiry, ...sched`; step 2 CAPTURE (810-827); step 3 commitApproval (851-873) -> the Payment/Job/AuditLog `prisma.$transaction([...])` at 1142-1175. So the row reads CONFIRMED + depositPaid=true BEFORE any money moves and BEFORE any money is recorded.

commitApproval IS THE ONLY UNPROTECTED THROW BETWEEN CAPTURE AND RETURN. The capture failure path is correctly compensated (819-826 rollbackClaim, guarded on status='CONFIRMED') and correctly idempotency-keyed (`capture:${pi}` at 814, passed through captureDeposit -> stripe.paymentIntents.capture, src/lib/stripe.ts:131-140) â€” that code is CORRECT and must not be rewritten. Between line 829 and 873 everything else is safe (retrieveCharge has `.catch(() => null)` at 833). commitApproval at 851 has NO try/catch, NO rollback, NO compensating cancel. It throws out of approveBooking into the caller.

I RAN IT. Offline probe driving the SHIPPED approveBooking with in-memory deps (capture succeeds, commitApproval throws P1001; ensureStaffing faithfully models prismaApprovalStore.ensureStaffing -> ensureStaffingForBooking, which requires an existing Job row â€” booking-approval.ts:650-660):
  ATTEMPT 1 -> approveBooking threw; stripe captures = 1; booking.status = CONFIRMED; Payment rows 0; Job rows 0; AuditLog rows 0; rollbackClaim NOT called.
  ATTEMPT 2 (the owner clicks Approve again â€” the only repair available) -> `{ok:true, outcome:'already_confirmed', capturedCents:null}`. commit attempts stayed at 1 (the replay never re-tries the money write, booking-approval.ts:746-749). Payment 0, Job 0, staffing outcome `{ensured:false, reason:'no job row for this booking'}`, staffing rows 0.

WHERE THE REVIEWER UNDERSTATED IT (3 ways):
1. "A retry only repairs staffing" â€” FALSE, the retry repairs NOTHING. ensureStaffingForBooking returns early at :660 (`no job row for this booking`) because the Job upsert died with the transaction. The only observable effect is one ERROR log line. And it returns ok:true, so the admin route (app/api/admin/bookings/[id]/status/route.ts:126-151) answers 200 with a healthy-looking booking and the Discord route (app/api/discord/interactions/route.ts:173-204) renders confirmedCard, which at :99 falls back to `booking.depositAmount ?? 4900` and prints "Deposit captured Â· booking CONFIRMED" + "ðŸ’³ Captured $49.00" â€” a claim about a capture this code path never verified, over a database with no Payment row. That is the house "no unprovable claim" rule broken by the failure mode itself.
2. THE CUSTOMER IS NEVER NOTIFIED, EVER. notifier.sendApproved (902-908) sits after commitApproval, so attempt 1 never reaches it, and the replay returns at :749 before it. booking-approval.ts:1245 / emitApproved (1235-1243) are the only producers of 'final-confirmation'; the admin/Discord routes only call onBookingConfirmed (journeys.ts:689-701), which fires a trigger and schedules 72h/24h reminders â€” it does not send the confirmation. The customer pays $49 and gets silence, then pre-move reminders.
3. THE $49 IS THEN BILLED AGAIN. bookingPricing (src/lib/pricing.ts:88-122) derives `dueOnMoveDayDollars` from COMPLETED Payment rows (:96, :106), not from depositPaid. Ran it: with depositPaid=true and no Payment row -> dueOnMoveDay $599, collected $0 (healthy case: $550 / $49). After completion, reminder-rules.ts:362 raises "the customer's balance has not been recorded as collected. Collect it or record the payment", actively prompting Diego to collect the $49 again.

CONVERGENCE â€” NOTHING AUTOMATIC EXISTS. (a) Retry: proved inert above. (b) Webhook: handleStripeEvent (src/lib/stripe-events.ts:181-352) has NO `payment_intent.succeeded` and NO `charge.captured` case â€” a manual capture produces no handled event, so the webhook cannot repair it. (c) repairStaffing (928-947): needs the Job that never got created. (d) Action Center: reminder-rules.ts has no CONFIRMED-without-payment rule. (e) Partial manual repair only: admin "Mark scheduled" (status route :198-205 -> labor-service.ensureJobForBooking :202-240) creates the Job + staffing â€” but never the Payment or the PAYMENT_RECEIVED audit, so the money stays unrecorded and the balance stays wrong.

RECONCILIATION â€” THE REVIEWER MISSED THAT IT ALREADY DETECTS THIS. I ran the shipped `reconcile()` (src/lib/reconciliation.ts:76-200) on the exact post-failure state; it returned both `captured_no_payment_row` (critical, :99-110) and `confirmed_no_payment` (high, :112-130). It is DETECT-ONLY and never repairs, and it is manual-only: exposed at app/api/admin/reconciliation/route.ts (GET, owner-only, read-only) and `npm run reconcile` (package.json:37). vercel.json has no `crons` block, and no admin page links the endpoint (repo-wide grep finds only the route file and its own doc comment). So the detector exists and nobody runs it.

TEST COVERAGE GAP: no test anywhere makes commitApproval throw â€” every harness (booking-approval.test.ts:103, day-level-scheduling.test.ts:126, staffing-plan.test.ts:891) implements it as always-succeeding.

MIRROR CASE, SAME ROOT CAUSE: if the process dies between claimConfirm (:798) and capture (:814) â€” Vercel function timeout, deploy, crash â€” the rollback at :819 never runs. Booking reads CONFIRMED + depositPaid=true with NO capture; the authorization expires in ~7 days and the $49 is never collected. reconcile() flags that one as `confirmed_no_payment` too; nothing else does.

NOT A DEPLOY-WINDOW BUG: I checked the three pending migrations (20260811000000_moving_os_phase1, 20260812000000_staffing_plan, 20260812010000_start_time_known) â€” they touch `bookings`, `booking_inventory_items`, new tables and two AuditAction values only. No Payment/Job/AuditLog column changes, so commitApproval is not systematically P2022-broken in the code-before-SQL window. The trigger is transient (Neon autosuspend/cold start, dropped connection, serverless timeout), not deterministic.

### Business impact
TRIGGER: any failure of one Postgres transaction in the ~1 second after Stripe returns a successful capture â€” Neon autosuspend/cold start, a dropped connection, or a serverless timeout at the end of a slow approval. Per-approval probability is low (it is NOT the deploy-window bug â€” the three pending migrations do not touch Payment/Job/AuditLog), but it is unbounded in consequence and there is zero automatic detection, so the expected damage per occurrence is what matters. At Diego's volume (a handful of approvals a week) think "a couple of times a year" â€” and every occurrence is a silent money defect that persists until someone manually runs a report nobody has scheduled.

WHAT DIEGO EXPERIENCES: clicks Approve, gets a generic 500 (admin) or "This interaction failed" (Discord). Clicks again. Gets a green "âœ… Approved â€” Deposit captured Â· booking CONFIRMED Â· ðŸ’³ Captured $49.00" card and a 200 response. He has no reason to suspect anything. Meanwhile the $49 sits in Stripe with no Payment row, the job has no Job record and no crew requirement, dispatch cannot warn about staffing, revenue reporting under-counts by $49, and closeout/profit have nothing to hang costs on. Later, when the move is done, the Action Center tells him the customer's balance "has not been recorded as collected" and asks him to collect it â€” steering him into charging the customer a second time.

WHAT THE CUSTOMER EXPERIENCES: they paid $49 and receive NO confirmation email and NO confirmation SMS â€” ever (the notifier runs only on the captured path, and every later retry returns before it). They then get 72h/24h pre-move reminders for a move they were never told was approved. Their portal and their move-day balance are $49 too high: verified by running bookingPricing â€” $599 due instead of $550 on a $599 job. If they pay what the balance says, they have been charged $49 twice, and the only record of the first $49 is inside Stripe.

MIRROR VARIANT, SAME ROOT CAUSE: if the process dies between the claim and the capture instead, the compensating rollback never runs â€” the booking reads CONFIRMED and depositPaid=true, the authorization is never captured, and it expires in ~7 days. Diego runs a confirmed job and collects $0 of the deposit. Same invisibility.

RECOVERY TODAY: only Stripe's dashboard, or an owner who happens to run `npm run reconcile` / GET /api/admin/reconciliation. That report does correctly identify both shapes (I ran it â€” critical + high), but it is read-only, uncronned and unlinked from any UI. Nothing in the product converges the state on its own.

### Fix plan
The saga does not need building from scratch â€” the detector, the idempotency key and the idempotent upserts already exist. Make the RETRY converge, add ONE webhook net, and schedule the detector.

1. MAKE THE REPLAY PATHS CONVERGE INSTEAD OF LYING (the core fix; booking-approval.ts:746-749 and 799-808). Both CONFIRMED early-returns must ask "is the money actually recorded?" before reporting success. Add `store.findPaymentForIntent(paymentIntentId)`. If the booking is CONFIRMED and there is no COMPLETED Payment for its intent: retrieve the intent from Stripe; if it is captured, re-drive the SAME commitApproval (its Payment upsert is keyed on stripePaymentIntentId and its Job upsert on bookingId, so both are already exactly-once), then repairStaffing, then notify â€” returning outcome 'repaired'. If the intent is NOT captured, the row must not read CONFIRMED: capture with the same `capture:${pi}` key (idempotent) or rollbackClaim. Guard the AuditLog write with a one-per-booking count exactly like labor-service.ts:227 does for JOB_CREATED, and guard the notification on that same audit record so the retry can never double-send.

2. BOUNDED RETRY AROUND commitApproval (851-873) â€” 2-3 attempts, short backoff, before the throw escapes. Most Neon blips heal in under a second; this alone removes the majority of real occurrences.

3. STOP THROWING A BARE 500. When the commit still fails, return a new result code 'commit_failed' with an owner-honest message ("The $49 WAS captured but the booking record did not save. Click Approve again â€” do NOT charge the customer again."), log ERROR with the payment-intent id, and raise an ops alert (the ops-alert dedupe table exists). Map it to 500 in the status route and to an ephemeral in Discord.

4. FIX confirmedCard (app/api/discord/interactions/route.ts:88-120). Delete the `?? booking.depositAmount ?? 4900` fallback at :99 â€” print an amount only when the call actually captured or verified one; otherwise say "confirmed (deposit already captured earlier)" with no figure.

5. ADD THE WEBHOOK NET (src/lib/stripe-events.ts:181-352). Handle `payment_intent.succeeded` (and/or `charge.captured`): resolve the booking by intent metadata / booking.stripePaymentIntentId and run the same idempotent Payment+Job+Audit commit. This is the "Stripe success webhook converges on exactly one Payment/Job/audit" the reviewer asked for, and it rides the existing webhookLog idempotency.

6. SCHEDULE THE DETECTOR YOU ALREADY HAVE. Add a `crons` entry in vercel.json (or a worker tick) running runReconciliation daily, and surface `captured_no_payment_row` / `confirmed_no_payment` as HIGH Action Center reminders + a Discord alert. Do not rewrite reconcile() â€” it is correct; I ran it against the real failure state.

7. TESTS (mutation-tested): a harness where commitApproval throws once. Assert â€” exactly one Stripe capture; the retry produces exactly one Payment, one Job, one PAYMENT_RECEIVED audit, one staffing requirement and one customer notification; the retry never returns ok:true while the Payment is missing; and the Discord card never prints an unverified amount. Add the mirror case (crash between claim and capture) asserting the booking does not stay CONFIRMED-without-capture.

DO NOT TOUCH: the capture-failure rollback (819-826) and the `capture:${pi}` idempotency key â€” both verified correct; a retry after a network-timeout on capture is already safe.

### Files
C:/wt-moving-os/src/lib/booking-approval.ts, C:/wt-moving-os/src/lib/stripe-events.ts, C:/wt-moving-os/src/lib/reconciliation.ts, C:/wt-moving-os/src/lib/pricing.ts, C:/wt-moving-os/src/lib/labor-service.ts, C:/wt-moving-os/src/lib/reminder-rules.ts, C:/wt-moving-os/src/lib/journeys.ts, C:/wt-moving-os/app/api/admin/bookings/[id]/status/route.ts, C:/wt-moving-os/app/api/discord/interactions/route.ts, C:/wt-moving-os/app/api/admin/reconciliation/route.ts, C:/wt-moving-os/vercel.json, C:/wt-moving-os/src/lib/__tests__/booking-approval.test.ts

---

## B2 â€” "A failed hold release is reported to the customer as successful" (src/lib/booking-approval.ts ~1009-1065; app/my-booking/[token]/page.tsx ~197-202, ~363-370)

**VERDICT: WORSE_THAN_DESCRIBED**

### Evidence
All three of the reviewer's sub-claims are TRUE, and I proved the first two by executing the shipped `declineBooking()` offline with in-memory fakes (DI'd via ApprovalDeps) plus rendering the shipped declined email through @react-email/render. It reaches further than described in three ways.

=== CLAIM 1 â€” ordering + swallowed failure + "released" messaging: CONFIRMED (executed) ===
src/lib/booking-approval.ts:1017 `const claimed = await store.claimCancel(booking.id)` -> prisma updateMany `data: { status: 'CANCELLED' }` (1188-1194). The Stripe call happens AFTER, at 1030 `await stripe.releaseHold(...)`, wrapped in try/catch at 1033-1036 which only does `logger.warn(... 'releaseHold failed (continuing - hold may already be void)')`. Notification at 1057-1063 is unconditional: `notifier.sendDeclined(booking)` â€” the interface (208 `sendDeclined(booking: ApprovableBooking)`) has no holdReleased parameter, so the copy CANNOT vary.

Executed trace, release throwing "Stripe API is currently unavailable (503)":
  1. DB: booking.status = CANCELLED
  2. STRIPE: releaseHold(pi_1) THREW
  3. DB: auditLog stripeResult=release_failed:... result=success
  4. EMAIL: booking-declined queued
  result {"ok":true,"outcome":"declined","holdReleased":false}; emails sent to customer: 1

The email is the shipped src/emails/booking-declined.tsx with the exact payload sendDeclined builds (1283-1295: customerName/displayId/requestedDate/amountHold/rebookUrl/locale). Rendered offline, every release claim PRESENT and hardcoded â€” there is no conditional in the template (76-88):
  preview: "About your booking request (WMIC-1042) - your $49 hold was released."
  releaseTitle (80): "Your $49 hold was released"
  releaseBody (81): "You were not charged. The temporary authorization on your card is released automatically (your bank may take a few days to drop it)."
  disclaimer (86): "This email confirms your request was not approved and the $49 authorization was released."

=== CLAIM 2 â€” retry does not retry the release: CONFIRMED (executed) ===
booking-approval.ts:1009-1011 `if (booking.status === 'CANCELLED') return { ok: true, outcome: 'already_cancelled', booking, holdReleased: false }` â€” returns BEFORE the release block at 1026-1037. Executed: re-declining the same booking with Stripe healthy produced zero timeline entries, `releaseHold retried? NO`. The hold stays on the card until Stripe's ~7-day auth expiry.

=== CLAIM 3 â€” captured booking cancelled without refund; portal says never charged: CONFIRMED ===
app/api/admin/bookings/[id]/status/route.ts:21-27 allows CONFIRMED->CANCELLED and SCHEDULED->CANCELLED; both are captured states (approveBooking sets depositPaid=true at 1124). Line 158 routes only PENDING_APPROVAL->CANCELLED to declineBooking; CONFIRMED/SCHEDULED fall through to the generic path (172-315), which touches Stripe NOWHERE. Executed confirmation: `declineBooking(CONFIRMED)` -> {"ok":false,"code":"invalid_status","message":"Already approved & captured - issue a refund instead of declining."}. `refundDeposit` exists at src/lib/stripe.ts:165-171 with ZERO call sites in the repo. The UI reaches this in one click: app/(admin)/admin/(dashboard)/jobs/[id]/BookingActions.tsx:11-18 puts a red "Cancel" on CONFIRMED and SCHEDULED behind only `confirm("Move booking to CANCELLED?")`.

The portal defect is a single mis-ordered ternary. page.tsx:197-202:
  const captured = booking.depositPaid || booking.payments.some((p) => p.status === 'COMPLETED')
  const paymentStatus: PaymentStatus =
    status === 'cancelled' ? 'released'
      : captured ? 'captured' ...
`status === 'cancelled'` is tested FIRST, so `captured` is never consulted for a cancelled booking. Every downstream string is keyed off it:
  363-372 hero lede: "This booking is cancelled and any $49 hold has been released - you were not charged." / reviewBody "Nothing further is owed."
  391-392 tracker: "$49 hold released"
  442-446 next steps: "Nothing is owed" / "Any $49 hold was released in full - your card was never charged."
  505-509 payHeadline: "Hold released"
  717 `{paid ? ...}` is false for cancelled, so the else branch renders 770-771: "The authorization on your card was released in full. You were not charged."

=== WHY WORSE THAN DESCRIBED ===
(a) The false claim is not "portal + hold-released messaging" â€” it is SIX portal strings, the customer EMAIL, the OWNER's Discord card, and the AUDIT LOG. app/api/discord/interactions/route.ts:123-140 `deniedCard` hardcodes description "Authorization released (no charge) - booking **CANCELLED**." and field "Hold: Released - not charged". booking-approval.ts:1051 hardcodes `result: 'success'` in the audit details even when stripeResult is `release_failed:...`; line 1055 logs the fixed message "Booking declined -> hold released -> CANCELLED".
(b) The failure is INVISIBLE, not merely mis-worded. `holdReleased` IS computed and returned (966, 1065), and BOTH call sites throw it away: Discord route.ts:223 renders `deniedCard(result.booking, approverName)` ignoring it; admin route.ts:168-169 returns `readBookingResponse(...)` ignoring it. Nothing is persisted â€” no Booking/Payment column records whether the authorization was actually voided. src/lib/reconciliation.ts has issue types captured_no_payment_row / confirmed_no_payment / amount_mismatch / duplicate_payment / refund_state_mismatch / dispute_state_mismatch (103-197) and NO stale-hold check, so `npm run reconcile` cannot catch it either. The only trace of a lost $49 hold is one logger.warn and a JSON substring in an audit row.
(c) The captured-cancel case is a self-contradiction, not just a gap. The generic route's EMAIL is already honest â€” route.ts:240-262 branches on `booking.depositPaid` and sends booking-cancellation with `refundStatus: 'custom'` + statusText "Our team will follow up with you about your $49 deposit." (rendered at src/emails/booking-cancellation.tsx:98 as "Payment status" + that body, no refund claimed). So the same customer receives an email saying we'll follow up about the deposit and, clicking the portal link in it, reads "your card was never charged." Worse, page.tsx:778-782 still renders "View payment receipt" when a Receipt row exists â€” a receipt link directly under "You were not charged."

=== WHAT IS NOT BROKEN (do not let a fixer rewrite it) ===
- No double-charge risk. approveBooking's claim requires status='PENDING_APPROVAL' (1112) and VALID_TRANSITIONS has no path out of CANCELLED, so an un-released manual-capture intent can never be captured later; Stripe expires it in ~7 days.
- The generic cancellation EMAIL copy is correct and must be kept as-is.
- checkDeclinable (983-993) correctly refuses to "decline" a CONFIRMED booking.
- The existing test src/lib/__tests__/booking-approval.test.ts:379-387 ("decline still cancels even if the hold release fails") asserts holdReleased===false and status CANCELLED but never asserts `declinedNotified` â€” which is exactly why the false email shipped green.

### Business impact
TWO DISTINCT INCIDENTS, different frequencies.

A) Failed hold release on a DECLINE. Every rejected request runs this path â€” Discord "Deny" and admin "Cancel" on PENDING_APPROVAL are the only ways to say no, so at a few declines a week this code runs constantly. Most releaseHold throws are benign ("PaymentIntent already canceled"), and that is precisely the danger: the noise trains everyone to ignore it, and there is no signal to ignore anyway. When the throw is real (Stripe API timeout, 503, rate limit), the customer gets an email whose subject preview reads "your $49 hold was released", a portal page reading "The authorization on your card was released in full. You were not charged." â€” and a $49 pending charge that sits on their statement for up to seven days. They call Diego. Diego opens Discord and sees his own card saying "Hold: Released - not charged", opens the admin page and sees CANCELLED, and has nothing that says otherwise. He tells a customer with a live charge on their bank app that they were not charged. The only recovery is manual Stripe-dashboard work he has no prompt to do, and re-clicking Deny does nothing (proven above). No money is lost permanently â€” Stripe expires the auth â€” but the trust damage is the whole product promise ("no message may claim what the code cannot prove") failing on the one interaction where the customer is already unhappy.

B) Cancelling a CAPTURED booking. Lower frequency, higher stakes â€” a handful a month for a small mover (customer cancels late, truck down, weather). Diego clicks the red Cancel on a CONFIRMED or SCHEDULED job. The $49 stays in his account, correctly and by policy; the email correctly says "Our team will follow up with you about your $49 deposit." The customer then clicks the portal link in that same email and reads "Nothing is owed", "$49 hold released", "your card was never charged" â€” and, if a Receipt row exists, a "View payment receipt" button underneath. Two contradictory statements from one company about one $49 charge. That is a chargeback invitation, and in a dispute the customer's evidence is Diego's own booking page telling them they were never charged. Diego loses the $49, the ~$15 dispute fee, and dispute-rate standing with Stripe â€” and the portal is a public URL he cannot argue with.

Both are pure-truthfulness defects: the correct data (Booking.depositPaid, Payment.status, Payment.refundedAmountCents) is already in the row the page reads. The portal simply asks the wrong question first, and the decline path never records the answer.

### Fix plan
Sized to the real defect: one 6-line portal reorder, one persisted flag, one early-return change, and two surfacing hooks. The reviewer's proposed CANCEL_PENDING status is heavier than needed â€” CANCELLED is the correct terminal state (the booking IS cancelled); what is missing is the payment-side fact.

1. PORTAL â€” derive wording from payment, not status (app/my-booking/[token]/page.tsx). Move the `captured` test ABOVE the cancelled test at 197-202 and add a 'refunded' member to PaymentStatus (71-76):
   - cancelled + captured + refund recorded (Payment.status in REFUNDED/PARTIALLY_REFUNDED or refundedAmountCents > 0 â€” both columns already exist, prisma/schema.prisma:1290-1291) -> 'refunded'
   - cancelled + captured + no refund -> 'captured', with copy that matches the email already sent: "$49 deposit was charged. Our team will follow up with you about it." Never "nothing is owed".
   - cancelled + not captured + release PROVEN (see 2) -> 'released' (today's copy)
   - cancelled + not captured + release unproven -> neutral: "This booking is cancelled. If a $49 authorization is still showing on your card, it will drop off â€” call us if it doesn't."
   Then rewrite the four string sites to read `v.paymentStatus`, not `v.status`: heroConfig 'cancelled' (363-372), nextSteps 'cancelled' (442-446), trackerSteps payLabel (391-392), the else-branch note (770-771). Gate the receipt link (778) on `v.paymentStatus !== 'released'`. Also drop the "$49 today - balance on move day" section sub (715) for cancelled.

2. PERSIST THE RELEASE OUTCOME (src/lib/booking-approval.ts + prisma). Add `depositReleasedAt DateTime?` (or a small `depositReleaseState` enum) to Booking and write it inside `recordDecline` ONLY when releaseHold resolved. Same edit removes the three false owner-facing claims:
   - 1051: `result: holdReleased ? 'success' : 'release_failed'`
   - 1055: log message must vary on holdReleased
   - 208 + 1280: `sendDeclined(booking, holdReleased)`; when false either hold the email or send copy that claims only the cancellation ("your booking is cancelled; we're releasing the authorization now"). booking-declined.tsx needs a second variant of the 76-88 block â€” do not touch the existing released wording.

3. MAKE RETRY RETRY (booking-approval.ts:1009-1011 and the post-claim path at 1018-1022). When the booking is already CANCELLED but the release is not proven, skip the claim and FALL THROUGH to the release + audit rather than returning early. Cancelling an already-cancelled PaymentIntent is a Stripe no-op, so this is safe to run repeatedly. Optionally add a small retry (2 attempts, short backoff) around line 1030 for transient failures.

4. SURFACE IT â€” both call sites currently discard `holdReleased`:
   - app/api/discord/interactions/route.ts:123-140/223 â€” pass it into `deniedCard`; on false render "Hold: RELEASE FAILED - retry Deny" in red instead of "Released - not charged".
   - app/api/admin/bookings/[id]/status/route.ts:158-170 â€” include it in the JSON response and show it in BookingActions.
   - src/lib/reconciliation.ts â€” add issue type `cancelled_with_live_authorization` (severity high): booking CANCELLED + stripePaymentIntentId set + intent still requires_capture. That wires the stale hold into the existing `npm run reconcile` exit-2 gate.

5. CAPTURED CANCELLATION NEEDS A DECISION, NOT SILENCE. Keep the honest email at route.ts:240-262. Add an explicit owner action (Refund / Retain) that finally calls the already-written `refundDeposit` (src/lib/stripe.ts:165-171) and writes Payment.status + refundedAmountCents + stripeRefundId, so step 1's 'refunded' branch has a truth source; a Stripe-dashboard refund is currently detected but never written back (reconciliation.ts:168-182 is read-only). Until that ships, change the BookingActions confirm() text (BookingActions.tsx:36) for CONFIRMED/SCHEDULED -> CANCELLED to say "$49 was already captured - no refund is issued automatically."

MUTATION TESTS (all offline, ApprovalDeps fakes already exist):
   - extend booking-approval.test.ts:379 to assert the notifier receives holdReleased=false and that the released-copy variant is NOT used; introduce the defect (unconditional copy) -> red.
   - new: re-declining a CANCELLED booking whose release never succeeded DOES call releaseHold exactly once.
   - new: audit details carry result='release_failed' when the release throws.
   - export buildCustomerView (or lift the paymentStatus derivation into a pure helper) and table-test the four combinations of depositPaid x Payment.status x refundedAmountCents against the rendered strings â€” that helper is what the "no claim the code cannot prove" rule needs a test for.

### Files
C:/wt-moving-os/src/lib/booking-approval.ts, C:/wt-moving-os/app/my-booking/[token]/page.tsx, C:/wt-moving-os/app/api/admin/bookings/[id]/status/route.ts, C:/wt-moving-os/app/api/discord/interactions/route.ts, C:/wt-moving-os/src/emails/booking-declined.tsx, C:/wt-moving-os/src/emails/booking-cancellation.tsx, C:/wt-moving-os/src/lib/stripe.ts, C:/wt-moving-os/src/lib/reconciliation.ts, C:/wt-moving-os/app/(admin)/admin/(dashboard)/jobs/[id]/BookingActions.tsx, C:/wt-moving-os/src/lib/__tests__/booking-approval.test.ts, C:/wt-moving-os/prisma/schema.prisma

---

## B3 â€” "Stripe webhook events can be permanently lost, or processed twice" (src/lib/stripe-events.ts ~83-161)

**VERDICT: WORSE_THAN_DESCRIBED**

### Evidence
METHOD: I copied the shipped `src/lib/stripe-events.ts` byte-for-byte into a scratchpad harness (md5 verified identical), stubbed only its six imports, and EXECUTED the real `processStripeWebhook` / `processStripeEventJob` across every failure branch. Repo untouched; no edits, no git, no DB.

HARNESS OUTPUT (real shipped code):
  A happy      -> HTTP 200 | enqueued=1 inlineFulfill=0 log=(no row)      1ms
  B hang+ok    -> HTTP 200 | enqueued=0 inlineFulfill=1 log=evt_1=processed 3012ms
  C hang+FAIL  -> HTTP 200 | enqueued=0 inlineFulfill=1 log=evt_1=failed   3023ms
  D late+ok    -> HTTP 200 | lateJob=1 fulfillBefore=1 fulfillAfter=1 log=processed
  E late+FAIL  -> lateJob=1 workerRescue=YES log=evt_1=processed
  F concurrent -> handleStripeEvent ran 2x (guard is read-then-act)
  G stale-proc -> retry outcome="skipped" (never re-runs once 'processed')
  H badsig 400 / nosecret 500

â”€â”€ HALF 1 OF THE CLAIM: CONFIRMED, AND PROVEN BY EXECUTION â”€â”€
`src/lib/stripe-events.ts:102-118` â€” queue handoff fails (3s race, :96-98) â†’ inline `processStripeEventJob` (:110) â†’ if that throws it is caught at :111, logged at :112-115, and `:117` returns `{status:200, body:{ok:true}}`. Scenario C reproduces this: Stripe is told SUCCESS, nothing is enqueued, and the only artifact is a `webhook_logs` row at status 'failed'.

That row is a dead end. `prisma.webhookLog` is read or written ONLY inside stripe-events.ts (grep across src/, app/, scripts/ returns no other consumer). No cron, no sweep, no admin replay reads status 'failed'. `app/api/admin/queues/failed/route.ts:13` states outright that it is an inspector and deliberately exposes no retry; `:34` is GET-only. The sole recovery is Diego manually pressing "Resend event" in the Stripe Dashboard â€” which he has no reason to do, because Stripe recorded a 200 and will never alert him.

â”€â”€ HALF 2 OF THE CLAIM: THE REVIEWER IS WRONG â”€â”€
"the timed-out queue request may later succeed while inline processing also ran" is real as a mechanism (Promise.race at :86-99 abandons but does not cancel the `add()`; ioredis `maxRetriesPerRequest:null` in `src/lib/redis.ts:26` queues it offline) â€” but the framing as a hazard is incorrect on two counts:
 â€¢ Scenario D: the late job lands, the worker runs, `:127-131` sees status 'processed' and SKIPS. `fulfillAfter` stayed at 1. Not double-processed.
 â€¢ Scenario E: when inline FAILED, the late job is the thing that RESCUES the event (log 'failed' â‰  'processed' â†’ re-runs â†’ 'processed'). The late enqueue is the recovery path, not the bug.
And even a genuine double-run is money-safe: `src/lib/fulfillment.ts:147-159` is ONE conditional SQL UPDATE (`updateMany` guarded on status IN PENDING_PAYMENT/DRAFT). Scenario F proved `handleStripeEvent` can run 2x concurrently (the `findUnique` at :127 is read-then-act, not atomic) â€” yet only one caller wins the claim; the loser returns `already-fulfilled-or-not-pending`. No double email, no double Discord card, no double capture. THIS CODE IS CORRECT â€” a fixer must not rewrite it.

â”€â”€ WHY IT IS WORSE THAN DESCRIBED â”€â”€
1. A LARGER LOSS PATH THE REVIEWER NEVER MENTIONS. The reviewer's branch needs Redis AND Postgres to fail together. But the far likelier path is the SUCCESS branch: `add()` succeeds â†’ `:101` returns 200 â†’ the worker retries per `src/lib/queues/index.ts:83-94` (attempts 5, exponential 10 000ms = 10+20+40+80s â‰ˆ 2.5 minutes total) â†’ all 5 fail â†’ the job sits in the BullMQ failed set under `removeOnFail:{count:100}` and is eventually evicted. Stripe already got its 200. Any incident lasting over ~2.5 minutes silently destroys the event, with Redis perfectly healthy.
2. THE PROJECT'S OWN P0-E RECOVERY IS SILENTLY DEFEATED. `:207-211` deliberately THROWS on `MIGRATION_NOT_APPLIED` â€” the comment at :199-206 explains this exists so the event is NOT recorded processed and the retry can still fulfill it. On the inline path that throw is swallowed at :111 and converted to 200. The reviewer's own doc (line 134) records THREE UNAPPLIED MIGRATIONS, and `src/lib/fulfillment.ts:87` notes migrations here are applied by hand â€” so this is a live trigger, not a hypothetical.
3. THE ONE SAFETY NET IS STRUCTURALLY BLIND TO IT. `src/lib/reconciliation.ts:101` and `:134` both begin `if (!c.captured â€¦) continue`. The $49 is authorize-then-manual-capture, so a hold is `captured:false` â€” reconciliation CANNOT see a lost `checkout.session.completed`. It is also on-demand only (admin route + `scripts/reconcile-payments.ts`); no cron exists (no reconciliation entry in the `ScheduledJobData` union, queues/index.ts:227-285).
4. A STALE-'processed' HAZARD. `:147-150` stamps 'processed' by `log.id` with no status guard, while `:158-159` only downgrades rows still at 'pending'. Under the F-race, a no-op loser can stamp 'processed' while the winner's fan-out rolls back (fulfillment.ts:403-405) â€” after which scenario G proves every future retry is skipped forever.

â”€â”€ WHAT IS GENUINELY FINE (do not "fix") â”€â”€
`fulfillPaidCheckout`'s atomic claim; the success-redirect backup trigger (`app/api/stripe/checkout/success/route.ts:36-42`) which independently fulfills the default path without Redis or the webhook; `WebhookLog.eventId @unique` (prisma/schema.prisma:1786); the 400/500 signature branches (:53-65, scenario H). Also note `ARCHITECTURE.md:163` calls `webhook-retry` "never produced or consumed" â€” that doc is STALE; the worker is live at `src/worker-host.ts:230` and `src/workers/index.ts:93`.

### Business impact
WHAT BREAKS DEPENDS ENTIRELY ON WHICH EVENT IS LOST â€” and the money-critical one is the best protected, which is why this has not bitten yet.

checkout.session.completed (the default path): LOW customer impact, because `app/api/stripe/checkout/success/route.ts:36-42` is a genuine second trigger â€” Stripe 303-redirects the browser there and it calls the same idempotent `fulfillPaidCheckout` without needing Redis or the webhook. A customer only falls through if webhook processing fails AND they close the tab before the redirect resolves. When that happens: they have paid $49 (authorized), the booking is stuck PENDING_PAYMENT, they get no pre-approval email, and Diego gets no Discord approval card â€” the exact "payment succeeds but nothing triggers" failure this module was written to kill. Diego finds out when the customer calls.

charge.dispute.created: HIGHEST severity, NO backup trigger of any kind. Diego never learns a dispute was opened. Stripe's evidence deadline (7-21 days) passes undefended, so the disputed amount plus the dispute fee is lost automatically. Rare â€” but it is unrecoverable money and there is no second path.

charge.refunded: the local Payment row keeps a stale amount and status, so the admin and the customer portal show money that was actually refunded. Reconciliation CAN detect this one (`refund_state_mismatch`) but only if a human runs the script â€” it is not on a cron.

payment_intent.payment_failed: no Discord failure alert, no audit row; a failed payment simply goes unnoticed.

HOW OFTEN: near zero in steady state â€” it needs a Redis or Postgres incident overlapping a webhook, or a worker outage longer than the ~2.5-minute retry budget. But it is close to 100% during a code-before-SQL deploy window, which this project does by hand and is in RIGHT NOW with three unapplied migrations: in that window every `checkout.session.completed` that takes the inline fallback throws MIGRATION_NOT_APPLIED, gets swallowed, and returns 200. The deeper operational cost is that every failure is INVISIBLE â€” Stripe's dashboard shows 200/healthy, the failed-job inspector cannot replay, and reconciliation is blind to uncaptured holds. Diego's monitoring will tell him everything is fine while paid customers sit in silence.

### Fix plan
Sized to the real defect â€” the HTTP contract lies, and there is no durable retry of last resort. Four changes, smallest first.

1. STOP LYING TO STRIPE (â‰ˆ5 lines, src/lib/stripe-events.ts:109-117). In the inline-fallback catch, when `processStripeEventJob` throws, return `{status: 500, body:{error:'â€¦'}}` instead of 200. Stripe's own retry schedule (~3 days, with delivery-failure alerting) then becomes the durable retry this design lacks. Keep 200 when inline SUCCEEDS â€” that work is genuinely done. This alone converts "permanently lost and invisible" into "retried and alarmed", and it restores the intent of the MIGRATION_NOT_APPLIED throw at :207-211.

2. CLOSE THE WORKER-EXHAUSTION HOLE (the part the reviewer missed). In `src/workers/webhook.worker.ts:37-42`, detect final failure (`job.attemptsMade >= (job.opts.attempts ?? 1)`) and raise a Discord failure-alert so a dead event is visible. Then add a replay sweep: a new `scheduled` job type that selects `WebhookLog` rows with status 'failed'/'pending' older than ~10 minutes and re-enqueues them by `eventId`. The table already exists and already carries the unique key, so it IS the durable store the reviewer asked for â€” it just has no reader today. Add `@@index([status])` to `model WebhookLog` (prisma/schema.prisma:1782-1797) for that scan.

3. MAKE THE EVENT CLAIM ATOMIC (robustness, NOT money). Replace the `findUnique` + `upsert` pair (:127-143) with a single conditional claim â€” create-if-absent then `updateMany({ where:{ eventId, status:{ in:['pending','failed'] } }, data:{ status:'processing' } })`, proceed only on `count===1`. Guard the success write at :147-150 with `where:{ id: log.id, status:'processing' }` so a loser can never stamp 'processed' over a run that later rolled back, and widen the failure downgrade at :158-159 to match 'processing'. Explicitly LEAVE `fulfillPaidCheckout`'s claim (fulfillment.ts:147-159) alone â€” it is already correct and is what makes double-processing harmless.

4. GIVE RECONCILIATION EYES FOR HOLDS. In `src/lib/reconciliation.ts`, add an issue type for PaymentIntents in `requires_capture` whose booking is still PENDING_PAYMENT beyond a short window â€” that is precisely a lost `checkout.session.completed`, and today nothing can see it. Register `runReconciliation` on the scheduled queue (daily) so it is a real net rather than a script someone must remember.

MUTATION TESTS (offline, mirroring the harness that produced the evidence above): (a) queue add rejects + inline throws â‡’ assert status 500, not 200; (b) queue add rejects + inline succeeds â‡’ assert 200 and log 'processed'; (c) two concurrent `processStripeEventJob` calls â‡’ assert `handleStripeEvent` runs exactly once; (d) a run that throws after a stale 'processed' stamp â‡’ assert the next retry still executes; (e) an uncaptured `requires_capture` intent on a PENDING_PAYMENT booking â‡’ assert reconcile reports it.

### Files
C:/wt-moving-os/src/lib/stripe-events.ts, C:/wt-moving-os/app/api/stripe/webhook/route.ts, C:/wt-moving-os/src/workers/webhook.worker.ts, C:/wt-moving-os/src/lib/queues/index.ts, C:/wt-moving-os/src/lib/fulfillment.ts, C:/wt-moving-os/app/api/stripe/checkout/success/route.ts, C:/wt-moving-os/src/lib/reconciliation.ts, C:/wt-moving-os/app/api/admin/queues/failed/route.ts, C:/wt-moving-os/prisma/schema.prisma, C:/wt-moving-os/src/lib/redis.ts, C:/wt-moving-os/src/worker-host.ts, C:/wt-moving-os/ARCHITECTURE.md

---

## B4 â€” "Paid checkout can report processed when every notification handoff failed" (src/lib/fulfillment.ts)

**VERDICT: WORSE_THAN_DESCRIBED**

### Evidence
REPRODUCED AGAINST THE SHIPPED CODE, NOT JUST READ. I ran the real `fulfillPaidCheckout` offline (fake prisma on globalThis, real BullMQ stack pointed at a dead Redis on 127.0.0.1:6399 â€” the exact Upstash failure the file's own comments describe). Result:

  elapsed 10,044ms | threw: NO | returned: {"processed":true,"bookingId":"bk_b4"}
  5/5 handoffs failed: email:pre-approval, sms:final-confirmation, discord:booking-created, marketing:enroll, discord:create-job-channels
  final log line: "Checkout fulfilled - booking -> PENDING_APPROVAL, all jobs queued"
  booking.status after: PENDING_APPROVAL (claim NOT released)

Second run, simulating the browser success-redirect arriving after that webhook:
  returned: {"processed":false,"reason":"already-fulfilled-or-not-pending"}

So the reviewer is right on every stated point. The defect is bigger in four ways they did not report.

1) THE SWALLOW AND THE FALSE CLAIM (reviewer's core, confirmed)
- src/lib/fulfillment.ts:54-69 â€” `enqueue()` catches everything and logs; it never throws (63-68).
- src/lib/fulfillment.ts:227-232 â€” the outbox emit is `.catch`-ed the same way.
- src/lib/fulfillment.ts:419-420 â€” `log.info('Checkout fulfilled ... all jobs queued')` and `return { processed: true }` are UNCONDITIONAL. Nothing between 392 and 419 inspects an outcome.

2) THE SHIPPED ROLLBACK FOR THIS EXACT CASE IS UNREACHABLE, AND ITS COMMENT ASSERTS THE OPPOSITE (not in the review)
- src/lib/fulfillment.ts:161-167 states: "Each task is already individually guarded and cannot reject, so reaching the catch means essentially nothing was queued - in which case the claim is RELEASED."
- The premise is true; the conclusion is inverted. Because the tasks cannot reject, `await Promise.all(tasks)` (392) cannot reject, `onBookingPaid` is `.catch`-ed (399-401), the audit write is `.catch`-ed (178), and `ingestBookingToTracker` never throws (src/lib/tracker.ts:37,71-78). The catch at 403-417 therefore CANNOT fire in the one scenario it names. My run confirms it: 5/5 failures, zero rollback. A fixer reading that comment would conclude this case is handled.

3) "processed" TERMINATES ALL THREE RECOVERY PATHS AT ONCE (not in the review)
- Backup trigger dead: the claim (147-159) was consumed by a run that delivered nothing, so the "guaranteed" success redirect (app/api/stripe/checkout/success/route.ts:36-49) no-ops â€” proven in run 2. The two-independent-triggers design the module exists for (fulfillment.ts:12-29) is defeated.
- Stripe/queue retry dead: `fulfillment.processed === true` means no throw, so src/lib/stripe-events.ts:147-150 stamps webhookLog `processed`. The file already knows this hazard and guards the migration case only (193-212).
- This is the SAME structural bug the P0-E block at fulfillment.ts:85-104 says was already fixed ("the retry re-entered, matched 0 rows ... A customer who paid $49 would never have been contacted"). The fix was applied to the read-before-claim window and never to the fan-out.

4) NOTHING DETECTS THE RESULT AFTERWARDS (not in the review)
- src/lib/reconciliation.ts:101 skips uncaptured charges and :63 excludes PENDING_APPROVAL from CAPTURED_BOOKING_STATES. A $49 authorization is uncaptured, so a booking stranded this way is invisible to the only durable money audit.
- The daily Discord digest covers only CONFIRMED/SCHEDULED/IN_PROGRESS (src/workers/scheduled.worker.ts:423, 476) â€” no Discord-side recovery.
- The fan-out is explicitly untested: src/lib/__tests__/migration-window.test.ts:524-529 â€” "the fan-out itself (BullMQ enqueues) needs Redis and is NOT exercised offline ... Every test below stops at the atomic CLAIM."

WHERE THE REVIEWER IS TOO HARSH â€” corrections a fixer must not over-rewrite:
- The owner is NOT blind. app/(admin)/admin/(dashboard)/page.tsx:35 counts PENDING_APPROVAL from Postgres (no Redis) and :302-307 renders "N bookings waiting for approval - Review now ->". The Discord card is the push; the dashboard is a pull Diego must remember to perform. "No Discord approval card" is true; "the owner would see nothing" is not.
- The customer email IS durable when OUTBOX_ENABLED=true: src/outbox/controllers/stripeController.ts:27-58 writes an email_jobs row inside a `$transaction` with an ON CONFLICT idempotency key. But it is default-off (src/outbox/integration.ts:18-20), still swallowed (22-30), and covers only the email â€” never Discord or SMS.
- No money defect. The status flip, `depositPaid:false` and AUTHORIZE-ONLY semantics (fulfillment.ts:147-154) are correct; nothing is lost, double-charged or double-sent. This is a NOTIFICATION-DURABILITY defect. Do not rewrite the payment code.

THE FIX ALREADY EXISTS IN THIS REPO, APPLIED TO THE WRONG THING:
src/lib/quote-capture.ts:581-613 does exactly the right thing for a $0 LEAD â€” queue add fails -> `postLeadNoticeDirect` (deps decl at 292-295) -> bare REST post via src/lib/ops-alert.ts `postToChannels` (used by src/lib/lead-alert.ts:170) -> `recordAlertDelivered` so "we told the owner" and "we could not reach anyone" stay distinguishable. A free lead gets guaranteed delivery; a booking with $49 authorized does not.

### Business impact
TRIGGER â€” not exotic. Any Redis stall or outage during the ~10 seconds a customer completes checkout. The codebase documents this as an OBSERVED recurring condition, not a hypothetical: fulfillment.ts:48-53 ("when Upstash drops the idle connection, queue.add() HANGS FOREVER"), redis.ts:28 ("Upstash Free Tier drops idle TCP connections aggressively"), queues/index.ts:29-33 records a real staging incident where one Redis error killed the web process. It is the single most likely infrastructure failure in this stack, and checkout is the moment it costs the most.

WHAT THE CUSTOMER EXPERIENCES â€” they authorize $49, land on the portal reading "under review" (app/my-booking/[token]/page.tsx:64,114), and then nothing. No pre-approval email, no SMS, ever. From their side it is indistinguishable from having been scammed by a small moving company they found online. The predictable next actions are a phone call, a chargeback, or a public review â€” and the review is the expensive one for a business this size.

WHAT DIEGO EXPERIENCES â€” no Discord approval card, no crew job-coordination card, no entry in the morning or evening digest. His only signal is the amber banner on /admin. If he does not open the dashboard that day, the job is never crewed and the authorization silently expires in about 7 days (src/lib/stripe.ts:83-84) â€” a customer who paid gets ghosted AND the deposit is never collected. Because webhookLog reads `processed`, nothing ever retries and reconciliation cannot see it, so the failure leaves no artifact anyone would go looking at.

FREQUENCY â€” low probability per booking, but every single occurrence is unrecoverable and lands on a real paying customer. At a handful of bookings a day, one Upstash blip that lines up with a checkout costs one entire job plus the relationship. The asymmetry is what makes this release-blocking: the system currently gives a $0 lead a guaranteed-delivery fallback (quote-capture.ts:581-613) and gives a $49-authorized booking none.

SECOND-ORDER â€” the same silent-swallow also drops `discord:create-job-channels` (crew dispatch) and `marketing:enroll`, so downstream lifecycle automation anchored on those never starts either. And the pre-render assumption that "the browser always hits the success URL so the card still posts" (fulfillment.ts:22-28) is false in this failure mode, which means the module's stated safety property does not hold.

### Fix plan
Scope: notification durability only. Do not touch the claim, the status flip, or any Stripe call â€” all verified correct.

1. Make `enqueue` report instead of swallow (src/lib/fulfillment.ts:54-69). Return `{label, ok, err}` rather than `void`; collect results. ~10 lines.

2. Make the log and the return value truthful (fulfillment.ts:419-420). Replace the unconditional "all jobs queued" with the real tally, and add `handoffs` to `FulfillResult` (31-35). Never claim all queued unless all queued. This alone converts a silent failure into a visible one.

3. Durable intent BEFORE the queue â€” the transactional outbox, using the table that already exists. `model Notification` (prisma/schema.prisma:1753-1780) already carries channel / status(QUEUED|SENT|FAILED|SKIPPED|DEFERRED) / recipient / template / payload / bullJobId / retries / error and is indexed on bookingId+status. Write one row per handoff in the SAME transaction as the atomic claim (fulfillment.ts:147-154), then enqueue and stamp bullJobId. Workers move QUEUED->SENT/FAILED (src/workers/email.worker.ts:188-341 already updates these rows; extend the sms and discord workers). Add a sweep that re-drives rows still QUEUED after N minutes. The only schema change likely needed is a unique dedupe key (deterministic `bookingId:eventType`) so re-drives cannot duplicate â€” coordinate with the three already-unapplied migrations noted in docs/deployment.md.

4. Guaranteed approval-card fallback â€” reuse, do not invent. Mirror src/lib/quote-capture.ts:581-613 for `discord:booking-created`: on enqueue failure, post a plain-text approval notice (displayId, name, phone, date, $ amount, deep link to /admin/bookings/<id>) directly through src/lib/ops-alert.ts `postToChannels`, and record delivered/not on the Notification row. ops-alert.ts is a bare HTTPS POST with no discord.js dependency â€” that bundle constraint is documented at ops-alert.ts:8-16, and it is why this primitive, not src/bot/discord-rest.ts, is the safe one to call from a Next route.

5. Resolve the unreachable rollback (fulfillment.ts:161-167, 403-417). Either delete it as dead code or make the honest rule real: if the durable Notification rows were NOT written, release the claim and throw so the webhook retries; if they WERE written, keep the claim and let the sweep deliver. What must not survive is a comment asserting a guarantee the code cannot make.

6. Extend the "do not record processed" contract (src/lib/stripe-events.ts:193-212). The MIGRATION_NOT_APPLIED precedent is already there; add the same for "no durable work exists", so webhookLog stays `failed` and webhook-retry re-runs it.

7. Close the detection gap: teach src/lib/reconciliation.ts an issue type for PENDING_APPROVAL bookings older than ~N minutes with no delivered owner notification (today :63 and :101 make it structurally blind to uncaptured authorizations), and/or add PENDING_APPROVAL to the daily digest (src/workers/scheduled.worker.ts:423, 476).

8. Tests â€” the gap is documented at src/lib/__tests__/migration-window.test.ts:524-529. Add offline coverage in the shape I proved works: fake prisma on globalThis + REDIS_URL pointed at a dead port, then assert that with every queue dead fulfillment does NOT return processed:true, does NOT log "all jobs queued", and either releases the claim or leaves durable Notification rows. Mutation-test each guard (introduce the defect, confirm red, restore).

### Files
C:/wt-moving-os/src/lib/fulfillment.ts, C:/wt-moving-os/src/lib/stripe-events.ts, C:/wt-moving-os/app/api/stripe/checkout/success/route.ts, C:/wt-moving-os/src/lib/queues/index.ts, C:/wt-moving-os/src/lib/redis.ts, C:/wt-moving-os/src/lib/ops-alert.ts, C:/wt-moving-os/src/lib/lead-alert.ts, C:/wt-moving-os/src/lib/quote-capture.ts, C:/wt-moving-os/src/outbox/integration.ts, C:/wt-moving-os/src/outbox/controllers/stripeController.ts, C:/wt-moving-os/src/lib/tracker.ts, C:/wt-moving-os/src/lib/journeys.ts, C:/wt-moving-os/src/lib/reconciliation.ts, C:/wt-moving-os/src/workers/scheduled.worker.ts, C:/wt-moving-os/src/workers/email.worker.ts, C:/wt-moving-os/prisma/schema.prisma, C:/wt-moving-os/app/(admin)/admin/(dashboard)/page.tsx, C:/wt-moving-os/src/lib/__tests__/migration-window.test.ts

---

## B5 â€” "SMS messages are sent at the wrong lifecycle stages" (docs/moving-os-release-blockers.md:84-88)

**VERDICT: WORSE_THAN_DESCRIBED**

### Evidence
WHAT THE REVIEWER GOT RIGHT (call sites confirmed exactly):
- C:/wt-moving-os/src/lib/fulfillment.ts:272 queues job 'final-confirmation-sms', text = t(locale,'finalConfirmation') at :274 â€” fired after the PENDING_PAYMENT/DRAFT -> PENDING_APPROVAL claim at fulfillment.ts:148-150. Owner has NOT approved; $49 is authorized, not captured.
- C:/wt-moving-os/src/lib/booking-approval.ts:1273 queues job 'pre-approval-sms', text = t(locale,'preApproval') at :1275 â€” fired after the atomic claim + Stripe capture (booking-approval.ts:790-829) and commitApproval writing Payment status COMPLETED + Job SCHEDULED (:1142-1175). Booking IS CONFIRMED and the $49 IS CAPTURED.

ANSWERING THE QUESTION POSED â€” the job NAMES are inert; the customer-visible TEXT is genuinely wrong:
src/workers/sms.worker.ts:59-121 destructures only { to, message, bookingId }. job.name appears ONLY in log lines (:61, :143, :146). There is no SMS name/template allowlist (unlike email). So renaming the jobs changes nothing a customer sees â€” the defect is entirely in the i18n key selected.

EXACT STRINGS A CUSTOMER RECEIVES (produced by RUNNING the shipped t() from src/lib/i18n.ts via tsx, name=Maria, displayId=WMIC-1042):

Stage 1 â€” PENDING_APPROVAL, hold authorized, Diego can still decline:
EN: "Hi Maria! Booking WMIC-1042 confirmed. $49 hold recorded. Next: we finalize your move for Thursday, January 15, 2026. Questions? 862-640-0625"
ES: "Â¡Hola Maria! Reserva WMIC-1042 confirmada. RetenciÃ³n de $49 registrada. Siguiente: finalizamos tu mudanza para 15 ene 2026, 10:00 a.m.. Â¿Preguntas? 862-640-0625"
-> "Booking ... confirmed"/"confirmada" is an OVER-CLAIM the code cannot prove: status is PENDING_APPROVAL and claimCancel (booking-approval.ts:1188-1193) can still cancel it. It also flatly contradicts the EMAIL the SAME function sends 35 lines earlier (fulfillment.ts:237-238, template 'pre-approval', subject i18n.ts:142 = "We've received your booking request"), and contradicts that file's own written policy at fulfillment.ts:199-205 ("Sending the pre-confirmation here (not the confirmation) keeps every message honest about the true booking state"). "$49 hold recorded" is accurate and fine.

Stage 2 â€” CONFIRMED, $49 actually CAPTURED:
EN: "Hi Maria! Booking WMIC-1042 is approved â€” pending final confirmation for Thursday, January 15, 2026. We'll be in touch. â€” 862-640-0625"
ES: "Â¡Hola Maria! La reserva WMIC-1042 estÃ¡ aprobada â€” pendiente de confirmaciÃ³n final para Thursday, January 15, 2026 at 10:00 AM. Te contactaremos. â€” 862-640-0625"
-> "pending final confirmation"/"pendiente de confirmaciÃ³n final" is FALSE: the booking is CONFIRMED. It contradicts the email sent 28 lines earlier (booking-approval.ts:1245-1254, template 'final-confirmation', literal bookingStatus:'CONFIRMED', subject i18n.ts:143 = "Your booking is approved").

WHY THE REVIEWER'S FIX IS WRONG (simulated by running t() with the keys swapped):
- Stage 1 would then say "Booking WMIC-1042 is approved â€” pending final confirmation" â€” claims an owner approval that has not happened. New false claim.
- Stage 2 would then say "$49 hold recorded. Next: we finalize your move" â€” but the $49 was CAPTURED, not held, and the move IS finalized. Two new false claims, one of them about money.
The two strings are not mirror images; each is wrong for its own stage in a different way, so "swap them" ships four wrong statements instead of two.

WORSE #1 â€” THE CAPTURE IS NEVER DISCLOSED BY SMS AT ALL (not in the reviewer's report):
Stage 1 correctly tells the customer "$49 hold recorded" (a hold, not a charge). Stage 2 is the exact moment the card is really charged, and its text says nothing about money. Across the entire lifecycle no text ever tells the customer $49 left their card.

WORSE #2 â€” THE CORRECT COPY ALREADY EXISTS AND IS DEAD (so this is a wiring bug, not missing copy):
grep across src/ and app/ shows i18n.ts:39-42 'depositHold' and i18n.ts:44-47 'bookingConfirmed' have ZERO consumers (only the doc-comment at i18n.ts:11). Both are bilingual and fit exactly:
depositHold EN: "Move It Clear It.: Your $49 is authorized (a hold, not a charge) for booking WMIC-1042 â€” we're reviewing it now and only capture it once approved..." = stage 1.
bookingConfirmed EN: "Hi Maria! Your move with Move It Clear It. is confirmed for Thursday, January 15, 2026..." = stage 2.

WORSE #3 â€” SPANISH DATE DEFECT ON THE SAME FIVE LINES (untriaged by the reviewer):
booking-approval.ts:1223 builds dateStr via scheduling.formatMoveWhen(when, startTimeKnown) (scheduling.ts:396) which accepts NO locale, and falls back to the hardcoded English 'your move date'. Verified by running: an ES customer's stage-2 SMS embeds "Thursday, January 15, 2026 at 10:00 AM" inside Spanish copy, and for a day-level booking reads "...pendiente de confirmaciÃ³n final para your move date...". The stage-1 site does this correctly (fulfillment.ts:189-191 passes 'es-US' to booking-display.smsMoveWhen -> "15 ene 2026").

CORRECTION TO THE REVIEWER'S PROVENANCE CLAIM:
"(Noted in an earlier audit as a copy/key inversion and never fixed.)" is unsupported. Grepping docs/ and all *.md, the ONLY occurrence of these key/job names in the repo is the reviewer's own file (docs/moving-os-release-blockers.md:85-86). docs/moving-os.md:29 flags different SMS gaps (jobStarted has no consumer; the 7AM day-of text). No prior audit recorded this.

SCOPE CONFIRMATIONS (no over-statement):
- Exactly ONE SMS per stage â€” grep shows no SMS sender in the outbox path (src/lib/payment-events.ts, src/lib/email-events.ts); the outbox is email-only. No double-text.
- Both SMS calls sit OUTSIDE their outboxEnabled() if/else (fulfillment.ts:267 after the else closes at :265; booking-approval.ts:1272 after the else closes at :1270), so the defect fires on BOTH OUTBOX_ENABLED branches â€” it is not flag-gated.
- Delivery is gated by TWILIO_ENABLED==='true' (sms.worker.ts:66); DEPLOY.md:147 instructs setting it true for production, .env.example:119 ships false.

### Business impact
Every booking that has a customer phone number, on the default path, once TWILIO_ENABLED=true (DEPLOY.md:147). Not flag-gated otherwise â€” both texts fire on both OUTBOX_ENABLED branches. That is two texts per booking, and both are wrong.

What the CUSTOMER experiences: minutes after paying, they get a text saying their booking is "confirmed" while Diego has not yet looked at it â€” and simultaneously an email saying "We've received your booking request" (under review). They will believe the move is booked. If Diego then declines or offers a different date, he is retracting a confirmation his own system already issued, to a customer who has started planning around it. That directly undermines the decline and reschedule flows (and compounds B2, where a failed hold release is already reported as successful). Then, at approval â€” the moment their card is genuinely charged $49 â€” they get a text saying the move is "pending final confirmation" alongside an email titled "Your booking is approved". The two channels contradict each other at both stages, in opposite directions.

What DIEGO experiences: a predictable "so is my move actually booked or not?" call or text on essentially every job, at the two highest-anxiety moments (right after payment, right after approval). Because no SMS ever states that the $49 was captured, he also has no texted record of the charge to point to in a card dispute â€” the only place the capture is disclosed is the email.

Spanish-speaking customers get an additional hit: the approval text mixes Spanish copy with an English date ("...pendiente de confirmaciÃ³n final para Thursday, January 15, 2026 at 10:00 AM..."), or literally the untranslated string "your move date" for a day-level booking.

Severity is customer-trust and money-transparency, not data corruption â€” no booking, payment or job row is written incorrectly by this defect. It is release-blocking for the stated standard ("no message may claim something the code cannot prove"), and cheap to fix, but the reviewer's prescribed swap would leave it worse than doing nothing.

### Fix plan
Do NOT apply the reviewer's swap. Re-point each call site at the already-written, already-bilingual key that matches its stage, and fix the Spanish date on the approval line.

1. Stage 1 â€” src/lib/fulfillment.ts:271-282. Replace t(locale,'finalConfirmation',{name,displayId,date:dateStr}) with t(locale,'depositHold',{displayId, phone: BIZ_PHONE}) (import BIZ_PHONE from '@/lib/i18n'). This removes the "confirmed" over-claim and aligns the SMS with the 'pre-approval' email this same function sends. If Diego wants the date in this text, EXTEND the depositHold string in both en and es â€” do not fall back to finalConfirmation. Rename the job to 'deposit-hold-sms' for log legibility only (cosmetic; sms.worker.ts ignores it).

2. Stage 2 â€” src/lib/booking-approval.ts:1272-1278. Replace t(locale,'preApproval',...) with t(locale,'bookingConfirmed',{name,date:dateStr}), and add the capture disclosure that exists nowhere today. Preferred: add ONE new key (e.g. bookingConfirmedCaptured) rather than mutating bookingConfirmed, since capturedCents is already in scope at :1259 â€” EN "Hi {name}! Your move with Move It Clear It. is confirmed for {date}. Your ${amount} deposit was charged. Questions? Reply or call 862-640-0625." plus the ES twin. Rename the job to 'booking-confirmed-sms' (cosmetic).

3. Spanish date â€” src/lib/booking-approval.ts:1223. For the SMS only, build dateStr the way fulfillment.ts:189-191 does: smsMoveWhen(booking, locale === 'es' ? 'es-US' : 'en-US') from '@/lib/booking-display', with a localized fallback ('tu fecha de mudanza' / 'your move date'). Leave the EMAIL's `when`/`timeLabel` path (:1218-1229, :1257-1258) untouched â€” it carries the moveTimeKnown day-anchor guard (ITEM R3-2) and must keep suppressing an invented hour. Whatever helper is used must keep honoring moveTimeKnown so a day-level booking never prints a time.

4. Keep the "1 of the 2 allowed texts" policy intact â€” still exactly two transactional texts per booking, so no 10DLC/TCPA volume change. Update the stale comments at i18n.ts:48-49 and :54-55, which currently describe the inverted wiring as intended.

5. Tests (mutation-test each: introduce the defect, confirm red, restore):
   - stage-1 SMS body must NOT match /confirmed|confirmada/ and MUST contain hold/authorized language, EN and ES;
   - stage-2 SMS body must NOT match /pending|pendiente/, MUST assert confirmation, MUST disclose the charge, EN and ES;
   - ES stage-2 body must contain no English month name and must not contain 'your move date';
   - a day-level (startTimeKnown=false) booking must produce no clock time in either SMS.

6. Correct docs/moving-os-release-blockers.md:84-88: record that the job names are inert, that the prescribed swap is harmful, and drop the unsupported "noted in an earlier audit" provenance line.

### Files
C:/wt-moving-os/src/lib/fulfillment.ts, C:/wt-moving-os/src/lib/booking-approval.ts, C:/wt-moving-os/src/lib/i18n.ts, C:/wt-moving-os/src/workers/sms.worker.ts, C:/wt-moving-os/src/lib/scheduling.ts, C:/wt-moving-os/src/lib/booking-display.ts, C:/wt-moving-os/docs/moving-os-release-blockers.md

---

## B6 â€” "Expired Stripe checkouts leave permanent truck holds"

**VERDICT: WORSE_THAN_DESCRIBED**

### Evidence
MECHANISM â€” CONFIRMED EXACTLY AS DESCRIBED, at the cited lines.

1. 30-minute expiry is real. src/lib/stripe.ts:115 â€” `expires_at: Math.floor(Date.now() / 1000) + 30 * 60` on every session created by `createBookingCheckout`. The abandonment window is half an hour, not a day.

2. The expiry handler is a no-op. src/lib/stripe-events.ts:250-256:
   case 'checkout.session.expired': { ... webhookLogger.info({ bookingId }, 'Checkout session expired'); break }
   It reads `metadata.bookingId` and logs. No status write, no truck clear, no alert. A repo-wide grep for `checkout.session.expired` returns exactly ONE code hit (this one); DEPLOY.md:66 confirms the event IS subscribed in Stripe, so it fires and does nothing.

3. PENDING_PAYMENT occupies the truck. src/lib/truck-conflicts.ts:110-118 puts PENDING_PAYMENT in TRUCK_HOLD_STATUSES; :123-125 `holdsTruck`. src/lib/admin-booking.ts:255-256 `decideStatus('stripe_link') === 'PENDING_PAYMENT'`, and :1151 writes `truckId: input.truckId ?? null` UNCONDITIONALLY â€” so the default path stamps a truck onto an unpaid row.

I RAN the shipped pure functions offline (tsx, no DB) against the row the default create actually persists (PENDING_PAYMENT, truckId set, estimatedHours 8, NO scheduledStart/confirmedDate, requestedDate 2026-09-19 18:00 ET):
  holdsTruck('PENDING_PAYMENT')     = true
  truckHoldHours                    = 9h  (8h + 1h travel buffer)
  truckOccupiedEtDays               = ["2026-09-19","2026-09-20"]  <- TWO ET days
  truckConflictBetween(new same-day)= 'same_day_unknown_times'
  truckConflictBetween(next 08:00)  = 'same_day_unknown_times'
  findTruckConflictsIn              = 1 conflict, hold='pending', blocker='WMIC-1042'
  holdsTruck('CANCELLED')           = false   <- the ONLY exit
truckCandidateWhere still matches the row via its `requestedDate` OR-clause, so nothing ages it out.

NOTHING RELEASES IT â€” I checked every path the task named, exhaustively:
 â€¢ No cron. Full registry, src/workers/scheduled.worker.ts:697-828: digests, campaign-sweep, automation-sweep, email-side-effect-sweep, email-monitoring, email-agent-cycle, lead-maintenance, marketing-discovery, lifecycle-repair. None touches bookings-by-age or trucks. `lifecycle-repair` (:383-392) calls `repairStrandedQuoteJourneys` â€” LEAD quote journeys, unrelated.
 â€¢ The abandoned-checkout journey PRESERVES the hold rather than clearing it: scheduled.worker.ts:88 `if (booking.status !== 'PENDING_PAYMENT') break` â€” it only sends email, and requires the stuck state to persist.
 â€¢ The resume route (app/api/stripe/checkout/resume/route.ts:99-119) creates a fresh session and changes no status.

TWO DEFECTS THE REVIEWER MISSED â€” this is why the verdict is WORSE:

A. An abandoned booking cannot be cancelled by ANYONE, through ANY surface. app/api/admin/bookings/[id]/status/route.ts:21-27 `VALID_TRANSITIONS` has keys for PENDING_APPROVAL, CONFIRMED, SCHEDULED, IN_PROGRESS, COMPLETED â€” and NO key for PENDING_PAYMENT. Line 114 `const allowed = VALID_TRANSITIONS[booking.status] ?? []` then line 115-117 returns 422 "Cannot transition from PENDING_PAYMENT to CANCELLED". Every transition out of the state is refused. The capability EXISTS and is unreachable: src/lib/booking-approval.ts:978 `DENYABLE = ['PENDING_APPROVAL','PENDING_PAYMENT','DRAFT']` â€” `declineBooking` explicitly accepts PENDING_PAYMENT and would free the truck â€” but its only other caller is the Discord Deny button, and that card is posted from src/lib/fulfillment.ts:285-288 inside `fulfillPaidCheckout`, i.e. ONLY after payment. An unpaid booking never gets a card. The admin create route posts none. Nor can the truck be detached: app/api/admin/bookings/[id]/route.ts:41 allowlists only ['internalNotes','confirmedDate','scheduledStart','scheduledEnd','estimatedHours','baseRate'] â€” `truckId` is not editable, and no `truckId: null` write exists anywhere in the repo. So PENDING_PAYMENT is an unclearable dead-end state for ALL purposes, not just trucks.

B. A trap that will bite the fixer. app/api/stripe/checkout/resume/route.ts:99-119 creates a NEW Stripe session and never persists its id (no `booking.update`; `stripeCheckoutId` still points at the ORIGINAL session, written at app/api/admin/bookings/route.ts:805). A naive expiry handler keyed on `metadata.bookingId` alone would therefore CANCEL a booking whose customer is at that moment paying through a resumed session. Also note the route's own comment at :21 claims "Stripe sessions expire (~24h)" â€” contradicting the 30-minute `expires_at`; the author's model of the abandonment rate is 48x off.

TWO REVIEWER CLAIMS THAT DO NOT SURVIVE â€” stated plainly so nobody over-fixes:
 â€¢ "Blocks a truck FOREVER" is imprecise. The block is scoped to the ET days the hold window covers, keyed off `requestedDate` (probe: Sep 19 + Sep 20). It burns that truck on those dates until the date passes â€” not the truck globally.
 â€¢ "Does the owner have any way to SEE or clear it" â€” SEEING is fine, and the write-up implies otherwise. app/api/admin/trucks/route.ts:111-117 returns per-truck `pendingHolds`/`confirmedJobs`; app/(admin)/admin/(dashboard)/trucks/page.tsx:64-66 counts holds; the bookings list has a PENDING_PAYMENT filter (app/(admin)/admin/(dashboard)/bookings/page.tsx:8); the dashboard labels the status "abandoned checkout" (app/(admin)/admin/(dashboard)/page.tsx:49); and the create refusal NAMES the blocking booking as an unpaid hold (src/lib/truck-lock.ts:76). The owner is also NOT hard-blocked: `truckConflictOverride` (src/lib/admin-booking.ts:229, app/api/admin/bookings/route.ts:489, audited at :610) is a real, wired UI checkbox (BookMoveForm.tsx:906,917). So this is a silent slot-burn plus permanent uncleanable garbage â€” NOT lost revenue.

### Business impact
WHO TRIGGERS IT: every admin Book Move on the default deposit mode (`stripe_link`) where the customer does not finish paying within 30 minutes. Because the expiry window is 30 minutes, not 24 hours, the ordinary "I'll pay tonight / let me ask my wife" customer trips it. This is the DEFAULT path, so it is the most common unpaid outcome the system has.

WHAT DIEGO EXPERIENCES: the truck stays held on the customer's requested move date â€” and, for any evening job, on the following morning too (my probe: a 6pm 4BR holds Sep 19 AND Sep 20). When he later books that truck for that date, he is refused with a 409 that correctly names the blocker as an unpaid hold. He is not stuck: he can tick the audited "override" checkbox (BookMoveForm.tsx:906) or pick another truck. So the direct cost is friction and a burned-looking slot, NOT a lost booking â€” the reviewer's "blocks a truck forever" overstates the revenue impact.

THE REAL COST IS THE MESS HE CANNOT CLEAN. The stuck row is permanent and there is no button anywhere that ends it: the admin status route 422s every transition out of PENDING_PAYMENT, and truckId is not editable. So (a) dead bookings accumulate in the bookings list forever, (b) once he overrides, the Action Center raises a CRITICAL `truck-double-booked` reminder for that truck-day (verified: two unpaid holds fire the rule, deduped per truck-day) that he can never resolve at the source â€” only dismiss, which trains him to dismiss the alert that exists to prevent a real double-booking, and (c) the row stays in the abandoned-checkout email audience. Over a season this is a slowly-filling bucket of un-actionable CRITICAL noise on the one guard protecting against genuinely double-booking a truck.

FREQUENCY: proportional to unpaid admin bookings â€” realistically several a month for a small NJ operator, and every single one is permanent. Nothing self-heals; the backlog only grows.

CUSTOMER IMPACT: mostly none directly â€” but note admin-created bookings never enter the abandoned-checkout journey at all (`onBookingCreated` is wired only into the public app/api/bookings/route.ts:645, not the admin route), so a customer who abandons an admin-created checkout gets no recovery email AND no cleanup. That is a separate revenue-recovery gap worth raising, outside B6's scope.

RISK IF FIXED CARELESSLY: the highest-consequence failure mode here is the fix, not the bug. An expiry handler keyed on `metadata.bookingId` alone will cancel bookings mid-payment, because the resume route issues a new session without persisting its id. That converts a housekeeping defect into customers being cancelled while their card is being charged. The session-identity guard in step 1 plus the persistence in step 2 must land together.

### Fix plan
Sized to the real defect: the hold is clearable neither automatically nor manually, so the fix is TWO paths plus a safety guard â€” not just the expiry handler the reviewer described.

1. Make the expiry handler act (src/lib/stripe-events.ts:250-256), with the session-identity guard that prevents the resume-race in evidence B. Conditional update only:
   prisma.booking.updateMany({ where: { id: bookingId, status: 'PENDING_PAYMENT', depositPaid: false, stripeCheckoutId: session.id }, data: { status: 'CANCELLED' /* or a new EXPIRED state */ } })
   All four predicates matter: `stripeCheckoutId: session.id` is what stops a stale session's expiry from killing a booking the customer is actively paying through, and it makes the handler replay-safe. Write an AuditLog row on count:1 so the state change is explainable; log-and-skip on count:0. Do NOT free the truck by nulling truckId â€” leaving TRUCK_HOLD_STATUSES already releases it (probe: holdsTruck('CANCELLED') === false), and nulling would destroy the owner's assignment intent.

2. Persist the resumed session id (app/api/stripe/checkout/resume/route.ts, after the create at :112): `prisma.booking.update({ where: { id: booking.id }, data: { stripeCheckoutId: session.id } })`. Without this, step 1's guard silently never fires for any resumed checkout â€” the fix would look correct and do nothing. Fix the stale "~24h" comment at :21 to 30 minutes while there.

3. Give the owner the manual exit that does not exist today (app/api/admin/bookings/[id]/status/route.ts:21-27). Add `PENDING_PAYMENT: ['CANCELLED']` to VALID_TRANSITIONS and route it to the existing `declineBooking` â€” which already lists PENDING_PAYMENT in DENYABLE (booking-approval.ts:978), already takes an atomic claim, already releases any hold, and already writes the audit row. This is a two-line change reusing a tested service, and it is what makes an already-stuck production row recoverable. Surface a "Cancel unpaid booking" action on the PENDING_PAYMENT filter view.

4. Reconciliation sweep for MISSED webhooks (a new `stale-checkout-sweep` in src/workers/scheduled.worker.ts, registered alongside the others at :697-828). Hourly: find `status='PENDING_PAYMENT' AND depositPaid=false AND createdAt < now-2h`, retrieve the session from Stripe, and only cancel on a genuine `expired`/`open-but-past-expires_at` verdict â€” never on age alone, or it will cancel bookings a customer is still paying for. Keep it bounded and idempotent; a no-op pass should be one indexed query. Give PENDING_PAYMENT rows an index on (status, depositPaid, createdAt).

5. Tests (mutation-test each): expiry with a matching session id cancels and frees the truck; expiry with a NON-matching session id (the resume race) does NOT cancel; replayed expiry is a no-op; PENDING_PAYMENT â†’ CANCELLED is now permitted and releases the hold; a cancelled row is absent from findTruckConflictsIn. The existing offline harness in src/lib/__tests__/truck-hold.test.ts already builds the exact row shapes needed.

NOT in scope: do not touch TRUCK_HOLD_STATUSES. PENDING_PAYMENT holding a truck is deliberate and correct (documented R2-2, truck-conflicts.ts:63-78) â€” the bug is the missing exit, not the hold.

### Files
C:/wt-moving-os/src/lib/stripe-events.ts, C:/wt-moving-os/src/lib/stripe.ts, C:/wt-moving-os/src/lib/truck-conflicts.ts, C:/wt-moving-os/src/lib/admin-booking.ts, C:/wt-moving-os/src/lib/booking-approval.ts, C:/wt-moving-os/src/lib/fulfillment.ts, C:/wt-moving-os/app/api/admin/bookings/[id]/status/route.ts, C:/wt-moving-os/app/api/admin/bookings/[id]/route.ts, C:/wt-moving-os/app/api/admin/bookings/route.ts, C:/wt-moving-os/app/api/stripe/checkout/resume/route.ts, C:/wt-moving-os/src/workers/scheduled.worker.ts, C:/wt-moving-os/app/api/admin/trucks/route.ts, C:/wt-moving-os/app/(admin)/admin/(dashboard)/book/BookMoveForm.tsx, C:/wt-moving-os/app/(admin)/admin/(dashboard)/bookings/page.tsx, C:/wt-moving-os/src/lib/__tests__/truck-hold.test.ts

---

## B7 + B8 â€” lifecycle inconsistency across the admin status route and the Discord interactions route

**VERDICT: WORSE_THAN_DESCRIBED**

### Evidence
SUMMARY: B8 is CONFIRMED and materially worse than described (it is the DEFAULT completion path and the damage is UNRECOVERABLE). B7 is PARTIAL: one of its three sub-claims is factually wrong as stated, two are confirmed, and the consequence it names is real but arrives by a different mechanism â€” one that is also unrecoverable. Combined verdict: worse than described.

=== EVERY PATH THAT CAN COMPLETE OR CANCEL A BOOKING (exhaustive) ===
Established by grepping every `prisma.booking.update|updateMany` and every `status: 'COMPLETED'|'CANCELLED'` write in app/ and src/ (non-test).

COMPLETE â€” exactly 2 paths:
1. app/api/admin/bookings/[id]/status/route.ts POST (IN_PROGRESS -> COMPLETED only; VALID_TRANSITIONS L21-27). Writes, as 5 SEPARATE awaits, no transaction:
   L214-219 prisma.job.updateMany -> Job.status COMPLETED + Job.completedAt (updateMany, NOT upsert: if no Job row exists, 0 rows and no Job is ever created; durationMins never set)
   L221 updateBookingStatusRow -> Booking.status = COMPLETED, `data` is `{ status }` only (L172) â€” no Booking.completedAt here
   L223-230 auditLog.create BOOKING_STATE_CHANGED
   L267-283 emailQueue.add('job-completion')
   L288-293 onBookingCompleted -> src/lib/followups.ts:156-158 `booking.updateMany({ where: { id, completedAt: null }, data: { completedAt: new Date() } })` â€” first-wins, unconditional, BEFORE the FOLLOWUPS_ENABLED gate; failure is swallowed by `.catch(log.warn)` â€” then schedules review-request/review-reminder/referral-ask/repeat-reminder
   L298-301 onBookingCompletedBalance -> src/lib/journeys.ts:746 fires the `move_completed` automation trigger + L749-754 the +24h balance reminder
2. app/api/discord/interactions/route.ts handleJobComplete L738-781. Accepts CONFIRMED / SCHEDULED / IN_PROGRESS. ONE prisma.$transaction (L759-776): Booking.status COMPLETED + Booking.completedAt, Job upsert COMPLETED + completedAt + durationMins, auditLog JOB_COMPLETED. Then L778-780 logs and re-renders the card. NOTHING ELSE.

CANCEL â€” 3 paths:
3. Admin route L158-170 (PENDING_APPROVAL -> CANCELLED) -> declineBooking; booking-approval.ts:1188-1193 claimCancel writes ONLY Booking.status (no Job â€” none exists at that stage; DENYABLE = PENDING_APPROVAL/PENDING_PAYMENT/DRAFT, L978).
4. Admin route generic path (CONFIRMED -> CANCELLED, SCHEDULED -> CANCELLED). L172 `data = { status }`, L208-219 touches the Job ONLY for IN_PROGRESS and COMPLETED â€” so the Job is NOT touched at all. L307-313 onBookingCancelled (queue cleanup only). A Job DOES exist by then: booking-approval.ts:1166-1170 upserts Job status SCHEDULED at approval, and the admin route L181-185 does the same on CONFIRMED.
5. Discord deny -> declineBooking (same as 3).
NO cancel path exists from IN_PROGRESS (VALID_TRANSITIONS L24-25), and Discord has no cancel button.
NOT completion/cancellation paths (checked and excluded): app/api/admin/bookings/[id]/route.ts:41 PATCH allowlist is notes/dates/rates only â€” status cannot be set; app/api/customer/booking/[token]/route.ts PATCH is reschedule -> PENDING_APPROVAL only (L97-107); closeout-service, labor-service, scheduled.worker, bot/* write no Booking status.

=== B7, CLAIM BY CLAIM ===
(a) "completion sets Job.completedAt but NOT Booking.completedAt" â€” WRONG AS STATED. The route line does not, but the route CALLS onBookingCompleted (L290), which stamps it (followups.ts:156-158). On the happy path Booking.completedAt IS set. A fixer told to "add the missing stamp" would be rewriting correct code.
    THE REAL DEFECT, which is worse: the stamp is the LAST write, outside any transaction, AFTER the point of no return, and its failure is swallowed. Anything that kills the request between L221 and L290 (deploy restart, Neon blip, client abort, the swallowed .catch) leaves Booking.status = COMPLETED with completedAt = NULL â€” and the route can never be re-run, because VALID_TRANSITIONS['COMPLETED'] = ['ARCHIVED'] (L26), so a retry returns 422 at L115-117. Permanent, silent.
(b) "cancellation does not set the Job to CANCELLED" â€” CONFIRMED, completely. `JobStatus.CANCELLED` exists (prisma/schema.prisma:88-93) and is written by NOTHING in the entire repo (only JobCrew.assignmentStatus is ever set to CANCELLED, app/api/admin/staff/[id]/deactivate/route.ts:66). A cancelled CONFIRMED booking leaves Job.status = SCHEDULED forever. Consequences the reviewer did not name:
    â€¢ src/lib/conflict-engine.ts:128-130 `ASSIGNMENT_ON_CANCELLED_JOB` HARD_BLOCK is DEAD CODE â€” unreachable. app/api/admin/jobs/[id]/crew/route.ts:146-164 gates crew creation on exactly this engine and performs no Booking-status check of its own (L80 only checks existence), so crew can be assigned to a cancelled move with zero warning.
    â€¢ app/api/crew/assignments/route.ts:26-73 filters only on assignmentStatus liveness â€” not Booking.status, not Job.status â€” so the cancelled move stays in the worker's "upcoming" list (app/crew/page.tsx:63-76). Note: setting Job.status = CANCELLED alone would NOT fix this; the assignments must also be cancelled or the query filtered.
    â€¢ Nothing cancels the JobCrew rows or their AssignmentNotification reminders on booking cancellation.
    â€¢ Not affected: the scheduling board (src/lib/scheduling-service.ts:176-198 filters on Booking.status) and truck holds (truck-conflicts keys on Booking.status), so this is a crew/staffing defect, not a dispatch or truck one.
(c) "Job, Booking and Audit are not one transaction" â€” CONFIRMED (L215, L221, L223 are three independent awaits; contrast Discord L759-776, which is correctly atomic).
(d) "Booking.completedAt gates follow-ups (email-eligibility.ts ~116-122) so completion automation can be silently blocked" â€” CONFIRMED as an outcome. src/lib/email-eligibility.ts:117-122 requires completedAt for job-completion, review-request, review-reminder, referral, referral-ask, repeat-reminder. I RAN the shipped predicate offline (bookingBlockReason, pure, no DB):
      status=COMPLETED + completedAt=NULL -> job-completion/review-request/review-reminder/referral/referral-ask/repeat-reminder ALL return `not_completed`
      same booking with completedAt stamped -> all six return null (allowed)
    And the block is not recoverable: email-guard.ts:664-677 refuses with no retryAt; classifyBlock (L382-402) maps `not_completed` to 'retryable' (the `^booking_not_completed:` regex does not match it) so the row lands in `blocked_retryable`; email.worker.ts:321-336 returns without throwing, so BullMQ never retries; and `dueForRetry` (email-guard.ts:868-878) HAS NO CALLER â€” documented by the repo itself at app/api/admin/email-marketing/sends/route.ts:13-17 and scripts/email-queue-audit.ts:228. Nothing re-drives it.
(e) ORDERING HAZARD the reviewer missed: the job-completion email is enqueued at L267-283 BEFORE completedAt is stamped at L290. A worker that reaches its recheck before that single DB write sees completedAt = NULL and permanently drops the customer's move-complete email per (d). Narrow (the worker renders + hits suppression first, so the route usually wins) but unguarded, and it is the only send exposed â€” the four follow-ups are delayed >= 2h.

=== B8 ===
CONFIRMED, and worse than described on three counts.
â€¢ Verified absence: `onBookingCompleted`, `onBookingCompletedBalance` and `onBookingCancelled` are imported and called from EXACTLY ONE file in the repo â€” app/api/admin/bookings/[id]/status/route.ts (L6-7, L290/298/309). handleJobComplete calls none of them and enqueues no email. So a Discord completion produces: no job-completion email, no +24h balance reminder, no `move_completed` automation trigger (journeys.ts:746 â€” an event-driven trigger with no sweep; email-automation-runtime.ts:880-882 `continue`s for such triggers), no review request, no review reminder, no referral ask, no repeat-customer reminder.
â€¢ IT IS THE DEFAULT PATH, not an alternative. src/lib/fulfillment.ts:361-364 enqueues `create-job-channels` for EVERY paid booking; discord.worker.ts:33-35 -> discord-rest.ts:232-264 posts the MOVE DAY JOB card, whose buttons (src/lib/booking-display.ts:667-679) include "âœ… Complete Job" for CONFIRMED/SCHEDULED/IN_PROGRESS. That is one tap in the field. The admin equivalent needs four sequential clicks (BookingActions.tsx:6-25: Confirm -> Mark scheduled -> Start job -> Complete job).
â€¢ THERE IS NO RECOVERY. Once Discord sets COMPLETED, VALID_TRANSITIONS['COMPLETED'] = ['ARCHIVED'], so the admin route can never run its completion block for that booking (422 at L115-117), and the admin UI offers only "Archive". The completion workflow for that job is permanently unreachable.
â€¢ Partial mitigation, stated for accuracy: Discord DOES stamp Booking.completedAt atomically, so the TIME-BASED `review_eligible` / `referral_eligible` automation sweeps (email-automation-runtime.ts:866-879) could still enrol these bookings â€” but only if the owner has an ACTIVE automation on those triggers (per project history, automations are BETA-gated and dispatch is not wired). The email, the balance reminder and the followups.ts sequence have no sweep at all.
â€¢ No test covers this: src/lib/__tests__/lifecycle-orchestration.test.ts and lifecycle-wiring.test.ts contain no reference to the Discord path or to completion stamping.

### Business impact
CUSTOMER, and this is the expensive one. The crew finishes a move and taps "âœ… Complete Job" on the Discord move-day card â€” the one-tap action the system posts for EVERY paid booking. The customer then receives NOTHING: no "your move is complete" email, no reminder about the balance still owed (the $49 was only the deposit; the rest is due on move day), no review request, no referral offer, no repeat-customer follow-up. From the customer's side the business goes silent the moment the truck pulls away. FREQUENCY: every job completed in the field, i.e. the normal case â€” not an edge case. It is also unrecoverable: after Discord marks it COMPLETED, the admin UI offers only "Archive", so Diego cannot trigger the missed messages even if he notices. The review and referral funnel â€” the whole point of the post-move sequence â€” produces zero output for jobs closed the way jobs are actually closed.

DIEGO, money: the +24h balance reminder is the automated ask for the outstanding move-day balance. Every Discord-completed job loses it, so collection falls back entirely on him remembering to chase it. He also loses the reviews that drive new leads.

DIEGO, if he instead completes from the admin UI (four clicks) and the request dies mid-way â€” a Railway restart, a Neon blip, a closed laptop â€” the booking reads COMPLETED but is invisible to every post-move automation forever, with no error shown and no retry accepted (the route returns "Cannot transition from COMPLETED to COMPLETED"). Rare per-request, but silent and permanent when it happens, and there is currently no report that would reveal it.

CREW/CANCELLATION: when Diego cancels a confirmed move, the Job row stays SCHEDULED and the crew assignments stay live. The assigned worker still sees the job in "upcoming" on the crew portal, and the server will happily let Diego assign MORE crew to a cancelled move â€” the hard block written for exactly this case can never fire because nothing ever marks a Job cancelled. Frequency: every post-confirmation cancellation, and it only bites once real crew are on the schedule (with Diego solo it is latent). Worst case is a worker driving to a move that is not happening. Trucks and the dispatch board are NOT affected â€” they key off the booking status, which is correct.

### Fix plan
Sized to the real defect: the problem is not a missing stamp, it is that COMPLETE and CANCEL have two implementations, neither atomic end-to-end, and both terminal-on-failure.

1. NEW src/lib/lifecycle-service.ts â€” one `completeBooking({ bookingId, actor, source, at })` and one `cancelBooking({ bookingId, actor, source, reason })`, pure-testable with injected deps (the booking-approval.ts approveBooking/declineBooking shape is the house pattern to copy).
   completeBooking, in ONE prisma.$transaction: Booking.status = COMPLETED + `completedAt` set FIRST-WINS in the SAME statement (conditional updateMany on `completedAt: null` / status not already COMPLETED, so a second press is a no-op and returns `already_completed`); Job UPSERT (not updateMany) status COMPLETED + completedAt + durationMins from Job.startedAt; auditLog JOB_COMPLETED. Return the claim result so callers can tell "I completed it" from "it was already complete".
   cancelBooking, in ONE transaction: Booking.status = CANCELLED (conditional claim on the allowed source statuses); Job.updateMany -> status CANCELLED; JobCrew.updateMany live assignments -> assignmentStatus CANCELLED + cancelReason 'Booking cancelled'; auditLog. Keep declineBooking as-is for the PENDING_APPROVAL hold-release case and have it delegate the record-writing half here, or leave it untouched if that widens the blast radius past this blocker.
2. POST-COMMIT SIDE EFFECTS, run only after the transaction commits, in one shared `afterCompletion(bookingId)` helper: enqueue job-completion, then onBookingCompleted, then onBookingCompletedBalance. Order matters â€” the completedAt stamp is now inside the transaction, so the L267/L290 ordering race disappears by construction. Each side effect stays individually guarded and non-fatal; the lifecycle FACT is already durable.
3. REWIRE BOTH CALLERS. app/api/admin/bookings/[id]/status/route.ts: replace L208-230 + L267-302 with `completeBooking(...)` / `cancelBooking(...)` + `afterCompletion(...)`. app/api/discord/interactions/route.ts handleJobComplete L755-776: replace the inline $transaction with the same two calls. Discord's idempotent-second-press behaviour (L744-746) is preserved by the conditional claim.
4. MAKE THE SIDE EFFECTS RECOVERABLE, since the status guard is terminal. Add an idempotent `POST /api/admin/bookings/[id]/replay-completion` (OWNER/MANAGER) that re-runs `afterCompletion` for an already-COMPLETED booking, and surface it in the admin UI when status is COMPLETED. It costs nothing when everything already fired â€” followups' FollowUpLedger unique key, the journeys jobIds and email-guard's idempotency key all dedupe â€” and it is the ONLY way to rescue a booking completed via Discord before this fix, or one stranded by a partial failure. This is the piece that turns a permanent loss into an operator action.
5. BACKFILL/RECONCILE (read-only report first, no writes without the owner's say-so): list bookings with status COMPLETED whose Job is missing or not COMPLETED, whose completedAt is NULL, or that have no job-completion EmailSend row; and bookings with status CANCELLED whose Job is not CANCELLED or that still carry live JobCrew rows.
6. TESTS (offline, the house style): (a) both routes converge on identical DB writes for the same completion; (b) a thrown error inside the transaction leaves status unchanged (mutation-test: remove the transaction, confirm red); (c) second press / double-call is a no-op and does not re-fire side effects; (d) `bookingBlockReason` returns null for all six post-completion templates immediately after completeBooking (i.e. completedAt is committed with the status); (e) cancelBooking sets Job CANCELLED and kills live JobCrew rows, and `detectAssignmentConflicts` then returns ASSIGNMENT_ON_CANCELLED_JOB (this currently-dead HARD_BLOCK becomes reachable); (f) the crew endpoint no longer returns a cancelled booking's assignment in `upcoming`.
7. DO NOT: change VALID_TRANSITIONS to allow COMPLETED->COMPLETED (that reopens the transition guard for a retry it was never designed for â€” the replay endpoint is the correct seam); do not add a Booking.completedAt stamp to the route as a standalone patch (the stamp already exists at followups.ts:157 and a second one races it); do not touch declineBooking's Stripe hold release under this blocker (that is B2).

### Files
C:/wt-moving-os/app/api/admin/bookings/[id]/status/route.ts, C:/wt-moving-os/app/api/discord/interactions/route.ts, C:/wt-moving-os/src/lib/followups.ts, C:/wt-moving-os/src/lib/journeys.ts, C:/wt-moving-os/src/lib/email-eligibility.ts, C:/wt-moving-os/src/lib/email-guard.ts, C:/wt-moving-os/src/workers/email.worker.ts, C:/wt-moving-os/src/lib/conflict-engine.ts, C:/wt-moving-os/src/lib/scheduling-service.ts, C:/wt-moving-os/app/api/crew/assignments/route.ts, C:/wt-moving-os/app/api/admin/jobs/[id]/crew/route.ts, C:/wt-moving-os/src/lib/booking-approval.ts, C:/wt-moving-os/src/lib/fulfillment.ts, C:/wt-moving-os/src/lib/booking-display.ts, C:/wt-moving-os/prisma/schema.prisma, C:/wt-moving-os/app/(admin)/admin/(dashboard)/jobs/[id]/BookingActions.tsx, C:/wt-moving-os/app/api/admin/email-marketing/sends/route.ts, C:/wt-moving-os/src/lib/email-automation-runtime.ts

---

## B9 â€” "Public checkout can create an orphaned live Stripe session" (app/api/bookings/route.ts ~504-564)

**VERDICT: PARTIAL**

### Evidence
THE MECHANISM IS EXACTLY AS DESCRIBED â€” confirmed.
- app/api/bookings/route.ts:507 `createBookingCheckout({...})` (inside try/catch, rollback path at :528-548).
- app/api/bookings/route.ts:557-564 `await prisma.booking.update({... status:'PENDING_PAYMENT', stripeCheckoutId: checkoutSession.id ...})` â€” UNGUARDED. Brace/try-depth walk over the shipped source confirms it is inside no try block. It is the only writer of PENDING_PAYMENT on this route (grep: one occurrence, line 560).
- The booking is created `status:'DRAFT'` at :420, so a throw at :557 leaves it DRAFT with stripeCheckoutId null while the Stripe session is live.

BUT THE HARM IS NOT WHERE THE REVIEWER PUT IT. Four checks refute the "usable live checkout" framing:
1. UNREACHABLE. The session URL exists only in the response body at :683-697, which is never returned. Worse than the reviewer says: POST (:66-72) has no try/catch, so the throw escapes before `res.headers.set` â€” the CORS headers are never attached. Simulated the shipped wrapper with a throwing handler: it throws before header attachment. The browser gets an opaque network/CORS failure, not the JSON error the reviewer assumed. Neither customer nor owner ever receives the URL.
2. SHORT-LIVED. src/lib/stripe.ts:115 `expires_at: now + 30*60` = 30 minutes, not the ~24h the resume route's own comment (resume/route.ts:21) assumes.
3. IF PAID, IT FULFILS CORRECTLY. src/lib/stripe-events.ts:185 and app/api/stripe/checkout/success/route.ts:26 both resolve the booking from `session.metadata.bookingId`. src/lib/fulfillment.ts:147-154 claims on `status: { in: ['PENDING_PAYMENT','DRAFT'] }` â€” DRAFT is explicitly accepted. `stripeCheckoutId` is never a lookup key anywhere (grep: written at bookings/route.ts:561 and admin/bookings/route.ts:805, read only for display in booking-display.ts:886 and the admin job page). So the money path is already durable against this.
4. NO CAPACITY LOST. src/lib/truck-conflicts.ts:110-118 excludes DRAFT from TRUCK_HOLD_STATUSES, and conflicts key on truckId (:401, :450) which a public booking never sets.

THE REAL DEFECT IS THE UNREACHABLE TAIL, AND IT IS UNRECOVERABLE. Everything after :564 is skipped: photos (:572), lead ingest (:613), `onBookingCreated` (:645 â€” lead conversion, consent propagation, abandoned-checkout journey), `notifyBookingCreated` (:664 â€” the only owner alert). The customer already signed the Moving Service Agreement (:495-499 agreementAccepted:true) and permanently burned a WMIC reference (:413 -> booking-reference.ts:44-47, `SELECT nextval` is never rolled back).
RECOVERY IS BLOCKED THREE INDEPENDENT WAYS, all keyed on PENDING_PAYMENT: resume route refuses (resume/route.ts:86 `booking.status !== 'PENDING_PAYMENT'`), abandoned-recovery worker refuses (scheduled.worker.ts:88), and the journey was never scheduled anyway (journeys.onCheckoutStarted runs from the skipped :645). Answer to the brief's question: NO, neither resume nor the abandoned journey can recover it.
IT IS ALSO INVISIBLE. admin Jobs page STAGES (jobs/page.tsx:15-21) has no DRAFT or PENDING_PAYMENT pill; the default query is `where.status = { in: activeStatuses }` (:91); `?status=DRAFT` is silently ignored because DRAFT is absent from STATUS_LABEL (:22-27, gate at :78). Only /admin/bookings shows it (bookings/page.tsx:7-10 STATUS_OPTIONS, :27 default ALL) â€” with no alert.

IDEMPOTENCY: none. src/lib/stripe.ts:79-121 `checkout.sessions.create` passes no idempotencyKey; only `captureDeposit` (:131-140) takes one. Four callers exist (public route, admin route, resume route, admin/test-booking) â€” none keyed.

THE REVIEWER'S PROPOSED FIX IS WRONG AND WOULD ADD A DEFECT: a key "derived from booking id" lives 24h in Stripe while these sessions expire in 30 minutes, so a retry >30 min later would replay the SAME expired session and hand the customer a dead checkout page.

PROBABILITY IS HIGHER THAN A RARE DB BLIP: no `maxDuration` export on the route and no `functions` block in vercel.json, so it runs at Vercel's default cap; by line 557 it has already made 2 Google Address Validation calls (:275-278), ~5 Postgres round trips, a sequence read and a very wide INSERT, plus a Stripe API call. A function timeout landing in that tail produces exactly this state.

REACHES FURTHER â€” same root cause ("a session is created and nobody records it"), two other sites:
- admin/bookings/route.ts:785-807 has the identical create-then-record order, but inside try/catch and the booking is already PENDING_PAYMENT (admin-booking.ts:255-257 decideStatus), so no DRAFT orphan. Its catch (:814) tells the owner "Stripe hold link could not be created" when the session WAS created, and advises "retry the link" â€” there is no regenerate endpoint (only the 4 callers above). A message naming an action the product does not have.
- resume/route.ts:99-119 creates a fresh session per click, never persists the id, never expires the prior session. Two payable $49 authorizations can coexist; if both are paid the second fulfillPaidCheckout gets claim.count===0 (fulfillment.ts:156-159) and that authorization is never captured, never released, nobody alerted. Gated by EMAIL_JOURNEYS_ENABLED (journeys.ts:40).

### Business impact
SCOPE: public website booking form only. The DEFAULT path in the brief (admin Book Move -> stripe_link) is NOT affected â€” decideStatus writes PENDING_PAYMENT inside the transaction and its Stripe step is already guarded.

FREQUENCY: needs a DB/timeout failure in a one-statement window, but that window is at the tail of a route that has already made 2 Google API calls, ~5 Postgres round trips, a sequence read, a wide INSERT and a Stripe call, under Vercel's default function cap with no maxDuration set. Rare per submission; effectively certain across a busy month or any single Neon/Vercel/cold-start incident.

WHAT THE CUSTOMER EXPERIENCES: fills the entire form, types their name as a signature on the Moving Service Agreement, clicks pay â€” and gets an opaque browser network error with no readable message (the CORS headers never get attached). No checkout page, no email, no SMS. No recovery email will ever arrive, because the abandoned-checkout journey was never scheduled. They either re-submit (creating a second booking, a second WMIC number, a second signed agreement) or they book a competitor.

WHAT DIEGO EXPERIENCES: nothing at all. No Discord card, no owner alert, no lead conversion. The booking never appears on /admin/jobs â€” no pill, and even a hand-typed ?status=DRAFT is silently ignored. He finds it only if the customer phones, or if he happens to scroll /admin/bookings and spots a grey DRAFT row. The WMIC counter keeps a permanent gap, so his public reference numbers stop matching his job count.

MONEY AT RISK FROM THE DESCRIBED DEFECT: effectively zero. The orphaned session is unreachable, dies in 30 minutes, and would fulfil correctly if it somehow were paid. The cost is a lost job and a silent hole in the booking record â€” a revenue-leak and trust defect, not a mis-charged card. The genuine money-shaped exposure nearby is the resume route's unbounded unrecorded sessions (a different file than the one cited), where a second paid authorization would be neither captured nor released and nobody alerted.

RELEASE CALL: fix before launch â€” but as a durability/visibility fix on the public form, not as a rewrite of the payment code. Do not let a fixer touch fulfillPaidCheckout or the metadata lookup; those are the parts that are already correct.

### Fix plan
Fix the recoverability, not the Stripe object. Sized to the real defect:

1. BORN RECOVERABLE (the one-line fix that closes most of it). Set `status: 'PENDING_PAYMENT'` in the `prisma.booking.create` at app/api/bookings/route.ts:415-502 instead of DRAFT (optionally add `checkoutRequestedAt`). All three existing recovery mechanisms key on PENDING_PAYMENT, so the orphan becomes an ordinary abandoned checkout that resume/route.ts and scheduled.worker.ts already handle. No new state machine.

2. MAKE THE POST-STRIPE UPDATE NON-FATAL. Wrap :557-564 in try/catch that logs and continues â€” then still return 200 with the checkout URL. `stripeCheckoutId` is display-only (proven by grep), so losing it must never cost the customer their checkout. Copy the shape the admin route already uses at :783-815; do not invent a new one.

3. MAKE THE TAIL UNSKIPPABLE. Photos (:570), lead ingest (:612), `onBookingCreated` (:645) and `notifyBookingCreated` (:663) are each individually guarded but collectively unreachable behind one unguarded statement. Either move them above the update or wrap the whole tail so the route always returns the checkout URL. At minimum `notifyBookingCreated` must run â€” it is the only signal Diego gets.

4. IDEMPOTENCY KEYED ON ATTEMPT, NOT BOOKING. Add `idempotencyKey` to `checkout.sessions.create` (src/lib/stripe.ts:79) as `${bookingId}:${checkoutAttempt}`, with `checkoutAttempt` a booking column incremented per creation. A bare bookingId key would resurrect 30-minute-expired sessions for 24 hours. Apply at all three real callers.

5. ONE PAYABLE SESSION PER BOOKING. In resume/route.ts, call `stripe.checkout.sessions.expire` on the recorded `stripeCheckoutId` before creating the new one, and persist the new session id. Closes the two-live-authorizations hole.

6. RECONCILIATION + VISIBILITY. A scheduled sweep for bookings older than N minutes still in DRAFT with `agreementAccepted: true` -> flip to PENDING_PAYMENT or alert the owner. Add the "Awaiting Payment" stage pill (DRAFT + PENDING_PAYMENT) to app/(admin)/admin/(dashboard)/jobs/page.tsx STAGES/STATUS_LABEL â€” this is the reviewer's own ops item and it is what makes the state findable at all.

7. HONEST ADMIN COPY. admin/bookings/route.ts:814 must distinguish "link could not be created" from "link was created but not recorded", and must not advise retrying a link there is no endpoint to retry.

8. MUTATION TESTS (offline, source/stub level like src/lib/__tests__/payment-cleanup.test.ts): (a) stub the update to throw -> assert the response still carries checkoutUrl and the booking is PENDING_PAYMENT; (b) assert `?status=DRAFT` reaches the Jobs list; (c) assert a second session for the same booking cannot be created while one is live. Introduce each defect, confirm red, restore.

DO NOT: rewrite fulfillPaidCheckout's claim (fulfillment.ts:147-154 correctly accepts DRAFT), or change the metadata-based booking lookup â€” both are already right and are what keeps this from being a money bug.

### Files
C:/wt-moving-os/app/api/bookings/route.ts, C:/wt-moving-os/src/lib/stripe.ts, C:/wt-moving-os/app/api/stripe/checkout/resume/route.ts, C:/wt-moving-os/src/lib/fulfillment.ts, C:/wt-moving-os/src/lib/stripe-events.ts, C:/wt-moving-os/app/api/stripe/checkout/success/route.ts, C:/wt-moving-os/src/workers/scheduled.worker.ts, C:/wt-moving-os/src/lib/journeys.ts, C:/wt-moving-os/app/api/admin/bookings/route.ts, C:/wt-moving-os/src/lib/admin-booking.ts, C:/wt-moving-os/src/lib/truck-conflicts.ts, C:/wt-moving-os/src/lib/booking-reference.ts, C:/wt-moving-os/app/(admin)/admin/(dashboard)/jobs/page.tsx, C:/wt-moving-os/app/(admin)/admin/(dashboard)/bookings/page.tsx, C:/wt-moving-os/vercel.json

---


