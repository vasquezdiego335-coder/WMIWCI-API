import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render } from '@react-email/render'

import {
  AdminBookingSchema,
  buildBookingCreateData,
  resolveMoveSchedule,
  type AdminBookingInput,
} from '../admin-booking'
import { calculateEndTime, etDateTimeToInstant, formatEastern, formatMoveWhen } from '../scheduling'
import { computeEstimate } from '../estimate'
import {
  approvalCardDataFromBooking,
  buildBookingApprovalCard,
  buildJobCard,
  formatMoveWhen as formatMoveWhenPure,
  isDayAnchor,
  jobDateTime,
  moveTimeKnown,
  moveTimeLabel,
  moveWhenParts,
  smsMoveWhen,
} from '../booking-display'
import { moveTimeLabel as moveTimeLabelFromOutbox } from '../../outbox/services/premiumEmails'
import { effectiveMoveDate } from '../scheduling'
import PreApprovalEmail from '../../emails/pre-approval'
import JobReminderEmail from '../../emails/job-reminder'

// ════════════════════════════════════════════════════════════════════════════
//  ITEM R3-1 — the day anchor must never be rendered as a TIME.
//
//  THE DEFECT (a regression against HEAD, which stored 07:00 and so read
//  "7:00 AM"): R2-1 correctly stopped promoting the 00:00 ET day anchor into
//  `scheduledStart`, but SEVEN customer- and owner-facing surfaces still ran
//  that anchor through a formatter that prints an hour. Everyone — the owner
//  on Discord, the customer in three different messages, the customer's own
//  booking page, the admin jobs list — was told the move was at 12:00 AM.
//  The 72h/24h reminder then swung the other way and printed NO DATE AT ALL
//  ("Your move is coming up soon"), because the worker sent only the null
//  `scheduledStart`. Losing the hour is right; losing the date is not.
//
//  THE ROUND-3 RULE, obeyed here: every fixture is the row the SHIPPED WRITER
//  persists. `dayLevelRow()` / `timedRow()` call the real zod schema, the real
//  `resolveMoveSchedule` and the real `buildBookingCreateData`, so no test
//  below can assert a shape production cannot produce. (Round 2 lost two
//  verdicts to a hand-built row with a `scheduledStart` on PENDING_PAYMENT.)
//
//  Each surface is checked TWICE: a day-level move must contain no "12:00 AM"
//  and NO AM/PM at all, and a timed move must still show its real hour. Where
//  a surface is a Next page or an interaction route that cannot be imported
//  offline, the behavioural assertion runs on the shared formatter with the
//  SHIPPED row and is paired with a comment-stripped source guard proving that
//  render site actually calls it — reinstate the old formatter and the guard
//  goes red.
// ════════════════════════════════════════════════════════════════════════════

const ROOT = process.cwd()
const HELPERS = { toInstant: etDateTimeToInstant, endTime: calculateEndTime }
const EDT_DAY = '2027-07-15' // a Thursday, EDT (UTC-4)
const EST_DAY = '2027-01-15' // a Friday, EST (UTC-5)

/** Any clock reading at all. The contract asks for "no AM/PM"; this is the
 *  stronger check — a 24h locale slip would still fail it. */
const CLOCK = /\d{1,2}:\d{2}/
const MERIDIEM = /\b[AP]\.?M\.?\b/i
const MIDNIGHT = /12:00\s?[   ]?AM/i

function assertNoTimeOfDay(label: string, rendered: string): void {
  assert.ok(!MIDNIGHT.test(rendered), `${label} printed the day anchor as midnight: ${rendered}`)
  assert.ok(!MERIDIEM.test(rendered), `${label} printed an AM/PM time for a day-level move: ${rendered}`)
  assert.ok(!CLOCK.test(rendered), `${label} printed a clock time for a day-level move: ${rendered}`)
}

// ── The row POST /api/admin/bookings actually writes ─────────────────────────

