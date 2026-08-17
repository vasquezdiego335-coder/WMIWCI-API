#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════
//  test-moving-os.mjs — the PRE-DEPLOY correctness gate for the Moving OS.
//
//  WHY THIS EXISTS
//  `npm test` enumerates every test file by name, and 18 tests across 8 of them
//  are RED on this branch already (a stale hard-coded price, sibling-site parity
//  mirrors, and one generated preview file that only exists after
//  `npm run preview:emails`). A real correctness regression is invisible inside
//  that noise, and nothing in the build or the deploy runbook ran tests at all.
//  This runner covers ONLY the moving-OS correctness tests, all of which are
//  GREEN, so any failure here is a NEW regression — not baseline rot.
//  (No total is written down anywhere in this file that it cannot recompute:
//   the file count comes from package.json at run time and the 18 is summed
//   from BASELINE_FAILING_FILES. Hand-typed totals are what H4 removed.)
//
//  It does NOT fix the baseline failures and does not hide them: see
//  docs/deployment.md → "Known baseline failures (do NOT fix here)".
//
//  RUN
//    node scripts/test-moving-os.mjs          # run the gate
//    node scripts/test-moving-os.mjs --list   # print the file list, exit 0
//    node scripts/test-moving-os.mjs --audit  # coverage report, runs nothing
//  (the orchestrator wires this as `npm run test:moving-os`; this file works
//   standalone from the repo root and does not need the npm script.)
//
//  GUARANTEES THIS FILE CHECKS BEFORE IT RUNS ANYTHING
//   1. Every listed path EXISTS and is a non-empty file. A previous pass
//      listed a filename that did not exist; a typo must fail loudly and
//      immediately, not silently shrink the suite.
//   2. No duplicates (a duplicated path double-counts and wastes time).
//   3. No file that is a KNOWN baseline failure is in the list — so the
//      summary line "these are not the pricing-parity failures" is CHECKED,
//      not claimed.
//   4. Every listed file is also in package.json's `test` script (advisory
//      NOTE only — package.json belongs to the orchestrator, so this reports
//      drift instead of enforcing it).
//
//  OFFLINE ONLY. These tests touch no database and no network: the ones that
//  need Prisma install a fake client on globalThis before src/lib/db.ts is
//  first imported. There is no init migration in prisma/migrations (nothing
//  creates the `bookings` table), so a database could not be provisioned from
//  this repo even if a runner wanted to. Keep it that way.
// ════════════════════════════════════════════════════════════════════════

import { spawn } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

