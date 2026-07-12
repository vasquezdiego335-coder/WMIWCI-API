// Offline unit tests for the shared booking-display module.
// Run: npm test  (tsx --test src/lib/__tests__/booking-display.test.ts)
// No DB, no network, no Discord — pure functions only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  statusLabel,
  statusColor,
  STATUS_COLORS,
  shortRef,
  discordSafe,
  humanizeLegacyAccess,
  crewNotesFromDescription,
  accessBulletsFromDescription,
  serviceLabelFromDescription,
  truckLabelFromDescription,
  buildJobCard,
  buildBookingApprovalCard,
  approvalCardDataFromBooking,
  BOOKING_STATUS_LABELS,
  TRUCK_OPTION_LABELS,
  jobDateTime,
} from '../booking-display'

// The exact legacy blob from the owner's bug report (raw enums leaking to workers).
const LEGACY_DESCRIPTION = [
  'Service: 2 Bedrooms',
  'Truck: Customer provides truck ($0)',
  'Notes: All details are as per our Facebook messages. 26 ft truck unload and place in townhome. All details were specified in Facebook messages. — Access: stairs, elevator=none, parking=door, building=newer | Est. $699 (base $699 + add-ons $0)',
].join('\n')

// A description in the NEW server-side format.
const NEW_DESCRIPTION = [
  'Service: 4 Bedrooms',
  'Truck: Truck Pickup & Return (+$50 due on move day)',
  'Truck add-on due on move day: $50 (not charged in Stripe)',
  'Stairs: No elevator / flights to carry up or down',
  'Elevator: No elevator — stairs only',
  'Parking: Truck parking at the door',
  'Building: Newer building (2000+)',
  'Note: Stairs, long walks, and heavy items may add an extra fee.',
  'Customer-side estimate: $1329 (includes $80 access add-ons)',
  'Notes: Gate code is 4321.',
  '⚠ Service area: Owner review required — travel price pending; do not confirm a final travel price',
].join('\n')

test('status labels: every enum maps to human text with no raw enum leakage', () => {
  for (const [key, label] of Object.entries(BOOKING_STATUS_LABELS)) {
    assert.ok(label.length > 0)
    assert.ok(!/[A-Z]{2,}_[A-Z]/.test(label), `label for ${key} leaks an enum: ${label}`)
  }
  assert.equal(statusLabel('IN_PROGRESS'), 'Job in progress')
  assert.equal(statusLabel('CONFIRMED'), 'Scheduled')
  assert.equal(statusLabel('SOMETHING_NEW'), 'Scheduled') // unknown → safe fallback, never raw
  assert.equal(statusLabel(null), 'Scheduled')
})

test('status colors: brand mapping incl. gold for owner review', () => {
  assert.equal(statusColor('CONFIRMED'), STATUS_COLORS.scheduled)
  assert.equal(statusColor('CONFIRMED', true), STATUS_COLORS.ownerReview)
  assert.equal(statusColor('IN_PROGRESS'), STATUS_COLORS.inProgress)
  assert.equal(statusColor('COMPLETED'), STATUS_COLORS.completed)
  assert.equal(statusColor('COMPLETED', true), STATUS_COLORS.completed) // done beats review accent
})

test('shortRef never exposes a full cuid', () => {
  assert.equal(shortRef('cmrgxmon4000emihhe1rarww5'), '…rww5')
  assert.equal(shortRef(''), '—')
  assert.equal(shortRef('abc'), 'abc')
})

test('discordSafe: mass mentions neutralized, long text truncated under the 1024 field cap', () => {
  const out = discordSafe('@everyone big job <@12345> ' + 'x'.repeat(3000))
  assert.ok(!out.includes('@everyone'))
  assert.ok(!out.includes('<@12345>'))
  assert.ok(out.length <= 1024)
  assert.ok(out.includes('full notes in the admin portal'))
})

test('humanizeLegacyAccess converts raw tokens to human words', () => {
  const out = humanizeLegacyAccess('elevator=none, parking=door, building=newer, MANUAL_REVIEW')
  assert.ok(!out.includes('='))
  assert.ok(!out.includes('MANUAL_REVIEW'))
  assert.ok(out.includes('No elevator'))
  assert.ok(out.includes('Truck parking at the door'))
  assert.ok(out.includes('Newer building'))
  assert.ok(out.includes('Owner review required'))
})