function adminPayload(over: { startTime?: string; moveDate?: string } = {}): AdminBookingInput {
  const parsed = AdminBookingSchema.safeParse({
    customer: { name: 'Maria Lopez', phone: '(973) 555-0100' },
    move: {
      serviceType: '2br',
      moveDate: over.moveDate ?? EDT_DAY,
      // The whole point: on the phone the owner leaves this blank.
      ...(over.startTime ? { startTime: over.startTime } : {}),
      originAddress: { street: '12 Main St', city: 'Newark', state: 'NJ', zip: '07102' },
      destAddress: { street: '99 Oak Ave', city: 'Montclair', state: 'NJ', zip: '07042' },
    },
    services: { serviceMode: 'full_service' },
    inventory: [],
    deposit: { mode: 'stripe_link' }, // the DEFAULT path → PENDING_PAYMENT
    pricing: { ownerTotal: 700, overrideReason: 'phone quote' },
  })
  assert.ok(parsed.success, `fixture must satisfy the real schema: ${JSON.stringify(parsed.error?.flatten())}`)
  return parsed.data
}

/** The exact Booking scalars `buildBookingCreateData` persists, reshaped as the
 *  row every surface below reads (schedule columns exactly as stripe_link
 *  leaves them: a requested date and nothing else). */
function createdRow(over: { startTime?: string; moveDate?: string } = {}) {
  const input = adminPayload(over)
  const schedule = resolveMoveSchedule(input.move, { estimatedHours: 4, helpers: HELPERS })
  assert.ok(schedule.requestedDate, 'the move date must resolve')
  const data = buildBookingCreateData(
    input,
    {
      estimate: computeEstimate({ serviceType: input.move.serviceType, travelFeeCents: 0 }),
      travel: { zone: 'primary', travelFeeCents: 0 },
      reference: 'WMIC-1001',
      tokenExpiry: new Date('2027-12-31T00:00:00.000Z'),
      requestedDate: schedule.requestedDate,
      schedule,
      estimatedHours: 4,
    },
    [],
  )
  return {
    id: 'bk_1',
    displayId: 'WMIC-1001',
    status: 'PENDING_APPROVAL',
    requestedDate: (data.requestedDate as Date | undefined) ?? null,
    confirmedDate: (data.confirmedDate as Date | undefined) ?? null,
    scheduledStart: (data.scheduledStart as Date | undefined) ?? null,
    scheduledEnd: (data.scheduledEnd as Date | undefined) ?? null,
    startTimeKnown: data.startTimeKnown as boolean,
    arrivalWindow: null as string | null,
    itemsDescription: (data.itemsDescription as string | undefined) ?? null,
    originAddress: (data.originAddress as string | undefined) ?? null,
    destAddress: (data.destAddress as string | undefined) ?? null,
    depositAmount: 4900,
    customer: { name: 'Maria Lopez', email: 'maria@example.com', phone: '+19735550100', locale: 'en' },
  }
}

const dayLevelRow = (moveDate?: string) => createdRow(moveDate ? { moveDate } : {})
const timedRow = (moveDate?: string) => createdRow({ startTime: '09:30', ...(moveDate ? { moveDate } : {}) })

/** Source with `//` and `/* *\/` comments removed, so a source guard can never
 *  be satisfied by a comment that merely NAMES the right function.
 *
 *  CRLF FIRST, and that is load-bearing: this repo checks out with `\r\n`, and
 *  in a JS regex `.` does not match `\r` (it is a line terminator). So the
 *  line-comment strip `/(^|[^:])\/\/.*$/` could never reach `$` and silently
 *  stripped NOTHING — every negative guard below ("this file must no longer
 *  contain X") was satisfiable by a comment merely mentioning X, which is the
 *  exact failure mode the helper exists to prevent. */
function codeOf(...segments: string[]): string {
  return readFileSync(join(ROOT, ...segments), 'utf8')
    .replace(/\r\n?/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n')
}

/** The body of a named function/arrow declaration, brace-matched.
 *
 *  The parameter list is SKIPPED before the opening brace is looked for: a
 *  parameter carrying an inline object TYPE (`opts: { amountPaid?: string } =
 *  {}`) otherwise wins the `indexOf('{')` race and the guard ends up inspecting
 *  a five-word type annotation instead of the function. */
function bodyOf(code: string, declaration: string): string {
  const start = code.indexOf(declaration)
  assert.ok(start > -1, `could not find \`${declaration}\` — this guard has drifted from the source`)
  const paramsOpen = code.indexOf('(', start)
  assert.ok(paramsOpen > -1, `no parameter list for \`${declaration}\``)
  let parens = 0
  let afterParams = -1
  for (let i = paramsOpen; i < code.length; i++) {
    if (code[i] === '(') parens++
    else if (code[i] === ')' && --parens === 0) {
      afterParams = i + 1
      break
    }
  }
  assert.ok(afterParams > -1, `unbalanced parentheses in \`${declaration}\``)
  const open = code.indexOf('{', afterParams)
  assert.ok(open > -1, `no body for \`${declaration}\``)
  let depth = 0
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth++
    else if (code[i] === '}' && --depth === 0) return code.slice(open, i + 1)
  }
  assert.fail(`unbalanced braces after \`${declaration}\``)
}

