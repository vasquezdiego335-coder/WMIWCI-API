import { NextResponse } from "next/server";
import nacl from "tweetnacl";
import { prisma } from "@/lib/db";
import { ManualEventType } from "@prisma/client";
import {
  addTask,
  listTasks,
  completeTask,
  deleteTask,
  editTask,
  todayTasks,
  overdueTasks,
  type Embed,
} from "@/bot/task-service";
import { captureDeposit, cancelDeposit, retrieveChargeForIntent } from "@/lib/stripe";
import { emailQueue, smsQueue } from "@/lib/queues";
import { offerRescheduleToCustomer } from "@/lib/reschedule";
import { t } from "@/lib/i18n";
import { formatEastern, confirmationScheduleData } from "@/lib/scheduling";
import { authorizeOwnerAction, type DiscordActor } from "@/lib/discord-auth";
import {
  buildJobCard,
  serviceLabelFromDescription,
  truckLabelFromDescription,
  timeOfDay,
  TRUCK_OPTION_LABELS,
} from "@/lib/booking-display";
import { apiLogger } from "@/lib/logger";
import { outboxEnabled, emitApproved, emitRescheduleRequested } from "@/outbox/integration";

export const runtime = "nodejs";

// ── Discord interaction type / response constants ──────────────────────────
const TYPE_PING = 1;
const TYPE_APPLICATION_COMMAND = 2; // a slash command
const TYPE_MESSAGE_COMPONENT = 3; // a button / select press
const RES_PONG = 1;
const RES_REPLY = 4; // CHANNEL_MESSAGE_WITH_SOURCE
const RES_UPDATE_MESSAGE = 7; // edit the component message in place
const FLAG_EPHEMERAL = 64;

// ── Ed25519 signature verification (tweetnacl; replaces discord-interactions) ─
function verifyDiscordSignature(
  rawBody: string,
  signature: string,
  timestamp: string,
  publicKey: string
): boolean {
  try {
    const timestampSec = Number(timestamp);
    if (Math.abs(Date.now() / 1000 - timestampSec) > 5) return false;

    return nacl.sign.detached.verify(
      Buffer.from(timestamp + rawBody),
      Buffer.from(signature, "hex"),
      Buffer.from(publicKey, "hex")
    );
  } catch {
    return false;
  }
}

const ephemeral = (content: string) =>
  NextResponse.json({ type: RES_REPLY, data: { content, flags: FLAG_EPHEMERAL } });

// Don't let a Redis stall blow Discord's 3-second interaction deadline.
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)),
  ]);
}

type CardBooking = {
  displayId: string;
  requestedDate: Date | null;
  confirmedDate: Date | null;
  depositAmount: number;
  customer?: { name: string } | null;
};

// The "✅ Approved" card that replaces the approval card in place. The only
// button that survives is a link to the customer's Stripe receipt (when the
// capture produced one) — everything else is done, so the decision buttons go.
function confirmedCard(
  booking: CardBooking,
  approverName: string,
  capturedCents?: number,
  receiptUrl?: string | null,
) {
  const when = booking.confirmedDate ?? booking.requestedDate;
  const dateStr = when ? formatEastern(when) : "—";
  const cents = capturedCents ?? booking.depositAmount ?? 4900;
  const components = receiptUrl
    ? [{ type: 1, components: [{ type: 2, style: 5, label: "🧾 Customer Receipt", url: receiptUrl }] }]
    : [];
  return {
    embeds: [
      {
        title: `✅ Approved — ${booking.displayId}`,
        color: 0x22c55e,
        description: "Deposit captured · booking **CONFIRMED**.",
        fields: [
          { name: "👤 Customer", value: booking.customer?.name ?? "—", inline: true },
          { name: "📅 Move date", value: dateStr, inline: true },
          { name: "💳 Captured", value: `$${(cents / 100).toFixed(2)}`, inline: true },
        ],
        footer: { text: `Approved by ${approverName}` },
        timestamp: new Date().toISOString(),
      },
    ],
    components,
  };
}

// The "❌ Denied" card (authorization released, no charge).
function deniedCard(booking: { displayId: string; customer?: { name: string } | null }, approverName: string) {
  return {
    embeds: [
      {
        title: `❌ Denied — ${booking.displayId}`,
        color: 0xef4444,
        description: "Authorization released (no charge) · booking **CANCELLED**.",
        fields: [
          { name: "👤 Customer", value: booking.customer?.name ?? "—", inline: true },
          { name: "💳 Hold", value: "Released — not charged", inline: true },
        ],
        footer: { text: `Denied by ${approverName}` },
        timestamp: new Date().toISOString(),
      },
    ],
    components: [],
  };
}

// The "📅 New dates offered" card (link sent; a fresh card posts when they pick).
function offeredCard(
  booking: { displayId: string; customer?: { name: string } | null },
  approverName: string,
  offeredDates: string[]
) {
  const list = offeredDates.length
    ? offeredDates.map((d, i) => `${i + 1}. ${d}`).join("\n")
    : "Customer will call to pick a date.";
  return {
    embeds: [
      {
        title: `📅 New dates offered — ${booking.displayId}`,
        color: 0x3b82f6,
        description: "Reschedule link sent to the customer. A fresh approval card posts when they pick a date.",
        fields: [
          { name: "👤 Customer", value: booking.customer?.name ?? "—", inline: true },
          { name: "🗓️ Offered", value: list, inline: false },
        ],
        footer: { text: `Offered by ${approverName}` },
        timestamp: new Date().toISOString(),
      },
    ],
    components: [],
  };
}

