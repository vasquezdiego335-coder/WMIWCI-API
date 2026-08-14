// ============================================================================
// Offline tests for the Action Center kick outcome mapper (correctness pass
// item 7). The admin Book Move create used to fire syncReminders and forget
// it while the success panel claimed "scan kicked" unconditionally — a silent
// failure was indistinguishable from a healthy scan. describeScanOutcome is
// the ONE place runScan's real endings become the reported state.
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import {
  SCANNED_BOOKING_STATUSES,
  SCAN_KICK_MESSAGES,
  SCAN_LOADER_OR_KEYS,
  SCAN_LOADER_TAKE,
  SCAN_LOADER_WHERE_KEYS,
  decideClaim,
  describeScanOutcome,
  scanCoversBooking,
  scanCoversBookingStatus,
  type ScanKickState,
} from '../scan-lock'
import { TRUCK_HOLD_STATUSES } from '../truck-conflicts'
// TYPE-ONLY (erased at runtime — this test never touches the DB module): proves
// the mapper accepts the REAL runScan() return type, not an invented shape.
import type { ScanOutcome } from '../reminder-sync'

const STATES: ScanKickState[] = ['completed', 'skipped_cooldown', 'failed']

// ════════════════════════════════════════════════════════════════════════════
//  ONE list of banned phrases, ONE comment stripper — used by the message
//  tests below AND by the source guards over the owner-facing files (P0-B).
//
//  P0-B's ROOT CAUSE was not the string, it was the FILE LIST. This list
//  already existed and already contained /is included/, but it was only ever
//  applied to describeScanOutcome()'s return values; the two source guards
//  read reminder-sync.ts and the bookings route. No test opened
//  BookMoveForm.tsx, which is where a hand-typed copy of the retired sentence
//  "Action Center rescanned — this booking is included" survived round 3 —
//  unconditional, and under a branch covering BOTH server endings, so it
//  printed a coverage claim for the very ending where the server refuses to
//  make one. Hoisted here so one list serves both, and the guard now names
//  every owner-facing file that talks about the scan.
// ════════════════════════════════════════════════════════════════════════════

/** Phrases that assert this booking is accounted for. R3-3: `/is included/` is
 *  now guarded like every other coverage claim — round 2 exempted it, which is
 *  how the false line survived in the SUCCESS message. Only a scan that ran
 *  AND was told a status the scan actually loads may use one of these.
 *  P0-B adds the two remaining phrases from the owner's search list.
 *
 *  H2/H3 — THE BLACKLIST ESCAPE. The list below the divider is the same claim
 *  in the words a human actually reaches for. "This booking is on the list."
 *  passed every check in round 4 while meaning exactly what "is included"
 *  means; a blacklist that only bans the retired sentence bans the sentence,
 *  not the lie. Each of these is written to match the CLAIM and not its
 *  DENIAL — the shipped honest copy says "may not be on the list" and "may not
 *  appear", so `be on the list` and `not covered` must stay legal. The tests
 *  above run every SCAN_KICK_MESSAGES string through this list, so a regex
 *  widened until it swallows the honest wording turns them red immediately. */
