import { NextRequest, NextResponse } from 'next/server'
import nacl from 'tweetnacl'
import { prisma } from '@/lib/db'
import { emailQueue, discordQueue, smsQueue } from '@/lib/queues'
import { findAvailableSlots, formatEastern } from '@/lib/scheduling'
import { webhookLogger } from '@/lib/logger'
import { captureDeposit, cancelDeposit, refundDeposit, BOOKING_FEE_CENTS } from '@/lib/stripe'
import { t } from '@/lib/i18n'

export const runtime = 'nodejs'

// ── Verify Ed25519 signature from Discord ─────────────────────
function verifyDiscordSignature(
  body: string,
  signature: string,
  timestamp: string
): boolean {
  try {
    const publicKey = process.env.DISCORD_PUBLIC_KEY
    if (!publicKey || publicKey === 'placeholder_public_key') return false

    const message = Buffer.from(timestamp + body)
    const sig = Buffer.from(signature, 'hex')
    const key = Buffer.from(publicKey, 'hex')

    return nacl.sign.detached.verify(message, sig, key)
  } catch {
    return false
  }
}

// ── Interaction types ─────────────────────────────────────────
const PING = 1
const APPLICATION_COMMAND = 2
const MESSAGE_COMPONENT = 3

export async function POST(req: NextRequest): Promise<NextResponse> {
  const signature = req.headers.get('x-signature-ed25519') ?? ''
  const timestamp = req.headers.get('x-signature-timestamp') ?? ''
  const rawBody = await req.text()

  // ── Replay attack prevention (reject if >5 seconds old) ──────
  const ts = parseInt(timestamp, 10)
  if (isNaN(ts) || Date.now() / 1000 - ts > 5) {
    return NextResponse.json({ error: 'Request too old' }, { status: 401 })
  }

  // ── Verify signature ──────────────────────────────────────────
  if (!verifyDiscordSignature(rawBody, signature, timestamp)) {
    webhookLogger.warn('Discord signature verification failed')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  let interaction: any
  try {
    interaction = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // ── Handle PING (Discord requires this) ───────────────────────
  if (interaction.type === PING) {
    return NextResponse.json({ type: 1 })
  }

  // ── Handle button interactions ────────────────────────────────
  if (interaction.type === MESSAGE_COMPONENT) {
    const customId: string = interaction.data?.custom_id ?? ''
    const userId: string = interaction.member?.user?.id ?? ''
    const username: string = interaction.member?.user?.username ?? 'Unknown'

    webhookLogger.info({ customId, userId }, 'Discord button interaction')

    // Log interaction to webhook_logs
    await prisma.webhookLog.create({
      data: {
        source: 'discord',
        eventType: 'button_interaction',
        payload: interaction,
        status: 'processing',
      },
    })

    return await handleButtonInteraction(customId, userId, username, interaction)
  }

  return NextResponse.json({ type: 1 })
}

async function handleButtonInteraction(
  customId: string,
  discordUserId: string,
  username: string,
  interaction: any
): Promise<NextResponse> {
  // custom_id format: "action:bookingId"
  const [action, bookingId] = customId.split(':')

  if (!bookingId) {
    return NextResponse.json({
      type: 4,
      data: { content: '❌ Invalid interaction data.', flags: 64 },
    })
  }

  // Fetch staff user by Discord ID
  const staffUser = await prisma.user.findFirst({
    where: { discordId: discordUserId },
  })

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { customer: true },
  })

  if (!booking) {
    return NextResponse.json({
      type: 4,
      data: { content: `❌ Booking \`${bookingId}\` not found.`, flags: 64 },
    })
  }

  switch (action) {
    // ── APPROVE BOOKING ─────────────────────────────────────────
    case 'approve_booking': {
      if (!staffUser || !['OWNER', 'MANAGER'].includes(staffUser.role)) {
        return NextResponse.json({
          type: 4,
          data: { content: '❌ You do not have permission to approve bookings.', flags: 64 },
        })
      }

      if (booking.status !== 'PENDING_APPROVAL') {
        return NextResponse.json({
          type: 4,
          data: { content: `⚠️ Booking is already **${booking.status}**.`, flags: 64 },
        })
      }

      // Capture the held $49 now that we're approving (authorize-only -> capture).
      let captured = false
      if (booking.stripePaymentIntentId) {
        try {
          await captureDeposit(booking.stripePaymentIntentId)
          await prisma.payment.create({
            data: {
              bookingId,
              stripePaymentIntentId: booking.stripePaymentIntentId,
              amount: BOOKING_FEE_CENTS,
              currency: 'usd',
              status: 'COMPLETED',
              description: 'Booking deposit (captured on approval)',
            },
          })
          captured = true
        } catch (err) {
          webhookLogger.error({ err, bookingId }, 'Deposit capture failed on approve (hold may have expired)')
        }
      }

      // Find next available slot
      const slots = await findAvailableSlots(
        booking.requestedDate ?? new Date(),
        1
      )
      const confirmedDate = slots[0] ?? booking.requestedDate ?? new Date()

      await prisma.booking.update({
        where: { id: bookingId },
        data: {
          status: 'CONFIRMED',
          confirmedDate,
          scheduledStart: confirmedDate,
          depositPaid: captured,
        },
      })

      await prisma.auditLog.create({
        data: {
          action: 'BOOKING_STATE_CHANGED',
          userId: staffUser?.id,
          bookingId,
          details: { from: 'PENDING_APPROVAL', to: 'CONFIRMED', approvedBy: username, captured },
        },
      })

      // Email customer confirmation (bilingual via customer.locale)
      await emailQueue.add('booking-confirmed', {
        template: 'booking-confirmed',
        to: booking.customer.email,
        bookingId,
        payload: {
          customerName: booking.customer.name,
          confirmedDate: formatEastern(confirmedDate),
          originAddress: booking.originAddress,
          destAddress: booking.destAddress,
          discountPercent: booking.discountPercent,
          discountType: booking.discountType,
          portalUrl: `${process.env.APP_URL}/my-booking/${booking.customerToken}`,
          locale: booking.customer.locale,
        },
      })

      // SMS (bilingual)
      await smsQueue.add('booking-confirmed-sms', {
        to: booking.customer.phone,
        message: t(booking.customer.locale, 'bookingConfirmed', {
          name: booking.customer.name,
          date: formatEastern(confirmedDate),
        }),
        bookingId,
      })

      // Schedule 24h reminder
      const reminderTime = new Date(confirmedDate)
      reminderTime.setHours(reminderTime.getHours() - 24)
      if (reminderTime > new Date()) {
        await discordQueue.add(
          'job-reminder',
          { type: 'job-reminder-24h', bookingId },
          { delay: reminderTime.getTime() - Date.now() }
        )
      }

      // type: 7 = UPDATE_MESSAGE — edits the original booking card in-place
      const approvedEmbed = {
        title: `✅ APPROVED — ${booking.displayId}`,
        color: 0x22c55e,
        fields: [
          { name: '👤 Customer', value: `${booking.customer.name}\n${booking.customer.phone ?? '—'}\n${booking.customer.email}`, inline: true },
          { name: '📅 Confirmed', value: formatEastern(confirmedDate), inline: true },
          { name: '👷 Crew', value: 'Diego & Sebastian', inline: true },
          { name: '📍 From → To', value: `${booking.originAddress} → ${booking.destAddress}`, inline: false },
          { name: '💳 Deposit', value: captured ? '$49 captured' : '⚠️ capture failed — re-collect', inline: true },
          { name: '👮 Approved By', value: username, inline: true },
        ],
        timestamp: new Date().toISOString(),
        footer: { text: `Booking ID: ${bookingId}` },
      }
      return NextResponse.json({
        type: 7,
        data: { embeds: [approvedEmbed], components: [] },
      })
    }

    // ── DENY BOOKING (release the $49 hold) ─────────────────────
    case 'deny_booking': {
      if (!staffUser || !['OWNER', 'MANAGER'].includes(staffUser.role)) {
        return NextResponse.json({
          type: 4,
          data: { content: '❌ Permission denied.', flags: 64 },
        })
      }

      // Release the $49: cancel the authorization (no charge) if still held,
      // or refund it if it had already been captured.
      let released = false
      if (booking.stripePaymentIntentId) {
        try {
          if (booking.depositPaid) {
            await refundDeposit(booking.stripePaymentIntentId)
            await prisma.payment.updateMany({
              where: { bookingId, stripePaymentIntentId: booking.stripePaymentIntentId },
              data: { status: 'REFUNDED' },
            })
          } else {
            await cancelDeposit(booking.stripePaymentIntentId)
          }
          released = true
        } catch (err) {
          webhookLogger.error({ err, bookingId }, 'Deposit release failed on deny')
        }
      }

      // CANCELLED is the terminal "denied" state (no separate DENIED enum value).
      await prisma.booking.update({
        where: { id: bookingId },
        data: { status: 'CANCELLED' },
      })

      const rescheduleUrl = `${process.env.FRONTEND_URL ?? process.env.MARKETING_SITE_URL ?? 'https://moveitclearit.com'}/booking-form.html`
      const fallbackMessage =
        'If we cannot process your booking automatically, we will call you or send you an email to confirm your move manually.'

      // Apology email with refund note + reschedule link (bilingual)
      await emailQueue.add('booking-denied', {
        template: 'booking-denied',
        to: booking.customer.email,
        bookingId,
        payload: {
          customerName: booking.customer.name,
          released,
          depositAmount: (BOOKING_FEE_CENTS / 100).toFixed(2),
          rescheduleUrl,
          fallbackMessage,
          locale: booking.customer.locale,
        },
      })

      // Apology SMS — hold released (not charged) + reschedule link + fallback (bilingual)
      if (booking.customer.phone) {
        const refundLine = t(booking.customer.locale, released ? 'refundReleased' : 'refundPending')
        await smsQueue.add('booking-denied-sms', {
          to: booking.customer.phone,
          message: t(booking.customer.locale, 'bookingDenied', {
            name: booking.customer.name,
            refundLine,
            url: rescheduleUrl,
          }),
          bookingId,
        })
      }

      await prisma.auditLog.create({
        data: {
          action: 'BOOKING_STATE_CHANGED',
          userId: staffUser?.id,
          bookingId,
          details: { action: 'denied', released, by: username },
        },
      })

      // type: 7 = UPDATE_MESSAGE — edits the original booking card in-place
      const deniedEmbed = {
        title: `❌ DENIED — ${booking.displayId}`,
        color: 0xef4444,
        fields: [
          { name: '👤 Customer', value: booking.customer.name, inline: true },
          { name: '👮 Denied By', value: username, inline: true },
          { name: '💸 Deposit', value: released ? '$49 hold released (not charged)' : 'Release pending', inline: true },
        ],
        timestamp: new Date().toISOString(),
        footer: { text: `Booking ID: ${bookingId}` },
      }
      return NextResponse.json({
        type: 7,
        data: { embeds: [deniedEmbed], components: [] },
      })
    }

    // ── OFFER NEW DATES (reschedule, KEEP the $49 hold) ─────────
    case 'offer_reschedule': {
      if (!staffUser || !['OWNER', 'MANAGER'].includes(staffUser.role)) {
        return NextResponse.json({
          type: 4,
          data: { content: '❌ Permission denied.', flags: 64 },
        })
      }

      // Find 3 open dates starting from the day after the requested date.
      const from = new Date(booking.requestedDate ?? new Date())
      from.setDate(from.getDate() + 1)
      const slots = await findAvailableSlots(from, 3)
      const formatted = slots.map((s) => formatEastern(s))

      // Tokenized self-service link — customer picks without re-entering info.
      // NOTE: the $49 authorization hold and the customer token both live ~7
      // days; if the customer picks after the hold expires, capture-on-approve
      // fails gracefully (card shows "capture failed — re-collect").
      const portalBase =
        process.env.FRONTEND_URL ?? process.env.MARKETING_SITE_URL ?? 'https://www.wemoveitweclearit.com'
      const rescheduleUrl = `${portalBase}/booking-form.html?reschedule=${booking.customerToken}`

      // Booking stays PENDING_APPROVAL (alive, hold intact) awaiting the pick.
      await prisma.auditLog.create({
        data: {
          action: 'BOOKING_STATE_CHANGED',
          userId: staffUser?.id,
          bookingId,
          details: { action: 'reschedule_offered', by: username, offeredDates: formatted },
        },
      })

      // Email the customer the alternate dates (bilingual template + locale).
      await emailQueue.add('reschedule-offer', {
        template: 'reschedule-offer',
        to: booking.customer.email,
        bookingId,
        payload: {
          customerName: booking.customer.name,
          alternateDates: formatted,
          rescheduleUrl,
          locale: booking.customer.locale,
        },
      })

      // SMS the customer (bilingual; Twilio-gated).
      if (booking.customer.phone) {
        await smsQueue.add('reschedule-offer-sms', {
          to: booking.customer.phone,
          message: t(booking.customer.locale, 'rescheduleOffer', {
            name: booking.customer.name,
            url: rescheduleUrl,
            dates: formatted.slice(0, 3).join(' / '),
          }),
          bookingId,
        })
      }

      // Edit the card to show dates were offered — KEEP buttons so staff can
      // still Approve/Deny later (e.g., if the customer calls instead).
      const offeredEmbed = {
        title: `📅 RESCHEDULE OFFERED — ${booking.displayId}`,
        color: 0x3b82f6,
        fields: [
          { name: '👤 Customer', value: `${booking.customer.name}\n${booking.customer.phone ?? '—'}\n${booking.customer.email}`, inline: true },
          { name: '💳 Deposit', value: '$49 hold KEPT (not released)', inline: true },
          { name: '👮 Offered By', value: username, inline: true },
          { name: '🗓️ Dates Offered', value: formatted.length ? formatted.map((d, i) => `${i + 1}. ${d}`).join('\n') : 'None available — customer will call', inline: false },
          { name: 'ℹ️ Status', value: 'Awaiting customer date pick → a fresh approval card posts when they choose.', inline: false },
        ],
        timestamp: new Date().toISOString(),
        footer: { text: `Booking ID: ${bookingId}` },
      }
      // type 7 = UPDATE_MESSAGE; keep the original action row (components) intact.
      return NextResponse.json({
        type: 7,
        data: { embeds: [offeredEmbed], components: interaction.message?.components ?? [] },
      })
    }

    // ── APPROVE 30% DOOR HANGER DISCOUNT ────────────────────────
    case 'approve_discount': {
      const diegoId = process.env.DISCORD_USER_DIEGO
      if (discordUserId !== diegoId && staffUser?.role !== 'OWNER') {
        return NextResponse.json({
          type: 4,
          data: { content: '❌ Only the owner can approve 30% discounts.', flags: 64 },
        })
      }

      await prisma.booking.update({
        where: { id: bookingId },
        data: {
          discountType: 'DOOR_HANGER_APPROVED',
          discountPercent: 30,
          discountApprovedById: staffUser?.id,
        },
      })

      await prisma.auditLog.create({
        data: {
          action: 'DISCOUNT_APPROVED',
          userId: staffUser?.id,
          bookingId,
          details: { percent: 30, code: booking.discountCode },
        },
      })

      await emailQueue.add('discount-approved', {
        template: 'booking-confirmed',
        to: booking.customer.email,
        bookingId,
        payload: {
          customerName: booking.customer.name,
          discountPercent: 30,
          message: '🎉 Great news! Your 30% door hanger discount has been approved.',
          portalUrl: `${process.env.APP_URL}/my-booking/${booking.customerToken}`,
        },
      })

      return NextResponse.json({
        type: 4,
        data: { content: `✅ 30% discount approved for booking **${booking.displayId}** by ${username}.` },
      })
    }

    // ── DENY 30% — OFFER 10% INSTEAD ────────────────────────────
    case 'deny_discount': {
      const diegoId = process.env.DISCORD_USER_DIEGO
      if (discordUserId !== diegoId && staffUser?.role !== 'OWNER') {
        return NextResponse.json({
          type: 4,
          data: { content: '❌ Only the owner can deny discounts.', flags: 64 },
        })
      }

      await prisma.booking.update({
        where: { id: bookingId },
        data: {
          discountType: 'DOOR_HANGER_DENIED',
          discountPercent: 10, // fallback
        },
      })

      await prisma.auditLog.create({
        data: {
          action: 'DISCOUNT_DENIED',
          userId: staffUser?.id,
          bookingId,
          details: { code: booking.discountCode, fallback: '10%' },
        },
      })

      await emailQueue.add('discount-denied', {
        template: 'booking-confirmed',
        to: booking.customer.email,
        bookingId,
        payload: {
          customerName: booking.customer.name,
          discountPercent: 10,
          message: "We couldn't verify your door hanger code, but we're giving you 10% off as a first-time customer.",
          portalUrl: `${process.env.APP_URL}/my-booking/${booking.customerToken}`,
        },
      })

      return NextResponse.json({
        type: 4,
        data: { content: `🔄 30% denied for **${booking.displayId}** — 10% fallback applied. Customer notified.` },
      })
    }

    // ── MARK JOB IN PROGRESS ─────────────────────────────────────
    case 'job_start': {
      await prisma.booking.update({
        where: { id: bookingId },
        data: { status: 'IN_PROGRESS' },
      })
      await prisma.job.updateMany({
        where: { bookingId },
        data: { status: 'IN_PROGRESS', startedAt: new Date() },
      })

      await smsQueue.add('job-started-sms', {
        to: booking.customer.phone,
        message: t(booking.customer.locale, 'jobStarted'),
        bookingId,
      })

      await prisma.auditLog.create({
        data: { action: 'JOB_STARTED', bookingId, details: { by: username } },
      })

      return NextResponse.json({
        type: 4,
        data: { content: `🚛 Job **${booking.displayId}** marked IN PROGRESS by ${username}.` },
      })
    }

    // ── MARK JOB COMPLETED ───────────────────────────────────────
    case 'job_complete': {
      const now = new Date()
      await prisma.booking.update({
        where: { id: bookingId },
        data: { status: 'COMPLETED' },
      })
      await prisma.job.updateMany({
        where: { bookingId },
        data: { status: 'COMPLETED', completedAt: now },
      })

      // Create receipt record
      await prisma.receipt.upsert({
        where: { bookingId },
        update: { sentAt: now, sentTo: booking.customer.email },
        create: { bookingId, sentAt: now, sentTo: booking.customer.email },
      })

      await emailQueue.add('job-completion', {
        template: 'job-completion',
        to: booking.customer.email,
        bookingId,
        payload: {
          customerName: booking.customer.name,
          completedAt: now.toISOString(),
          portalUrl: `${process.env.APP_URL}/my-booking/${booking.customerToken}`,
          locale: booking.customer.locale,
        },
      })

      // SMS completion (bilingual)
      await smsQueue.add('job-completed-sms', {
        to: booking.customer.phone,
        message: t(booking.customer.locale, 'jobCompleted', { email: booking.customer.email }),
        bookingId,
      })

      // Schedule review request (48 hours)
      await discordQueue.add(
        'review-request',
        { type: 'review-request-48h', bookingId },
        { delay: 48 * 60 * 60 * 1000 }
      )

      await prisma.auditLog.create({
        data: { action: 'JOB_COMPLETED', bookingId, details: { by: username } },
      })

      return NextResponse.json({
        type: 4,
        data: { content: `✅ Job **${booking.displayId}** COMPLETED by ${username}. Receipt + review request queued.` },
      })
    }

    // ── ARCHIVE JOB ──────────────────────────────────────────────
    case 'archive_job': {
      if (!staffUser || !['OWNER', 'MANAGER'].includes(staffUser.role)) {
        return NextResponse.json({
          type: 4,
          data: { content: '❌ Permission denied.', flags: 64 },
        })
      }

      await prisma.booking.update({
        where: { id: bookingId },
        data: { status: 'ARCHIVED' },
      })

      await prisma.auditLog.create({
        data: { action: 'BOOKING_STATE_CHANGED', userId: staffUser?.id, bookingId, details: { to: 'ARCHIVED', by: username } },
      })

      return NextResponse.json({
        type: 4,
        data: { content: `🗃️ Booking **${booking.displayId}** archived by ${username}.` },
      })
    }

    default:
      return NextResponse.json({ type: 1 })
  }
}
