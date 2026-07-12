import { Fragment } from 'react'
import { prisma } from '@/lib/db'
import { notFound } from 'next/navigation'
import { CopyReference } from './CopyReference'
import { accessSections } from '@/lib/booking-access'
import { waitingMinutesBetween, WAITING_GRACE_MINUTES, WAITING_POLICY } from '@/lib/waiting-time'

export const revalidate = 0

// ════════════════════════════════════════════════════════════════════════════
//  BOOKING SUBMITTED / PAYMENT SUCCESSFUL — the page a customer lands on after
//  Stripe checkout completes.
//
//  TRUST / VERIFICATION NOTE (why this page is safe to show as "successful"):
//  We NEVER decide success from a URL query param (?success=true). Stripe
//  redirects to GET /api/stripe/checkout/success, which retrieves the Checkout
//  Session from Stripe server-side, confirms session.status === 'complete', and
//  only THEN flips the booking to PENDING_APPROVAL (see src/lib/fulfillment.ts)
//  before redirecting here. This page renders purely from that server-verified
//  DB state — so a "Payment successful" badge always reflects a real, Stripe-
//  confirmed authorization, never a spoofable query string.
//
//  PAYMENT MODEL: the $49 is a manual-capture Stripe AUTHORIZATION — held, not
//  charged, until an admin approves (then captured; released in full if denied).
//  Copy reflects the REAL state: "received" while authorized, "paid" only once
//  the hold is actually captured — it never claims money that hasn't moved, and
//  never uses the word "hold" once captured.
//
//  DATA SAFETY: we render ONLY from `CustomerBookingView`, a hand-mapped, sanitized
//  projection of the booking (see buildCustomerView). Internal blob lines
//  (Source:, 📷 photo counts, ⚠ MANUAL REVIEW, service-area notes, Stripe/PI ids)
//  are dropped — never surfaced to the customer.
//
//  MOTION: all animation is CSS-only, one-shot (no infinite loops except the very
//  faint ambient background drift), driven by transforms/opacity, and disabled
//  under prefers-reduced-motion. The only client component is the copy button.
// ════════════════════════════════════════════════════════════════════════════

const BIZ_PHONE = '(862) 640-0625'
const BIZ_TEL = '+18626400625'
const BIZ_EMAIL = 'hello@moveitclearit.com'

// ── Owner-provided trust facts ──────────────────────────────────────────────
// Edit these to match your live values; unset fields simply don't render.
// IMPORTANT: googleRating / googleReviewCount / verifiedProfile are CUSTOMER-
// FACING claims — keep them true to your real Google Business Profile. Leave
// googleReviewCount '' until you have a real number (there's no live API here).
const TRUST = {
  googleRating: '5.0',
  googleReviewCount: '', // e.g. '120+' to show a count; '' hides it
  verifiedProfile: true,
  confirmationWindow: '2–24 hours',
  homeCity: 'West Orange, NJ',
  counties: ['Essex', 'Morris', 'Union', 'Bergen', 'Passaic'],
}

// ── Customer-safe projection ────────────────────────────────────────────────
type ViewStatus =
  | 'awaiting_payment' // DRAFT / PENDING_PAYMENT — no verified payment yet
  | 'under_review' // PENDING_APPROVAL — paid + awaiting crew confirmation (the hero state)
  | 'confirmed' // CONFIRMED
  | 'scheduled' // SCHEDULED
  | 'in_progress' // IN_PROGRESS
  | 'completed' // COMPLETED / ARCHIVED
  | 'cancelled' // CANCELLED

type PaymentStatus =
  | 'captured' // hold captured — genuinely paid
  | 'received' // authorized/held (normal post-checkout state)
  | 'awaiting' // no verified payment yet
  | 'released' // authorization cancelled — customer not charged

type CustomerBookingView = {
  reference: string
  customerFirstName: string
  status: ViewStatus
  paymentStatus: PaymentStatus
  bookingFee: number // dollars
  requestedDate: string | null // formatted, human
  requestedTime: string | null
  dateConfirmed: boolean
  serviceType: string | null
  origin: string | null
  destination: string | null
  truckType: string | null
  accessDetails: string[]
  extraStops: string | null
  feeNote: string | null
  notes: string | null // customer's own words, capped — never internal notes
  estimate: string | null // "$X" move estimate (labor), advisory
  estimateTotal: number | null // raw dollars for the payment breakdown
  travelFeeNote: string | null // clean move-day travel line, or null
  photoCount: number
  receiptUrl: string | null
  // Live waiting state (Late Arrival & Delay Policy). 'none' hides the banner.
  waitingState: 'none' | 'waiting' | 'billable'
  waitingMessage: string | null
}

const STATUS_MAP: Record<string, ViewStatus> = {
  DRAFT: 'awaiting_payment',
  PENDING_PAYMENT: 'awaiting_payment',
  PENDING_APPROVAL: 'under_review',
  CONFIRMED: 'confirmed',
  SCHEDULED: 'scheduled',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  ARCHIVED: 'completed',
  CANCELLED: 'cancelled',
}