// ── approve_booking:<id> → capture the $49 hold → CONFIRMED → notify ───────
async function handleApprove(bookingId: string | undefined, messageId: string | undefined, actor: DiscordActor) {
  const approverName = actor.username;
  // Load by the clicked card's message id (canonical), falling back to the id
  // carried in the button's custom_id.
  const booking = await prisma.booking.findFirst({
    where: {
      OR: [
        ...(messageId ? [{ discordApprovalMessageId: messageId }] : []),
        ...(bookingId ? [{ id: bookingId }] : []),
      ],
    },
    include: { customer: true },
  });

  if (!booking) return ephemeral("⚠️ Booking not found for this card.");

  // Idempotent: a second click just re-shows the confirmed card.
  if (booking.status === "CONFIRMED") {
    return NextResponse.json({ type: RES_UPDATE_MESSAGE, data: confirmedCard(booking, approverName) });
  }
  if (booking.status !== "PENDING_APPROVAL") {
    return ephemeral(`⚠️ Can't approve a booking in ${booking.status}.`);
  }
  if (!booking.stripePaymentIntentId) {
    return ephemeral("⚠️ No payment hold attached — nothing to capture.");
  }

  // 1) CONCURRENCY GUARD — atomically CLAIM the PENDING_APPROVAL → CONFIRMED
  //    transition BEFORE touching Stripe. Postgres serializes this conditional
  //    UPDATE, so of two simultaneous approvals exactly one gets count === 1 and
  //    proceeds to capture; the loser gets count === 0 and bails out. This is
  //    what guarantees the $49 is captured at most once. The move-date fields are
  //    written in the same claim so a CONFIRMED booking is immediately schedulable
  //    (scheduledStart is what the daily digest + dashboards query on).
  const sched = confirmationScheduleData(booking);
  const claim = await prisma.booking.updateMany({
    where: { id: booking.id, status: "PENDING_APPROVAL" },
    data: { status: "CONFIRMED", depositPaid: true, ...(sched ?? {}) },
  });
  if (claim.count === 0) {
    // Lost the race (or the booking moved). Re-read and respond honestly.
    const fresh = await prisma.booking.findUnique({ where: { id: booking.id }, include: { customer: true } });
    if (fresh?.status === "CONFIRMED") {
      return NextResponse.json({ type: RES_UPDATE_MESSAGE, data: confirmedCard(fresh, approverName) });
    }
    return ephemeral("⏳ This booking was just handled by another owner — no action taken.");
  }

  // 2) We own the transition — capture the held $49. The idempotency key (keyed
  //    on the payment intent) means even a pathological double-run collapses into
  //    a single charge at Stripe.
  let pi;
  try {
    pi = await captureDeposit(booking.stripePaymentIntentId, `capture:${booking.stripePaymentIntentId}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    apiLogger.error({ bookingId: booking.id, err: msg }, "captureDeposit failed — rolling back approval claim");
    // Roll the claim back so the booking can be approved again once Stripe is
    // healthy. Guarded on status === CONFIRMED so we never stomp a later change.
    await prisma.booking
      .updateMany({
        where: { id: booking.id, status: "CONFIRMED" },
        data: { status: "PENDING_APPROVAL", depositPaid: false, confirmedDate: null, scheduledStart: null, scheduledEnd: null },
      })
      .catch((rbErr) =>
        apiLogger.error(
          { bookingId: booking.id, err: rbErr instanceof Error ? rbErr.message : String(rbErr) },
          "✖ CRITICAL: failed to roll back approval claim after Stripe error — booking may be CONFIRMED without capture"
        )
      );
    return ephemeral(`⚠️ Stripe capture failed: ${msg}. The hold was NOT captured — try again.`);
  }
  const capturedCents = pi.amount_received ?? pi.amount ?? booking.depositAmount;

  // 2b) Pull the resulting Charge for the hosted receipt URL + charge id +
  //     payment method. Best-effort (never blocks approval): the record is nicer
  //     with it, and it unlocks the "🧾 Customer Receipt" button + View Full
  //     Booking. Stripe also emails the customer their receipt from this charge.
  const charge = await retrieveChargeForIntent(pi).catch(() => null);
  const receiptUrl = charge?.receipt_url ?? null;
  const stripeChargeId =
    charge?.id ?? (typeof pi.latest_charge === "string" ? pi.latest_charge : pi.latest_charge?.id) ?? null;
  const paymentMethodType = charge?.payment_method_details?.type ?? null;
  const stripeCustomerId =
    typeof pi.customer === "string" ? pi.customer : pi.customer?.id ?? null;
  // Only present values (string-only) so this is a clean Prisma JSON input.
  const paymentMeta: Record<string, string> = { capturedBy: approverName };
  if (paymentMethodType) paymentMeta.paymentMethodType = paymentMethodType;
  if (stripeCustomerId) paymentMeta.stripeCustomerId = stripeCustomerId;
  if (booking.stripeCheckoutId) paymentMeta.stripeCheckoutId = booking.stripeCheckoutId;

  // 3) Record the payment + create the Job record + audit (atomic). The booking
  //    status/date fields were already set by the claim in step 1.
  await prisma.$transaction([
    prisma.payment.create({
      data: {
        bookingId: booking.id,
        stripePaymentIntentId: pi.id,
        stripeChargeId,
        amount: capturedCents,
        status: "COMPLETED",
        description: "Booking deposit captured on approval",
        receiptUrl,
        metadata: paymentMeta,
      },
    }),
    prisma.job.upsert({
      where: { bookingId: booking.id },
      update: { status: "SCHEDULED" },
      create: { bookingId: booking.id, status: "SCHEDULED" },
    }),
    prisma.auditLog.create({
      data: {
        action: "PAYMENT_RECEIVED",
        bookingId: booking.id,
        details: {
          event: "approve_booking",
          discordUserId: actor.userId ?? null,
          approvedBy: approverName,
          previousStatus: "PENDING_APPROVAL",
          newStatus: "CONFIRMED",
          captured: capturedCents,
          paymentIntentId: pi.id,
          stripeResult: "captured",
          result: "success",
        },
      },
    }),
  ]);

  // 4) Queue the PRE-APPROVAL customer messages (email + SMS) — the ONLY pair
  //    sent from the approval handler. Non-fatal + timeout-guarded so a Redis
  //    stall can't blow Discord's 3s interaction window.
  const locale = booking.customer.locale;
  const when = booking.requestedDate;
  const dateStr = when ? formatEastern(when) : "your move date";
  const appUrl = process.env.APP_URL ?? "https://wmiwci-api.vercel.app";
  const portalUrl = `${appUrl}/my-booking/${booking.customerToken}`;
  try {
    await withTimeout(
      (async () => {
        // OUTBOX_ENABLED → emit APPROVED to the outbox (which sends the email)
        // and SKIP the legacy email here, so the customer never gets both.
        if (outboxEnabled()) {
          apiLogger.info({ bookingId: booking.id, to: booking.customer.email }, "[outbox] emitting APPROVED (legacy approval email skipped)");
          await emitApproved({
            bookingId: booking.id,
            approvedBy: approverName,
            customerName: booking.customer.name,
            customerEmail: booking.customer.email,
            requestedDate: when?.toISOString() ?? null,
            items: booking.itemsDescription ?? undefined,
          });
        } else {
          apiLogger.info({ bookingId: booking.id, to: booking.customer.email }, "[messaging] queueing PRE-APPROVAL email");
          await emailQueue.add("pre-approval", {
            template: "pre-approval",
            to: booking.customer.email,
            bookingId: booking.id,
            payload: {
              customerName: booking.customer.name,
              displayId: booking.displayId,
              requestedDate: when?.toISOString(),
              items: booking.itemsDescription ?? undefined,
              originAddress: booking.originAddress ?? undefined,
              destAddress: booking.destAddress ?? undefined,
              portalUrl,
              locale,
            },
          });
        }
        if (booking.customer.phone) {
          apiLogger.info({ bookingId: booking.id }, "[messaging] queueing PRE-APPROVAL sms");
          await smsQueue.add("pre-approval-sms", {
            to: booking.customer.phone,
            message: t(locale, "preApproval", {
              name: booking.customer.name,
              displayId: booking.displayId,
              date: dateStr,
            }),
            bookingId: booking.id,
          });
        }
      })(),
      2500
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    apiLogger.error({ bookingId: booking.id, err: msg }, "pre-approval notifications failed/timeout (non-fatal)");
  }

  apiLogger.info(
    { bookingId: booking.id, captured: capturedCents, approvedBy: approverName },
    "Booking approved → $49 captured → CONFIRMED"
  );

  // 4) Edit the Discord card in place (with a receipt link when Stripe gave one).
  return NextResponse.json({
    type: RES_UPDATE_MESSAGE,
    data: confirmedCard(booking, approverName, capturedCents, receiptUrl),
  });
}

// ── deny_booking:<id> → release the hold → CANCELLED → notify ──────────────
async function handleDeny(bookingId: string | undefined, messageId: string | undefined, actor: DiscordActor) {
  const approverName = actor.username;
  const booking = await prisma.booking.findFirst({
    where: {
      OR: [
        ...(messageId ? [{ discordApprovalMessageId: messageId }] : []),
        ...(bookingId ? [{ id: bookingId }] : []),
      ],
    },
    include: { customer: true },
  });

  if (!booking) return ephemeral("⚠️ Booking not found for this card.");

  // Idempotent: a second click just re-shows the denied card.
  if (booking.status === "CANCELLED") {
    return NextResponse.json({ type: RES_UPDATE_MESSAGE, data: deniedCard(booking, approverName) });
  }
  if (booking.status === "CONFIRMED") {
    return ephemeral("⚠️ Already approved & captured — issue a refund instead of denying.");
  }
  if (!["PENDING_APPROVAL", "PENDING_PAYMENT", "DRAFT"].includes(booking.status)) {
    return ephemeral(`⚠️ Can't deny a booking in ${booking.status}.`);
  }

  // CONCURRENCY GUARD — atomically CLAIM the transition to CANCELLED among the
  // deny-able statuses. Of two simultaneous clicks exactly one wins; the loser is
  // told it was already handled (so a deny can't race an approve into a bad mix).
  const previousStatus = booking.status;
  const claim = await prisma.booking.updateMany({
    where: { id: booking.id, status: { in: ["PENDING_APPROVAL", "PENDING_PAYMENT", "DRAFT"] } },
    data: { status: "CANCELLED" },
  });
  if (claim.count === 0) {
    const fresh = await prisma.booking.findUnique({ where: { id: booking.id }, include: { customer: true } });
    if (fresh?.status === "CANCELLED") {
      return NextResponse.json({ type: RES_UPDATE_MESSAGE, data: deniedCard(fresh, approverName) });
    }
    return ephemeral("⏳ This booking was just handled by another owner — no action taken.");
  }

  // Release the authorization (no money moves). Tolerate an already-void PI.
  let stripeResult = "no_hold";
  if (booking.stripePaymentIntentId) {
    try {
      await cancelDeposit(booking.stripePaymentIntentId);
      stripeResult = "hold_released";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stripeResult = `release_failed: ${msg.slice(0, 80)}`;
      apiLogger.warn({ bookingId: booking.id, err: msg }, "cancelDeposit failed (continuing — hold may already be void)");
    }
  }

  await prisma.auditLog.create({
    data: {
      action: "BOOKING_STATE_CHANGED",
      bookingId: booking.id,
      details: {
        event: "deny_booking",
        discordUserId: actor.userId ?? null,
        deniedBy: approverName,
        previousStatus,
        newStatus: "CANCELLED",
        stripeResult,
        result: "success",
      },
    },
  });

  // MESSAGING POLICY: deny does NOT send a customer email/SMS. The system sends
  // exactly four customer messages (pre-approval + final-confirmation, each as
  // email + SMS); a denial is not one of them. The hold is released above and
  // the Discord card is updated below, but the customer is not auto-notified.
  apiLogger.info(
    { bookingId: booking.id, deniedBy: approverName },
    "Booking denied → hold released → CANCELLED (no customer email/SMS per messaging policy)"
  );
  return NextResponse.json({ type: RES_UPDATE_MESSAGE, data: deniedCard(booking, approverName) });
}

// ── offer_reschedule:<id> → reuse the shared offer logic → update card ─────
async function handleOffer(bookingId: string | undefined, messageId: string | undefined, actor: DiscordActor) {
  const approverName = actor.username;
  const booking = await prisma.booking.findFirst({
    where: {
      OR: [
        ...(messageId ? [{ discordApprovalMessageId: messageId }] : []),
        ...(bookingId ? [{ id: bookingId }] : []),
      ],
    },
    include: { customer: true },
  });

  if (!booking) return ephemeral("⚠️ Booking not found for this card.");
  if (["CANCELLED", "COMPLETED", "ARCHIVED"].includes(booking.status)) {
    return ephemeral(`⚠️ Can't offer a reschedule for a ${booking.status} booking.`);
  }

  // Reuse the SAME helper the admin route uses (its queue adds are already
  // timeout-guarded, so this can't hang past Discord's 3s window).
  const result = await offerRescheduleToCustomer(booking.id, { offeredBy: approverName }).catch((err) => {
    apiLogger.error(
      { bookingId: booking.id, err: err instanceof Error ? err.message : String(err) },
      "offer_reschedule failed"
    );
    return undefined;
  });
  if (!result) return ephemeral("⚠️ Couldn't send the reschedule link — please try again.");

  // OUTBOX_ENABLED → record RESCHEDULE_REQUESTED (sends the reschedule email via
  // the outbox). No-op + swallowed when the flag is off.
  if (outboxEnabled()) {
    await emitRescheduleRequested({
      bookingId: booking.id,
      offeredDates: result.offeredDates,
      rescheduleUrl: result.rescheduleUrl,
      customerName: booking.customer.name,
      customerEmail: booking.customer.email,
      requestedDate: booking.requestedDate?.toISOString() ?? null,
    });
  }

  apiLogger.info({ bookingId: booking.id, offeredBy: approverName }, "Offer reschedule → link sent to customer");
  // Idempotent: removing the buttons (UPDATE_MESSAGE) prevents a second offer
  // from this card; a fresh approval card posts when the customer picks a date.
  return NextResponse.json({ type: RES_UPDATE_MESSAGE, data: offeredCard(booking, approverName, result.offeredDates) });
}

// ════════════════════════════════════════════════════════════════════════
//  view_full_booking:<id> — owner-only ephemeral dump of EVERY stored field.
//  --------------------------------------------------------------------
//  Nothing hidden, nothing summarized, no truncation beyond Discord's own
//  per-field / per-embed limits (which we page across multiple embeds). This
//  is the "I never want to open the DB" escape hatch. Owner-gated by the same
//  OWNER_ACTIONS check as approve/deny, and ephemeral so raw customer data is
//  only ever shown to the owner who clicked, never posted to the channel.
// ════════════════════════════════════════════════════════════════════════
type FullField = { name: string; value: string; inline?: boolean };

// Discord caps a single embed at 25 fields / 6000 chars. Page the fields across
// as many embeds as needed (message allows up to 10) so a data-heavy booking is
// never dropped.
function paginateEmbeds(title: string, color: number, description: string, fields: FullField[]) {
  const embeds: Array<Record<string, unknown>> = [];
  let cur: FullField[] = [];
  let curLen = title.length + description.length;
  const flush = (): void => {
    if (!cur.length) return;
    embeds.push({
      title: embeds.length === 0 ? title : `${title} (cont. ${embeds.length + 1})`,
      color,
      description: embeds.length === 0 ? description : undefined,
      fields: cur,
    });
    cur = [];
    curLen = title.length;
  };
  for (const f of fields) {
    const flen = f.name.length + f.value.length + 8;
    if (cur.length >= 25 || curLen + flen > 5500) flush();
    cur.push(f);
    curLen += flen;
  }
  flush();
  if (embeds.length) {
    embeds[embeds.length - 1].footer = { text: "Every stored field · ephemeral (only you can see this)" };
    embeds[embeds.length - 1].timestamp = new Date().toISOString();
  }
  return embeds;
}

async function handleViewFullBooking(bookingId: string | undefined, messageId: string | undefined) {
  const booking = await prisma.booking.findFirst({
    where: {
      OR: [
        ...(messageId ? [{ discordApprovalMessageId: messageId }] : []),
        ...(bookingId ? [{ id: bookingId }] : []),
      ],
    },
    include: {
      customer: true,
      payments: { orderBy: { createdAt: "desc" } },
      files: { orderBy: { createdAt: "asc" } },
      job: true,
    },
  });
  if (!booking) return ephemeral("⚠️ Booking not found for this card.");

  const appUrl = process.env.APP_URL ?? "https://wmiwci-api.vercel.app";
  const DASH = "—";
  const s = (v: unknown): string => (v === null || v === undefined || v === "" ? DASH : String(v));
  const dt = (v: Date | null | undefined): string => (v ? formatEastern(v) : DASH);
  const moneyC = (c: number | null | undefined): string => (typeof c === "number" ? `$${(c / 100).toFixed(2)}` : DASH);
  const moneyD = (d: number | null | undefined): string => (typeof d === "number" ? `$${d.toFixed(2)}` : DASH);
  const yn = (b: boolean | null | undefined): string => (b ? "Yes" : "No");
  const cap = (v: string, n = 1024): string => (v.length > n ? v.slice(0, n - 1) + "…" : v);

  const c = booking.customer;
  const fields: FullField[] = [];
  const add = (name: string, lines: Array<string | null | undefined>, inline = false): void => {
    const value = lines.filter((l): l is string => !!l && l.length > 0).join("\n");
    fields.push({ name, value: cap(value || DASH), inline });
  };

  add("🆔 Booking", [
    `ID: \`${booking.id}\``,
    `Ref: ${s(booking.displayId)}`,
    `Status: ${s(booking.status)}`,
    booking.outboxState ? `Outbox: ${booking.outboxState}` : null,
    `Created: ${dt(booking.createdAt)}`,
  ], true);

  add("👤 Customer", [
    s(c?.name),
    `📞 ${s(c?.phone)}`,
    `✉ ${s(c?.email)}`,
    `Lang: ${s(c?.locale)} · First-time: ${yn(c?.isFirstTime)}`,
    `Customer ID: \`${s(c?.id)}\``,
  ], true);

  add("📅 Schedule", [
    `Requested: ${dt(booking.requestedDate)}`,
    `Confirmed: ${dt(booking.confirmedDate)}`,
    `Window: ${dt(booking.scheduledStart)} → ${dt(booking.scheduledEnd)}`,
    booking.rescheduleCount ? `Reschedules: ${booking.rescheduleCount}` : null,
  ], true);

  add("📍 Pickup", [s(booking.originAddress), booking.originFloor != null ? `Floor: ${booking.originFloor}` : null], true);
  add("📍 Dropoff", [
    s(booking.destAddress),
    booking.destFloor != null ? `Floor: ${booking.destFloor}` : null,
    `Elevator: ${yn(booking.hasElevator)}`,
  ], true);

  add("🧭 Service Area", [
    `Zone: ${s(booking.serviceAreaZone)}`,
    `Travel fee: ${moneyC(booking.travelFee)}${booking.travelFeeDueOnMoveDay ? " (move day)" : ""}`,
    `Manual review: ${yn(booking.manualReviewRequired)}`,
    booking.distanceFromWestOrangeMiles != null ? `Distance: ${booking.distanceFromWestOrangeMiles} mi` : null,
    booking.serviceAreaMessage ? `Note: ${booking.serviceAreaMessage}` : null,
  ], true);

  add("💰 Pricing", [
    `Base rate: ${moneyD(booking.baseRate)}`,
    `Total estimate: ${moneyD(booking.totalEstimate)}`,
    booking.finalAmount != null ? `Final: ${moneyD(booking.finalAmount)}` : null,
    `Deposit: ${moneyC(booking.depositAmount)} · Paid: ${yn(booking.depositPaid)}`,
    booking.truckAddonDueOnMoveDay ? `Truck add-on: ${moneyC(booking.truckAddonAmount)} (move day)` : null,
  ], true);

  add("🏷️ Discount", [
    `Code: ${s(booking.discountCode)}`,
    `Type: ${s(booking.discountType)}`,
    booking.discountPercent != null ? `Percent: ${booking.discountPercent}%` : null,
  ], true);

  const payLines = booking.payments.map(
    (p) =>
      `${moneyC(p.amount)} · ${p.status}${p.stripeChargeId ? ` · charge \`${p.stripeChargeId}\`` : ""}${
        p.receiptUrl ? ` · [receipt](${p.receiptUrl})` : ""
      }`,
  );
  add("💳 Stripe", [
    `Checkout: \`${s(booking.stripeCheckoutId)}\``,
    `PaymentIntent: \`${s(booking.stripePaymentIntentId)}\``,
    ...(payLines.length ? payLines : ["No captured payment yet"]),
  ]);

  add("📜 Agreement", [
    `Accepted: ${yn(booking.agreementAccepted)}${booking.agreementVersion ? ` (${booking.agreementVersion})` : ""}`,
    booking.agreementName ? `Name: ${booking.agreementName}` : null,
    booking.agreementSignature ? `Signature: ${booking.agreementSignature}` : null,
    booking.agreementAcceptedAt ? `At: ${dt(booking.agreementAcceptedAt)}` : null,
  ], true);

  add("🌐 Attribution", [
    `Source: ${s(booking.source)}`,
    `Found us: ${s(booking.foundUs)}`,
    booking.referrer ? `Referrer: ${booking.referrer}` : null,
    booking.ipAddress ? `IP: ${booking.ipAddress}` : null,
  ], true);

  if (booking.customerNotes) add("📝 Customer Notes", [booking.customerNotes]);
  if (booking.internalNotes) add("🔒 Internal Notes", [booking.internalNotes]);
  if (booking.itemsDescription) add("🧾 Full Description (as stored)", [booking.itemsDescription]);
  if (booking.files.length) {
    add(
      `📷 Files (${booking.files.length})`,
      booking.files.map((f, i) => `[${f.type} ${i + 1}](${f.cloudinaryUrl})`),
    );
  }

  const embeds = paginateEmbeds(
    `📄 Full Booking — ${s(booking.displayId)}`,
    0x0a1628,
    `Every stored field for this booking. [Open in dashboard](${appUrl}/admin/bookings)`,
    fields,
  );

  return NextResponse.json({ type: RES_REPLY, data: { flags: FLAG_EPHEMERAL, embeds } });
}