// ── THE LIST ────────────────────────────────────────────────────────────
// ONE place. Order follows docs/moving-os-p0-review.md § D. Paths are
// repo-root-relative, POSIX separators (node resolves them against the
// pinned cwd below on every platform).
//
// ADDING A FILE: append it here and nowhere else. If a P0/Phase item adds a
// new moving-OS correctness test, it belongs in this array in the same change
// that creates the file — otherwise the gate silently does not cover it.
const MOVING_OS_TESTS = [
  // Admin Book Move write path + its guards
  'src/lib/__tests__/admin-booking.test.ts',
  'src/lib/__tests__/admin-review-parity.test.ts',
  'src/lib/__tests__/admin-customer-locale.test.ts',
  'src/lib/__tests__/admin-route-coverage.test.ts',
  // Approval service: capture exactly once, atomic claim, rollback on failure
  'src/lib/__tests__/booking-approval.test.ts', // H4: P0-B/E rewrote booking-approval.ts
  'src/lib/__tests__/approval-convergence.test.ts', // B1: captured-but-uncommitted, and the replay that repairs it
  'src/lib/__tests__/reconciliation.test.ts', // B1: the money detector the convergence relies on
  // Estimate + crew/staffing
  'src/lib/__tests__/estimate-assistant.test.ts',
  'src/lib/__tests__/staffing-plan.test.ts',
  'src/lib/__tests__/staffing-repair-triggers.test.ts',
  'src/lib/__tests__/scheduling-guards.test.ts', // H4: the permission/conflict gates staffing rides
  // Day-level bookings: never invent an hour
  'src/lib/__tests__/day-level-scheduling.test.ts',
  'src/lib/__tests__/day-anchor-display.test.ts',
  'src/lib/__tests__/bot-command-dates.test.ts', // P0-C: Discord /job + /schedule
  'src/lib/__tests__/booking-display.test.ts', // H4: P0-C changed booking-display.ts (the Discord cards)
  // Migration-window honesty on the approval path
  'src/lib/__tests__/approval-deploy-window.test.ts',
  'src/lib/__tests__/migration-window.test.ts', // P0-E: fulfillment claim + pre-capture staffing
  // Stripe webhook durability + the truth of the fulfilment fan-out
  'src/lib/__tests__/webhook-durability.test.ts', // B3/B4: 200 only when queued-or-processed; handoff tally
  // Truck double-booking + the conflict codes underneath it
  'src/lib/__tests__/truck-conflicts.test.ts',
  'src/lib/__tests__/truck-hold.test.ts',
  'src/lib/__tests__/truck-lock.test.ts',
  'src/lib/__tests__/conflict-engine.test.ts', // H4: the codes/severities truck-conflicts asserts against
  // Lead lifecycle + Action Center scan honesty
  'src/lib/__tests__/lead-transitions.test.ts',
  'src/lib/__tests__/action-center-kick.test.ts',
  'src/lib/__tests__/scan-lock.test.ts', // H4: scanCoversBooking / claim + cooldown (P0-D, H2)
  'src/lib/__tests__/reminder-rules.test.ts', // H4: the rule engine + sync diff the scan claim covers
  // Recovery-sequence suppression, the scheduled money check, and the card the
  // owner reads (tranche-1 repair R5/R6/R7)
  'src/lib/__tests__/lifecycle-orchestration.test.ts', // R5: the journey orchestration the suppression lives in
  'src/lib/__tests__/recovery-suppression.test.ts', // R5: suppress only against proof, never against a status
  'src/lib/__tests__/scheduled-run-guard.test.ts', // R6: CRON_SECRET documented; a refused schedule alerts
  'src/lib/__tests__/discord-card-truth.test.ts', // R7: the Approved card prints only a verified amount
  // B6: an expired checkout must release its truck hold — and must NEVER cancel
  // a booking whose customer is mid-payment (the session-identity, own-clock and
  // grace guards, plus the sweep that is the net under a missed webhook)
  'src/lib/__tests__/checkout-expiry.test.ts',
  // B7/B8: the lifecycle blocker — ONE transactional service behind both the
  // admin status route and the Discord move-day card (Booking + Job + crew +
  // audit together, then the post-move messages), and the replay action that
  // rescues a job completed before it existed.
  'src/lib/__tests__/lifecycle-service.test.ts',
  // D3: the lifecycle EffectReport may not claim work that was never
  // scheduled. Two files because the flags they run under
  // (MARKETING_FOLLOWUPS_ENABLED / EMAIL_JOURNEYS_ENABLED) are module-level
  // consts read ONCE per process: `-report` is the SHIPPED DEFAULT (both off,
  // which is the reproduction), `-consent` runs with them on.
  'src/lib/__tests__/lifecycle-effect-report.test.ts',
  'src/lib/__tests__/lifecycle-effect-consent.test.ts',
  // C3/C4: the three narrow lifecycle holes (a thrown read reported as a
  // deliberate skip, a failure nobody read, `already_cancelled` for a COMPLETED
  // move) and the owner's release finishing the cancellation its two twins
  // perform — job, crew, journeys, and the checkout session a cancelled booking
  // can no longer consume.
  'src/lib/__tests__/lifecycle-release.test.ts',
  // C1/C2: no customer- or owner-facing string may state an amount, a capture,
  // a release or a refund the system cannot prove from the database.
  // `-proof-` is the money RULE and every renderer that prints a figure (the
  // Discord cards, the admin money card, the admin cancellation email, the
  // receipt route, the pre-approval hold figure and both outbox events);
  // `cancelled-` is release blocker B2 — the customer portal's payment state,
  // the denied card, the declined email, and the decline's release retry.
  'src/lib/__tests__/deposit-proof-truth.test.ts',
  'src/lib/__tests__/cancelled-booking-truth.test.ts',
]