const COVERAGE_CLAIMS = [
  /already current/i,
  /list is current/i,
  /up to date/i,
  /up-to-date/i,
  /will include this booking/i,
  /is included/i,
  /nothing to refresh/i,
  /scan kicked/i,
  /has been scanned/i,
  // ── H3: the near-variants the owner's search list names ──
  /\b(?:is|are|it'?s)\s+(?:already\s+|now\s+)?(?:on|in)\s+the\s+list\b/i,
  /\b(?:is|are|was|were|been|all)\s+accounted\s+for\b/i,
  /\b(?:is|are|was|were|been)\s+(?:already\s+|now\s+)?covered\b/i,
  /\bnothing\s+(?:is\s+)?missing\b/i,
]

/** Does the copy tell the owner what to do about it? */
const WAY_OUT = /open the action center/i

const ROOT = process.cwd()

/** Source with COMMENTS REMOVED, so a guard asserts about code and never about
 *  a sentence describing code.
 *
 *  THE CRLF LESSON (Method §1). A previous round's stripper was a silent no-op
 *  on CRLF checkouts, which made every negative guard satisfiable by a comment
 *  merely naming the old code. This is day-anchor-display.test.ts's `codeOf`,
 *  verbatim, and the reason for each step:
 *    • line endings are normalized FIRST — `.` never matches `\r`, so a
 *      CRLF-only stripper is where that no-op came from;
 *    • `(^|[^:])//` keeps `https://…` inside string literals intact.
 *  MEASURED, not assumed: files the guard walks ARE CRLF on disk in this
 *  worktree (action-center/page.tsx, ReminderActions.tsx,
 *  api/admin/reminders/route.ts), so this is a live hazard, not a theoretical
 *  one — and H3 widened the walk from six files to every source file under
 *  app/, which can only add more of them. And the guard SELF-CHECKS the
 *  stripper before asserting (see below),
 *  because a broken stripper here would fail loudly on BookMoveForm.tsx while
 *  silently satisfying the positive guards elsewhere in this file. */
function codeOf(...segments: string[]): string {
  return codeOfPath(join(ROOT, ...segments))
}

/** codeOf for an already-joined absolute path (the repo walk below). */
function codeOfPath(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\r\n?/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n')
}

/** Comment-stripped code as ONE whitespace-normalized line.
 *
 *  THE LINE-SCOPE ESCAPE (H3). Round 4's guard tested `code.split('\n')` line
 *  by line, so the retired sentence survived a single line break through the
 *  middle of it. That is not an exotic dodge: Prettier wraps JSX text at
 *  printWidth, so the wording an owner reads as one sentence is stored as two
 *  lines the moment it sits inside a paragraph. What renders as one sentence
 *  must be matched as one sentence. */
function normalizedCodeOfPath(path: string): string {
  return codeOfPath(path).replace(/\s+/g, ' ')
}

// ── A tiny source-object reader (H2) ────────────────────────────────────────
//
// Enough of a parser to answer "what keys does this `where` actually have?".
// A regex cannot answer that — it can only confirm the keys it already knows
// to look for, which is precisely the presence-shaped weakness H2 closes.
// String literals are skipped so a brace or comma inside copy can never
// unbalance the walk.

const OPENERS = '{[('
const CLOSERS = '}])'

/** Index of the closing quote of the string literal starting at `start`. */
function endOfString(src: string, start: number): number {
  const quote = src[start]
  for (let i = start + 1; i < src.length; i++) {
    if (src[i] === '\\') { i++; continue }
    if (src[i] === quote) return i
  }
  return src.length - 1
}

/** The text INSIDE the bracket pair that opens at/after `from`. */
function bracketBody(src: string, from: number): string {
  const open = src.slice(from).search(/[{[]/)
  assert.ok(open >= 0, 'expected an object or array literal in the source')
  const start = from + open
  let depth = 0
  for (let i = start; i < src.length; i++) {
    const ch = src[i]
    if (ch === "'" || ch === '"' || ch === '`') { i = endOfString(src, i); continue }
    if (OPENERS.includes(ch)) depth++
    else if (CLOSERS.includes(ch)) {
      depth--
      if (depth === 0) return src.slice(start + 1, i)
    }
  }
  assert.fail('unbalanced literal in the source — the parser or the file is wrong')
}

/** Split an object/array body on its DEPTH-0 commas. */
function splitTopLevel(body: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (ch === "'" || ch === '"' || ch === '`') { i = endOfString(body, i); continue }
    if (OPENERS.includes(ch)) depth++
    else if (CLOSERS.includes(ch)) depth--
    else if (ch === ',' && depth === 0) { parts.push(body.slice(start, i)); start = i + 1 }
  }
  parts.push(body.slice(start))
  return parts.map((p) => p.trim()).filter((p) => p.length > 0)
}

/** `{ key: <source of the value> }` for an object literal body. */
function objectEntries(body: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of splitTopLevel(body)) {
    const m = /^([A-Za-z_$][\w$]*)\s*:/.exec(part)
    assert.ok(m, `unparsed object member (the guard must understand every key): ${part}`)
    out[m![1]] = part.slice(m![0].length).trim()
  }
  return out
}

/** Whitespace-insensitive comparison of two source fragments. */
function tight(src: string): string {
  return src.replace(/\s+/g, '')
}

const RAN: ScanOutcome = {
  ran: true,
  scanRunId: 'scan_1',
  result: { created: 2, updated: 1, autoResolved: 0, reopened: 0, woken: 0, candidates: 9, entitiesEvaluated: 40 },
}
const COOLDOWN: ScanOutcome = {
  ran: false,
  reason: 'cooldown',
  lastScan: { running: false, runningSince: null, lastSuccessAt: new Date('2026-08-12T12:00:00Z'), lastFailureAt: null, lastError: null },
}
const ALREADY_RUNNING: ScanOutcome = {
  ran: false,
  reason: 'already_running',
  lastScan: { running: true, runningSince: new Date('2026-08-12T12:00:00Z'), lastSuccessAt: null, lastFailureAt: null, lastError: null },
}

test('a scan that ran → completed', () => {
  const r = describeScanOutcome(RAN)
  assert.equal(r.state, 'completed')
  assert.equal(r.reason, 'ran')
  assert.ok(r.message.length > 0)
})

test('cooldown → skipped_cooldown (a healthy skip, not a failure)', () => {
  const r = describeScanOutcome(COOLDOWN)
  assert.equal(r.state, 'skipped_cooldown')
  assert.equal(r.reason, 'cooldown')
  assert.match(r.message, /skipped/i)
})

test('already_running → skipped_cooldown, and the REAL reason survives', () => {
  // The response contract has three states; flattening this into "cooldown"
  // would lose the truth, so the reason field keeps it.
  const r = describeScanOutcome(ALREADY_RUNNING)
  assert.equal(r.state, 'skipped_cooldown')
  assert.equal(r.reason, 'already_running')
  assert.match(r.message, /in progress/i)
})

test('a thrown scan error → failed, with the way out in the message', () => {
  const r = describeScanOutcome(new Error('connect ECONNREFUSED 10.0.0.5:5432'))
  assert.equal(r.state, 'failed')
  assert.equal(r.reason, 'error')
  assert.match(r.message, /did not run/i)
  assert.match(r.message, /Action Center/i)
  // Never leak the underlying error text to the owner-facing panel.
  assert.ok(!r.message.includes('ECONNREFUSED'))
})

test('the caller stopped waiting → failed/timeout, honestly worded', () => {
  const r = describeScanOutcome({ timedOut: true })
  assert.equal(r.state, 'failed')
  assert.equal(r.reason, 'timeout')
  // It IS still running server-side — the copy must say that, not "did not
  // run" (R2-6: a red "did not run" banner on every healthy-but-slow scan is
  // what trains an owner to ignore the banner).
  assert.match(r.message, /still running/i)
  assert.ok(!/did not run/i.test(r.message), 'a slow scan is not a dead scan')
  assert.match(r.message, /Action Center/i)
})

test('a blocked scan with an unrecognized reason → failed, never a fake skip', () => {
  const r = describeScanOutcome({ ran: false, reason: 'quota_exhausted' })
  assert.equal(r.state, 'failed')
  assert.equal(r.reason, 'unknown')
})

test('garbage in → failed (the honest default), never a throw', () => {
  for (const input of [null, undefined, 'ok', 0, 42, true, [], {}, { ran: 'yes' }, NaN]) {
    const r = describeScanOutcome(input)
    assert.equal(r.state, 'failed', `unexpected state for ${JSON.stringify(input) ?? String(input)}`)
    assert.equal(r.reason, 'error')
  }
})

test('every ending maps into the three contract states with a real message', () => {
  const inputs: unknown[] = [RAN, COOLDOWN, ALREADY_RUNNING, { timedOut: true }, new Error('x'), null, { ran: false, reason: 'nonsense' }]
  for (const input of inputs) {
    const r = describeScanOutcome(input)
    assert.ok(STATES.includes(r.state))
    assert.ok(r.message.trim().length > 10, 'the owner-facing message must actually say something')
  }
})

test('only a real scan is reported as completed', () => {
  const notCompleted: unknown[] = [COOLDOWN, ALREADY_RUNNING, { timedOut: true }, new Error('x'), { ran: false }, undefined]
  for (const input of notCompleted) {
    assert.notEqual(describeScanOutcome(input).state, 'completed')
  }
})

// ════════════════════════════════════════════════════════════════════════════
//  R2-6 — the messages may only claim what the code can know.
//
//  THE DEFECT: the skip copy read "one ran moments ago, so the list is already
//  current". That is provably FALSE for the booking that triggered the kick —
//  the scan being cited ran BEFORE this booking committed, so the one row it
//  cannot have seen is exactly the one the owner is being reassured about.
//  Booking two jobs back to back reliably produced a green line claiming the
//  list was current while job #2 was missing from it. The already-running copy
//  had the same problem in the other direction ("it will include this
//  booking" — an in-flight scan may already have read its booking list).
//
//  These tests are written against the CLAIM, not the wording: any message
//  that tells the owner the list covers this booking, for any ending except a
//  scan that actually ran after the commit, fails.
// ════════════════════════════════════════════════════════════════════════════

test('R2-6: no skipped scan claims the list already covers this booking', () => {
  for (const input of [COOLDOWN, ALREADY_RUNNING]) {
    const r = describeScanOutcome(input)
    assert.equal(r.state, 'skipped_cooldown')
    for (const claim of COVERAGE_CLAIMS) {
      assert.ok(
        !claim.test(r.message),
        `a skipped scan must not claim coverage (${claim}) — got: ${r.message}`,
      )
    }
    // It must say the honest thing instead: this booking may be missing.
    assert.match(r.message, /may not (appear|be on the list)/i, `skip copy must state the real risk — got: ${r.message}`)
    assert.match(r.message, WAY_OUT, `skip copy must give the owner a way out — got: ${r.message}`)
  }
})

test('R2-6: the cooldown skip names the real reason — an EARLIER scan, not this booking', () => {
  const r = describeScanOutcome(COOLDOWN)
  // The scan being cited ran before this booking existed. The copy has to say
  // so; "a scan ran moments ago" alone is what made the old line misleading.
  assert.match(r.message, /before this booking/i)
})

test('R2-6: the already-running skip never promises the in-flight scan will catch this booking', () => {
  const r = describeScanOutcome(ALREADY_RUNNING)
  assert.ok(!/will include/i.test(r.message), 'we cannot know when that scan read its booking list')
  assert.match(r.message, /started before this booking/i)
})

test('R2-6/R3-3: no ending may claim coverage on its own — not even a scan that ran', () => {
  // ROUND 2 asserted the opposite here: `describeScanOutcome(RAN)` had to match
  // /is included/, which made the test REQUIRE the defect. The kick forces the
  // scan, so `ran` is the normal ending — and "included" was printed for a
  // PENDING_PAYMENT booking the loader did not even query. A scan that ran
  // proves it started after the commit; it proves nothing about whether this
  // row is in the set it loads. Without a status, no claim.
  const ran = describeScanOutcome(RAN)
  assert.equal(ran.state, 'completed')
  assert.equal(ran.reason, 'ran')
  for (const claim of COVERAGE_CLAIMS) {
    assert.ok(!claim.test(ran.message), `a status-less success must not claim coverage (${claim}) — got: ${ran.message}`)
  }
  assert.match(ran.message, /rescanned/i, 'it must still report that the scan ran')

  const everyOtherEnding: unknown[] = [
    COOLDOWN,
    ALREADY_RUNNING,
    { timedOut: true },
    new Error('boom'),
    { ran: false, reason: 'quota_exhausted' },
    null,
  ]
  for (const input of everyOtherEnding) {
    const r = describeScanOutcome(input)
    for (const claim of COVERAGE_CLAIMS) {
      assert.ok(!claim.test(r.message), `${r.reason} must not claim coverage (${claim}) — got: ${r.message}`)
    }
    // …and a status cannot buy coverage for an ending that never scanned.
    const withStatus = describeScanOutcome(input, { bookingStatus: 'PENDING_PAYMENT' })
    for (const claim of COVERAGE_CLAIMS) {
      assert.ok(!claim.test(withStatus.message), `${withStatus.reason} must not claim coverage even with a status — got: ${withStatus.message}`)
    }
  }
})

test('R3-3: the inclusion claim needs a scan that ran AND a status the scan loads', () => {
  // The two statuses POST /api/admin/bookings can persist (decideStatus:
  // stripe_link → PENDING_PAYMENT, collect_on_day/waived → CONFIRMED). Both are
  // scanned as of R3-3, so the default path finally earns the sentence.
  for (const status of ['PENDING_PAYMENT', 'CONFIRMED']) {
    const r = describeScanOutcome(RAN, { bookingStatus: status })
    assert.equal(r.state, 'completed')
    assert.match(r.message, /is included/i, `${status} is scanned, so the claim is true`)
  }
  // A status the scan does not load gets the scan reported and NOTHING promised.
  for (const status of ['DRAFT', 'CANCELLED', 'ARCHIVED', 'COMPLETED', 'NONSENSE', '', null, undefined]) {
    const r = describeScanOutcome(RAN, { bookingStatus: status })
    assert.equal(r.state, 'completed', 'the scan still ran — that part is true')
    for (const claim of COVERAGE_CLAIMS) {
      assert.ok(!claim.test(r.message), `${String(status)} is not scanned — no coverage claim (${claim}) — got: ${r.message}`)
    }
    assert.match(r.message, WAY_OUT, 'if we cannot promise coverage we must say where to look')
  }
  // COMPLETED is deliberately absent: performSync loads it only inside a
  // 30-day recency window, which a status alone cannot decide.
  assert.equal(scanCoversBookingStatus('COMPLETED'), false)
})

test('R3-3: every status that can HOLD A TRUCK is a status the scan loads', () => {
  // The structural invariant behind the truck-double-booked rule. A truck hold
  // the loader never queries is a rule that cannot fire, whatever its own
  // status filter says — that is exactly how a PENDING_PAYMENT double-booking
  // stayed invisible until both bookings were approved.
  for (const status of TRUCK_HOLD_STATUSES) {
    assert.ok(
      scanCoversBookingStatus(status),
      `${status} holds a truck but is not scanned — the truck rule would be blind to it`,
    )
  }
  assert.ok(SCANNED_BOOKING_STATUSES.includes('PENDING_PAYMENT'), 'the DEFAULT stripe_link booking must be scanned')
})

test('R3-3: the loader builds its status filter from the shared constant', () => {
  // A source guard, like the route guard below: the claim above is only
  // truthful because performSync queries THIS list. A hand-written list next to
  // the query is how the copy and the loader drifted in round 2.
  const code = codeOf('src', 'lib', 'reminder-sync.ts')
  assert.match(code, /status:\s*\{\s*in:\s*\[\.\.\.SCANNED_BOOKING_STATUSES\]\s*\}/, 'the booking loader must query SCANNED_BOOKING_STATUSES')
  // The take: 500 cap must not be arbitrary (R3-3 item 5).
  assert.match(code, /orderBy:\s*\[\{\s*updatedAt:\s*'desc'\s*\}/, 'the capped booking query needs a deterministic order')
  // P0-B: …and the OTHER half of the same where clause. scanCoversBooking
  // refuses the claim for an internal-test row precisely because the loader
  // does. If this filter is ever dropped from the query, the predicate is
  // modelling a loader that no longer exists.
  assert.match(code, /isInternalTest:\s*false/, 'the booking loader filters out internal-test rows — the predicate mirrors that')
})

// ════════════════════════════════════════════════════════════════════════════
//  H2 — THE PREDICATE MUST MODEL THE WHOLE LOADER, KEY BY KEY.
//
//  The guard above is PRESENCE-shaped: it confirms the query still mentions
//  the two filters the predicate knows about. It cannot see a THIRD filter,
//  and a third filter is what makes scanCoversBooking start lying — a narrower
//  loader means rows the predicate calls covered were never read. The verifier
//  proved it twice on a green suite:
//    M10  `manualReviewRequired: false` added to the where  → still green.
//         (buildBookingCreateData sets that flag TRUE for a default-path
//         booking with a piano, so this silently drops the exact jobs the
//         owner most needs on the list.)
//    M11  `take: 500` → `take: 5`                           → still green.
//         (the predicate models no row cap at all.)
//  So the guard is now EQUIVALENCE-shaped: the query is parsed, and every
//  top-level key — plus the keys inside each OR branch, plus the row cap and
//  the order that makes the cap safe — must match what scan-lock.ts says the
//  predicate models. Adding a filter deliberately is still allowed; it just
//  cannot be done without editing SCAN_LOADER_WHERE_KEYS three lines from
//  scanCoversBooking and writing the proof below.
// ════════════════════════════════════════════════════════════════════════════

/** The cap may rise (a bigger page can only make the claim safer) but never
 *  fall: the status-only predicate is truthful only while the cap sits far
 *  above the live operational set. */
const SCAN_MIN_LOADER_TAKE = 500

/** One executable proof per allowed `where` key that scanCoversBooking really
 *  does model it. The Record type is over the CONSTANT's union, so adding a key
 *  to SCAN_LOADER_WHERE_KEYS without adding its proof here fails `tsc` as well
 *  as this suite — the "same commit" rule, enforced twice. */
const PREDICATE_MODELS: Record<(typeof SCAN_LOADER_WHERE_KEYS)[number], () => void> = {
  isInternalTest: () => {
    assert.equal(scanCoversBooking({ status: 'CONFIRMED', isInternalTest: true }), false, 'internal-test rows are filtered out by the loader')
    assert.equal(scanCoversBooking({ status: 'CONFIRMED', isInternalTest: false }), true, 'real rows are not')
  },
  OR: () => {
    // The OR is the status half: the live list, plus a COMPLETED branch the
    // predicate deliberately refuses to claim (a status alone cannot know
    // whether a completed row is inside the recency window).
    assert.equal(scanCoversBooking({ status: 'CONFIRMED' }), true, 'a scanned status is covered')
    assert.equal(scanCoversBooking({ status: 'DRAFT' }), false, 'an unscanned status is not')
    assert.equal(scanCoversBooking({ status: 'COMPLETED' }), false, 'the recency branch is never claimed')
  },
}

test('H2: every `where` key the loader filters on is one the predicate models', () => {
  const code = codeOf('src', 'lib', 'reminder-sync.ts').replace(/\s+/g, ' ')
  const at = code.indexOf('prisma.booking.findMany(')
  assert.ok(at >= 0, 'performSync must still load bookings through prisma.booking.findMany')
  const query = objectEntries(bracketBody(code, at))

  assert.ok(query.where, 'the booking loader must have a where clause')
  const where = objectEntries(bracketBody(query.where, 0))
  assert.deepEqual(
    Object.keys(where).sort(),
    [...SCAN_LOADER_WHERE_KEYS].sort(),
    'performSync filters bookings on a key scanCoversBooking does not model (or has lost one it does): ' +
      `query=[${Object.keys(where).join(', ')}] predicate=[${SCAN_LOADER_WHERE_KEYS.join(', ')}]. ` +
      'A narrower loader means the kick claims coverage for rows the scan never read — model it in ' +
      'scan-lock.ts (SCAN_LOADER_WHERE_KEYS + scanCoversBooking) in this same commit.',
  )

  // Each allowed key is modelled in BEHAVIOUR, not just named in a list.
  assert.deepEqual(Object.keys(PREDICATE_MODELS).sort(), [...SCAN_LOADER_WHERE_KEYS].sort())
  for (const [key, proof] of Object.entries(PREDICATE_MODELS)) {
    try {
      proof()
    } catch (err) {
      assert.fail(`the predicate does not actually model ${key}: ${(err as Error).message}`)
    }
  }

  // ── The OR branches, which narrow just as effectively as a top-level key ──
  const branches = splitTopLevel(bracketBody(where.OR, 0)).map((b) => objectEntries(bracketBody(b, 0)))
  assert.equal(
    branches.length,
    2,
    'the loader has a branch the predicate was never told about — the live-status branch and the ' +
      'recent-COMPLETED branch are the two scanCoversBooking is written against',
  )
  for (const branch of branches) {
    for (const key of Object.keys(branch)) {
      assert.ok(
        (SCAN_LOADER_OR_KEYS as readonly string[]).includes(key),
        `an OR branch filters on '${key}', which the coverage predicate does not model`,
      )
    }
  }
  const live = branches.find((b) => /SCANNED_BOOKING_STATUSES/.test(b.status ?? ''))
  const completed = branches.find((b) => /'COMPLETED'/.test(b.status ?? ''))
  assert.ok(live, 'the live branch must query the shared SCANNED_BOOKING_STATUSES constant')
  assert.deepEqual(
    Object.keys(live!),
    ['status'],
    'the live branch is the whole of what scanCoversBookingStatus models — a second condition on it ' +
      'silently narrows the claim',
  )
  assert.equal(tight(live!.status), tight('{ in: [...SCANNED_BOOKING_STATUSES] }'))
  assert.ok(completed, 'the recent-COMPLETED branch must still be there')
  assert.deepEqual(Object.keys(completed!).sort(), ['status', 'updatedAt'])
  assert.equal(
    scanCoversBookingStatus('COMPLETED'),
    false,
    'COMPLETED is loaded only inside a recency window, so it stays unclaimable',
  )

  // ── The row cap and the order that is the ONLY reason a cap is survivable ──
  assert.equal(
    Number(query.take),
    SCAN_LOADER_TAKE,
    `the loader caps at ${query.take} rows but the predicate is documented against ${SCAN_LOADER_TAKE} ` +
      '(scan-lock.SCAN_LOADER_TAKE) — a status-only coverage claim cannot model a cap it does not know',
  )
  assert.ok(
    SCAN_LOADER_TAKE >= SCAN_MIN_LOADER_TAKE,
    `a cap of ${SCAN_LOADER_TAKE} is below the live operational set this claim assumes — lowering it ` +
      'makes "this booking is included" a guess about how many rows were touched more recently',
  )
  assert.equal(
    tight(query.orderBy ?? ''),
    tight("[{ updatedAt: 'desc' }, { id: 'desc' }]"),
    'most-recently-touched first is what stops truncation dropping the row the kick is reporting on; ' +
      'id breaks ties so two scans a millisecond apart see the same page',
  )
})

test('R3-3: the admin booking route reports the status it actually committed', () => {
  // The claim is derived from the WRITE, not from the deposit mode the request
  // asked for — a create that lands in an unexpected status must not inherit a
  // sentence about a status it does not have.
  const code = codeOf('app', 'api', 'admin', 'bookings', 'route.ts')
  // P0-B: BOTH halves of the loader's filter, read off the committed row —
  // never assumed from "this route never writes the internal-test flag".
  assert.match(
    code,
    /kickActionCenterScan\(booking\.status,\s*booking\.isInternalTest\)/,
    "the kick must be told the committed row's status AND its internal-test flag",
  )
  // The argument expression contains its own parens (`Promise.race([...])`), so
  // this cannot be a `[^)]*` scan — it looks for the options object handed to
  // the mapper, wherever inside the call it lands.
  assert.match(
    code,
    /describeScanOutcome\([\s\S]{0,240}?\{\s*bookingStatus,\s*bookingIsInternalTest\s*\}\s*\)/,
    'and pass both through to the mapper',
  )
})

test('R2-6: every non-completed ending tells the owner how to see the booking', () => {
  for (const input of [COOLDOWN, ALREADY_RUNNING, { timedOut: true }, new Error('x'), { ran: false, reason: 'nope' }]) {
    const r = describeScanOutcome(input)
    assert.match(r.message, WAY_OUT, `${r.reason}: the owner needs a way out — got: ${r.message}`)
  }
})

// ── The kick FORCES the scan, and forcing is safe ───────────────────────────
//
// Round 1 kicked with `force: false`, so the 3-minute cooldown swallowed the
// kick and the panel then made the false claim above. There is no cron scan
// yet, so cooldown skips were the COMMON case. The fix forces the kick — which
// is only safe because `force` bypasses the cooldown and nothing else.

test('R2-6: force bypasses the cooldown but NEVER the already-running guard', () => {
  const now = new Date('2026-08-12T15:00:00Z')
  const justRan = new Date(now.getTime() - 30_000) // well inside the cooldown

  // Unforced: the cooldown swallows the kick — the round-1 behavior.
  assert.deepEqual(
    decideClaim({ liveRunningExists: false, lastScanStartedAt: justRan, trigger: 'API', force: false }, now),
    { proceed: false, reason: 'cooldown' },
  )
  // Forced: the event-driven kick gets its scan.
  assert.deepEqual(
    decideClaim({ liveRunningExists: false, lastScanStartedAt: justRan, trigger: 'API', force: true }, now),
    { proceed: true },
  )
  // But a scan already in flight still wins, forced or not — forcing can never
  // start a second concurrent scan.
  for (const force of [true, false]) {
    assert.deepEqual(
      decideClaim({ liveRunningExists: true, lastScanStartedAt: justRan, trigger: 'API', force }, now),
      { proceed: false, reason: 'already_running' },
      `force=${force} must not defeat the in-progress guard`,
    )
  }
})

test('R2-6: the admin booking route actually kicks the scan with force', () => {
  // A source guard (same class as admin-route-coverage.test.ts): the honest
  // wording above is worth nothing if the kick is still swallowed by the
  // cooldown on every second booking. Comments are stripped first so this
  // asserts about CODE, not about a sentence describing the code.
  const code = codeOf('app', 'api', 'admin', 'bookings', 'route.ts')
  const call = /runScan\(\s*\{([^}]*)\}/.exec(code)
  assert.ok(call, 'the admin booking route must kick a scan')
  assert.match(call![1], /force\s*:\s*true/, 'a post-commit event kick must not be swallowed by the cooldown')
})

// ════════════════════════════════════════════════════════════════════════════
//  P0-B — THE OWNER-FACING SOURCE GUARD.
//
//  THE DEFECT this exists for: BookMoveForm.tsx's success panel carried
//    cascade.push(success.actionCenterScanMessage ?? 'Action Center rescanned
//      — this booking is included')
//  Three independent things were wrong with it, any one fatal:
//    1. UNCONDITIONAL. The server earns that sentence only when
//       scanCoversBooking() is true; the fallback checked nothing at all.
//    2. THE BRANCH WAS TOO WIDE. `actionCenterScan === 'completed'` is the
//       state for BOTH endings — SCAN_KICK_MESSAGES.ran_included (covered) AND
//       SCAN_KICK_MESSAGES.ran ("may not be on the list"). It printed a
//       coverage claim for the exact ending the server refuses to claim.
//    3. IT RE-TOLD A RETIRED LIE VERBATIM. Round 3 deleted that wording from
//       scan-lock.ts; the client kept a copy, and it even contradicted this
//       panel's own contract comment ("Absent means 'not reported', which the
//       panel says nothing about rather than claiming a scan ran").
//
//  WHY IT SURVIVED THREE ROUNDS: no test ever opened the file. COVERAGE_CLAIMS
//  existed and already contained /is included/ — it was only ever pointed at
//  describeScanOutcome()'s output and at two server files. The fix is the FILE
//  LIST, not the string; without this guard, round 5 is free to retype it.
// ════════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════════
//  H3 — AND THE FILE LIST WAS STILL AN ESCAPE.
//
//  P0-B fixed the file list by making it longer. The verifier then walked
//  through all three walls it left standing, on a green suite:
//    M13  the retired sentence typed into a NEW owner-facing page  → green.
//         (six files were guarded; the repo has 200+.)
//    M14  the retired sentence with ONE line break through it, in a LISTED
//         file → green. Prettier wraps JSX text at printWidth, so the sentence
//         an owner reads as one sentence is stored as two lines the moment it
//         sits in a paragraph. The guard matched line by line.
//    M15  "This booking is on the list." → green. Not on the blacklist.
//  So the guard now (1) matches whitespace-normalized WHOLE-FILE text, (2)
//  walks every source file under app/ plus the scan libraries instead of a
//  hand-kept list, and (3) bans the near-variants as well as the retired
//  sentence. The one string in the repo that has EARNED the claim is exempted
//  by exact text, not by exempting its file.
// ════════════════════════════════════════════════════════════════════════════

/** Files that renders or produces owner-facing copy about a scan.
 *
 *  H3: this is no longer THE guard — it is the guard's ANCHOR. The walk below
 *  covers these and everything else; this list stays so that a walk which
 *  silently stops finding files (a bad root, a changed extension, an
 *  over-eager skip) fails loudly instead of passing on an empty set. */
const SCAN_SURFACE_FILES: string[][] = [
  ['app', '(admin)', 'admin', '(dashboard)', 'book', 'BookMoveForm.tsx'],
  ['app', '(admin)', 'admin', '(dashboard)', 'action-center', 'page.tsx'],
  ['app', '(admin)', 'admin', '(dashboard)', 'action-center', 'ReminderActions.tsx'],
  ['app', 'api', 'admin', 'reminders', 'route.ts'],
  ['app', 'api', 'admin', 'bookings', 'route.ts'],
  ['src', 'lib', 'reminder-sync.ts'],
]

/** What the phrase guard reads: every page, component and route under app/
 *  (the whole owner-facing surface — a new page is the M13 hole) plus the scan
 *  libraries, whose exported constants ARE the owner-facing copy. */
const GUARDED_ROOTS: string[][] = [
  ['app'],
  ['src', 'lib', 'scan-lock.ts'],
  ['src', 'lib', 'reminder-sync.ts'],
  ['src', 'lib', 'reminder-rules.ts'],
]

const WALK_SKIP = new Set(['node_modules', '.next', '.git', '__tests__'])

function walkSources(segments: string[]): string[] {
  const start = join(ROOT, ...segments)
  if (!statSync(start).isDirectory()) return [start]
  const out: string[] = []
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (WALK_SKIP.has(entry.name)) continue
      const p = join(dir, entry.name)
      if (entry.isDirectory()) visit(p)
      else if (/\.tsx?$/.test(entry.name)) out.push(p)
    }
  }
  visit(start)
  return out
}