// ════════════════════════════════════════════════════════════════════════
//  MOVE-DAY JOB BUTTONS — job_start / job_complete / archive_job
//  --------------------------------------------------------------------
//  The worker dispatch card (posted by discord-rest createJobChannels) is
//  edited IN PLACE on every press, using the same shared builder, so the
//  card always shows the current human status + who pressed what and when.
//
//  Valid transitions (two-action crew workflow — matches the Job model):
//    CONFIRMED/SCHEDULED → IN_PROGRESS → COMPLETED → ARCHIVED
//  Completing straight from CONFIRMED is tolerated (crew forgot Start) and
//  audited as such. Backward transitions are refused with an ephemeral note.
//  Permissions: same boundary as the approve/deny buttons — access to the
//  jobs channel. Every press is written to the audit log with the clicker.
// ════════════════════════════════════════════════════════════════════════

type JobBooking = NonNullable<Awaited<ReturnType<typeof loadJobBooking>>>;

function loadJobBooking(bookingId: string) {
  return prisma.booking.findUnique({
    where: { id: bookingId },
    include: { customer: true, job: true },
  });
}

// Who pressed Start/Complete (for re-rendering after later presses).
async function jobAuditTrail(bookingId: string): Promise<{
  startedBy?: string;
  startedAtLabel?: string;
  completedBy?: string;
  completedAtLabel?: string;
}> {
  const rows = await prisma.auditLog
    .findMany({
      where: { bookingId, action: { in: ["JOB_STARTED", "JOB_COMPLETED"] } },
      orderBy: { createdAt: "asc" },
    })
    .catch(() => []);
  const out: { startedBy?: string; startedAtLabel?: string; completedBy?: string; completedAtLabel?: string } = {};
  for (const row of rows) {
    const details = (row.details ?? {}) as Record<string, unknown>;
    const by = typeof details.by === "string" ? details.by : undefined;
    if (row.action === "JOB_STARTED" && !out.startedBy) {
      out.startedBy = by ?? "crew";
      out.startedAtLabel = timeOfDay(row.createdAt);
    }
    if (row.action === "JOB_COMPLETED") {
      out.completedBy = by ?? "crew";
      out.completedAtLabel = timeOfDay(row.createdAt);
    }
  }
  return out;
}