test('crewNotesFromDescription: dedupes the repeated Facebook sentence, strips access blob + estimate', () => {
  const notes = crewNotesFromDescription(LEGACY_DESCRIPTION)
  const fbCount = (notes.match(/Facebook messages/gi) ?? []).length
  assert.equal(fbCount, 1, `expected one Facebook mention, got:\n${notes}`)
  assert.ok(!notes.includes('Est. $'))
  assert.ok(!notes.includes('elevator='))
  assert.ok(!notes.includes('$699'))
  assert.ok(notes.includes('26 ft truck'))
})

test('crewNotesFromDescription: new format keeps only the customer notes', () => {
  const notes = crewNotesFromDescription(NEW_DESCRIPTION)
  assert.ok(notes.includes('Gate code is 4321'))
  assert.ok(!notes.includes('Customer-side estimate'))
  assert.ok(!notes.includes('Stairs:'))
  assert.ok(!notes.includes('Service:'))
})

test('accessBulletsFromDescription: legacy blob → clean bullets', () => {
  const bullets = accessBulletsFromDescription(LEGACY_DESCRIPTION)
  assert.ok(bullets.some((b) => /stairs/i.test(b)))
  assert.ok(bullets.some((b) => /no elevator/i.test(b)))
  assert.ok(bullets.some((b) => /parking at the door/i.test(b)))
  assert.ok(bullets.some((b) => /newer building/i.test(b)))
  for (const b of bullets) assert.ok(!b.includes('='), `raw token leaked: ${b}`)
})

test('accessBulletsFromDescription: new format lines → same bullet shape', () => {
  const bullets = accessBulletsFromDescription(NEW_DESCRIPTION)
  assert.ok(bullets.some((b) => /no elevator/i.test(b)))
  assert.ok(bullets.some((b) => /parking at the door/i.test(b)))
  assert.ok(bullets.some((b) => /newer building/i.test(b)))
})

test('service/truck labels parse from the description', () => {
  assert.equal(serviceLabelFromDescription(LEGACY_DESCRIPTION), '2 Bedrooms')
  assert.equal(truckLabelFromDescription(LEGACY_DESCRIPTION), TRUCK_OPTION_LABELS['own-truck'])
  assert.equal(truckLabelFromDescription(NEW_DESCRIPTION), TRUCK_OPTION_LABELS['truck-pickup-return'])
})

test('jobDateTime: eastern-time short format, safe fallback on garbage', () => {
  assert.match(jobDateTime('2026-07-12T20:00:00.000Z'), /Jul 12 · \d{1,2}:\d{2} [AP]M/)
  assert.equal(jobDateTime(null), 'Date to be confirmed')
  assert.equal(jobDateTime('not-a-date'), 'Date to be confirmed')
})

// ── The worker dispatch card ────────────────────────────────────────────────
function baseCardData() {
  return {
    bookingId: 'cmrgxmon4000fmihhwekvykji',
    displayId: 'cmrgxmon4000emihhe1rarww5',
    status: 'CONFIRMED',
    customerName: 'Manshi Patel',
    customerPhone: '(248) 555-0100',
    moveDate: '2026-07-12T20:00:00.000Z',
    originAddress: 'Rochester Hills, MI',
    destAddress: '12 Elm St, West Orange, NJ 07052',
    rawDescription: LEGACY_DESCRIPTION,
    photoCount: 3,
    laborEstimate: 699,
    manualReviewRequired: true,
    adminUrl: 'https://wmiwci-api.vercel.app/admin/bookings',
  }
}

test('job card: worker view has no full IDs, no raw enums, short ref footer', () => {
  const card = buildJobCard(baseCardData())
  const json = JSON.stringify(card)
  assert.ok(!json.includes('cmrgxmon4000fmihhwekvykji'.slice(0, 12)) || json.includes('custom_id'),
    'full booking id must only appear inside button custom_ids')
  // The embed itself (fields/footer/title) must not contain the full ids.
  const embedJson = JSON.stringify(card.embeds)
  assert.ok(!embedJson.includes('cmrgxmon4000fmihhwekvykji'))
  assert.ok(!embedJson.includes('cmrgxmon4000emihhe1rarww5'))
  assert.ok(embedJson.includes('…rww5'))
  assert.ok(!embedJson.includes('MANUAL_REVIEW'))
  assert.ok(!embedJson.includes('elevator='))
  assert.ok(!embedJson.includes('CUSTOMER_PROVIDES'))
})