/** THE ONE EARNED CLAIM IN THE REPO. `SCAN_KICK_MESSAGES.ran_included` is the
 *  sentence describeScanOutcome prints only when scanCoversBooking() is true,
 *  so its file cannot be guarded like the rest — but exempting the FILE would
 *  re-open scan-lock.ts to every other claim. The exemption is the exact text
 *  of that one constant, removed before matching, and the self-check below
 *  fails if it stops being found (an exemption nobody can see is an exemption
 *  that has become a blanket pass). */
const EARNED_COVERAGE_CLAIM = { label: 'src/lib/scan-lock.ts', text: SCAN_KICK_MESSAGES.ran_included }

interface GuardedSource { label: string; text: string; exempted: number }

/** One walked file as the guard sees it: comments stripped, whitespace
 *  normalized to a single line, the earned constant removed. */
function guardedSource(path: string): GuardedSource {
  const label = relative(ROOT, path).split(sep).join('/')
  let text = normalizedCodeOfPath(path)
  let exempted = 0
  if (label === EARNED_COVERAGE_CLAIM.label) {
    const parts = text.split(EARNED_COVERAGE_CLAIM.text.replace(/\s+/g, ' '))
    exempted = parts.length - 1
    text = parts.join(' ')
  }
  return { label, text, exempted }
}