async function renderJobCard(booking: JobBooking) {
  const photoCount = await prisma.file
    .count({ where: { bookingId: booking.id, type: "PHOTO_BEFORE" } })
    .catch(() => 0);
  const trail = await jobAuditTrail(booking.id);
  const items = booking.itemsDescription;
  const appUrl = process.env.APP_URL ?? "https://wmiwci-api.vercel.app";

  return buildJobCard({
    bookingId: booking.id,
    displayId: booking.displayId,
    status: booking.status,
    customerName: booking.customer?.name,
    customerPhone: booking.customer?.phone,
    serviceType: serviceLabelFromDescription(items) ?? undefined,
    moveDate: booking.confirmedDate ?? booking.requestedDate,
    originAddress: booking.originAddress,
    destAddress: booking.destAddress,
    truckOptionLabel: booking.truckAddonDueOnMoveDay
      ? TRUCK_OPTION_LABELS["truck-pickup-return"]
      : truckLabelFromDescription(items) ?? undefined,
    rawDescription: items,
    photoCount,
    laborEstimate: booking.baseRate,
    travelFeeDollars: booking.travelFee ? booking.travelFee / 100 : null,
    manualReviewRequired: booking.manualReviewRequired,
    adminUrl: `${appUrl}/admin/bookings`,
    ...trail,
  });
}

