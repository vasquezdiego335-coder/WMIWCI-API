import * as React from 'react'
import type { Prisma } from '@prisma/client'
import { render } from '@react-email/render'
import { prisma } from '../../lib/db'
import { readBookingWithMigrationFallback } from '../../lib/migration-window'
import { provenCapturedCents, PROOF_PAYMENT_SELECT, type ProofPayment } from '../domain/captured-amount'
import { emailSubject } from '../../lib/i18n'
import PreApprovalEmail from '../../emails/pre-approval'
import FinalConfirmationEmail from '../../emails/final-confirmation'
import BookingUpdatedEmail from '../../emails/booking-updated'
import OperationalAlertEmail from '../../emails/operational-alert'

// ════════════════════════════════════════════════════════════════════════
//  Premium email rendering for the outbox path.
//  ------------------------------------------------------------------------
//  The outbox previously sent bare inline HTML, so the finished React email
//  templates (pre-approval / final-confirmation, built on the shared _ui kit)
//  never reached a customer. This module is the bridge: given a bookingId, it
//  loads the booking + customer ONCE and maps them to the exact props those
//  templates expect, then renders brand-perfect HTML.
//
//  DESIGN NOTES
//   • Re-reads the booking at send time so the email always reflects current
//     state (address edits, travel-fee review, locale). The event payload is
//     used only as a fallback when the row can't be loaded.
//   • Customer-safe fields ONLY. internalNotes, access codes, dispatcher notes,
//     and owner pricing math are never mapped — customerNotes is the only free
//     text surfaced, matching what the booking summary already shows.
//   • Every enrichment field is optional; the templates render a row only when
//     its value is present, so a sparse booking still produces a clean email.
// ════════════════════════════════════════════════════════════════════════

export interface RenderedEmail {
  to: string
  subject: string
  html: string
  /** Plain-text alternative. REQUIRED (finding EMAIL-P1-05): the outbox used to
   *  send HTML only, hurting spam score and accessibility, while the queue path
   *  sent multipart. Both paths now produce both parts. */
  text: string
  /** The EXACT props used to render, so the send guard validates what shipped
   *  rather than a hand-built approximation (finding EMAIL-P1-05). */
  payload: Record<string, unknown>
  template: string
  locale: string
}

/** Render html + text from one props object, so they can never diverge. */
function renderBoth(el: React.ReactElement): { html: string; text: string } {
  return { html: render(el), text: render(el, { plainText: true }) }
}

/**
 * MONEY (finding EMAIL-P2-17).
 * `Math.round(cents / 100)` silently destroyed cents — $49.50 rendered as "$50",
 * and a missing amount fell back to the literal `'49'`, inventing a number from
 * a legacy default. Both are wrong in an email a customer treats as a receipt.
 *
 * Returns undefined when there is no real amount. The templates already render
 * a neutral phrase for undefined (see `money()` in _ui.tsx), and the required-
 * field gate blocks any template for which the amount is mandatory — so a
 * missing amount fails CLOSED instead of guessing.
 */
export function dollarsFromCents(cents?: number | null): string | undefined {
  if (cents == null || !Number.isFinite(cents)) return undefined
  return (cents / 100).toFixed(2)
}

/** Normalize an amount supplied as dollars (string) without losing cents. */
export function dollarsFromInput(value?: string | number | null): string | undefined {
  if (value == null || value === '') return undefined
  const n = Number(value)
  if (!Number.isFinite(n)) return undefined
  return n.toFixed(2)
}