function guardedSources(): GuardedSource[] {
  const seen = new Set<string>()
  const out: GuardedSource[] = []
  for (const root of GUARDED_ROOTS) {
    for (const path of walkSources(root)) {
      if (seen.has(path)) continue
      seen.add(path)
      out.push(guardedSource(path))
    }
  }
  return out
}

test('P0-B: the comment stripper this guard depends on actually works', () => {
  // SELF-CHECK FIRST — otherwise a broken stripper would satisfy every negative
  // assertion below by simply finding nothing, which is precisely how the CRLF
  // no-op slipped through round 3. BookMoveForm.tsx is the right specimen: its
  // history comment DELIBERATELY quotes the banned phrases ("scan kicked",
  // "already current", "this booking is included") while its code must not, so
  // a no-op stripper turns the next test red instead of green.
  const raw = readFileSync(join(ROOT, 'app', '(admin)', 'admin', '(dashboard)', 'book', 'BookMoveForm.tsx'), 'utf8')
  const code = codeOf('app', '(admin)', 'admin', '(dashboard)', 'book', 'BookMoveForm.tsx')

  assert.match(raw, /Phase 1 claimed/, 'the specimen comment is gone — re-anchor this self-check before trusting the guard')
  assert.ok(!/Phase 1 claimed/.test(code), 'the stripper did not remove a line comment — every guard below is a no-op')
  assert.match(code, /actionCenterScanMessage/, 'the stripper ate real code — it is over-eager, not under-eager')
  assert.match(code, /SCAN_KICK_FALLBACKS/, 'the stripper ate real code')
})