// ── KNOWN BASELINE FAILURES — deliberately NOT in this run ──────────────
// MEASURED on branch claude/moving-os (not copied from a doc): `npm test` is red
// before anything on this branch changes, and the failures sit in exactly these
// files, in FOUR unrelated groups. They are pre-existing and unrelated to
// moving-OS correctness. Full write-up: docs/deployment.md.
// The gate asserts none of them is in MOVING_OS_TESTS, so the "this is not
// baseline noise" claim in the summary is verified rather than asserted.
//
// NUMBERS RULE (H4): nothing here hard-codes a total this file cannot re-derive.
// The failing-test total is SUMMED from the table below, and the `npm test` file
// count is read out of package.json at run time — a stale hand-typed total is
// exactly what H4 was opened to remove. `date` stamps only when this LIST (which
// files fail, and why) was last confirmed against a real run.
const BASELINE_FAILING_FILES = [
  { file: 'src/lib/__tests__/estimate.test.ts', fail: 5, why: 'stale $649 1BR constant in the test; the frozen price book says $550' },
  { file: 'src/lib/__tests__/pricing-config.test.ts', fail: 2, why: 'same stale $649 constant' },
  { file: 'src/lib/__tests__/pricing-parity.test.ts', fail: 1, why: 'sibling-site generated mirror (C:/WMIWCI-SITE) has drifted' },
  { file: 'src/lib/__tests__/pricing-browser-parity.test.ts', fail: 2, why: 'same sibling-site mirror' },
  { file: 'src/lib/__tests__/pricing-truck-parity.test.ts', fail: 2, why: 'same sibling-site mirror' },
  { file: 'src/lib/__tests__/services-page-parity.test.ts', fail: 4, why: 'sibling-site services page HTML has drifted' },
  { file: 'src/lib/__tests__/booking-access-review.test.ts', fail: 1, why: 'sibling-site pricing.html lost its package preselect links' },
  { file: 'src/lib/__tests__/email-lifecycle.test.ts', fail: 1, why: 'ENOENT on email-previews/ (gitignored; run `npm run preview:emails` first)' },
]
const BASELINE_FILE_PATHS = BASELINE_FAILING_FILES.map((b) => b.file)
// Derived, never typed: the per-file counts above are the source of truth.
const BASELINE_FAIL_TOTAL = BASELINE_FAILING_FILES.reduce((n, b) => n + b.fail, 0)
// Only the composition of that list is a "measurement"; totals are computed.
const BASELINE_CONFIRMED = '2026-08-14'

const BAR = '─'.repeat(72)

function fail(msg) {
  console.error(`\n${msg}\n`)
  process.exit(2)
}

// ── flags ───────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const KNOWN_FLAGS = ['--list', '--audit', '--help', '-h']
const unknown = argv.filter((a) => !KNOWN_FLAGS.includes(a))
if (unknown.length) {
  fail(`Unknown argument(s): ${unknown.join(' ')}\nUsage: node scripts/test-moving-os.mjs [--list | --audit]`)
}
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('Usage: node scripts/test-moving-os.mjs [--list | --audit]')
  console.log('  (no flags)  run the moving-OS correctness gate; exit 0 only if every test passes')
  console.log('  --list      print the test file list (one per line) and exit 0')
  console.log('  --audit     print a coverage report (gate vs `npm test` vs disk); runs no tests')
  process.exit(0)
}
if (argv.includes('--list')) {
  for (const f of MOVING_OS_TESTS) console.log(f)
  process.exit(0)
}

// ── pre-flight 1: duplicates ────────────────────────────────────────────
const seen = new Set()
const dupes = []
for (const f of MOVING_OS_TESTS) {
  if (seen.has(f)) dupes.push(f)
  seen.add(f)
}
if (dupes.length) {
  fail(`DUPLICATE entries in MOVING_OS_TESTS (remove them):\n  ${dupes.join('\n  ')}`)
}

// ── pre-flight 2: every file exists and is a real, non-empty file ───────
const missing = []
for (const f of MOVING_OS_TESTS) {
  try {
    const st = statSync(resolve(ROOT, f))
    if (!st.isFile()) missing.push(`${f}  (exists but is not a file)`)
    else if (st.size === 0) missing.push(`${f}  (exists but is EMPTY)`)
  } catch {
    missing.push(`${f}  (not found)`)
  }
}
if (missing.length) {
  fail(
    `MISSING TEST FILE(S) — nothing was run.\n  ${missing.join('\n  ')}\n\n` +
      `Fix the path in scripts/test-moving-os.mjs (MOVING_OS_TESTS) or restore the file.\n` +
      `A list that names a file which does not exist silently shrinks the gate, which is\n` +
      `why this check refuses to run the remaining files.`,
  )
}

// ── pre-flight 3: the gate must not contain a known-red baseline file ───
const overlap = MOVING_OS_TESTS.filter((f) => BASELINE_FILE_PATHS.includes(f))
if (overlap.length) {
  fail(
    `A KNOWN BASELINE-FAILING file is in MOVING_OS_TESTS:\n  ${overlap.join('\n  ')}\n\n` +
      `This gate reports "any failure here is a NEW regression". That sentence is only\n` +
      `true while the list excludes the known-red files. Either remove it from the list,\n` +
      `or fix the baseline failure and drop it from BASELINE_FAILING_FILES.`,
  )
}