function fmtDate(d: Date): string {
  return new Date(d).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York',
  })
}
function fmtTime(d: Date): string {
  return new Date(d).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })
}
function money(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`
}
function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
function pushUniq(arr: string[], v: string): void {
  if (!arr.includes(v)) arr.push(v)
}

// Parse the itemsDescription newline blob into ONLY customer-safe, structured
// fields. Everything not explicitly whitelisted below is dropped — that includes
// the internal `Source:`, `📷 N job photo(s)`, `⚠ … MANUAL REVIEW REQUIRED`,
// `Service area: …`, `Customer-side estimate:`, and `Extended service-area fee:`
// lines, so no internal note or ops instruction can ever leak to the customer.
type ParsedItems = {
  service: string | null
  truck: string | null
  access: string[]
  feeNote: string | null
  notes: string | null
  extraStops: string | null
}
function parseItems(desc?: string | null): ParsedItems {
  const out: ParsedItems = { service: null, truck: null, access: [], feeNote: null, notes: null, extraStops: null }
  if (!desc) return out
  for (const raw of desc.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (/^Truck add-on/i.test(line)) continue // internal $ note; truck shown cleanly elsewhere
    else if (/^Service:/i.test(line)) out.service = line.replace(/^Service:\s*/i, '').trim() || null
    else if (/^Truck:/i.test(line)) out.truck = line.replace(/^Truck:\s*/i, '').trim() || null
    else if (/^Stairs:/i.test(line)) pushUniq(out.access, 'Stairs to carry')
    else if (/^Long walk:/i.test(line)) pushUniq(out.access, 'Long carry to the truck')
    else if (/^Heavy items:/i.test(line)) pushUniq(out.access, 'Heavy or specialty items')
    // Structured access lines (elevator/parking/building) carry an already-human
    // label from buildDescription — surface the label itself as an access note.
    else if (/^Elevator:/i.test(line)) { const t = line.replace(/^Elevator:\s*/i, '').trim(); if (t) pushUniq(out.access, t) }
    else if (/^Parking:/i.test(line)) { const t = line.replace(/^Parking:\s*/i, '').trim(); if (t) pushUniq(out.access, t) }
    else if (/^Building:/i.test(line)) { const t = line.replace(/^Building:\s*/i, '').trim(); if (t) pushUniq(out.access, t) }
    else if (/^Note:/i.test(line)) out.feeNote = line.replace(/^Note:\s*/i, '').trim() || null
    else if (/^Notes:/i.test(line)) {
      const body = line.replace(/^Notes:\s*/i, '').trim()
      // only keep if it reads like real prose (has a space) — hides code-like blobs
      if (body && /\s/.test(body)) out.notes = body.length > 360 ? `${body.slice(0, 360).trim()}…` : body
    } else if (/^Additional pickup/i.test(line)) {
      out.extraStops = line.replace(/^Additional pickup\(s\):\s*/i, '').trim() || null
    }
    // any other line (Source:, 📷, ⚠ Service area …, Service area:, Extended
    // service-area fee:, Customer-side estimate:, etc.) is intentionally NOT
    // captured — dropped as internal.
  }
  return out
}

type BookingRecord = NonNullable<Awaited<ReturnType<typeof loadBooking>>>

function buildCustomerView(booking: BookingRecord): CustomerBookingView {
  const items = parseItems(booking.itemsDescription)

  const rawFirst = (booking.customer.name?.split(' ')[0] || 'there').trim()
  const firstName = cap(rawFirst)
  const reference = `MIC-${booking.displayId.replace(/[^a-z0-9]/gi, '').slice(-6).toUpperCase()}`

  const status: ViewStatus = STATUS_MAP[booking.status] ?? 'under_review'

  const captured = booking.depositPaid || booking.payments.some((p) => p.status === 'COMPLETED')
  const paymentStatus: PaymentStatus =
    status === 'cancelled' ? 'released'
      : captured ? 'captured'
        : status === 'awaiting_payment' ? 'awaiting'
          : 'received'

  // Confirmed date wins over requested; fall back to requested for the review state.
  const confirmedStart = booking.scheduledStart ?? booking.confirmedDate ?? null
  const dateConfirmed = !!confirmedStart
  const dateSource = confirmedStart ?? booking.requestedDate ?? null
  const requestedDate = dateSource ? fmtDate(dateSource) : null
  const requestedTime = booking.scheduledStart
    ? `${fmtTime(booking.scheduledStart)}${booking.scheduledEnd ? ` – ${fmtTime(booking.scheduledEnd)}` : ''}`
    : booking.requestedDate ? `Around ${fmtTime(booking.requestedDate)}` : null

  const origin = cleanAddr(booking.originAddress)
  const destination = cleanAddr(booking.destAddress)

  // Non-sensitive structured access (unit/floor/elevator/stairs/notes, truck,
  // equipment/crew) — NEVER the gate codes (includeSensitive:false). Location
  // lines are tagged so pickup vs drop-off stays clear in the flat summary list.
  const structuredAccess: string[] = []
  for (const sec of accessSections(booking, { includeSensitive: false })) {
    const loc = /Pickup/i.test(sec.title) ? 'Pickup' : /Drop-off/i.test(sec.title) ? 'Drop-off' : null
    for (const line of sec.lines) structuredAccess.push(loc ? `${loc} — ${line}` : line)
  }

  const estimateTotal = booking.totalEstimate != null && booking.totalEstimate > 0
    ? Math.round(booking.totalEstimate)
    : null
  const estimate = estimateTotal != null ? money(estimateTotal) : null

  // Travel fee: clean, from the structured column only. Pending (manual-review)
  // bookings show no number — never the internal "do not confirm" instruction.
  const travelFeeNote = booking.travelFeeDueOnMoveDay && booking.travelFee > 0 && !booking.manualReviewRequired
    ? `${money(booking.travelFee / 100)} travel fee — due on move day`
    : null

  // Live waiting banner (Late Arrival & Delay Policy). Keyed off the crew's
  // "Waiting Started" tap; once waiting ends or the customer is ready, it clears.
  let waitingState: CustomerBookingView['waitingState'] = 'none'
  let waitingMessage: string | null = null
  const waitingResolved = !!(booking.waitingEndedAt || booking.customerReadyAt)
  if (!waitingResolved && booking.waitingStartedAt) {
    const elapsed = waitingMinutesBetween(booking.waitingStartedAt, null)
    if (elapsed > WAITING_GRACE_MINUTES) {
      waitingState = 'billable'
      waitingMessage = WAITING_POLICY.portalBillableStarted
    } else {
      waitingState = 'waiting'
      waitingMessage = WAITING_POLICY.portalWaitingStarted
    }
  }

  return {
    reference,
    customerFirstName: firstName,
    status,
    paymentStatus,
    bookingFee: (booking.depositAmount ?? 4900) / 100,
    requestedDate,
    requestedTime,
    dateConfirmed,
    serviceType: items.service,
    origin,
    destination,
    truckType: items.truck,
    accessDetails: [...items.access, ...structuredAccess],
    extraStops: items.extraStops,
    feeNote: items.feeNote,
    notes: items.notes,
    estimate,
    estimateTotal,
    travelFeeNote,
    photoCount: booking.files.length,
    receiptUrl: booking.receipt?.cloudinaryUrl ?? null,
    waitingState,
    waitingMessage,
  }
}

// Addresses default to the "Provided at confirmation" placeholder at booking time;
// keep real values, soften the placeholder, and never render an empty string.
function cleanAddr(v?: string | null): string | null {
  const s = (v ?? '').trim()
  if (!s) return null
  if (/^provided at confirmation$/i.test(s)) return 'Confirmed with your crew'
  return s
}

// ── Per-status hero / review copy ───────────────────────────────────────────
type Tone = 'success' | 'confirmed' | 'progress' | 'neutral' | 'stop'
type HeroConfig = {
  eyebrow: string
  title: string
  lede: (v: CustomerBookingView) => string
  reviewTitle: string
  reviewBody: string
  tone: Tone
  showPaidChip: boolean
}

function heroConfig(v: CustomerBookingView): HeroConfig {
  switch (v.status) {
    case 'under_review':
      return {
        eyebrow: 'Booking submitted',
        title: 'Booking Submitted Successfully',
        lede: (b) => `Hi, ${b.customerFirstName}. Your booking request and $${b.bookingFee.toFixed(0)} booking fee were received.`,
        reviewTitle: 'Under review',
        reviewBody:
          'Our team is reviewing your requested date, route, inventory, and crew requirements. Your move is officially submitted — the requested time and final details are confirmed once you receive our confirmation email or text.',
        tone: 'success',
        showPaidChip: true,
      }
    case 'confirmed':
    case 'scheduled':
      return {
        eyebrow: 'Booking confirmed',
        title: v.dateConfirmed ? 'Your Move Is Confirmed' : 'Booking Confirmed',
        lede: (b) => `Hi, ${b.customerFirstName}. Your crew is locked in${b.requestedDate ? ` for ${b.requestedDate}` : ''}.`,
        reviewTitle: 'Confirmed & scheduled',
        reviewBody:
          'Your date is set and your crew is assigned. We’ll call the day before to confirm your arrival window — nothing more is needed from you until then.',
        tone: 'confirmed',
        showPaidChip: true,
      }
    case 'in_progress':
      return {
        eyebrow: 'Move day',
        title: 'Your Crew Is On It',
        lede: (b) => `Hi, ${b.customerFirstName}. Your crew is on-site working your move right now.`,
        reviewTitle: 'In progress',
        reviewBody: 'Your movers are on the job. If anything comes up on-site, tell your crew lead or call us any time.',
        tone: 'progress',
        showPaidChip: true,
      }
    case 'completed':
      return {
        eyebrow: 'All done',
        title: 'Move Complete — Thank You',
        lede: (b) => `Hi, ${b.customerFirstName}. Your move is done. It was a pleasure moving with you.`,
        reviewTitle: 'Completed',
        reviewBody: 'Everything’s wrapped up. A quick review means the world to our small crew — and we’re one call away whenever you need us again.',
        tone: 'confirmed',
        showPaidChip: true,
      }
    case 'cancelled':
      return {
        eyebrow: 'Booking cancelled',
        title: 'This Booking Was Cancelled',
        lede: (b) => `Hi, ${b.customerFirstName}. This booking is cancelled and any $${b.bookingFee.toFixed(0)} hold has been released — you were not charged.`,
        reviewTitle: 'Cancelled',
        reviewBody: 'Nothing further is owed. Call or text us any time to rebook — we’d love to help with your move.',
        tone: 'stop',
        showPaidChip: false,
      }
    default: // awaiting_payment — SAFE fallback (never a false success, never "resume checkout")
      return {
        eyebrow: 'Almost there',
        title: 'We’re Confirming Your Payment',
        lede: (b) => `Hi, ${b.customerFirstName}. Hang tight — we’re confirming your booking fee.`,
        reviewTitle: 'One moment',
        reviewBody:
          'This page updates automatically as soon as your payment is confirmed. If it doesn’t update in a few minutes, call or text us and we’ll sort it out right away.',
        tone: 'neutral',
        showPaidChip: false,
      }
  }
}

// Connected progress tracker. One-shot; wording never implies the move is fully
// confirmed while it is still under review.
type StepState = 'done' | 'active' | 'upcoming'
function trackerSteps(v: CustomerBookingView): { label: string; state: StepState }[] {
  const paid = v.paymentStatus === 'received' || v.paymentStatus === 'captured'
  const payLabel = v.paymentStatus === 'released' ? '$49 hold released' : '$49 payment received'

  let thirdLabel = 'Crew review in progress'
  let thirdState: StepState = 'upcoming'
  switch (v.status) {
    case 'under_review':
      thirdState = 'active'; break
    case 'confirmed': case 'scheduled': case 'in_progress': case 'completed':
      thirdLabel = 'Crew confirmed'; thirdState = 'done'; break
    case 'cancelled':
      thirdLabel = 'Booking cancelled'; thirdState = 'upcoming'; break
    default:
      thirdLabel = 'Crew review'; thirdState = 'upcoming'
  }

  return [
    { label: 'Booking submitted', state: 'done' },
    { label: payLabel, state: paid ? 'done' : 'upcoming' },
    { label: thirdLabel, state: thirdState },
  ]
}

// What-happens-next steps, status-aware.
function nextSteps(v: CustomerBookingView): { t: string; b: string }[] {
  switch (v.status) {
    case 'under_review':
      return [
        { t: 'We review your booking details', b: 'Your requested date, route, and inventory get a real set of eyes.' },
        { t: 'We verify crew availability and travel', b: 'We check the calendar and line up the right movers for your job.' },
        { t: 'We send your final confirmation', b: 'You’ll get confirmation by text and email — usually within 24 hours.' },
        { t: 'Move day', b: 'Our crew arrives on time, ready to load, carefully wrap, and move everything.' },
      ]
    case 'confirmed':
    case 'scheduled':
      return [
        { t: 'Your date is locked in', b: 'See it up top. We’ll call the day before with your arrival window.' },
        { t: 'Get your space ready', b: 'Clear a path, reserve parking, and finish packing before your crew arrives.' },
        { t: 'Have your balance ready', b: 'Card or cash — collected on move day once the job’s done and you’re happy.' },
        { t: 'Move day', b: 'Our crew arrives on time, ready to load, carefully wrap, and move everything.' },
      ]
    case 'in_progress':
      return [
        { t: 'Your crew is on the job', b: 'If anything comes up on-site, tell your crew lead or call us.' },
        { t: 'Payment on completion', b: 'Your balance is collected once everything’s moved and you’re satisfied.' },
      ]
    case 'completed':
      return [
        { t: 'Thanks for moving with us', b: 'A quick review is the best way to support our small crew.' },
        { t: 'Need more cleared out?', b: 'We also haul and clear junk, garages, and estates — call us any time.' },
      ]
    case 'cancelled':
      return [
        { t: 'Nothing is owed', b: 'Any $49 hold was released in full — your card was never charged.' },
        { t: 'Rebook whenever you’re ready', b: 'Call or text and a real person will get you back on the calendar.' },
      ]
    default:
      return [
        { t: 'Sit tight', b: 'This page refreshes on its own as soon as your payment clears.' },
        { t: 'Need a hand?', b: 'Call or text us and we’ll confirm your booking right away.' },
      ]
  }
}

// ── Data ────────────────────────────────────────────────────────────────────
async function loadBooking(token: string) {
  return prisma.booking.findFirst({
    where: { customerToken: token, customerTokenExpiry: { gte: new Date() } },
    include: {
      customer: { select: { name: true } },
      payments: { select: { status: true } },
      files: { select: { id: true } },
      receipt: { select: { cloudinaryUrl: true } },
    },
  })
}

export default async function BookingStatusPage({ params }: { params: { token: string } }) {
  const booking = await loadBooking(params.token)
  if (!booking) notFound()

  const v = buildCustomerView(booking)
  const hero = heroConfig(v)
  const steps = nextSteps(v)
  const track = trackerSteps(v)

  const isReviewing = v.status === 'under_review'
  const paid = v.paymentStatus === 'received' || v.paymentStatus === 'captured'
  const remaining = v.estimateTotal != null ? Math.max(0, v.estimateTotal - v.bookingFee) : null
  const payHeadline = v.paymentStatus === 'captured' ? 'Payment successful'
    : v.paymentStatus === 'received' ? 'Payment successful'
      : v.paymentStatus === 'released' ? 'Hold released'
        : 'Confirming your payment'
  const receivedLabel = v.paymentStatus === 'captured' ? 'Paid today' : 'Received today'

  const hasMoveDetails = !!(
    v.requestedDate || v.serviceType || v.origin || v.destination || v.truckType ||
    v.accessDetails.length || v.notes || v.estimate || v.travelFeeNote || v.extraStops
  )

  return (
    <div className={`bk-root bk-tone-${hero.tone}`}>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />

      {/* Ambient background — one very faint drifting layer (reduced-motion: static) */}
      <div className="bk-bg" aria-hidden="true">
        <span className="bk-bg__glow bk-bg__glow--a" />
        <span className="bk-bg__glow bk-bg__glow--b" />
      </div>

      {/* 1 — Branded header with the real logo lockup */}
      <header className="bk-header">
        <div className="bk-header__inner bk-anim-down">
          <div className="bk-logo">
            <span className="bk-logo__mark">
              <img src="/icon.svg" alt="" width={40} height={40} />
            </span>
            <span className="bk-logo__word">WE MOVE IT.<br />WE CLEAR IT.</span>
          </div>
          <a className="bk-header__phone" href={`tel:${BIZ_TEL}`}>
            <IconPhone size={15} /> <span className="bk-header__phonetext">{BIZ_PHONE}</span>
          </a>
        </div>
      </header>

      <main className="bk-wrap">
        {/* 2 — Success hero */}
        <section className="bk-hero">
          <RouteBackdrop />
          <SuccessMark tone={hero.tone} />
          <p className="bk-hero__eyebrow bk-anim-up" style={anim(0.34)}>{hero.eyebrow}</p>
          <h1 className="bk-hero__title bk-anim-up" style={anim(0.42)}>{hero.title}</h1>
          <p className="bk-hero__lede bk-anim-up" style={anim(0.5)}>{hero.lede(v)}</p>

          {/* Live waiting-time banner (Late Arrival & Delay Policy) */}
          {v.waitingState !== 'none' && v.waitingMessage && (
            <div
              className="bk-anim-up"
              style={{
                ...anim(0.54),
                margin: '18px auto 0',
                maxWidth: '440px',
                display: 'flex',
                alignItems: 'flex-start',
                gap: '10px',
                textAlign: 'left',
                padding: '13px 16px',
                borderRadius: '14px',
                border: `1px solid ${v.waitingState === 'billable' ? '#FBD9C2' : '#E6DFcf'}`,
                background: v.waitingState === 'billable' ? '#FEF3EC' : '#FBF7EC',
                color: '#3A2E1E',
              }}
              role="status"
            >
              <span aria-hidden="true" style={{ fontSize: '18px', lineHeight: '22px' }}>
                {v.waitingState === 'billable' ? '⏱️' : '⏳'}
              </span>
              <span style={{ fontSize: '13.5px', lineHeight: '20px', fontWeight: 600 }}>{v.waitingMessage}</span>
            </div>
          )}

          {/* Connected progress tracker */}
          <div className="bk-track bk-anim-up" style={anim(0.6)} role="list" aria-label="Booking progress">
            {track.map((step, i) => (
              <Fragment key={i}>
                {i > 0 && (
                  <span className="bk-track__bar" aria-hidden="true">
                    <i className={step.state !== 'upcoming' ? 'bk-track__fill' : undefined} style={anim(0.75 + i * 0.28)} />
                  </span>
                )}
                <div className={`bk-track__item bk-track__item--${step.state}`} role="listitem">
                  <span className="bk-track__node">
                    {step.state === 'done'
                      ? <IconCheck size={15} strokeWidth={2.9} />
                      : step.state === 'active'
                        ? <span className="bk-track__pip" />
                        : <span className="bk-track__num">{i + 1}</span>}
                  </span>
                  <span className="bk-track__label">{step.label}</span>
                </div>
              </Fragment>
            ))}
          </div>

          {/* Estimated confirmation time — reduces uncertainty (review state only) */}
          {isReviewing && (
            <p className="bk-eta bk-anim-up" style={anim(0.64)}>
              <IconClock size={13} /> Estimated confirmation · <strong>usually within {TRUST.confirmationWindow}</strong>
            </p>
          )}

          <div className="bk-ref bk-anim-up" style={anim(0.68)}>
            <span className="bk-ref__label">Booking reference</span>
            <CopyReference reference={v.reference} />
            <span className="bk-ref__keep">Keep this reference for future questions about your move.</span>
          </div>
        </section>

        {/* Google trust strip */}
        <section className="bk-gtrust bk-anim-up" style={anim(0.5)} aria-label={`${TRUST.googleRating} out of 5 Google rating`}>
          <span className="bk-gtrust__g"><GoogleG size={24} /></span>
          <div className="bk-gtrust__body">
            <div className="bk-gtrust__top">
              <span className="bk-stars" aria-hidden="true">
                {[0, 1, 2, 3, 4].map((i) => <IconStar key={i} size={15} />)}
              </span>
              <span className="bk-gtrust__rating">{TRUST.googleRating} Google Rating{TRUST.googleReviewCount ? ` · ${TRUST.googleReviewCount} reviews` : ''}</span>
            </div>
            <p className="bk-gtrust__sub">
              {TRUST.verifiedProfile && <>Verified Google Business Profile<span className="bk-dot">·</span></>}
              Trusted by homeowners across New Jersey
            </p>
          </div>
        </section>

        {/* 3 — Review status */}
        <section className={`bk-review bk-anim-up${hero.tone === 'success' ? ' bk-review--search' : ''}`} style={anim(0.58)}>
          <span className="bk-review__ic">
            {hero.tone === 'confirmed' ? <IconCalendar size={20} /> : hero.tone === 'stop' ? <IconInfo size={20} /> : <IconSearch size={20} />}
          </span>
          <div>
            <p className="bk-review__k">{hero.reviewTitle}</p>
            <p className="bk-review__b">{hero.reviewBody}</p>
            {v.dateConfirmed && v.requestedDate && (
              <p className="bk-review__date"><IconCalendar size={15} /> {v.requestedDate}{v.requestedTime ? ` · ${v.requestedTime}` : ''}</p>
            )}
          </div>
        </section>

        {/* A real person is reviewing — reassurance (review state only) */}
        {isReviewing && (
          <>
            <section className="bk-card bk-anim-up" style={anim(0.62)}>
              <SectionHead icon={<IconUsers size={18} />} title="A real person is reviewing your booking" sub="Not an automated approval" />
              <div className="bk-checkgrid">
                {REVIEW_CHECKS.map((c, i) => (
                  <span className="bk-checkitem" key={i}><IconCheck size={14} strokeWidth={2.7} /> {c}</span>
                ))}
              </div>
              <div className="bk-callout">
                <span>This extra review helps us avoid scheduling mistakes and ensures everything is ready before move day.</span>
              </div>
            </section>

            <section className="bk-mini bk-anim-up" style={anim(0.66)}>
              <p className="bk-mini__q"><IconInfo size={15} /> Why isn’t my move confirmed instantly?</p>
              <p className="bk-mini__a">Every booking is manually reviewed so we can verify scheduling, travel, inventory, equipment, and crew availability before sending your final confirmation. This helps ensure a smooth move with no surprises.</p>
            </section>
          </>
        )}

        {/* 4 — Move details */}
        {hasMoveDetails && (
          <section className="bk-card bk-anim-up" style={anim(0.64)}>
            <SectionHead icon={<IconTruck size={18} />} title="Move details" sub="What we have on file" />
            <div className="bk-dl">
              {v.requestedDate && (
                <Row k={v.dateConfirmed ? 'Move date' : 'Requested date'} icon={<IconCalendar size={15} />}>
                  {v.requestedDate}
                  {v.requestedTime && <span className="bk-row__meta">{v.dateConfirmed ? 'Arrival' : 'Requested time'}: {v.requestedTime}</span>}
                </Row>
              )}
              {v.serviceType && <Row k="Service" icon={<IconSparkle size={15} />}>{v.serviceType}</Row>}
              {v.origin && <Row k="Pickup" icon={<IconPin size={15} />}>{v.origin}</Row>}
              {v.destination && <Row k="Dropoff" icon={<IconPin size={15} />}>{v.destination}</Row>}
              {v.extraStops && <Row k="Extra stops" icon={<IconPin size={15} />}>{v.extraStops}</Row>}
              {v.truckType && <Row k="Truck" icon={<IconTruck size={15} />}>{v.truckType}</Row>}
              {v.estimate && (
                <Row k="Estimated total" icon={<IconReceipt size={15} />}>
                  {v.estimate}
                  <span className="bk-row__meta">Labor estimate · balance due on move day</span>
                </Row>
              )}
              {v.travelFeeNote && <Row k="Travel" icon={<IconTruck size={15} />}>{v.travelFeeNote}</Row>}
            </div>

            {v.accessDetails.length > 0 && (
              <>
                <p className="bk-sublabel">Access notes</p>
                <div className="bk-tags">
                  {v.accessDetails.map((a, i) => <span className="bk-tag" key={i}>{a}</span>)}
                </div>
              </>
            )}
            {v.photoCount > 0 && (
              <p className="bk-note bk-note--soft"><IconCheck size={14} strokeWidth={2.6} /> {v.photoCount} photo{v.photoCount === 1 ? '' : 's'} attached for your crew</p>
            )}
            {v.notes && (
              <div className="bk-callout">
                <strong>What you told us</strong>
                <span>{v.notes}</span>
              </div>
            )}
            {v.feeNote && <p className="bk-note">{v.feeNote}</p>}
          </section>
        )}

        {/* 5 — Payment summary */}
        <section className="bk-card bk-anim-up" style={anim(0.7)}>
          <SectionHead icon={<IconReceipt size={18} />} iconClass="bk-ic-reveal" title="Payment" sub={`$${v.bookingFee.toFixed(0)} today · balance on move day`} />

          {paid ? (
            <>
              <div className="bk-payhead">
                <span className="bk-payhead__ic"><IconCheck size={18} strokeWidth={2.9} /></span>
                <div>
                  <p className="bk-payhead__t">{payHeadline}</p>
                  <p className="bk-payhead__s">{receivedLabel} · {money(v.bookingFee)} secured</p>
                </div>
              </div>
              <p className="bk-payreassure">Your booking fee has secured your reservation while our scheduling team prepares your move.</p>
              <dl className="bk-paybreak">
                {v.estimateTotal != null && (
                  <div className="bk-payline">
                    <dt className="bk-payline__k">Estimated move total</dt>
                    <dd className="bk-payline__v">{money(v.estimateTotal)}</dd>
                  </div>
                )}
                <div className="bk-payline bk-payline--accent">
                  <dt className="bk-payline__k">{receivedLabel}</dt>
                  <dd className="bk-payline__v">{money(v.bookingFee)}</dd>
                </div>
                {remaining != null && (
                  <div className="bk-payline">
                    <dt className="bk-payline__k">Remaining balance</dt>
                    <dd className="bk-payline__v">{money(remaining)}</dd>
                  </div>
                )}
                <div className="bk-paydue">Due on move day, after your crew is confirmed</div>
              </dl>
              <p className="bk-note">
                {v.paymentStatus === 'captured'
                  ? 'Your booking fee is paid and applied to your move total — nothing hidden.'
                  : 'Your booking fee is secured and applied to your move total once we confirm your crew.'}
              </p>
            </>
          ) : (
            <div className="bk-pay">
              <span className="bk-pay__ic"><IconClock size={18} /></span>
              <div className="bk-pay__body">
                <p className="bk-payhead__t">{payHeadline}</p>
                <p className="bk-pay__note">
                  {v.paymentStatus === 'released'
                    ? 'The authorization on your card was released in full. You were not charged.'
                    : 'We’re confirming your booking fee. This updates automatically — reach out if it doesn’t clear in a few minutes.'}
                </p>
              </div>
            </div>
          )}

          {v.receiptUrl && (
            <a className="bk-btn bk-btn--ghost" href={v.receiptUrl} target="_blank" rel="noreferrer">
              <IconReceipt size={16} /> View payment receipt
            </a>
          )}
        </section>

        {/* 6 — What happens next */}
        <section className="bk-card bk-anim-up" style={anim(0.76)}>
          <SectionHead icon={<IconArrow size={18} />} iconClass="bk-arrow" title="What happens next" sub="No action needed from you" />
          <ol className="bk-steps">
            {steps.map((s, i) => (
              <li className="bk-step" key={i}>
                <span className="bk-step__n">{i + 1}</span>
                <div>
                  <p className="bk-step__t">{s.t}</p>
                  <p className="bk-step__b">{s.b}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        {/* Why customers choose us */}
        <section className="bk-card bk-anim-up" style={anim(0.6)}>
          <SectionHead icon={<IconHeart size={18} />} title="Why customers choose us" sub="What you get with Move It Clear It" />
          <div className="bk-features">
            {WHY_CHOOSE.map((f, i) => (
              <div className="bk-feature" key={i}>
                <span className="bk-feature__ic">{f.icon}</span>
                <span className="bk-feature__t">{f.label}</span>
              </div>
            ))}
          </div>
        </section>

        {/* Our promise */}
        <section className="bk-card bk-anim-up" style={anim(0.66)}>
          <SectionHead icon={<IconShield size={18} />} title="Our promise" sub="What we commit to on every job" />
          <ul className="bk-promise">
            {PROMISE.map((p, i) => (
              <li key={i}><span className="bk-promise__ic"><IconCheck size={14} strokeWidth={2.8} /></span> {p}</li>
            ))}
          </ul>
        </section>

        {/* Local credibility */}
        <section className="bk-local bk-anim-up" style={anim(0.72)}>
          <span className="bk-local__ic"><IconPin size={18} /></span>
          <div>
            <p className="bk-local__k">Proudly based in {TRUST.homeCity}</p>
            <p className="bk-local__b">Serving {TRUST.counties.join(', ')} County — and all of New Jersey.</p>
          </div>
        </section>

        {/* 7 — Contact */}
        <section className="bk-contactcard bk-anim-up" style={anim(0.82)}>
          <p className="bk-contactcard__k">Need to change something?</p>
          <p className="bk-contactcard__b">Reschedules, additions, or questions — a real person answers 7 days a week.</p>
          <div className="bk-contactcard__actions">
            <a className="bk-btn bk-btn--primary" href={`tel:${BIZ_TEL}`}><IconPhone size={17} /> Call {BIZ_PHONE}</a>
            <a className="bk-btn bk-btn--ghost" href={`sms:${BIZ_TEL}`}><IconChat size={16} /> Text us</a>
            <a className="bk-btn bk-btn--ghost" href={`mailto:${BIZ_EMAIL}`}><IconMail size={16} /> Email</a>
          </div>
        </section>

        {/* Footer trust strip */}
        <section className="bk-ftrust bk-anim-up" style={anim(0.6)}>
          <span className="bk-ftrust__item"><GoogleG size={15} /> {TRUST.googleRating} Google Rated</span>
          <span className="bk-ftrust__d" />
          <span className="bk-ftrust__item">Serving New Jersey</span>
          <span className="bk-ftrust__d" />
          <span className="bk-ftrust__item">Real local team</span>
          <span className="bk-ftrust__d" />
          <span className="bk-ftrust__item">Fast response</span>
        </section>

        {/* Thank-you note */}
        <section className="bk-thanks">
          <p className="bk-thanks__t">Thank you for trusting Move It Clear It.</p>
          <p className="bk-thanks__b">We’re excited to help make your move as smooth and stress-free as possible.</p>
        </section>

        {/* 8 — Minimal brand footer (the layout adds the legal/copyright strip below) */}
        <section className="bk-brandfoot">
          <span className="bk-brandfoot__name">We Move It. We Clear It.</span>
          <span>Labor-only moving across New Jersey · Based in West Orange, NJ</span>
        </section>
      </main>
    </div>
  )
}

// Inline animation-delay helper — keeps the staggered entrance in one place.
function anim(delaySeconds: number): React.CSSProperties {
  return { animationDelay: `${delaySeconds}s` }
}

// ── Animated brand success mark (CSS-only, one-shot) ─────────────────────────
// Orange disc scales in → orange ring expands out → white check draws → a soft
// orange glow fades + a faint success ripple. Decorative: the visible hero title
// carries the meaning.
function SuccessMark({ tone }: { tone: Tone }) {
  if (tone === 'neutral' || tone === 'stop') {
    return (
      <span className="bk-mark bk-mark--muted" aria-hidden="true">
        {tone === 'stop' ? <IconInfo size={30} /> : <IconClock size={28} />}
      </span>
    )
  }
  return (
    <span className="bk-mark bk-mark--success" aria-hidden="true">
      <span className="bk-mark__ripple" />
      <svg viewBox="0 0 100 100" width="80" height="80">
        <circle className="bk-mark__ring" cx="50" cy="50" r="46" fill="none" stroke="var(--orange)" strokeWidth="3" />
        <circle className="bk-mark__disc" cx="50" cy="50" r="42" fill="var(--orange)" />
        <path className="bk-mark__check" d="M31 51 L44 64 L69 37" fill="none" stroke="#fff" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  )
}

// Faint decorative route line that draws once behind the hero.
function RouteBackdrop() {
  return (
    <svg className="bk-hero__bg" viewBox="0 0 620 300" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <path className="bk-hero__route" d="M34 258 C 170 200, 250 150, 388 148 S 556 116, 590 54" fill="none" stroke="var(--orange)" strokeWidth="2.5" strokeLinecap="round" />
      <circle className="bk-hero__pt bk-hero__pt--a" cx="34" cy="258" r="5" fill="var(--orange)" />
      <circle className="bk-hero__pt bk-hero__pt--b" cx="590" cy="54" r="5" fill="var(--orange)" />
    </svg>
  )
}

// ── Small presentational helpers ─────────────────────────────────────────────
function SectionHead({ icon, title, sub, iconClass }: { icon: React.ReactNode; title: string; sub?: string; iconClass?: string }) {
  return (
    <div className="bk-sechead">
      <span className={`bk-sechead__ic${iconClass ? ` ${iconClass}` : ''}`}>{icon}</span>
      <div>
        <h2 className="bk-sechead__t">{title}</h2>
        {sub && <span className="bk-sechead__s">{sub}</span>}
      </div>
    </div>
  )
}

function Row({ k, icon, children }: { k: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="bk-row">
      <span className="bk-row__k">{icon} {k}</span>
      <span className="bk-row__v">{children}</span>
    </div>
  )
}

// ── Inline icons (self-contained; stroke inherits currentColor) ──────────────
type IconProps = { size?: number; strokeWidth?: number }
function Svg({ size = 18, strokeWidth = 1.75, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  )
}
const IconCheck = (p: IconProps) => <Svg {...p}><path d="M20 6 9 17l-5-5" /></Svg>
const IconPhone = (p: IconProps) => <Svg {...p}><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3-8.6A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.3 1.8.6 2.6a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.5-1.2a2 2 0 0 1 2.1-.5c.8.3 1.7.5 2.6.6a2 2 0 0 1 1.7 2Z" /></Svg>
const IconChat = (p: IconProps) => <Svg {...p}><path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.5 8.6 8.6 0 0 1-3.8-.9L3 21l1.9-5.7a8.6 8.6 0 0 1-.9-3.8A8.4 8.4 0 0 1 12.5 3 8.4 8.4 0 0 1 21 11.5Z" /></Svg>
const IconMail = (p: IconProps) => <Svg {...p}><rect x="2" y="4" width="20" height="16" rx="2" /><path d="m22 7-10 6L2 7" /></Svg>
const IconPin = (p: IconProps) => <Svg {...p}><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" /><circle cx="12" cy="10" r="3" /></Svg>
const IconTruck = (p: IconProps) => <Svg {...p}><path d="M10 17V5H2v12" /><path d="M14 9h4l4 4v4h-8" /><circle cx="7" cy="18" r="2" /><circle cx="17" cy="18" r="2" /></Svg>
const IconCalendar = (p: IconProps) => <Svg {...p}><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></Svg>
const IconReceipt = (p: IconProps) => <Svg {...p}><path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1Z" /><path d="M8 7h8M8 11h8M8 15h5" /></Svg>
const IconClock = (p: IconProps) => <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Svg>
const IconArrow = (p: IconProps) => <Svg {...p}><path d="M5 12h14M13 6l6 6-6 6" /></Svg>
const IconSearch = (p: IconProps) => <Svg {...p}><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></Svg>
const IconInfo = (p: IconProps) => <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 16v-4M12 8h.01" /></Svg>
const IconSparkle = (p: IconProps) => <Svg {...p}><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Z" /></Svg>
// Added premium icons for the trust / reassurance sections.
const IconUsers = (p: IconProps) => <Svg {...p}><circle cx="9" cy="8" r="3.2" /><path d="M2.8 20a6.2 6.2 0 0 1 12.4 0" /><path d="M16.5 5.3a3 3 0 0 1 0 5.4" /><path d="M18 14.2A5.6 5.6 0 0 1 21.5 20" /></Svg>
const IconTag = (p: IconProps) => <Svg {...p}><path d="M20.6 13.4 12.4 21.6a2 2 0 0 1-2.8 0L3 15V4h11l6.6 6.6a2 2 0 0 1 0 2.8Z" /><circle cx="7.5" cy="7.5" r="1.4" /></Svg>
const IconWrap = (p: IconProps) => <Svg {...p}><path d="M3 8.5 12 4l9 4.5v7L12 20l-9-4.5Z" /><path d="M3 8.5 12 13l9-4.5M12 13v7" /></Svg>
const IconBolt = (p: IconProps) => <Svg {...p}><path d="M13 2 4 14h6l-1 8 9-12h-6z" /></Svg>
const IconShield = (p: IconProps) => <Svg {...p}><path d="M12 2 4 5v6c0 5 3.4 8.3 8 11 4.6-2.7 8-6 8-11V5z" /><path d="m9 12 2 2 4-4" /></Svg>
const IconHeart = (p: IconProps) => <Svg {...p}><path d="M12 20s-7-4.5-9.5-9A4.8 4.8 0 0 1 12 6a4.8 4.8 0 0 1 9.5 5c-2.5 4.5-9.5 9-9.5 9Z" /></Svg>
// Filled gold review star.
const IconStar = ({ size = 15 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 2.2l2.9 6.05 6.6.78-4.9 4.55 1.32 6.52L12 17.9l-5.92 3.2 1.32-6.52-4.9-4.55 6.6-.78z" />
  </svg>
)
// Official multi-color Google "G".
function GoogleG({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#4285F4" d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z" />
      <path fill="#34A853" d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z" />
      <path fill="#FBBC05" d="M11.69 28.18C11.25 26.86 11 25.45 11 24s.25-2.86.69-4.18v-5.7H4.34C2.85 17.09 2 20.45 2 24s.85 6.91 2.34 9.88l7.35-5.7z" />
      <path fill="#EA4335" d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z" />
    </svg>
  )
}

// Static content for the added trust / reassurance sections. Defined AFTER the
// icon components above so the JSX in WHY_CHOOSE isn't evaluated before those
// consts initialize (avoids a temporal-dead-zone crash at module load).
const REVIEW_CHECKS = [
  'Crew availability', 'Route & travel time', 'Equipment requirements',
  'Inventory', 'Parking & building access', 'Requested arrival window',
]
const WHY_CHOOSE: { icon: React.ReactNode; label: string }[] = [
  { icon: <IconTag size={18} />, label: 'Upfront flat-rate labor' },
  { icon: <IconUsers size={18} />, label: 'Experienced professional crew' },
  { icon: <IconWrap size={18} />, label: 'Careful wrapping & handling' },
  { icon: <IconBolt size={18} />, label: 'Fast, real communication' },
  { icon: <IconPin size={18} />, label: 'Local, West Orange–based' },
  { icon: <IconTruck size={18} />, label: 'Serving all of New Jersey' },
]
const PROMISE = [
  'Flat-rate labor, quoted upfront',
  'No hidden fees — add-ons shown before you book',
  'Friendly, experienced movers',
  'Careful handling of your items',
  'Clear communication, start to finish',
]

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Archivo:wght@600;700;800&display=swap');

.bk-root{
  --navy:#0D1A2D; --navy-80:rgba(13,26,45,.80); --navy-60:rgba(13,26,45,.60);
  --navy-45:rgba(13,26,45,.45); --navy-14:rgba(13,26,45,.14); --navy-08:rgba(13,26,45,.08);
  --orange:#FF6A00; --orange-dk:#E85F00; --orange-lt:rgba(255,106,0,.10); --orange-16:rgba(255,106,0,.16);
  --bone:#F7F7F2; --bone-dk:#EFEEE7; --gold:#D4A24C; --white:#fff; --ok:#16A34A; --ok-dk:#15803d; --ok-lt:rgba(22,163,74,.12);
  --radius:16px; --shadow:0 1px 2px rgba(13,26,45,.04),0 8px 24px rgba(13,26,45,.06);
  --shadow-hover:0 2px 4px rgba(13,26,45,.05),0 16px 36px rgba(13,26,45,.11);
  --accent:var(--orange); --accent-lt:var(--orange-lt);
  position:relative;
  font-family:'Inter',system-ui,-apple-system,'Segoe UI',sans-serif;
  color:var(--navy); background:var(--bone); min-height:100vh; -webkit-font-smoothing:antialiased;
}
.bk-tone-neutral,.bk-tone-stop{--accent:var(--navy);--accent-lt:var(--navy-08);}
.bk-root *{box-sizing:border-box;}
.bk-root img,.bk-root svg{display:block;max-width:100%;}
.bk-root a{color:inherit;text-decoration:none;}

/* Ambient background (one very faint drifting layer) */
.bk-bg{position:fixed;inset:0;z-index:0;overflow:hidden;pointer-events:none;}
.bk-bg__glow{position:absolute;border-radius:50%;filter:blur(64px);}
.bk-bg__glow--a{width:520px;height:520px;background:var(--orange);opacity:.05;top:-140px;left:-150px;animation:bk-drift-a 44s ease-in-out infinite alternate;}
.bk-bg__glow--b{width:600px;height:600px;background:var(--navy);opacity:.04;bottom:-200px;right:-170px;animation:bk-drift-b 54s ease-in-out infinite alternate;}
@keyframes bk-drift-a{to{transform:translate(60px,46px) scale(1.1);}}
@keyframes bk-drift-b{to{transform:translate(-52px,-40px) scale(1.08);}}
.bk-header,.bk-wrap{position:relative;z-index:1;}

/* Entrance keyframes (transform + opacity only) */
@keyframes bk-up{from{opacity:0;transform:translateY(11px);}to{opacity:1;transform:translateY(0);}}
@keyframes bk-down{from{opacity:0;transform:translateY(-9px);}to{opacity:1;transform:translateY(0);}}
.bk-anim-up{animation:bk-up .55s cubic-bezier(.22,1,.36,1) both;}
.bk-anim-down{animation:bk-down .55s cubic-bezier(.22,1,.36,1) both;}

/* Header + logo lockup */
.bk-header{background:var(--navy);}
.bk-header__inner{max-width:620px;margin:0 auto;padding:14px 18px;display:flex;align-items:center;justify-content:space-between;gap:12px;}
.bk-logo{display:flex;align-items:center;gap:12px;}
.bk-logo__mark{width:44px;height:44px;border-radius:11px;overflow:hidden;flex-shrink:0;box-shadow:0 3px 12px rgba(0,0,0,.32);}
.bk-logo__mark img{width:100%;height:100%;}
.bk-logo__word{color:#fff;font-family:'Archivo',system-ui,sans-serif;font-weight:800;font-size:13px;letter-spacing:.055em;line-height:1.18;}
.bk-header__phone{color:#CBD5E1;font-size:13px;font-weight:600;display:inline-flex;gap:6px;align-items:center;white-space:nowrap;transition:color .16s;}
.bk-header__phone:hover{color:#fff;}

.bk-wrap{max-width:620px;margin:0 auto;padding:0 18px 40px;}

/* Hero */
.bk-hero{position:relative;overflow:hidden;text-align:center;padding:38px 8px 8px;}
.bk-hero > *{position:relative;z-index:1;}
.bk-hero__bg{position:absolute;inset:0;width:100%;height:100%;z-index:0;pointer-events:none;}
.bk-hero__route{stroke-opacity:.10;stroke-dasharray:760;stroke-dashoffset:760;animation:bk-draw 1.6s ease .3s both;}
@keyframes bk-draw{to{stroke-dashoffset:0;}}
.bk-hero__pt{opacity:0;animation:bk-ptin .45s ease both;}
.bk-hero__pt--a{animation-delay:.3s;}
.bk-hero__pt--b{animation-delay:1.75s;}
@keyframes bk-ptin{to{opacity:.18;}}

/* Animated success mark */
.bk-mark{width:80px;height:80px;display:inline-flex;align-items:center;justify-content:center;margin-bottom:20px;border-radius:50%;}
.bk-mark--muted{width:70px;height:70px;background:var(--navy);color:#fff;box-shadow:0 10px 26px rgba(13,26,45,.22);animation:bk-up .5s cubic-bezier(.22,1,.36,1) .15s both;}
.bk-mark--success{position:relative;animation:bk-glow 1s ease-out .95s both;}
.bk-mark__ripple{position:absolute;top:0;left:0;right:0;bottom:0;margin:auto;width:80px;height:80px;border-radius:50%;border:2px solid var(--orange);opacity:0;animation:bk-ripple .9s ease-out .6s both;}
@keyframes bk-ripple{0%{transform:scale(.9);opacity:.4;}100%{transform:scale(1.6);opacity:0;}}
.bk-mark__disc{transform-box:fill-box;transform-origin:center;transform:scale(.75);opacity:0;animation:bk-disc .45s cubic-bezier(.22,1,.36,1) .15s both;}
.bk-mark__ring{transform-box:fill-box;transform-origin:center;opacity:0;animation:bk-ring .7s ease-out .32s both;}
.bk-mark__check{stroke-dasharray:60;stroke-dashoffset:60;animation:bk-check .42s cubic-bezier(.65,0,.35,1) .52s both;}
@keyframes bk-disc{0%{transform:scale(.75);opacity:0;}60%{opacity:1;}100%{transform:scale(1);opacity:1;}}
@keyframes bk-ring{0%{transform:scale(.78);opacity:.5;}100%{transform:scale(1.35);opacity:0;}}
@keyframes bk-check{to{stroke-dashoffset:0;}}
@keyframes bk-glow{0%{box-shadow:0 0 0 0 rgba(255,106,0,0);}35%{box-shadow:0 0 0 13px var(--orange-16);}100%{box-shadow:0 0 0 22px rgba(255,106,0,0);}}

.bk-hero__eyebrow{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--accent);margin:0 0 8px;}
.bk-tone-neutral .bk-hero__eyebrow,.bk-tone-stop .bk-hero__eyebrow{color:var(--navy-45);}
.bk-hero__title{font-family:'Archivo',system-ui,sans-serif;font-size:29px;font-weight:800;letter-spacing:-.02em;line-height:1.12;margin:0 0 12px;color:var(--navy);text-wrap:balance;}
.bk-hero__lede{font-size:15.5px;line-height:1.55;color:var(--navy-60);margin:0 auto;max-width:440px;}

/* Progress tracker */
.bk-track{margin:26px auto 0;display:flex;align-items:flex-start;justify-content:center;max-width:100%;}
.bk-track__item{display:flex;flex-direction:column;align-items:center;gap:9px;flex:0 0 auto;width:96px;text-align:center;}
.bk-track__node{width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;border:2px solid var(--navy-14);background:var(--white);color:var(--navy-45);flex-shrink:0;}
.bk-track__num{font-size:13px;font-weight:800;font-family:'Archivo',sans-serif;}
.bk-track__pip{width:9px;height:9px;border-radius:50%;background:currentColor;}
.bk-track__label{font-size:11.5px;font-weight:700;color:var(--navy-60);line-height:1.3;}
.bk-track__item--done .bk-track__node{background:var(--ok);border-color:var(--ok);color:#fff;}
.bk-track__item--active .bk-track__node{background:var(--orange);border-color:var(--orange);color:#fff;animation:bk-pip 1.6s ease-out 1.25s 1 both;}
.bk-track__item--active .bk-track__label{color:var(--orange-dk);}
@keyframes bk-pip{0%{box-shadow:0 0 0 0 var(--orange-16);}45%{box-shadow:0 0 0 9px rgba(255,106,0,0);}100%{box-shadow:0 0 0 0 rgba(255,106,0,0);}}
.bk-track__bar{flex:1 1 auto;height:2.5px;background:var(--navy-14);margin-top:16px;border-radius:3px;position:relative;min-width:16px;max-width:56px;overflow:hidden;}
.bk-track__fill{position:absolute;inset:0;background:var(--ok);border-radius:3px;transform:scaleX(0);transform-origin:left;animation:bk-fill .5s ease both;}
@keyframes bk-fill{to{transform:scaleX(1);}}

/* Estimated confirmation chip */
.bk-eta{margin:16px auto 0;display:inline-flex;align-items:center;gap:7px;font-size:12.5px;color:var(--navy-60);background:var(--white);border:1px solid var(--navy-08);border-radius:100px;padding:7px 14px;box-shadow:var(--shadow);}
.bk-eta svg{color:var(--orange);flex-shrink:0;}
.bk-eta strong{color:var(--navy);}

/* Copyable booking reference */
.bk-ref{margin-top:22px;display:flex;flex-direction:column;align-items:center;gap:8px;}
.bk-ref__label{font-size:12px;color:var(--navy-45);font-weight:600;}
.bk-ref__btn{display:inline-flex;align-items:center;gap:9px;background:var(--bone-dk);border:1px solid var(--navy-08);border-radius:100px;padding:7px 8px 7px 15px;cursor:pointer;font-family:inherit;transition:border-color .15s,background .15s,transform .12s;}
.bk-ref__btn:hover{border-color:var(--navy-14);}
.bk-ref__btn:active{transform:scale(.98);}
.bk-ref__btn:focus-visible{outline:2px solid var(--orange);outline-offset:2px;}
.bk-ref__btn.is-copied{border-color:rgba(22,163,74,.4);background:var(--ok-lt);}
.bk-ref__code{font-family:'Archivo',ui-monospace,monospace;font-weight:800;letter-spacing:.06em;font-size:14px;color:var(--navy);}
.bk-ref__ic{display:inline-flex;color:var(--navy-45);}
.bk-ref__btn.is-copied .bk-ref__ic{color:var(--ok);}
.bk-ref__hint{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--navy-45);background:var(--white);border-radius:100px;padding:3px 9px;transition:color .15s;}
.bk-ref__btn.is-copied .bk-ref__hint{color:var(--ok-dk);}
.bk-ref__keep{font-size:11.5px;color:var(--navy-45);margin-top:2px;}

/* Google trust strip */
.bk-gtrust{margin-top:16px;display:flex;align-items:center;gap:14px;background:var(--white);border:1px solid var(--navy-08);border-radius:14px;box-shadow:var(--shadow);padding:14px 18px;}
.bk-gtrust__g{width:40px;height:40px;border-radius:10px;background:var(--bone);border:1px solid var(--navy-08);display:flex;align-items:center;justify-content:center;flex-shrink:0;}
.bk-gtrust__body{min-width:0;}
.bk-gtrust__top{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
.bk-stars{display:inline-flex;gap:2px;color:var(--gold);}
.bk-gtrust__rating{font-size:14px;font-weight:800;color:var(--navy);font-family:'Archivo',sans-serif;}
.bk-gtrust__sub{font-size:12px;color:var(--navy-60);margin:4px 0 0;line-height:1.45;}
.bk-dot{margin:0 6px;color:var(--navy-14);}

/* Review card */
.bk-review{margin-top:16px;background:var(--white);border:1px solid var(--navy-08);border-radius:var(--radius);box-shadow:var(--shadow);padding:20px 22px;display:flex;gap:15px;align-items:flex-start;position:relative;overflow:hidden;}
.bk-review::before{content:'';position:absolute;left:0;top:0;bottom:0;width:5px;background:var(--accent);}
.bk-review__ic{width:42px;height:42px;border-radius:11px;background:var(--accent-lt);color:var(--accent);display:flex;align-items:center;justify-content:center;flex-shrink:0;}
.bk-tone-neutral .bk-review__ic,.bk-tone-stop .bk-review__ic{color:var(--navy);}
.bk-review--search .bk-review__ic svg{animation:bk-nudge 1.2s ease 1s 1 both;}
@keyframes bk-nudge{0%,100%{transform:translate(0,0);}35%{transform:translate(1.5px,-1.5px);}}
.bk-review__k{font-family:'Archivo',system-ui,sans-serif;font-size:16px;font-weight:700;margin:0 0 5px;color:var(--navy);}
.bk-review__b{font-size:14px;line-height:1.6;color:var(--navy-60);margin:0;}
.bk-review__date{display:inline-flex;align-items:center;gap:7px;margin:12px 0 0;font-size:13px;font-weight:700;color:var(--navy);background:var(--bone);border-radius:9px;padding:8px 12px;}
.bk-review__date svg{color:var(--accent);}

/* Cards */
.bk-card{margin-top:16px;background:var(--white);border:1px solid var(--navy-08);border-radius:var(--radius);box-shadow:var(--shadow);padding:22px;}

.bk-sechead{display:flex;align-items:center;gap:12px;margin:0 0 16px;}
.bk-sechead__ic{width:34px;height:34px;border-radius:10px;background:var(--orange-lt);color:var(--orange);display:flex;align-items:center;justify-content:center;flex-shrink:0;}
.bk-ic-reveal svg{animation:bk-reveal .5s ease .95s both;}
@keyframes bk-reveal{from{opacity:0;transform:translateY(6px);}to{opacity:1;transform:translateY(0);}}
.bk-arrow{transition:transform .2s;}
.bk-sechead__t{font-family:'Archivo',system-ui,sans-serif;font-size:16.5px;font-weight:700;letter-spacing:-.01em;margin:0;line-height:1.15;}
.bk-sechead__s{display:block;font-size:12.5px;color:var(--navy-60);margin-top:2px;}

.bk-dl{display:flex;flex-direction:column;}
.bk-row{display:flex;justify-content:space-between;gap:16px;padding:12px 0;border-bottom:1px solid var(--navy-08);}
.bk-row:first-child{padding-top:0;}
.bk-row:last-child{border-bottom:0;padding-bottom:0;}
.bk-row__k{font-size:13px;color:var(--navy-60);display:flex;align-items:center;gap:8px;flex-shrink:0;}
.bk-row__k svg{color:var(--navy-45);flex-shrink:0;}
.bk-row__v{font-size:13.5px;font-weight:600;text-align:right;color:var(--navy);line-height:1.45;}
.bk-row__meta{display:block;font-size:11.5px;font-weight:500;color:var(--navy-45);margin-top:3px;}

.bk-sublabel{font-size:11.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--navy-45);margin:18px 0 10px;}
.bk-tags{display:flex;flex-wrap:wrap;gap:8px;}
.bk-tag{display:inline-flex;align-items:center;background:var(--bone);border:1px solid var(--navy-08);border-radius:100px;padding:6px 13px;font-size:12.5px;font-weight:600;color:var(--navy-80);}

.bk-callout{margin-top:16px;background:var(--bone);border:1px solid var(--navy-08);border-left:3px solid var(--gold);border-radius:10px;padding:13px 15px;font-size:13.5px;color:var(--navy-80);line-height:1.6;display:flex;flex-direction:column;gap:3px;}
.bk-callout strong{color:var(--navy);font-size:11.5px;text-transform:uppercase;letter-spacing:.05em;}

.bk-note{font-size:12.5px;color:var(--navy-60);line-height:1.55;margin:14px 0 0;}
.bk-note--soft{display:flex;align-items:center;gap:7px;font-weight:600;color:var(--navy-80);}
.bk-note--soft svg{color:var(--ok);flex-shrink:0;}

/* Real-person review checklist */
.bk-checkgrid{display:grid;grid-template-columns:1fr 1fr;gap:10px 16px;}
.bk-checkitem{display:flex;align-items:center;gap:9px;font-size:13px;font-weight:600;color:var(--navy-80);line-height:1.35;}
.bk-checkitem svg{color:var(--ok);flex-shrink:0;}

/* "Why isn't it instant" mini card */
.bk-mini{margin-top:16px;background:var(--bone);border:1px solid var(--navy-08);border-radius:14px;padding:16px 18px;}
.bk-mini__q{display:flex;align-items:center;gap:8px;font-weight:700;font-size:13.5px;color:var(--navy);margin:0 0 6px;}
.bk-mini__q svg{color:var(--orange);flex-shrink:0;}
.bk-mini__a{font-size:12.5px;color:var(--navy-60);line-height:1.6;margin:0;}

/* Payment */
.bk-payhead{display:flex;gap:14px;align-items:center;background:var(--ok-lt);border:1px solid rgba(22,163,74,.32);border-radius:14px;padding:15px 17px;}
.bk-payhead__ic{width:38px;height:38px;border-radius:11px;background:var(--ok);color:#fff;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
.bk-payhead__t{font-size:15px;font-weight:800;color:var(--ok-dk);margin:0;font-family:'Archivo',sans-serif;}
.bk-payhead__s{font-size:12.5px;color:var(--navy-60);margin:3px 0 0;}
.bk-payreassure{font-size:13px;color:var(--navy-80);line-height:1.55;margin:14px 0 0;font-weight:500;}
.bk-paybreak{margin:14px 0 0;border:1px solid var(--navy-08);border-radius:12px;overflow:hidden;}
.bk-payline{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 15px;font-size:13.5px;border-bottom:1px solid var(--navy-08);margin:0;}
.bk-payline__k{color:var(--navy-60);margin:0;}
.bk-payline__v{font-weight:800;color:var(--navy);font-variant-numeric:tabular-nums;margin:0;font-family:'Archivo',sans-serif;}
.bk-payline--accent{background:var(--orange-lt);border-left:3px solid var(--orange);}
.bk-payline--accent .bk-payline__k{color:var(--orange-dk);font-weight:700;}
.bk-payline--accent .bk-payline__v{color:var(--orange-dk);}
.bk-paydue{padding:11px 15px;background:var(--bone);font-size:12px;color:var(--navy-60);text-align:center;}

.bk-pay{display:flex;gap:15px;align-items:flex-start;background:var(--bone);border:1px solid var(--navy-08);border-radius:14px;padding:18px;}
.bk-pay__ic{width:40px;height:40px;border-radius:11px;background:var(--navy);color:#fff;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
.bk-pay__body{flex:1;min-width:0;}
.bk-pay__note{font-size:12.5px;color:var(--navy-60);line-height:1.55;margin:5px 0 0;}

.bk-steps{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:15px;}
.bk-step{display:flex;gap:14px;}
.bk-step__n{width:28px;height:28px;border-radius:50%;background:var(--orange);color:#fff;font-weight:800;font-size:13px;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-family:'Archivo',sans-serif;}
.bk-step__t{font-weight:700;font-size:14.5px;margin:2px 0 3px;color:var(--navy);}
.bk-step__b{font-size:13px;color:var(--navy-60);margin:0;line-height:1.55;}

/* Why-choose feature grid */
.bk-features{display:grid;grid-template-columns:1fr 1fr;gap:12px;}
.bk-feature{display:flex;align-items:center;gap:11px;background:var(--bone);border:1px solid var(--navy-08);border-radius:12px;padding:12px 13px;}
.bk-feature__ic{width:34px;height:34px;border-radius:9px;background:var(--orange-lt);color:var(--orange);display:flex;align-items:center;justify-content:center;flex-shrink:0;}
.bk-feature__t{font-size:12.5px;font-weight:700;color:var(--navy);line-height:1.3;}

/* Our promise */
.bk-promise{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:12px;}
.bk-promise li{display:flex;align-items:center;gap:11px;font-size:13.5px;font-weight:600;color:var(--navy-80);}
.bk-promise__ic{width:24px;height:24px;border-radius:7px;background:var(--ok-lt);color:var(--ok);display:flex;align-items:center;justify-content:center;flex-shrink:0;}

/* Local credibility */
.bk-local{margin-top:16px;display:flex;gap:14px;align-items:center;background:var(--navy);border-radius:var(--radius);padding:18px 22px;color:#fff;}
.bk-local__ic{width:40px;height:40px;border-radius:11px;background:rgba(255,255,255,.10);color:var(--orange);display:flex;align-items:center;justify-content:center;flex-shrink:0;}
.bk-local__k{font-family:'Archivo',system-ui,sans-serif;font-size:15px;font-weight:800;margin:0;}
.bk-local__b{font-size:12.5px;color:#9fb0cc;margin:4px 0 0;line-height:1.45;}

/* Buttons */
.bk-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;font-weight:700;font-size:14px;border-radius:12px;padding:13px 18px;min-height:46px;cursor:pointer;border:1px solid transparent;transition:transform .16s,background .18s,box-shadow .18s,border-color .18s;line-height:1;font-family:inherit;margin-top:14px;}
.bk-btn--primary{background:var(--orange);color:#fff;box-shadow:0 4px 16px rgba(255,106,0,.30);}
.bk-btn--primary:hover{background:var(--orange-dk);}
.bk-btn--ghost{background:var(--white);color:var(--navy);border-color:var(--navy-14);}
.bk-btn--ghost:hover{border-color:var(--navy);background:var(--bone);}

/* Contact */
.bk-contactcard{margin-top:16px;background:var(--navy);border-radius:var(--radius);padding:26px 24px;text-align:center;position:relative;overflow:hidden;}
.bk-contactcard::before{content:'';position:absolute;top:0;left:50%;transform:translateX(-50%);width:58px;height:3px;background:var(--gold);border-radius:0 0 4px 4px;}
.bk-contactcard__k{font-family:'Archivo',system-ui,sans-serif;color:#fff;font-size:19px;font-weight:800;margin:4px 0 7px;}
.bk-contactcard__b{color:#9fb0cc;font-size:13.5px;line-height:1.55;margin:0 auto 16px;max-width:380px;}
.bk-contactcard__actions{display:flex;flex-wrap:wrap;gap:10px;justify-content:center;}
.bk-contactcard .bk-btn{margin-top:0;}
.bk-contactcard .bk-btn--ghost{background:rgba(255,255,255,.08);color:#fff;border-color:rgba(255,255,255,.26);}
.bk-contactcard .bk-btn--ghost:hover{background:rgba(255,255,255,.16);}

/* Footer trust strip */
.bk-ftrust{margin-top:20px;display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:8px 12px;padding:6px 4px;}
.bk-ftrust__item{display:inline-flex;align-items:center;gap:7px;font-size:12px;font-weight:700;color:var(--navy-60);}
.bk-ftrust__d{width:4px;height:4px;border-radius:50%;background:var(--navy-14);}

/* Thank-you note */
.bk-thanks{text-align:center;padding:22px 12px 4px;}
.bk-thanks__t{font-family:'Archivo',system-ui,sans-serif;font-size:16px;font-weight:800;color:var(--navy);margin:0 0 5px;}
.bk-thanks__b{font-size:13px;color:var(--navy-60);margin:0;line-height:1.55;max-width:400px;margin:0 auto;}

.bk-brandfoot{text-align:center;padding:26px 18px 8px;color:var(--navy-45);font-size:12.5px;line-height:1.7;display:flex;flex-direction:column;gap:2px;}
.bk-brandfoot__name{font-family:'Archivo',system-ui,sans-serif;font-weight:800;font-size:14px;color:var(--navy-80);letter-spacing:.01em;}

/* Desktop hover polish (fine pointers only) */
@media (hover:hover) and (pointer:fine){
  .bk-card,.bk-review,.bk-contactcard,.bk-gtrust,.bk-local,.bk-mini{transition:transform .2s cubic-bezier(.22,1,.36,1),box-shadow .2s;}
  .bk-card:hover,.bk-review:hover,.bk-gtrust:hover,.bk-mini:hover{transform:translateY(-2px);box-shadow:var(--shadow-hover);}
  .bk-contactcard:hover,.bk-local:hover{transform:translateY(-2px);}
  .bk-feature{transition:transform .18s,border-color .18s;}
  .bk-feature:hover{transform:translateY(-1px);border-color:var(--orange);}
  .bk-btn:hover{transform:translateY(-1px);}
  .bk-btn--primary:hover{box-shadow:0 6px 22px rgba(255,106,0,.42);}
  .bk-card:hover .bk-arrow{transform:translateX(2px);}
}

/* Mobile */
@media (max-width:520px){
  .bk-logo__word{display:none;}
  .bk-hero{padding-top:30px;}
  .bk-hero__title{font-size:24px;}
  .bk-card,.bk-review{padding:18px;}
  .bk-contactcard__actions{flex-direction:column;}
  .bk-contactcard .bk-btn{width:100%;}
  .bk-row{gap:12px;}
  .bk-track__item{width:80px;}
  .bk-track__label{font-size:10.5px;}
  .bk-checkgrid,.bk-features{grid-template-columns:1fr;}
}
@media (max-width:360px){
  .bk-track__item{width:66px;}
  .bk-header__phonetext{display:none;}
}

/* Reduced motion: snap everything to its final resting state */
@media (prefers-reduced-motion: reduce){
  .bk-root *,.bk-root *::before,.bk-root *::after{
    animation-duration:.01ms !important;
    animation-iteration-count:1 !important;
    transition-duration:.01ms !important;
  }
  .bk-hero__route{stroke-dashoffset:0 !important;}
  .bk-mark__check{stroke-dashoffset:0 !important;}
  .bk-mark__disc{transform:none !important;opacity:1 !important;}
  .bk-mark__ripple{display:none !important;}
  .bk-track__fill{transform:scaleX(1) !important;}
  .bk-bg__glow{animation:none !important;}
}

@media print{
  .bk-header__phone,.bk-btn,.bk-ref__hint,.bk-bg{display:none !important;}
  .bk-root{background:#fff;}
  .bk-card,.bk-review,.bk-contactcard,.bk-gtrust,.bk-local{box-shadow:none;break-inside:avoid;}
}
`
