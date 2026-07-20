import * as React from 'react'
import { render } from '@react-email/render'
import { prisma } from '../../lib/db'
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

/** Shared booking → template-props mapping (customer-safe fields only). */
async function loadBooking(bookingId: string) {
  return prisma.booking.findUnique({
    where: { id: bookingId },
    include: { customer: true },
  })
}

/** PAYMENT_COMPLETED → the premium "we've received your request" email. */
export async function renderPreApproval(
  bookingId: string,
  opts: { amountPaid?: string } & Fallback = {}
): Promise<RenderedEmail> {
  const b = await loadBooking(bookingId)
  const locale = b?.customer.locale ?? opts.locale ?? 'en'
  const to = b?.customer.email ?? opts.customerEmail ?? ''
  const access = b ? accessSummary(b) : {}
  // Cents preserved; NO '49' fallback (finding EMAIL-P2-17). Undefined when we
  // genuinely do not know the amount — the template renders a neutral phrase.
  const amountHold = dollarsFromInput(opts.amountPaid) ?? dollarsFromCents(b?.depositAmount)

  const payload: Record<string, unknown> = {
      customerName: b?.customer.name ?? opts.customerName,
      displayId: b?.displayId,
      requestedDate: (b?.requestedDate ?? (opts.requestedDate ? new Date(opts.requestedDate) : null))?.toISOString(),
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
  opts: { amountPaid?: string } & Fallback = {}
): Promise<RenderedEmail> {
  const b = await loadBooking(bookingId)
  const locale = b?.customer.locale ?? opts.locale ?? 'en'
  const to = b?.customer.email ?? opts.customerEmail ?? ''
  const access = b ? accessSummary(b) : {}
  const moveDate = b?.scheduledStart ?? b?.confirmedDate ?? b?.requestedDate ?? (opts.requestedDate ? new Date(opts.requestedDate) : null)
  // Cents preserved; NO '49' fallback (finding EMAIL-P2-17).
  const amountPaid = dollarsFromInput(opts.amountPaid) ?? dollarsFromCents(b?.depositAmount)

  const payload: Record<string, unknown> = {
      customerName: b?.customer.name ?? opts.customerName,
      displayId: b?.displayId,
      date: moveDate?.toISOString(),
      timeLabel: b?.arrivalWindow ?? undefined,
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