/** The balanced argument list of a call, so a payload guard cannot be satisfied
 *  by a key that appears somewhere else entirely in the file. */
function callArgs(code: string, marker: string): string {
  const start = code.indexOf(marker)
  assert.ok(start > -1, `could not find the call \`${marker}\``)
  const open = code.indexOf('(', start)
  assert.ok(open > -1, `no argument list for \`${marker}\``)
  let depth = 0
  for (let i = open; i < code.length; i++) {
    if (code[i] === '(') depth++
    else if (code[i] === ')' && --depth === 0) return code.slice(open, i + 1)
  }
  assert.fail(`unbalanced parentheses after \`${marker}\``)
}

/** Rendered email text with every whitespace run collapsed.
 *
 *  `render(..., { plainText: true })` hard-wraps at ~80 columns, so the honest
 *  label really does ship as "Time to be\nconfirmed". Matching the flattened
 *  text asserts the CONTENT rather than the wrap column — and it strengthens
 *  the negative checks too, since a "12:00\nAM" split across the wrap would
 *  slip past a raw-text search for "12:00 AM". */
const flat = (s: string): string => s.replace(/\s+/g, ' ')

// ── 0. The fixtures really are what production writes ────────────────────────

test('R3-1: the shipped writer stores a 00:00 ET DAY ANCHOR and records the absence', () => {
  const day = dayLevelRow()
  assert.equal(day.startTimeKnown, false, 'buildBookingCreateData must record that no hour was given')
  assert.equal(day.scheduledStart, null, 'stripe_link writes no start (R2-1, must not regress)')
  assert.equal(day.requestedDate?.toISOString(), '2027-07-15T04:00:00.000Z') // 00:00 EDT
  assert.ok(isDayAnchor(day.requestedDate), 'the stored value IS an ET midnight anchor')
  assert.equal(moveTimeKnown(day), false)

  const timed = timedRow()
  assert.equal(timed.startTimeKnown, true)
  assert.equal(timed.requestedDate?.toISOString(), '2027-07-15T13:30:00.000Z') // 9:30 EDT
  assert.equal(isDayAnchor(timed.requestedDate), false)
  assert.equal(moveTimeKnown(timed), true)

  // Both DST sides — an EST anchor is 05:00Z, not 04:00Z, and must still read
  // as an anchor (the naive "is the UTC time 04:00" check would break here).
  const est = dayLevelRow(EST_DAY)
  assert.equal(est.requestedDate?.toISOString(), '2027-01-15T05:00:00.000Z')
  assert.ok(isDayAnchor(est.requestedDate))
  assert.equal(moveTimeKnown(est), false)
  assert.equal(moveTimeKnown(timedRow(EST_DAY)), true)
})

test('R3-1: isDayAnchor never mistakes a real crew hour for an anchor', () => {
  for (const hour of ['00:01', '06:00', '09:30', '23:59']) {
    assert.equal(isDayAnchor(etDateTimeToInstant(EDT_DAY, hour)), false, `${hour} ET is a real time`)
  }
  // UTC midnight is 8 PM ET — a real time of day, and NOT an ET anchor.
  assert.equal(isDayAnchor(new Date('2027-07-15T00:00:00.000Z')), false)
  assert.equal(isDayAnchor(null), false)
  assert.equal(isDayAnchor('not-a-date'), false)
  // A stored start always wins, whatever the flag says.
  assert.equal(moveTimeKnown({ scheduledStart: etDateTimeToInstant(EDT_DAY, '09:00'), startTimeKnown: false }), true)
})