/**
 * ITEM D2 — the LEDGER answer to "how much did we actually take?".
 *
 * The outbox is the live email path (EMAIL-REGISTRY.md), and its APPROVED event
 * carried no amount, so the confirmation renderer fell through to
 * `dollarsFromCents(b?.depositAmount)` — a booking column, i.e. what the booking
 * was SUPPOSED to be charged. Reproduced end to end with `depositAmount = 12345`:
 * "Your $123.45 deposit is applied to your move".
 *
 * A COMPLETED Payment row is the only proof this system has, and it is a strong
 * one: the approval path writes that row ONLY from a Stripe-reported amount and
 * refuses to write it at all when Stripe reports none. So the renderer asks the
 * ledger rather than the intention column, and prints nothing when the ledger is
 * silent — which is exactly the state `reconciliation.ts` reports as
 * `captured_no_payment_row` and the admin's "Retry payment record" repairs.
 *
 * Never throws: a failed read (including the code-before-SQL window) is "no
 * proven amount", which renders as no figure — never as a guess.
 */
// ITEM C1 (round 8) — this used to be a LOCAL copy of the column list that
// omitted `stripeChargeId`, so the Stripe-evidence half of the rule
// (`isStripePayment`) ran here with one of its two inputs permanently
// undefined. The rule and the columns it reads now travel together.
async function ledgerCapturedCents(bookingId: string, stripePaymentIntentId?: string | null): Promise<number | null> {
  try {
    const rows = (await prisma.payment.findMany({
      where: { bookingId },
      select: PROOF_PAYMENT_SELECT,
    })) as unknown as ProofPayment[]
    return provenCapturedCents(rows, { stripePaymentIntentId })
  } catch (err) {
    console.error(
      `[outbox/email] could not read the payment ledger for ${bookingId} — the email will name no amount:`,
      err instanceof Error ? err.message : err,
    )
    return null
  }
}

const APP_URL = (process.env.APP_URL ?? 'https://wmiwci-api.vercel.app').replace(/\/+$/, '')
const CONTACT = {
  phone: process.env.BUSINESS_PHONE ?? '862-640-0625',
  email: process.env.EMAIL_REPLY_ADDRESS ?? 'hello@moveitclearit.com',
  website: 'https://moveitclearit.com',
  websiteLabel: 'moveitclearit.com',
}

// First line of itemsDescription is "Service: <label>" (see scheduled.worker).
function serviceLabel(items?: string | null): string | undefined {
  const first = items?.split('\n')[0]?.replace(/^Service:\s*/i, '').trim()
  return first || undefined
}

function truckLabel(provider?: string | null, size?: string | null): string | undefined {
  if (!provider) return undefined
  return size ? `${provider} · ${size}` : provider
}

function accessSummary(b: {
  hasElevator: boolean
  originHasElevator: boolean | null
  destHasElevator: boolean | null
  originStairCount: number | null
  destStairCount: number | null
}): { stairs?: string; elevator?: string } {
  const stairs = [b.originStairCount, b.destStairCount].filter((n): n is number => n != null && n > 0)
  const hasElevator = b.hasElevator || b.originHasElevator || b.destHasElevator
  return {
    stairs: stairs.length ? `${stairs.join(' / ')} flights` : undefined,
    elevator: hasElevator ? 'Elevator available' : undefined,
  }
}

interface Fallback {
  customerEmail?: string
  customerName?: string
  requestedDate?: string | null
  locale?: string
}

const EMAIL_INCLUDE = { customer: true } as const
type EmailBooking = Prisma.BookingGetPayload<{ include: typeof EMAIL_INCLUDE }>

/** Shared booking → template-props mapping (customer-safe fields only).
 *
 *  ITEM P0-E — this was a bare `include:`, which asks Postgres for `$scalars`
 *  FROM THE GENERATED SCHEMA. Migrations are hand-applied, so during the normal
 *  code-before-SQL window it raised P2022 in EVERY renderer below. Under
 *  OUTBOX_ENABLED the worker caught that and called markJobFailed, which
 *  retries with exponential backoff up to 5 attempts — so a window longer than
 *  about a minute burned the attempts and the customer's first email went
 *  terminally 'failed', with the row's last_error as the only record.
 *
 *  The fallback names every column that certainly exists (see
 *  src/lib/migration-window.ts). The renderers already tolerate a null/partial
 *  booking (every field is `b?.`), so the degraded row costs at most the newest
 *  flags — `startTimeKnown`, whose absence `moveTimeLabel`/`moveTimeKnown`
 *  already handle by falling back to the 00:00 ET anchor shape. */