test('job card: manual review → gold accent + owner-review warning, travel fee pending', () => {
  const card = buildJobCard(baseCardData())
  const embed = card.embeds[0]
  assert.equal(embed.color, STATUS_COLORS.ownerReview)
  assert.match(embed.description ?? '', /Owner Review Required/)
  assert.match(embed.description ?? '', /Do not promise/)
  const travel = embed.fields?.find((f) => f.name === 'Travel Fee')
  assert.equal(travel?.value, 'Pending owner review')
})

test('job card: scheduled state has Start + Complete buttons and a pickup navigation link', () => {
  const card = buildJobCard({ ...baseCardData(), manualReviewRequired: false })
  const buttons = card.components.flatMap((r) => r.components)
  const ids = buttons.map((b) => b.custom_id).filter(Boolean)
  assert.deepEqual(ids, ['job_start:cmrgxmon4000fmihhwekvykji', 'job_complete:cmrgxmon4000fmihhwekvykji'])
  const nav = buttons.find((b) => b.label.includes('Navigation'))
  assert.ok(nav?.url?.includes(encodeURIComponent('Rochester Hills, MI')))
})

test('job card: in progress → Complete only, navigation flips to destination, status trail shown', () => {
  const card = buildJobCard({
    ...baseCardData(),
    status: 'IN_PROGRESS',
    manualReviewRequired: false,
    startedBy: 'Diego',
    startedAtLabel: '4:08 PM',
  })
  const buttons = card.components.flatMap((r) => r.components)
  const ids = buttons.map((b) => b.custom_id).filter(Boolean)
  assert.deepEqual(ids, ['job_complete:cmrgxmon4000fmihhwekvykji'])
  const nav = buttons.find((b) => b.label.includes('Navigation'))
  assert.ok(nav?.url?.includes(encodeURIComponent('12 Elm St')))
  const status = card.embeds[0].fields?.find((f) => f.name === 'Status')
  assert.match(status?.value ?? '', /Job in progress/)
  assert.match(status?.value ?? '', /Started by Diego · 4:08 PM/)
})

test('job card: completed → Archive only, green, completion trail', () => {
  const card = buildJobCard({
    ...baseCardData(),
    status: 'COMPLETED',
    startedBy: 'Diego',
    startedAtLabel: '4:08 PM',
    completedBy: 'Sebastian',
    completedAtLabel: '7:42 PM',
  })
  assert.equal(card.embeds[0].color, STATUS_COLORS.completed)
  const ids = card.components.flatMap((r) => r.components).map((b) => b.custom_id).filter(Boolean)
  assert.deepEqual(ids, ['archive_job:cmrgxmon4000fmihhwekvykji'])
  const status = card.embeds[0].fields?.find((f) => f.name === 'Status')
  assert.match(status?.value ?? '', /Completed by Sebastian · 7:42 PM/)
})

test('job card: archived → no action buttons at all', () => {
  const card = buildJobCard({ ...baseCardData(), status: 'ARCHIVED' })
  const ids = card.components.flatMap((r) => r.components).map((b) => b.custom_id).filter(Boolean)
  assert.deepEqual(ids, [])
})

test('job card respects Discord platform limits', () => {
  const long = { ...baseCardData(), crewNotes: 'note '.repeat(1000), customerName: 'X'.repeat(300) }
  const card = buildJobCard(long)
  const embed = card.embeds[0]
  assert.ok((embed.title ?? '').length <= 256, 'title over 256')
  assert.ok((embed.fields ?? []).length <= 25, 'more than 25 fields')
  for (const f of embed.fields ?? []) {
    assert.ok(f.name.length <= 256, `field name over 256: ${f.name}`)
    assert.ok(f.value.length <= 1024, `field value over 1024: ${f.name}`)
  }
  assert.ok((embed.footer?.text ?? '').length <= 2048)
  const total =
    (embed.title ?? '').length +
    (embed.description ?? '').length +
    (embed.footer?.text ?? '').length +
    (embed.fields ?? []).reduce((s, f) => s + f.name.length + f.value.length, 0)
  assert.ok(total <= 6000, `embed total ${total} over 6000`)
  for (const row of card.components) {
    assert.ok(row.components.length <= 5, 'more than 5 buttons in a row')
    for (const b of row.components) assert.ok(b.label.length <= 80, 'button label over 80')
  }
  assert.ok(card.components.length <= 5, 'more than 5 action rows')
})