// ── 1. Discord OWNER APPROVAL card — booking-display.ts (Move field) ─────────

const moveField = (row: ReturnType<typeof createdRow>) =>
  buildBookingApprovalCard(approvalCardDataFromBooking(row)).embeds[0].fields?.find((f) => f.name === '📅 Move')
    ?.value ?? ''

test('R3-1 surface 1: the owner approval card shows the DATE for a day-level move', () => {
  const printed = moveField(dayLevelRow())
  assert.match(printed, /Thu, Jul 15/)
  assertNoTimeOfDay('the Discord approval card', printed)
})

test('R3-1 surface 1: a TIMED booking keeps its real hour on the approval card', () => {
  assert.match(moveField(timedRow()), /Thu, Jul 15 · 9:30\s?[   ]?AM/)
  assert.match(moveField(timedRow(EST_DAY)), /9:30\s?[   ]?AM/)
})

// ── 2. Discord CREW JOB card — booking-display.ts:410 ────────────────────────

const dateAndTimeField = (data: Parameters<typeof buildJobCard>[0]) =>
  buildJobCard(data).embeds[0].fields?.find((f) => f.name === 'Date & Time')?.value ?? ''

test('R3-1 surface 2: the crew job card shows the DATE for a day-level move', () => {
  const row = dayLevelRow()
  const printed = dateAndTimeField({
    bookingId: row.id,
    moveDate: row.confirmedDate ?? row.requestedDate,
    startTimeKnown: row.startTimeKnown,
  })
  assert.match(printed, /Thu, Jul 15/)
  assertNoTimeOfDay('the Discord crew job card', printed)
})

test('R3-1 surface 2: the crew card is right even when the flag never reached it', () => {
  // The card is also built from a QUEUED PAYLOAD (discord-rest / discord-actions),
  // which historically carried a date and nothing else. The anchor is still
  // caught by shape, so an old job left in the queue cannot print midnight.
  const row = dayLevelRow()
  const printed = dateAndTimeField({ bookingId: row.id, moveDate: row.requestedDate })
  assert.match(printed, /Thu, Jul 15/)
  assertNoTimeOfDay('the crew job card without a flag', printed)
})

test('R3-1 surface 2: a TIMED job still shows its hour, and an empty date still says so', () => {
  const row = timedRow()
  assert.match(
    dateAndTimeField({ bookingId: row.id, moveDate: row.requestedDate, startTimeKnown: row.startTimeKnown }),
    /9:30\s?[   ]?AM/,
  )
  assert.equal(jobDateTime(null), 'Date to be confirmed')
  assert.equal(jobDateTime('not-a-date'), 'Date to be confirmed')
})

test('R3-1 surfaces 1+2: NO field of either Discord card prints an hour for a day-level move', () => {
  // The two tests above read one field each. The contract asks for the whole
  // rendered surface, because the anchor reaches these cards through several
  // props and a future field could print it again without touching the one
  // field a narrower guard watches. (The embed's ISO `timestamp` is the render
  // time, not the move — hence AM/PM rather than the any-clock check.)
  const row = dayLevelRow()
  const owner = JSON.stringify(buildBookingApprovalCard(approvalCardDataFromBooking(row)))
  assert.ok(!MIDNIGHT.test(owner), `the Discord approval card printed midnight:\n${owner}`)
  assert.ok(!MERIDIEM.test(owner), `the Discord approval card printed an AM/PM time:\n${owner}`)

  const crew = JSON.stringify(
    buildJobCard({
      bookingId: row.id,
      displayId: row.displayId,
      status: row.status,
      customerName: row.customer.name,
      customerPhone: row.customer.phone,
      moveDate: row.confirmedDate ?? row.requestedDate,
      startTimeKnown: row.startTimeKnown,
      originAddress: row.originAddress,
      destAddress: row.destAddress,
      rawDescription: row.itemsDescription,
    }),
  )
  assert.ok(!MIDNIGHT.test(crew), `the Discord crew card printed midnight:\n${crew}`)
  assert.ok(!MERIDIEM.test(crew), `the Discord crew card printed an AM/PM time:\n${crew}`)
})

// ── 3. Discord "✅ Approved" card — app/api/discord/interactions/route.ts ────