// ── job_start:<id> — labor begins ───────────────────────────────────────────
async function handleJobStart(bookingId: string | undefined, actor: DiscordActor) {
  const crewName = actor.username;
  if (!bookingId) return ephemeral("⚠️ This button is missing its booking reference.");
  const booking = await loadJobBooking(bookingId);
  if (!booking) return ephemeral("⚠️ Booking not found for this card.");

  // Idempotent second press → just re-render the current card.
  if (booking.status === "IN_PROGRESS") {
    return NextResponse.json({ type: RES_UPDATE_MESSAGE, data: await renderJobCard(booking) });
  }
  if (booking.status === "COMPLETED" || booking.status === "ARCHIVED") {
    return ephemeral("✅ This job is already completed.");
  }
  if (booking.status === "CANCELLED") {
    return ephemeral("⚠️ This booking was cancelled — check with the owner before doing any work.");
  }
  if (booking.status !== "CONFIRMED" && booking.status !== "SCHEDULED") {
    return ephemeral("⚠️ This booking hasn't been approved yet — the owner needs to approve it first.");
  }

  const now = new Date();
  await prisma.$transaction([
    prisma.booking.update({ where: { id: booking.id }, data: { status: "IN_PROGRESS" } }),
    prisma.job.upsert({
      where: { bookingId: booking.id },
      update: { status: "IN_PROGRESS", startedAt: now },
      create: { bookingId: booking.id, status: "IN_PROGRESS", startedAt: now },
    }),
    prisma.auditLog.create({
      data: {
        action: "JOB_STARTED",
        bookingId: booking.id,
        details: { by: crewName, discordUserId: actor.userId ?? null, from: booking.status },
      },
    }),
  ]);

  apiLogger.info({ bookingId: booking.id, by: crewName }, "Job started via Discord");
  const updated = await loadJobBooking(booking.id);
  return NextResponse.json({ type: RES_UPDATE_MESSAGE, data: await renderJobCard(updated ?? booking) });
}