async function loadBooking(bookingId: string): Promise<EmailBooking | null> {
  const { row } = await readBookingWithMigrationFallback<EmailBooking>(
    (args) => prisma.booking.findUnique({ where: { id: bookingId }, ...(args as object) }),
    EMAIL_INCLUDE,
  )
  return row
}

/**
 * The `timeLabel` a move email should carry (item R2-1).
 *
 * MOVED in item R3-1 to `src/lib/booking-display.ts` — the pure module that now
 * owns the whole day-level display rule — so the reminder worker can reach it
 * without pulling the render layer in. Re-exported here because this is where
 * it was published and where its callers (and its tests) import it from.
 */
import { moveTimeLabel } from '../../lib/booking-display'
export { moveTimeLabel }

/** PAYMENT_COMPLETED → the premium "we've received your request" email. */
export async function renderPreApproval(
  bookingId: string,
  /** ITEM C1 (round 8) — `amountPaid` is nullable because the SENDER can now
   *  honestly not know it: `session.amount_total` is nullable in Stripe's API
   *  and `fulfillPaidCheckout` stopped substituting the house $49 for it. Null
   *  and undefined both mean "name no figure". */
  opts: { amountPaid?: string | null } & Fallback = {}
): Promise<RenderedEmail> {
  const b = await loadBooking(bookingId)
  const locale = b?.customer.locale ?? opts.locale ?? 'en'
  const to = b?.customer.email ?? opts.customerEmail ?? ''
  const access = b ? accessSummary(b) : {}
  // Cents preserved; NO '49' fallback (finding EMAIL-P2-17). Undefined when we
  // genuinely do not know the amount — the template renders a neutral phrase.
  //
  // ITEM D2 — and NO `depositAmount` fallback either. The authorization is
  // created for `BOOKING_FEE_CENTS` (src/lib/stripe.ts createBookingCheckout),
  // never for this column, so a booking whose `depositAmount` had drifted
  // printed a hold figure that was never authorized. The proven number is the
  // Stripe session total, which the PAYMENT_COMPLETED payload carries.
  const amountHold = dollarsFromInput(opts.amountPaid)

  const payload: Record<string, unknown> = {
      customerName: b?.customer.name ?? opts.customerName,
      displayId: b?.displayId,
      requestedDate: (b?.requestedDate ?? (opts.requestedDate ? new Date(opts.requestedDate) : null))?.toISOString(),
      // Item R3-1: NEITHER sender passed a timeLabel, so the template derived an
      // hour out of the 00:00 ET day anchor and the customer's very first email
      // said their move was at 12:00 AM. Both facts now travel: the honest
      // label, and the flag the template needs to suppress the hour by itself.
      timeLabel: moveTimeLabel(b, locale),
      startTimeKnown: b?.startTimeKnown ?? null,
      service: serviceLabel(b?.itemsDescription),
      estimate: b?.totalEstimate != null ? `$${Math.round(b.totalEstimate).toLocaleString('en-US')}` : undefined,
      truckLabel: truckLabel(b?.truckProvider, b?.truckSize),
      originAddress: b?.originAddress,
      destAddress: b?.destAddress,
      stairs: access.stairs,
      elevator: access.elevator,
      parking: b?.originAccessNotes ?? undefined,
      heavyItems: b?.specialtyItems ?? undefined,
      notes: b?.customerNotes ?? undefined,
      amountHold,
      portalUrl: b ? `${APP_URL}/my-booking/${b.customerToken}` : APP_URL,
      serviceAreaZone: b?.serviceAreaZone ?? undefined,
      travelFee: b?.travelFee ? b.travelFee / 100 : undefined,
      manualReviewRequired: b?.manualReviewRequired ?? undefined,
      locale,
      ...CONTACT,
  }

  const { html, text } = renderBoth(PreApprovalEmail(payload))
  return { to, subject: emailSubject('pre-approval', locale), html, text, payload, template: 'pre-approval', locale }
}