test('H3: the phrase guard is not a no-op — walk, matcher and exemption self-check', () => {
  // 1. THE WALK. An empty (or shrunken) walk would satisfy the guard below by
  //    finding nothing, the same shape of silent no-op as the CRLF stripper.
  const sources = guardedSources()
  const labels = new Set(sources.map((s) => s.label))
  assert.ok(sources.length > 100, `the walk found only ${sources.length} files — it is not covering app/`)
  for (const segments of SCAN_SURFACE_FILES) {
    assert.ok(labels.has(segments.join('/')), `the walk lost a known scan surface: ${segments.join('/')}`)
  }

  // 2. THE MATCHER. M14's specimen — the retired sentence with one JSX line
  //    break through it. It must be caught AFTER normalization and (this is
  //    the part that proves normalization is load-bearing) missed before it.
  const M14 = 'Action Center rescanned — this booking is\n              included in the scan'
  assert.ok(
    !COVERAGE_CLAIMS.some((c) => M14.split('\n').some((line) => c.test(line))),
    'the M14 specimen must be invisible to a LINE-scoped guard — otherwise this test proves nothing',
  )
  assert.ok(
    COVERAGE_CLAIMS.some((c) => c.test(M14.replace(/\s+/g, ' '))),
    'whitespace-normalized whole-file text must catch a wrapped claim',
  )

  // 3. THE PHRASE SET, both directions. Every near-variant is a claim…
  for (const variant of [
    'This booking is on the list.',
    'It is already on the list.',
    'Every booking is accounted for.',
    'This booking has been covered by the scan.',
    'Nothing missing.',
  ]) {
    assert.ok(COVERAGE_CLAIMS.some((c) => c.test(variant)), `an unguarded near-variant: ${variant}`)
  }
  // …and every honest shipped sentence is NOT. A regex widened until it
  // swallows the real copy would make the guard unusable, so calibration is
  // asserted rather than assumed.
  for (const [key, message] of Object.entries(SCAN_KICK_MESSAGES)) {
    if (key === 'ran_included') continue // the one earned claim
    for (const claim of COVERAGE_CLAIMS) {
      assert.ok(!claim.test(message), `${claim} is too wide — it flags the honest copy '${key}': ${message}`)
    }
  }

  // 4. THE EXEMPTION. Exactly one earned constant, removed by exact text.
  const scanLock = sources.find((s) => s.label === EARNED_COVERAGE_CLAIM.label)
  assert.ok(scanLock, 'scan-lock.ts must be walked')
  assert.equal(
    scanLock!.exempted,
    1,
    'the earned constant was not found in scan-lock.ts — re-anchor the exemption before trusting the guard',
  )
})