// ── job_complete:<id> — customer confirmed the move is finished ────────────
async function handleJobComplete(bookingId: string | undefined, actor: DiscordActor) {
  const crewName = actor.username;
  if (!bookingId) return ephemeral("⚠️ This button is missing its booking reference.");
  const booking = await loadJobBooking(bookingId);
  if (!booking) return ephemeral("⚠️ Booking not found for this card.");

  if (booking.status === "COMPLETED" || booking.status === "ARCHIVED") {
    return NextResponse.json({ type: RES_UPDATE_MESSAGE, data: await renderJobCard(booking) });
  }
  if (booking.status === "CANCELLED") {
    return ephemeral("⚠️ This booking was cancelled — nothing to complete.");
  }
  const skippedStart = booking.status === "CONFIRMED" || booking.status === "SCHEDULED";
  if (!skippedStart && booking.status !== "IN_PROGRESS") {
    return ephemeral("⚠️ This booking hasn't been approved yet — the owner needs to approve it first.");
  }

  const now = new Date();
  const startedAt = booking.job?.startedAt ?? null;
  const durationMins = startedAt ? Math.max(0, Math.round((now.getTime() - startedAt.getTime()) / 60000)) : null;

  await prisma.$transaction([
    prisma.booking.update({
      where: { id: booking.id },
      data: { status: "COMPLETED", completedAt: now },
    }),
    prisma.job.upsert({
      where: { bookingId: booking.id },
      update: { status: "COMPLETED", completedAt: now, ...(durationMins != null ? { durationMins } : {}) },
      create: { bookingId: booking.id, status: "COMPLETED", startedAt: now, completedAt: now },
    }),
    prisma.auditLog.create({
      data: {
        action: "JOB_COMPLETED",
        bookingId: booking.id,
        details: { by: crewName, discordUserId: actor.userId ?? null, from: booking.status, startNotPressed: skippedStart || undefined },
      },
    }),
  ]);

  apiLogger.info({ bookingId: booking.id, by: crewName, durationMins }, "Job completed via Discord");
  const updated = await loadJobBooking(booking.id);
  return NextResponse.json({ type: RES_UPDATE_MESSAGE, data: await renderJobCard(updated ?? booking) });
}

// ── archive_job:<id> — file the finished card away ─────────────────────────
async function handleJobArchive(bookingId: string | undefined, actor: DiscordActor) {
  const crewName = actor.username;
  if (!bookingId) return ephemeral("⚠️ This button is missing its booking reference.");
  const booking = await loadJobBooking(bookingId);
  if (!booking) return ephemeral("⚠️ Booking not found for this card.");

  if (booking.status === "ARCHIVED") {
    return NextResponse.json({ type: RES_UPDATE_MESSAGE, data: await renderJobCard(booking) });
  }
  if (booking.status !== "COMPLETED") {
    return ephemeral("⚠️ Only a completed job can be archived.");
  }

  await prisma.$transaction([
    prisma.booking.update({ where: { id: booking.id }, data: { status: "ARCHIVED" } }),
    prisma.auditLog.create({
      data: {
        action: "BOOKING_STATE_CHANGED",
        bookingId: booking.id,
        details: { action: "archive_job", by: crewName, discordUserId: actor.userId ?? null, from: booking.status },
      },
    }),
  ]);

  apiLogger.info({ bookingId: booking.id, by: crewName }, "Job archived via Discord");
  const updated = await loadJobBooking(booking.id);
  return NextResponse.json({ type: RES_UPDATE_MESSAGE, data: await renderJobCard(updated ?? booking) });
}