/** APPROVED → the premium "your booking is approved" email. */
export async function renderFinalConfirmation(
  bookingId: string,
  opts: { capturedAmountCents?: number | null } & Fallback = {}
): Promise<RenderedEmail> {
  const b = await loadBooking(bookingId)
  const locale = b?.customer.locale ?? opts.locale ?? 'en'
  const to = b?.customer.email ?? opts.customerEmail ?? ''
  const access = b ? accessSummary(b) : {}
  const moveDate = b?.scheduledStart ?? b?.confirmedDate ?? b?.requestedDate ?? (opts.requestedDate ? new Date(opts.requestedDate) : null)
  // ITEM D2 — the captured figure, or nothing. TWO sources, both proofs:
  //   1. `capturedAmountCents` on the APPROVED event — what Stripe reported to
  //      the approval that captured it (item M1's `capturedAmountFromIntent`);
  //   2. the COMPLETED Payment row, when the event carried none (every event
  //      written before this item, and every resend).
  // `booking.depositAmount` is NOT a source: it is what the booking was supposed
  // to be charged. Absent ⇒ the template omits the payment row and the deposit
  // sentence names no amount; the confirmation itself still goes out.
  const capturedCents = opts.capturedAmountCents ?? (await ledgerCapturedCents(bookingId, b?.stripePaymentIntentId))
  const amountPaid = dollarsFromCents(capturedCents)

  const payload: Record<string, unknown> = {
      customerName: b?.customer.name ?? opts.customerName,
      displayId: b?.displayId,
      date: moveDate?.toISOString(),
      timeLabel: moveTimeLabel(b, locale),
      service: serviceLabel(b?.itemsDescription),
      truckLabel: truckLabel(b?.truckProvider, b?.truckSize),
      estimate: b?.totalEstimate != null ? `$${Math.round(b.totalEstimate).toLocaleString('en-US')}` : undefined,
      amountPaid,
      originAddress: b?.originAddress,
      destAddress: b?.destAddress,
      stairs: access.stairs,
      elevator: access.elevator,
      parking: b?.originAccessNotes ?? undefined,
      heavyItems: b?.specialtyItems ?? undefined,
      notes: b?.customerNotes ?? undefined,
      portalUrl: b ? `${APP_URL}/my-booking/${b.customerToken}` : APP_URL,
      heroGifUrl: process.env.EMAIL_HERO_GIF_URL,
      serviceAreaZone: b?.serviceAreaZone ?? undefined,
      travelFee: b?.travelFee ? b.travelFee / 100 : undefined,
      manualReviewRequired: b?.manualReviewRequired ?? undefined,
      locale,
      ...CONTACT,
  }

  const { html, text } = renderBoth(FinalConfirmationEmail(payload))
  return {
    to,
    subject: emailSubject('final-confirmation', locale),
    html,
    text,
    payload,
    template: 'final-confirmation',
    locale,
  }
}

/** NEW_DATE_PICKED (reschedule confirmed) → the premium "booking updated" email. */
export async function renderBookingUpdated(
  bookingId: string,
  opts: { newDate?: string } & Fallback = {}
): Promise<RenderedEmail> {
  const b = await loadBooking(bookingId)
  const locale = b?.customer.locale ?? opts.locale ?? 'en'
  const to = b?.customer.email ?? opts.customerEmail ?? ''
  const moveDate = opts.newDate
    ? new Date(opts.newDate)
    : b?.scheduledStart ?? b?.confirmedDate ?? b?.requestedDate ?? null

  const payload: Record<string, unknown> = {
      customerName: b?.customer.name ?? opts.customerName,
      displayId: b?.displayId,
      changedLabel: locale.startsWith('es') ? 'la fecha' : 'date',
      date: moveDate?.toISOString(),
      // Item R2-1: `opts.newDate` is a real instant the customer picked, so it
      // keeps its hour. Falling back to the booking's own day anchor does not.
      timeLabel: moveTimeLabel(b, locale, !!opts.newDate),
      service: serviceLabel(b?.itemsDescription),
      originAddress: b?.originAddress,
      destAddress: b?.destAddress,
      portalUrl: b ? `${APP_URL}/my-booking/${b.customerToken}` : APP_URL,
      locale,
      ...CONTACT,
  }

  const { html, text } = renderBoth(BookingUpdatedEmail(payload))
  return { to, subject: emailSubject('booking-updated', locale), html, text, payload, template: 'booking-updated', locale }
}