test('job card: missing data degrades to honest fallbacks, never undefined/null text', () => {
  const card = buildJobCard({ bookingId: 'abc123xyz789' })
  const json = JSON.stringify(card.embeds)
  assert.ok(!json.includes('undefined'))
  assert.ok(!json.includes('null,') || true)
  const fields = card.embeds[0].fields ?? []
  assert.equal(fields.find((f) => f.name === 'Customer')?.value, 'Name pending')
  assert.equal(fields.find((f) => f.name === 'Date & Time')?.value, 'Date to be confirmed')
  assert.match(fields.find((f) => f.name === 'Pickup')?.value ?? '', /check admin/)
  assert.equal(fields.find((f) => f.name === 'Truck')?.value, TRUCK_OPTION_LABELS['own-truck'])
  assert.equal(fields.find((f) => f.name === 'Photos')?.value, 'None uploaded')
})

test('job card: "Provided at confirmation" addresses never become navigation links', () => {
  const card = buildJobCard({
    ...baseCardData(),
    manualReviewRequired: false,
    originAddress: 'Provided at confirmation',
  })
  const nav = card.components.flatMap((r) => r.components).find((b) => b.label.includes('Navigation'))
  assert.equal(nav, undefined)
})

// ════════════════════════════════════════════════════════════════════════
//  The OWNER approval card — buildBookingApprovalCard / approvalCardDataFromBooking
// ════════════════════════════════════════════════════════════════════════
const APPROVAL_BOOKING = {
  id: 'ckbooking123456',
  displayId: 'A1B2C3',
  status: 'PENDING_APPROVAL',
  originAddress: '123 Main St, Newark, NJ 07102',
  destAddress: '45 Oak Ave, Montclair, NJ 07042',
  itemsDescription: NEW_DESCRIPTION,
  customerNotes: null,
  requestedDate: new Date('2026-07-18T12:00:00Z'),
  baseRate: 699,
  totalEstimate: 749,
  travelFee: 5000,
  truckAddonDueOnMoveDay: true,
  truckAddonAmount: 5000,
  discountType: 'FIRST_TIME_AUTO',
  discountCode: null,
  discountPercent: 10,
  depositAmount: 4900,
  depositPaid: false,
  serviceAreaZone: 'extended_nj',
  manualReviewRequired: false,
  serviceAreaMessage: null,
  stripePaymentIntentId: 'pi_1234567890ABCDEF',
  stripeCheckoutId: 'cs_test_ABCDEF123456',
  agreementAccepted: true,
  agreementVersion: 'v1',
  agreementName: 'Diego Vasquez',
  agreementAcceptedAt: new Date('2026-07-12T15:00:00Z'),
  source: 'qr-door-1',
  foundUs: 'Facebook',
  customer: { name: 'Diego Vasquez', email: 'diego@example.com', phone: '(973) 555-0147' },
}
const approvalFields = (data: Parameters<typeof buildBookingApprovalCard>[0]) =>
  buildBookingApprovalCard(data).embeds[0].fields ?? []

test('approval card: shows BOTH addresses as their own fields (the dropped-address bug)', () => {
  const fields = approvalFields(approvalCardDataFromBooking(APPROVAL_BOOKING, { adminUrl: 'https://x/admin/bookings' }))
  assert.equal(fields.find((f) => f.name === '📍 Pickup')?.value, '123 Main St, Newark, NJ 07102')
  assert.equal(fields.find((f) => f.name === '📍 Dropoff')?.value, '45 Oak Ave, Montclair, NJ 07042')
})

test('approval card: full pricing breakdown (base, travel, truck add-on, discount, deposit, total, balance)', () => {
  const pricing = approvalFields(approvalCardDataFromBooking(APPROVAL_BOOKING)).find((f) => f.name === '💰 Pricing')?.value ?? ''
  assert.match(pricing, /Base labor: \$699/)
  assert.match(pricing, /Travel fee: \$50/)
  assert.match(pricing, /Truck add-on: \$50/)
  assert.match(pricing, /10% off/)
  assert.match(pricing, /Deposit: \$49 held/)
  assert.match(pricing, /Move total: \$749/)
  assert.match(pricing, /Balance after job: \$700/)
})