// ── pre-flight 4: is every gate file also in the full suite? (advisory) ──
// package.json belongs to the orchestrator, so this REPORTS drift; it never
// edits and never blocks. A gate file absent from `npm test` still runs here.
function npmTestFiles() {
  try {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'))
    const script = pkg?.scripts?.test
    if (typeof script !== 'string') return null
    return script.split(/\s+/).filter((t) => t.endsWith('.test.ts'))
  } catch {
    return null
  }
}
const npmTest = npmTestFiles()
const notInFullSuite = npmTest ? MOVING_OS_TESTS.filter((f) => !npmTest.includes(f)) : []

// ── --audit: coverage report, runs nothing ──────────────────────────────
if (argv.includes('--audit')) {
  const testFilesOnDisk = (() => {
    const acc = []
    const walk = (dir) => {
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        const p = `${dir}/${e.name}`
        if (e.isDirectory()) {
          if (e.name !== 'node_modules' && e.name !== '.next') walk(p)
        } else if (e.name.endsWith('.test.ts')) {
          acc.push(p.slice(ROOT.length + 1).replace(/\\/g, '/'))
        }
      }
    }
    walk(`${ROOT}/src`)
    walk(`${ROOT}/app`)
    return acc.sort()
  })()
  const runByNothing = npmTest ? testFilesOnDisk.filter((f) => !npmTest.includes(f) && !MOVING_OS_TESTS.includes(f)) : []

  console.log(BAR)
  console.log('MOVING-OS GATE — COVERAGE AUDIT (no tests run)')
  console.log(BAR)
  console.log(`gate files            : ${MOVING_OS_TESTS.length}  (all present on disk — checked above)`)
  console.log(`\`npm test\` files      : ${npmTest ? npmTest.length : 'unreadable'}`)
  console.log(`*.test.ts on disk     : ${testFilesOnDisk.length}`)
  console.log('')
  console.log('Gate files not in `npm test` (the full suite would not catch them):')
  console.log(notInFullSuite.length ? notInFullSuite.map((f) => `  ${f}`).join('\n') : '  (none)')
  console.log('')
  console.log('Test files no npm script runs (exist, never executed):')
  console.log(runByNothing.length ? runByNothing.map((f) => `  ${f}`).join('\n') : '  (none)')
  console.log('')
  console.log(
    `Known baseline failures — list confirmed ${BASELINE_CONFIRMED}: ${BASELINE_FAIL_TOTAL} failing tests in ${BASELINE_FAILING_FILES.length} files`,
  )
  for (const b of BASELINE_FAILING_FILES) console.log(`  ${String(b.fail).padStart(2)}  ${b.file}\n      ${b.why}`)
  console.log(BAR)
  process.exit(0)
}

// ── resolve the local tsx CLI (no reliance on npx / PATH / shell) ───────
const require = createRequire(import.meta.url)
let tsxCli
try {
  tsxCli = resolve(dirname(require.resolve('tsx/package.json')), 'dist/cli.mjs')
  statSync(tsxCli)
} catch {
  fail(
    `Could not locate the local tsx CLI (node_modules/tsx/dist/cli.mjs).\n` +
      `Run \`npm install\` in ${ROOT} first — these are TypeScript tests and node cannot run them directly.`,
  )
}

// ── run ─────────────────────────────────────────────────────────────────
console.log(BAR)
console.log('MOVING-OS CORRECTNESS GATE  (offline: no database, no network)')
console.log(`root : ${ROOT}`)
console.log(`files: ${MOVING_OS_TESTS.length} listed, ${MOVING_OS_TESTS.length} present`)
if (notInFullSuite.length) {
  console.log('')
  console.log(`NOTE: ${notInFullSuite.length} gate file(s) are not in package.json's \`test\` script, so the`)
  console.log('      full suite does not cover them. They still run here:')
  for (const f of notInFullSuite) console.log(`      - ${f}`)
}
console.log(BAR)

const started = Date.now()
// cwd is PINNED to the repo root, not inherited: several of these tests read
// source files through process.cwd() (e.g. action-center-kick.test.ts reads
// src/lib/reminder-sync.ts, admin-route-coverage/day-anchor-display/
// approval-deploy-window set ROOT = process.cwd()). Running from any other
// directory turns real source guards into spurious failures — verified.
const child = spawn(process.execPath, [tsxCli, '--test', ...MOVING_OS_TESTS], {
  cwd: ROOT,
  stdio: ['inherit', 'pipe', 'pipe'],
  env: process.env,
})