/**
 * RESCHEDULE_REQUESTED → "pick a new date".
 *
 * SAFETY (finding EMAIL-P1-13): the previous implementation lived in
 * emailService.ts and built raw HTML by interpolating the customer's name, each
 * offered date, and the reschedule URL straight into a template string:
 *
 *     `<p>Hi ${p.customerName},</p> … <a href="${p.rescheduleUrl}">`
 *
 * Any HTML in a customer-supplied name was injected verbatim into the message,
 * and the URL was never checked — a `javascript:` or `data:` URL would have been
 * emitted as a live, clickable link. Customer names come from a public booking
 * form, so this was reachable input.
 *
 * Rendering through React escapes all text by construction, and returning the
 * payload means `rescheduleUrl` is validated by the send guard's URL-safety gate
 * (which rejects javascript:/data:/'#'/empty/non-https/preview domains) exactly
 * like every other action link.
 *
 * Offered dates are formatted here rather than trusted as pre-formatted strings,
 * so a malformed value renders as nothing instead of as markup.
 */
export async function renderRescheduleRequest(
  bookingId: string,
  opts: { offeredDates?: string[]; rescheduleUrl?: string } & Fallback = {}
): Promise<RenderedEmail> {
  const b = await loadBooking(bookingId)
  const locale = b?.customer.locale ?? opts.locale ?? 'en'
  const to = b?.customer.email ?? opts.customerEmail ?? ''
  const es = locale.toLowerCase().startsWith('es')

  // Format defensively: an unparseable entry is dropped, never echoed raw.
  const parsedDates = (opts.offeredDates ?? [])
    .map((d) => new Date(d))
    .filter((d) => !Number.isNaN(d.getTime()))
  const dates = parsedDates.map((d) =>
    d.toLocaleDateString(es ? 'es-US' : 'en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      timeZone: 'America/New_York',
    })
  )
  const firstIso = parsedDates[0]?.toISOString()

  const payload: Record<string, unknown> = {
    customerName: b?.customer.name ?? opts.customerName,
    displayId: b?.displayId,
    alertType: 'reschedule',
    // The dates go INSIDE `message` because that is a real prop on
    // operational-alert.tsx. Passing an `options` array would have been silently
    // dropped by React, shipping "pick one of these" with nothing listed.
    // `message` is rendered as text, so these strings are escaped by React.
    message: dates.length
      ? (es
          ? 'Esa fecha no estaba disponible. Estas fechas sí funcionan: '
          : "That date wasn't available. These dates work: ") + dates.join(' · ')
      : es
      ? 'Esa fecha no estaba disponible. Responde a este correo y encontramos otra.'
      : "That date wasn't available. Reply to this email and we'll find another one.",
    // Only offer the first alternative as a structured date when we have one.
    newDate: firstIso,
    // Validated by the send guard (any *Url key is URL-safety checked).
    portalUrl: opts.rescheduleUrl ?? (b ? `${APP_URL}/my-booking/${b.customerToken}` : undefined),
    locale,
    ...CONTACT,
  }

  const { html, text } = renderBoth(OperationalAlertEmail(payload))
  return {
    to,
    subject: es ? 'Elige una nueva fecha para tu mudanza' : 'Pick a new date for your move',
    html,
    text,
    payload,
    template: 'operational-alert',
    locale,
  }
}