// ── Slash commands (type 2): field logging, usable from ANY channel ────────
// The work is a single fast insert, so we respond synchronously with a type-4
// reply (well within Discord's 3s window). This handles commands whether Discord
// delivers them over HTTP (this endpoint) — the gateway bot covers the case
// where they arrive over the websocket instead.
const FIELD_LOG: Record<string, { type: ManualEventType; emoji: string; label: string }> = {
  quote: { type: ManualEventType.QUOTE, emoji: "💵", label: "Quote given" },
  visit: { type: ManualEventType.VISIT, emoji: "🚚", label: "In-person visit" },
  onsite: { type: ManualEventType.ONSITE, emoji: "📍", label: "Wants on-site quote" },
  nobook: { type: ManualEventType.NOBOOK, emoji: "❌", label: "Did not book" },
  jobaccept: { type: ManualEventType.JOBACCEPT, emoji: "✅", label: "Job accepted (verbal)" },
  followup: { type: ManualEventType.FOLLOWUP, emoji: "🔁", label: "Follow-up" },
};

function cmdOptions(interaction: any): Record<string, string> {
  const out: Record<string, string> = {};
  for (const o of interaction?.data?.options ?? []) out[o.name] = String(o.value ?? "");
  return out;
}

function cmdUser(interaction: any): string {
  const u = interaction?.member?.user ?? interaction?.user;
  return u?.global_name ?? u?.username ?? "unknown";
}

async function handleFieldLog(interaction: any, cmd: string) {
  const def = FIELD_LOG[cmd];
  const o = cmdOptions(interaction);
  const name = (o.name ?? "").trim();
  const zip = (o.zip ?? "").trim();
  const job = (o.job ?? "").trim() || null;
  const notes = (o.notes ?? "").trim() || null;

  const ev = await prisma.manualEvent.create({
    data: { eventType: def.type, customerName: name || null, zip: zip || null, jobType: job, notes, loggedBy: cmdUser(interaction) },
  });
  apiLogger.info({ id: ev.id, cmd, zip, channelId: interaction.channel_id }, "✓ field event logged (HTTP)");

  const fields: Array<{ name: string; value: string; inline?: boolean }> = [
    { name: "👤 Customer", value: name || "—", inline: true },
    { name: "📍 ZIP", value: zip || "—", inline: true },
  ];
  if (job) fields.push({ name: "📦 Job", value: job, inline: true });
  if (notes) fields.push({ name: "📝 Notes", value: notes.slice(0, 1024), inline: false });

  return NextResponse.json({
    type: RES_REPLY,
    data: {
      flags: FLAG_EPHEMERAL,
      embeds: [{ title: `${def.emoji} ${def.label} — logged`, color: 0xff5a1f, fields, footer: { text: `Event ID: ${ev.id}` }, timestamp: new Date().toISOString() }],
    },
  });
}

async function handleRecent(interaction: any) {
  const o = cmdOptions(interaction);
  const type = (o.type || undefined) as ManualEventType | undefined;
  const count = Math.min(Math.max(parseInt(o.count || "10", 10) || 10, 1), 25);
  const events = await prisma.manualEvent.findMany({
    where: type ? { eventType: type } : undefined,
    orderBy: { createdAt: "desc" },
    take: count,
  });
  const emojiFor = (t: ManualEventType) => Object.values(FIELD_LOG).find((f) => f.type === t)?.emoji ?? "•";
  const description =
    events.length === 0
      ? "No events logged yet."
      : events
          .map((e) => `${emojiFor(e.eventType)} **${e.customerName ?? "—"}**${e.zip ? ` · ${e.zip}` : ""}${e.notes ? ` · ${e.notes}` : ""}`)
          .join("\n")
          .slice(0, 4000);

  return NextResponse.json({
    type: RES_REPLY,
    data: { flags: FLAG_EPHEMERAL, embeds: [{ title: "🗒️ Recent field events", color: 0x0a1628, description }] },
  });
}

// ── Owner task board (type 2): /task_add /task_list /task_done /task_delete ──
// /task_edit /task_today /task_overdue /task_setup. All logic lives in the
// shared task-service; here we just map options → service → ephemeral embed.
const TASK_CMDS = new Set([
  "task_add",
  "task_list",
  "task_done",
  "task_delete",
  "task_edit",
  "task_today",
  "task_overdue",
  "task_setup",
]);

// /task_setup — create the #owner-tasks text channel via Discord REST.
async function setupOwnerChannel(interaction: any): Promise<Embed> {
  const guildId = interaction?.guild_id;
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!guildId) return { title: "⚠️ Run /task_setup in the server, not a DM.", color: 0xef4444 };
  if (!token) return { title: "⚠️ DISCORD_BOT_TOKEN not configured on the server.", color: 0xef4444 };

  const headers = { Authorization: `Bot ${token}`, "Content-Type": "application/json" };
  const base = `https://discord.com/api/v10/guilds/${guildId}/channels`;

  // Idempotent: re-running just points at the existing channel.
  const existing = await fetch(base, { headers })
    .then((r) => (r.ok ? r.json() : []))
    .catch(() => []);
  const found = Array.isArray(existing) ? existing.find((c: any) => c?.name === "owner-tasks") : null;
  if (found) return { title: "✅ #owner-tasks already exists", color: 0x22c55e, description: `<#${found.id}>` };

  const res = await fetch(base, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "owner-tasks", type: 0, topic: "Owner task board — Diego & Sebastian" }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    apiLogger.error({ guildId, status: res.status, body: txt.slice(0, 300) }, "task_setup channel create failed");
    return {
      title: "⚠️ Couldn't create #owner-tasks",
      color: 0xef4444,
      description: (txt.slice(0, 250) || `HTTP ${res.status}`) + "\n(Does the bot have **Manage Channels**?)",
    };
  }
  const ch = await res.json();
  apiLogger.info({ guildId, channelId: ch.id }, "task_setup created #owner-tasks");
  return { title: "✅ Created #owner-tasks", color: 0x22c55e, description: `<#${ch.id}> — start with \`/task_add\`` };
}