let out = ''
child.stdout.on('data', (b) => {
  const s = b.toString()
  out += s
  process.stdout.write(s)
})
child.stderr.on('data', (b) => {
  const s = b.toString()
  out += s
  process.stderr.write(s)
})

child.on('error', (e) => fail(`Failed to start the test runner: ${e.message}`))

child.on('close', (code, signal) => {
  const seconds = ((Date.now() - started) / 1000).toFixed(1)

  // ── parse node's TAP tail ─────────────────────────────────────────────
  const lines = out.split(/\r?\n/)
  const counter = (name) => {
    // Take the LAST occurrence: the top-level summary is printed at the end.
    let v = null
    const re = new RegExp(`^# ${name} (\\d+)$`)
    for (const l of lines) {
      const m = re.exec(l.trim())
      if (m) v = Number(m[1])
    }
    return v
  }
  const total = counter('tests')
  const passed = counter('pass')
  const failed = counter('fail')
  const skipped = counter('skipped')

  // Failing test names + the file each came from.
  const failures = []
  for (let i = 0; i < lines.length; i++) {
    const m = /^not ok \d+ - (.*)$/.exec(lines[i])
    if (!m) continue
    let file = '(file unknown)'
    for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
      const loc = /^\s*location:\s*'(.+)'\s*$/.exec(lines[j])
      if (loc) {
        file = loc[1].replace(/\\\\/g, '\\').replace(/^.*[\\/](src[\\/].*?\.test\.ts).*$/, '$1').replace(/\\/g, '/')
        break
      }
      if (/^not ok \d+ - /.test(lines[j])) break
    }
    failures.push({ name: m[1], file })
  }

  console.log('')
  console.log(BAR)
  console.log('MOVING-OS GATE SUMMARY')
  console.log(
    `  files ${MOVING_OS_TESTS.length}   tests ${total ?? '?'}   pass ${passed ?? '?'}   fail ${failed ?? '?'}` +
      `${skipped ? `   skipped ${skipped}` : ''}   ${seconds}s`,
  )

  if (failures.length) {
    console.log('')
    console.log(`  FAILING (${failures.length}):`)
    const byFile = new Map()
    for (const f of failures) {
      if (!byFile.has(f.file)) byFile.set(f.file, [])
      byFile.get(f.file).push(f.name)
    }
    for (const [file, names] of byFile) {
      console.log(`    ${file}`)
      for (const n of names) console.log(`      - ${n}`)
    }
  }

  // Unparseable output is NOT a pass. If node's summary could not be read the
  // gate says so in its own words instead of implying a behaviour regression.
  const unreadable = failed === null
  const bad = code !== 0 || signal != null || (failed ?? 1) > 0
  console.log('')
  if (unreadable) {
    if (signal) console.log(`  runner killed by signal ${signal}`)
    console.log('  RESULT: FAIL — could not read the test summary from the runner output.')
    console.log(`  (child exit code ${code}). Nothing is claimed about these ${MOVING_OS_TESTS.length} files: re-run and`)
    console.log('  read the output above. Treat this as NOT VERIFIED, not as "passed".')
  } else if (bad) {
    if (signal) console.log(`  runner killed by signal ${signal}`)
    console.log('  RESULT: FAIL — a moving-OS correctness test is red. DO NOT DEPLOY.')
    console.log('')
    console.log(`  This is NOT the known pricing/site-parity baseline: none of the ${BASELINE_FAILING_FILES.length}`)
    console.log('  known-red files is in this list (checked above before the run).')
    console.log('  A failure here means a behaviour this system depends on changed.')
  } else {
    console.log('  RESULT: PASS — no moving-OS correctness regression.')
    console.log('')
    console.log('  Scope note (so this is not read as more than it is): this gate covers the')
    console.log(`  ${MOVING_OS_TESTS.length} files listed above and nothing else. The full suite (\`npm test\`) runs`)
    console.log(
      `  ${npmTest ? npmTest.length : 'an unreadable number of'} files and carries ${BASELINE_FAILING_FILES.length} known-red files / ${BASELINE_FAIL_TOTAL} failing tests` +
        ` (list confirmed ${BASELINE_CONFIRMED})`,
    )
    console.log('  — see docs/deployment.md "Known baseline failures". Those are NOT fixed by')
    console.log('  this run and are not covered by it.')
  }
  console.log(BAR)

  process.exit(bad ? 1 : 0)
})
