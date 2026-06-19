import { NextResponse } from "next/server";
import nacl from "tweetnacl";
import { prisma } from "@/lib/db";
import { ManualEventType } from "@prisma/client";
import { captureDeposit, cancelDeposit } from "@/lib/stripe";
import { emailQueue, smsQueue } from "@/lib/queues";
import { offerRescheduleToCustomer } from "@/lib/reschedule";
import { t } from "@/lib/i18n";
import { formatEastern } from "@/lib/scheduling";
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

// The "✅ Approved" card that replaces the approval card in place (no buttons).
function confirmedCard(booking: CardBooking, approverName: string, capturedCents?: number) {
  const when = booking.confirmedDate ?? booking.requestedDate;
  const dateStr = when ? formatEastern(when) : "—";
  const cents = capturedCents ?? booking.depositAmount ?? 4900;
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
    components: [], // strip the Approve / Offer / Deny buttons
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
async function handleApprove(bookingId: string | undefined, messageId: string | undefined, approverName: string) {
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

  // 1) Capture the manual-capture PaymentIntent (the held $49 → charged).
  let pi;
  try {
    pi = await captureDeposit(booking.stripePaymentIntentId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    apiLogger.error({ bookingId: booking.id, err: msg }, "captureDeposit failed");
    return ephemeral(`⚠️ Stripe capture failed: ${msg}. The hold was NOT captured.`);
  }
  const capturedCents = pi.amount_received ?? pi.amount ?? booking.depositAmount;

  // 2) Confirm the booking + record the payment (atomic).
  await prisma.$transaction([
    prisma.booking.update({
      where: { id: booking.id },
      data: { status: "CONFIRMED", depositPaid: true, confirmedDate: booking.requestedDate },
    }),
    prisma.payment.create({
      data: {
        bookingId: booking.id,
        stripePaymentIntentId: pi.id,
        amount: capturedCents,
        status: "COMPLETED",
        description: "Booking deposit captured on approval",
      },
    }),
    prisma.auditLog.create({
      data: {
        action: "PAYMENT_RECEIVED",
        bookingId: booking.id,
        details: { captured: capturedCents, paymentIntentId: pi.id, approvedBy: approverName },
      },
    }),
  ]);

  // 3) Queue the PRE-APPROVAL customer messages (email + SMS) — the ONLY pair
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

  // 4) Edit the Discord card in place.
  return NextResponse.json({ type: RES_UPDATE_MESSAGE, data: confirmedCard(booking, approverName, capturedCents) });
}

// ── deny_booking:<id> → release the hold → CANCELLED → notify ──────────────
async function handleDeny(bookingId: string | undefined, messageId: string | undefined, approverName: string) {
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

  // Release the authorization (no money moves). Tolerate an already-void PI.
  if (booking.stripePaymentIntentId) {
    try {
      await cancelDeposit(booking.stripePaymentIntentId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      apiLogger.warn({ bookingId: booking.id, err: msg }, "cancelDeposit failed (continuing — hold may already be void)");
    }
  }

  await prisma.$transaction([
    prisma.booking.update({ where: { id: booking.id }, data: { status: "CANCELLED" } }),
    prisma.auditLog.create({
      data: {
        action: "BOOKING_STATE_CHANGED",
        bookingId: booking.id,
        details: { action: "deny_booking", from: booking.status, deniedBy: approverName },
      },
    }),
  ]);

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
async function handleOffer(bookingId: string | undefined, messageId: string | undefined, approverName: string) {
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
    apiLogger.warn({ cmd }, "slash command not handled by HTTP endpoint (gateway bot owns it)");
  }

  // Button presses.
  if (interaction.type === TYPE_MESSAGE_COMPONENT) {
    const customId: string = interaction.data?.custom_id ?? "";
    const [action, id] = customId.split(":");
    const messageId: string | undefined = interaction.message?.id;
    const user = interaction.member?.user ?? interaction.user;
    const approver: string = user?.global_name ?? user?.username ?? "admin";

    if (action === "approve_booking") {
      return handleApprove(id, messageId, approver);
    }
    if (action === "deny_booking") {
      return handleDeny(id, messageId, approver);
    }
    if (action === "offer_reschedule") {
      return handleOffer(id, messageId, approver);
    }

    // Unknown component (discount buttons, job buttons, …) — acknowledge.
    return ephemeral("Received — that action isn't handled by this endpoint yet.");
  }

  return NextResponse.json({ type: RES_REPLY, data: { content: "Interaction received", flags: FLAG_EPHEMERAL } });
}