test('P0-B/H3: no owner-facing file claims coverage in CODE', () => {
  for (const { label, text } of guardedSources()) {
    for (const claim of COVERAGE_CLAIMS) {
      const hit = claim.exec(text)
      assert.equal(
        hit,
        null,
        `${label} makes a coverage claim (${claim}) in code: …${text.slice(Math.max(0, (hit?.index ?? 0) - 80), (hit?.index ?? 0) + 80)}…`,
      )
    }
  }
})

test('H3: an owner-facing page may not promise the Action Center detects things by itself', () => {
  // The verifier flagged trucks/page.tsx:101 — "the Action Center flags two
  // jobs sharing one truck" — as an unguarded owner-facing claim. It is not a
  // COVERAGE claim (no phrase above matches it), but it promises a detection
  // with no mechanism attached, and the mechanism is the thing that can be
  // absent: nothing is flagged until a scan runs, and during the code-before-
  // SQL window performSync does not run at all (see the accepted-degradations
  // table in docs/moving-os-p0-review.md). Naming the scan is the difference
  // between a description and a guarantee.
  const promise = /Action Center[^.'"`]{0,140}?\b(?:flags?|catches|detects|prevents|blocks)\b/gi
  for (const { label, text } of guardedSources()) {
    for (const hit of Array.from(text.matchAll(promise))) {
      assert.ok(
        /scan/i.test(hit[0]),
        `${label} promises the Action Center detects something without naming the scan that does it: ${hit[0]}`,
      )
    }
  }
})

test('P0-B: the Book Move panel takes its scan wording from the server constants', () => {
  const code = codeOf('app', '(admin)', 'admin', '(dashboard)', 'book', 'BookMoveForm.tsx')

  // It must use the shared constants rather than retyping the server's copy.
  assert.match(
    code,
    /import\s*\{\s*SCAN_KICK_MESSAGES\s*\}\s*from\s*'@\/lib\/scan-lock'/,
    'the panel must import the server wording, not retype it',
  )

  // THE MUTATION TRAP THE PHRASE REGEXES CANNOT SEE. Importing the constants
  // and then picking `ran_included` would reinstate the exact defect while
  // passing every phrase check above, because the identifier contains none of
  // the banned words. The client CANNOT evaluate scanCoversBooking (it depends
  // on the committed row and on the loader's own filter), so it may never
  // select that message — one derivation, server-side, is the point of R3-3.
  assert.ok(
    !/ran_included/.test(code),
    'the client must never select the coverage message — it cannot evaluate the predicate that earns it',
  )

  // No re-typed scan copy of any kind: every fallback is a constant reference.
  const literals = code.match(/['"`]\s*Action Center (?:rescan|scan)[^'"`]*['"`]/gi) ?? []
  assert.deepEqual(
    literals,
    [],
    `scan copy must come from SCAN_KICK_MESSAGES, not from string literals: ${literals.join(' | ')}`,
  )

  // …and the fallback is keyed on the REAL ending. The old code answered the
  // coarse 'skipped_cooldown' state with the cooldown sentence even when the
  // true reason was already_running — a second, smaller version of the same
  // "too wide a branch" mistake.
  assert.match(
    code,
    /SCAN_KICK_FALLBACKS\[\s*success\.actionCenterScanReason/,
    'the fallback must be chosen by the reported reason, not by the coarse state',
  )
})

// ── The predicate must model the WHOLE loader, not half of it ───────────────

test('P0-B: an internal-test booking is never claimed as covered', () => {
  // performSync's where clause is `isInternalTest: false AND (status in
  // SCANNED_BOOKING_STATUSES OR recent COMPLETED)`. scanCoversBookingStatus
  // modelled only the OR-branch, while the comment above it claimed the
  // constant is "what makes the sentence checkable". Harmless today —
  // buildBookingCreateData never writes the flag — but /api/admin/test-booking
  // creates isInternalTest rows, so the day one of those reaches a scan kick
  // the sentence becomes false. Closed before it opens.
  for (const status of SCANNED_BOOKING_STATUSES) {
    assert.equal(scanCoversBooking({ status, isInternalTest: false }), true, `${status} is scanned`)
    assert.equal(scanCoversBooking({ status, isInternalTest: true }), false, `${status} internal-test rows are NOT loaded`)
    // Absent flag → the status decides: the column is a non-nullable
    // @default(false), so "the caller did not say" is not "unknown".
    assert.equal(scanCoversBooking({ status }), true, `${status} with no flag falls back to the status half`)
  }
  // And a status the loader skips stays uncovered whatever the flag says.
  for (const status of ['DRAFT', 'CANCELLED', 'COMPLETED', '', null, undefined]) {
    for (const isInternalTest of [true, false, undefined]) {
      assert.equal(scanCoversBooking({ status, isInternalTest }), false, `${String(status)} is not scanned`)
    }
  }
})

test('P0-B: the success message drops its coverage claim for an internal-test row', () => {
  // End to end through the mapper, on the ONE ending that can claim coverage.
  const covered = describeScanOutcome(RAN, { bookingStatus: 'PENDING_PAYMENT', bookingIsInternalTest: false })
  assert.equal(covered.message, SCAN_KICK_MESSAGES.ran_included)

  const internal = describeScanOutcome(RAN, { bookingStatus: 'PENDING_PAYMENT', bookingIsInternalTest: true })
  assert.equal(internal.state, 'completed', 'the scan still ran — that part is true')
  assert.equal(internal.message, SCAN_KICK_MESSAGES.ran, 'but it cannot have read a row the loader filters out')
  for (const claim of COVERAGE_CLAIMS) {
    assert.ok(!claim.test(internal.message), `an internal-test row must not be claimed as covered (${claim})`)
  }
  assert.match(internal.message, WAY_OUT, 'and it must still say where to look')
})