async function handleTaskCommand(interaction: any, cmd: string) {
  const o = cmdOptions(interaction);
  let embed: Embed;
  switch (cmd) {
    case "task_add":
      embed = await addTask(o);
      break;
    case "task_list":
      embed = await listTasks(o.owner);
      break;
    case "task_done":
      embed = await completeTask(o.id);
      break;
    case "task_delete":
      embed = await deleteTask(o.id);
      break;
    case "task_edit":
      embed = await editTask(o);
      break;
    case "task_today":
      embed = await todayTasks();
      break;
    case "task_overdue":
      embed = await overdueTasks();
      break;
    case "task_setup":
      embed = await setupOwnerChannel(interaction);
      break;
    default:
      return ephemeral(`Unknown task command /${cmd}`);
  }
  return NextResponse.json({ type: RES_REPLY, data: { flags: FLAG_EPHEMERAL, embeds: [embed] } });
}

export async function POST(req: Request) {
  const signature = req.headers.get("x-signature-ed25519");
  const timestamp = req.headers.get("x-signature-timestamp");
  const rawBody = await req.text();

  if (!signature || !timestamp) {
    return new NextResponse("missing signature", { status: 401 });
  }
  const publicKey = process.env.DISCORD_PUBLIC_KEY;
  if (!publicKey) {
    return new NextResponse("server misconfigured: DISCORD_PUBLIC_KEY", { status: 500 });
  }
  if (!verifyDiscordSignature(rawBody, signature, timestamp, publicKey)) {
    return new NextResponse("invalid request signature", { status: 401 });
  }

  const interaction = JSON.parse(rawBody);

  // DEBUG: log every interaction that reaches this endpoint (type + command).
  apiLogger.info(
    {
      type: interaction.type,
      command: interaction?.data?.name,
      channelId: interaction?.channel_id,
      user: cmdUser(interaction),
    },
    "⇢ Discord interaction received (HTTP)"
  );

  // Endpoint-verification handshake.
  if (interaction.type === TYPE_PING) {
    return NextResponse.json({ type: RES_PONG });
  }

  // Slash commands (field logging). Handle here so they work from any channel
  // and never time out; unknown commands fall through to the generic ack below.
  if (interaction.type === TYPE_APPLICATION_COMMAND) {
    const cmd: string = interaction?.data?.name ?? "";
    if (FIELD_LOG[cmd] || cmd === "recent") {
      try {
        return cmd === "recent" ? await handleRecent(interaction) : await handleFieldLog(interaction, cmd);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        apiLogger.error({ cmd, err: msg, stack: err instanceof Error ? err.stack : undefined }, "✖ slash command handler failed");
        return ephemeral(`⚠️ Failed to log: ${msg.slice(0, 120)}`);
      }
    }
    if (TASK_CMDS.has(cmd)) {
      try {
        return await handleTaskCommand(interaction, cmd);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        apiLogger.error({ cmd, err: msg, stack: err instanceof Error ? err.stack : undefined }, "✖ task command handler failed");
        return ephemeral(`⚠️ Task command failed: ${msg.slice(0, 120)}`);
      }
    }
    apiLogger.warn({ cmd }, "slash command not handled by HTTP endpoint (gateway bot owns it)");
  }

  // Button presses.
  if (interaction.type === TYPE_MESSAGE_COMPONENT) {
    const customId: string = interaction.data?.custom_id ?? "";
    const [action, id] = customId.split(":");
    const messageId: string | undefined = interaction.message?.id;

    // ── OWNER AUTHORIZATION — the single gate for every privileged button ──
    // Every action that mutates a booking / moves money is owner-only. A user is
    // an owner when their ID is in DISCORD_OWNER_USER_IDS or they hold
    // DISCORD_OWNER_ROLE_ID inside the configured guild (see lib/discord-auth).
    // Unauthorized presses get a generic ephemeral notice and are logged; we
    // never leak which IDs/roles are allowed.
    const OWNER_ACTIONS = new Set([
      "approve_booking",
      "deny_booking",
      "offer_reschedule",
      "view_full_booking",
      "approve_discount",
      "deny_discount",
      "job_start",
      "job_complete",
      "archive_job",
    ]);
    if (OWNER_ACTIONS.has(action)) {
      const auth = authorizeOwnerAction(interaction, action);
      if (!auth.ok) {
        return ephemeral("🔒 You do not have permission to manage this booking.");
      }
      const actor = auth.actor;

      if (action === "approve_booking") {
        return handleApprove(id, messageId, actor);
      }
      if (action === "deny_booking") {
        return handleDeny(id, messageId, actor);
      }
      if (action === "offer_reschedule") {
        return handleOffer(id, messageId, actor);
      }
      if (action === "view_full_booking") {
        try {
          return await handleViewFullBooking(id, messageId);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          apiLogger.error({ action, bookingId: id, err: msg }, "✖ view_full_booking failed");
          return ephemeral("⚠️ Couldn't load the full booking — try the admin dashboard.");
        }
      }

      // Move-day job buttons — each wrapped so a failure never leaves the
      // worker with a dead "interaction failed" spinner.
      if (action === "job_start" || action === "job_complete" || action === "archive_job") {
        try {
          if (action === "job_start") return await handleJobStart(id, actor);
          if (action === "job_complete") return await handleJobComplete(id, actor);
          return await handleJobArchive(id, actor);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          apiLogger.error({ action, bookingId: id, err: msg }, "✖ job button handler failed");
          return ephemeral("⚠️ Something went wrong updating this job — try again or use the admin portal.");
        }
      }

      // Authorized owner, but the specific action (discount buttons) has no
      // handler on this endpoint yet — acknowledge without leaking anything.
      return ephemeral("Received — that action isn't handled by this endpoint yet.");
    }

    // Non-privileged / unknown component — acknowledge.
    return ephemeral("Received — that action isn't handled by this endpoint yet.");
  }

  return NextResponse.json({ type: RES_REPLY, data: { content: "Interaction received", flags: FLAG_EPHEMERAL } });
}
