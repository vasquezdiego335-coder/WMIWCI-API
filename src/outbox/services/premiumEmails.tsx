import { render } from '@react-email/render'
import { prisma } from '../../lib/db'
import { emailSubject } from '../../lib/i18n'
import PreApprovalEmail from '../../emails/pre-approval'
import FinalConfirmationEmail from '../../emails/final-confirmation'

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
  locale: string
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
  const amountHold = opts.amountPaid
    ? String(Math.round(Number(opts.amountPaid)))
    : b
    ? String(Math.round(b.depositAmount / 100))
    : '49'

  const html = render(
    PreApprovalEmail({
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
    })
  )

  return { to, subject: emailSubject('pre-approval', locale), html, locale }
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
  const amountPaid = opts.amountPaid
    ? String(Math.round(Number(opts.amountPaid)))
    : b
    ? String(Math.round(b.depositAmount / 100))
    : '49'

  const html = render(
    FinalConfirmationEmail({
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
    })
  )

  return { to, subject: emailSubject('final-confirmation', locale), html, locale }
}