test('R3-1 surface 3: the Approved card the owner sees at approval says the DATE', () => {
  const printed = formatMoveWhen(dayLevelRow())
  assert.equal(printed, 'Thursday, July 15, 2027')
  assertNoTimeOfDay('the Discord Approved card', printed)
  // What it USED to print, and still prints for a booking with a real hour.
  assert.match(formatEastern(dayLevelRow().requestedDate!), MIDNIGHT)
  assert.match(formatMoveWhen(timedRow()), /9:30\s?[   ]?AM/)
})

test('R3-1 surface 3: confirmedCard routes through the shared formatter, not formatEastern', () => {
  const card = bodyOf(codeOf('app', 'api', 'discord', 'interactions', 'route.ts'), 'function confirmedCard(')
  assert.match(card, /formatMoveWhen\(booking\)/, 'the Approved card must format the booking, not a bare date')
  assert.ok(!/formatEastern\(/.test(card), 'formatEastern on the move date is what printed 12:00 AM')
})

// ── 4. Customer PRE-APPROVAL email — the "Time" row ──────────────────────────

const preApprovalHtml = (row: ReturnType<typeof createdRow>) =>
  render(
    PreApprovalEmail({
      customerName: row.customer.name,
      displayId: row.displayId,
      requestedDate: row.requestedDate?.toISOString(),
      // Exactly what BOTH senders now pass (proved by the guard below).
      timeLabel: moveTimeLabel(row, row.customer.locale),
      startTimeKnown: row.startTimeKnown,
      amountHold: '49',
      portalUrl: 'https://moveitclearit.com/my-booking/tok',
    }),
    { plainText: true },
  )

test('R3-1 surface 4: the pre-approval email never says the move is at 12:00 AM', () => {
  const text = flat(preApprovalHtml(dayLevelRow()))
  assert.match(text, /Thursday, July 15, 2027/, 'the date must still be stated')
  assert.match(text, /Time to be confirmed/, 'and the missing hour named honestly')
  assert.ok(!MIDNIGHT.test(text), `the pre-approval email printed midnight:\n${text}`)
  assert.ok(!MERIDIEM.test(text), `the pre-approval email printed an AM/PM time:\n${text}`)
})

test('R3-1 surface 4: a TIMED booking still shows its hour in the pre-approval email', () => {
  const text = flat(preApprovalHtml(timedRow()))
  assert.match(text, /Thursday, July 15, 2027/)
  assert.match(text, /9:30\s?[   ]?AM/)
})

test('R3-1 surface 4: BOTH pre-approval senders carry the time facts', () => {
  const outbox = bodyOf(codeOf('src', 'outbox', 'services', 'premiumEmails.tsx'), 'export async function renderPreApproval(')
  assert.match(outbox, /timeLabel:\s*moveTimeLabel\(/, 'the outbox sender passed no timeLabel at all')
  assert.match(outbox, /startTimeKnown:/, 'the outbox sender must carry the flag')

  // The OTHER sender. Scoped to that call's own balanced argument list, so a
  // `timeLabel:` belonging to some later queue payload cannot vouch for it.
  const queued = callArgs(codeOf('src', 'lib', 'fulfillment.ts'), "emailQueue.add('pre-approval'")
  assert.match(queued, /timeLabel:/, 'the legacy queue payload passed no timeLabel')
  assert.match(queued, /startTimeKnown:/, 'the legacy queue payload must carry the flag')
  assert.ok(!/timeLabel:\s*undefined\s*,/.test(queued), 'an always-undefined label is not carrying the fact')
})

// ── 5. Customer SMS — fulfillment.ts ─────────────────────────────────────────

test('R3-1 surface 5: the confirmation SMS states the date and no invented hour', () => {
  const printed = smsMoveWhen(dayLevelRow(), 'en-US')
  assert.equal(printed, 'Jul 15, 2027')
  assertNoTimeOfDay('the confirmation SMS', printed!)
  assert.equal(smsMoveWhen(dayLevelRow(EST_DAY), 'en-US'), 'Jan 15, 2027')
  // Spanish path (the SMS is bilingual) — still a date, still no clock.
  assertNoTimeOfDay('the Spanish confirmation SMS', smsMoveWhen(dayLevelRow(), 'es-US')!)
  assert.equal(smsMoveWhen(null), null, 'no date ⇒ the caller words the fallback')
})

test('R3-1 surface 5: a TIMED booking keeps the exact medium/short text it had', () => {
  assert.match(smsMoveWhen(timedRow(), 'en-US')!, /^Jul 15, 2027, 9:30\s?[   ]?AM$/)
})

test('R3-1 surface 5: fulfillment builds the SMS date through the shared builder', () => {
  const code = codeOf('src', 'lib', 'fulfillment.ts')
  assert.match(code, /smsMoveWhen\(booking,/, 'the SMS date must come from the shared builder')
  assert.ok(
    !/timeStyle:\s*'short'/.test(code),
    "an unguarded timeStyle:'short' on the booking date is exactly what texted 12:00 AM",
  )
})

// ── 6. Customer PORTAL — app/my-booking/[token]/page.tsx ─────────────────────

test('R3-1 surface 6: the portal shows no "Around 12:00 AM" for a day-level move', () => {
  const row = dayLevelRow()
  // The portal renders `Around ${fmtTime(requestedDate)}` only when this is true.
  assert.equal(moveTimeKnown({ date: row.requestedDate, startTimeKnown: row.startTimeKnown }), false)
  assert.equal(moveTimeKnown({ date: timedRow().requestedDate, startTimeKnown: true }), true)

  const code = codeOf('app', 'my-booking', '[token]', 'page.tsx')
  const assignment = code.slice(code.indexOf('const requestedTime ='), code.indexOf('const origin ='))
  assert.ok(assignment.length > 0, 'could not locate the portal requestedTime projection')
  assert.match(assignment, /moveTimeKnown\(/, 'the "Around …" line must be gated by the shared rule')
  assert.ok(
    /moveTimeKnown\([\s\S]*?\)\s*\n?\s*\?\s*`Around/.test(assignment.replace(/\s+/g, ' ').replace(/ /g, ' ')) ||
      /moveTimeKnown\(.*\)\s*\?\s*`Around/.test(assignment.replace(/\s+/g, ' ')),
    `the gate must guard the "Around" branch itself:\n${assignment}`,
  )
})

// ── 7. Admin JOBS list — app/(admin)/admin/(dashboard)/jobs/page.tsx ─────────

const jobsListWhen = (row: ReturnType<typeof createdRow>) =>
  formatMoveWhenPure(row, { dateFormat: { weekday: 'short', month: 'short', day: 'numeric' }, separator: ', ' })

test('R3-1 surface 7: the admin jobs list shows the DATE for a day-level move', () => {
  const printed = jobsListWhen(dayLevelRow())
  assert.equal(printed, 'Thu, Jul 15')
  assertNoTimeOfDay('the admin jobs list', printed)
  assert.match(jobsListWhen(timedRow()), /^Thu, Jul 15, 9:30\s?[   ]?AM$/)
})

test('R3-1 surface 7: the jobs list formats the ROW, not a bare coalesced date', () => {
  const code = codeOf('app', '(admin)', 'admin', '(dashboard)', 'jobs', 'page.tsx')
  assert.match(code, /const dateTime = \(b: MoveWhenInput\) =>\s*\n?\s*formatMoveWhen\(b,/, 'the list must format the booking row')
  assert.match(code, /\{dateTime\(b\)\}/, 'the card must pass the row so startTimeKnown is visible')
  assert.ok(
    !/dateTime\(b\.scheduledStart \?\? b\.confirmedDate \?\? b\.requestedDate\)/.test(code),
    'passing only the coalesced date throws away the flag — that is the defect',
  )
})

// ── 8. Action Center — the generic `dueAt` row ───────────────────────────────

const actionCentreDue = (d: Date) =>
  formatMoveWhenPure({ date: d }, { dateFormat: { month: 'short', day: 'numeric' }, separator: ', ' })

test('R3-1: the Action Center dueAt row renders an anchor as a date, a real due time as a time', () => {
  // reminder-rules sets `dueAt: start`, i.e. the booking's move date — the ET
  // day anchor for a day-level job. A Reminder row carries no startTimeKnown,
  // so this is the fail-soft case: shape alone must decide.
  const anchorDue = actionCentreDue(dayLevelRow().requestedDate!)
  assert.equal(anchorDue, 'Jul 15')
  assertNoTimeOfDay('the Action Center due row', anchorDue)

  // Everything with a genuine time of day keeps it (a crew start, a snooze).
  assert.match(actionCentreDue(timedRow().requestedDate!), /^Jul 15, 9:30\s?[   ]?AM$/)
  assert.match(actionCentreDue(new Date('2027-07-15T18:05:00.000Z')), /2:05\s?[   ]?PM/)
})

test('R3-1: the Action Center prints dueAt through the anchor-aware helper', () => {
  const code = codeOf('app', '(admin)', 'admin', '(dashboard)', 'action-center', 'page.tsx')
  assert.match(code, /const anchorAware = \(d: Date\) =>\s*\n?\s*formatMoveWhen\(/)
  assert.match(code, /due \{anchorAware\(r\.dueAt\)\}/, 'the dueAt row must use the anchor-aware helper')
  assert.ok(!/due \{dateTime\(r\.dueAt\)\}/.test(code), 'dateTime always prints an hour — that is the defect')
})

// ── 9. The 72h / 24h REMINDER — it must NAME THE DATE ───────────────────────

/** The payload `scheduled.worker.ts` now builds for a booking, using the same
 *  shared helpers it imports (the guard below proves it does). */
function reminderPayload(row: ReturnType<typeof createdRow>, leadLabel: string) {
  return {
    customerName: row.customer.name,
    displayId: row.displayId,
    scheduledStart: effectiveMoveDate(row)?.toISOString(),
    startTimeKnown: moveTimeKnown(row),
    timeLabel: moveTimeLabel(row, row.customer.locale),
    leadLabel,
    originAddress: row.originAddress ?? undefined,
    portalUrl: 'https://moveitclearit.com/my-booking/tok',
    stage: '72_hours' as const,
  }
}

test('R3-1: the 72h reminder NAMES THE DATE for a day-level move', () => {
  const payload = reminderPayload(dayLevelRow(), 'in 3 days')
  // The bug: the worker sent only `booking.scheduledStart`, which is null here.
  assert.ok(payload.scheduledStart, 'the worker must send the effective move date, not the null start')

  const text = flat(render(JobReminderEmail(payload), { plainText: true }))
  assert.match(text, /Thursday, July 15/, 'the reminder must name the move date')
  assert.ok(!/coming up soon/i.test(text), 'losing the DATE is not an acceptable substitute for losing the hour')
  assert.ok(!MIDNIGHT.test(text), `the reminder printed midnight:\n${text}`)
  assert.ok(!MERIDIEM.test(text), `the reminder printed an AM/PM time:\n${text}`)
  // The honest label appears, but never inside "arrives … at <label>".
  assert.match(text, /Time to be confirmed/)
  assert.ok(!/at Time to be confirmed/i.test(text))
})

test('R3-1: the 24h reminder for a TIMED move still states the real hour', () => {
  const text = flat(
    render(JobReminderEmail({ ...reminderPayload(timedRow(), 'tomorrow'), stage: '24_hours' }), { plainText: true }),
  )
  assert.match(text, /Thursday, July 15/)
  assert.match(text, /9:30\s?[   ]?AM/)
  assert.ok(!/coming up soon/i.test(text))
})

test('R3-1: a reminder with NO date signal still degrades to the soft phrase', () => {
  const text = render(JobReminderEmail({ portalUrl: 'https://moveitclearit.com/x' }), { plainText: true })
  assert.match(text, /coming up soon/i, 'no date at all is the only case that may be vague')
})

test('R3-1: the reminder worker sends the effective date, the flag, and an honest label', () => {
  const code = codeOf('src', 'workers', 'scheduled.worker.ts')
  const block = code.slice(code.indexOf("case 'job-reminder-72h':"), code.indexOf("case 'quote-followup'"))
  assert.ok(block.length > 0, 'could not locate the job-reminder branch')
  assert.match(block, /scheduledStart:\s*moveWhen\?\.toISOString\(\)/, 'the payload must carry the EFFECTIVE move date')
  assert.match(block, /moveWhen = effectiveMoveDate\(booking\)/)
  assert.match(block, /startTimeKnown:\s*moveTimeKnown\(booking\)/)
  assert.match(block, /timeLabel:\s*moveTimeLabel\(booking,/, 'job-reminder declares timeLabel REQUIRED')
  assert.ok(
    !/scheduledStart:\s*booking\.scheduledStart\?\.toISOString\(\)/.test(block),
    'sending the null day-level start is exactly what erased the date',
  )
})

test('R3-1: the journeys comment no longer claims the template renders the date alone', () => {
  const src = readFileSync(join(ROOT, 'src', 'lib', 'journeys.ts'), 'utf8')
  const doc = src.slice(src.indexOf('DAY-LEVEL BOOKINGS (item R2-1)'), src.indexOf('export async function onMoveDateSet'))
  assert.ok(doc.length > 0, 'could not locate the onMoveDateSet docblock')
  assert.ok(
    !/the worker passes\s*\n?\s*\*?\s*`booking\.scheduledStart`, which stays NULL, so job-reminder\.tsx renders the/.test(doc),
    'the comment described behaviour the code never had',
  )
  assert.match(doc, /R3-1/, 'the correction should be attributed')
})

// ── 10. The rule stays ONE rule ──────────────────────────────────────────────

test('R3-1: moveTimeLabel is still reachable where it was published', () => {
  assert.equal(moveTimeLabelFromOutbox, moveTimeLabel, 'the outbox re-export must be the same function')
  const row = dayLevelRow()
  assert.equal(moveTimeLabel(row, 'en'), 'Time to be confirmed')
  assert.equal(moveTimeLabel(row, 'es'), 'Hora por confirmar')
  assert.equal(moveTimeLabel(timedRow(), 'en'), undefined)
  assert.equal(moveTimeLabel({ ...row, arrivalWindow: '8:00–10:00 AM' }, 'en'), '8:00–10:00 AM')
  assert.equal(moveTimeLabel(row, 'en', true), undefined, 'a caller-supplied instant is real by construction')
  assert.equal(moveTimeLabel(null, 'en'), undefined)
})

test('R3-1: scheduling.formatMoveWhen keeps its (date, flag) call shape', () => {
  // booking-approval.ts and the round-2 tests call it this way.
  const row = dayLevelRow()
  assert.equal(formatMoveWhen(row.requestedDate!, row.startTimeKnown), 'Thursday, July 15, 2027')
  assert.match(formatMoveWhen(timedRow().requestedDate!, true), /9:30\s?[   ]?AM/)
  assert.equal(formatMoveWhen({ requestedDate: null, confirmedDate: null, scheduledStart: null }), '')
})

test('R3-1: the source guards in this file really do ignore comments', () => {
  // A meta-guard, and it earned its place. Every NEGATIVE guard here ("that
  // formatter must no longer appear at this render site") is only as strong as
  // the comment stripper — and the stripper was silently a NO-OP: this repo
  // checks out CRLF, and in a JS regex `.` does not match `\r`, so the line-
  // comment pattern could never reach `$`. A comment that merely NAMED the old
  // formatter would have satisfied the guard it was documenting.
  const file = ['src', 'lib', 'fulfillment.ts']
  const raw = readFileSync(join(ROOT, ...file), 'utf8')
  assert.match(raw, /timeStyle/, "fixture: fulfillment.ts must still DISCUSS timeStyle in a comment for this to prove anything")
  assert.ok(!/timeStyle/.test(codeOf(...file)), 'codeOf must strip comments — the surface-5 guard depends on it')

  // And the body finder must return a body, not a parameter's inline type.
  const outbox = bodyOf(codeOf('src', 'outbox', 'services', 'premiumEmails.tsx'), 'export async function renderPreApproval(')
  assert.ok(outbox.includes('renderBoth'), `bodyOf returned a parameter annotation, not the function body: ${outbox}`)
})

test('R3-1: moveWhenParts is locale-aware, so the Spanish templates share the rule', () => {
  const es = moveWhenParts(dayLevelRow(), {
    locale: 'es-US',
    dateFormat: { weekday: 'long', month: 'long', day: 'numeric' },
  })
  assert.equal(es.time, null)
  assert.equal(es.timeKnown, false)
  assert.match(es.date!, /julio/i)
  assert.ok(moveWhenParts(timedRow(), { locale: 'es-US' }).time)
})