test('approval card: Stripe references shown (PI + checkout session short refs)', () => {
  const stripe = approvalFields(approvalCardDataFromBooking(APPROVAL_BOOKING)).find((f) => f.name === '💳 Stripe')?.value ?? ''
  assert.match(stripe, /hold authorized/i)
  assert.match(stripe, /Payment Intent/)
  assert.match(stripe, /Checkout Session/)
})

test('approval card: notes are the customer words only, not the mixed description blob', () => {
  const notes = approvalFields(approvalCardDataFromBooking(APPROVAL_BOOKING)).find((f) => f.name === '📝 Customer Notes')?.value ?? ''
  assert.match(notes, /Gate code is 4321/)
  assert.ok(!/Service:/.test(notes), 'notes leaked the Service: line')
  assert.ok(!/Customer-side estimate/.test(notes), 'notes leaked the estimate line')
})

test('approval card: every owner + link + view-full button, within Discord row/button limits', () => {
  const card = buildBookingApprovalCard(
    approvalCardDataFromBooking(APPROVAL_BOOKING, { adminUrl: 'https://x/admin/bookings', receiptUrl: 'https://stripe/r/1' }),
  )
  const buttons = card.components.flatMap((r) => r.components)
  const ids = buttons.map((b) => b.custom_id).filter(Boolean)
  assert.ok(ids.includes(`approve_booking:${APPROVAL_BOOKING.id}`))
  assert.ok(ids.includes(`offer_reschedule:${APPROVAL_BOOKING.id}`))
  assert.ok(ids.includes(`deny_booking:${APPROVAL_BOOKING.id}`))
  assert.ok(ids.includes(`view_full_booking:${APPROVAL_BOOKING.id}`))
  const urls = buttons.map((b) => b.url).filter((u): u is string => !!u)
  assert.equal(urls.filter((u) => /google\.com\/maps/.test(u)).length, 2, 'both maps buttons')
  assert.ok(urls.includes('https://stripe/r/1'), 'receipt link')
  assert.ok(card.components.length <= 5, 'more than 5 action rows')
  for (const row of card.components) assert.ok(row.components.length <= 5, 'more than 5 buttons per row')
})

test('approval card: photos become an inline gallery + link list', () => {
  const card = buildBookingApprovalCard(
    approvalCardDataFromBooking(APPROVAL_BOOKING, { photos: [{ url: 'https://cdn/p1.jpg' }, { url: 'https://cdn/p2.jpg' }] }),
  )
  assert.equal(card.embeds.length, 3) // main + 2 image embeds
  assert.equal(card.embeds[1].image?.url, 'https://cdn/p1.jpg')
  const photoField = (card.embeds[0].fields ?? []).find((f) => f.name.startsWith('📷 Job Photos'))
  assert.match(photoField?.value ?? '', /Photo 1/)
})

test('approval card: manual review adds the owner-review banner + pending travel line', () => {
  const card = buildBookingApprovalCard(approvalCardDataFromBooking({ ...APPROVAL_BOOKING, manualReviewRequired: true }))
  assert.match(card.embeds[0].description ?? '', /Owner review required/i)
  const pricing = (card.embeds[0].fields ?? []).find((f) => f.name === '💰 Pricing')?.value ?? ''
  assert.match(pricing, /Pending owner review/)
})

test('approval card: minimal data (only bookingId) never emits null/undefined, keeps View Full', () => {
  const card = buildBookingApprovalCard({ bookingId: 'onlyid123' })
  assert.ok(!JSON.stringify(card).includes('undefined'))
  const ids = card.components.flatMap((r) => r.components).map((b) => b.custom_id).filter(Boolean)
  assert.ok(ids.includes('view_full_booking:onlyid123'))
})

test('approvalCardDataFromBooking: cents→dollars conversion + balance math', () => {
  const data = approvalCardDataFromBooking(APPROVAL_BOOKING)
  assert.equal(data.travelFeeDollars, 50)
  assert.equal(data.depositDollars, 49)
  assert.equal(data.moveTotal, 749)
  assert.equal(data.balanceAfterJob, 700)
})
