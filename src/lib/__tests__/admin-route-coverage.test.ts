// admin-route-coverage.test.ts — a source guard, not a runtime test.
//
// THE BUG CLASS THIS EXISTS TO KILL (fix-doc item 8):
// middleware.ts holds the auth gate in TWO places that must agree —
//   1. PROTECTED_ROUTES: "this path needs a session with these roles"
//   2. config.matcher:   "run middleware on this path AT ALL"
// A path listed in (1) but missing from (2) is silently ungated: Next never
// invokes the middleware, so the allowlist entry reads as protection while no
// check ever runs. The repo has a live precedent (/api/files/upload sat in
// PROTECTED_ROUTES with no matcher entry) and Moving OS Phase 1 shipped the
// same gap on /admin/book, /admin/trucks, /admin/leads and /admin/leads/[id].
//
// The tests below compile the matcher the way NEXT ITSELF compiles it (its own
// vendored path-to-regexp, plus the exact source wrapping from
// next/dist/build/analysis/get-page-static-info.js → getMiddlewareMatchers), so
// "this path is covered" is a fact about the built middleware, not an
// approximation of it. Offline and pure: reads source files, touches no DB.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const ROOT = process.cwd()
const MIDDLEWARE_SRC = readFileSync(join(ROOT, 'middleware.ts'), 'utf8')

// ── Next's own path compiler ──────────────────────────────────────────────
// Not the root `path-to-regexp` dependency (that is express's 0.1.x and has
// different semantics) — the copy Next actually uses for middleware matchers.
const nodeRequire = createRequire(join(ROOT, 'package.json'))
type PathToRegexp = {
  parse(source: string): unknown[]
  tokensToRegexp(tokens: unknown[]): RegExp
}
const ptr = nodeRequire('next/dist/compiled/path-to-regexp') as PathToRegexp

// getMiddlewareMatchers() rewrites every matcher source before compiling:
//   `/:nextData(_next/data/[^/]{1,})?${source}(.json)?`
// (an i18n prefix and basePath are prepended too — this app configures
// neither, which the first test below pins down so this stays faithful).
function middlewareRegex(source: string): RegExp {
  const wrapped = `/:nextData(_next/data/[^/]{1,})?${source}(.json)?`
  return new RegExp(ptr.tokensToRegexp(ptr.parse(wrapped)).source)
}

// ── Parse the two halves of the gate out of middleware.ts ─────────────────
function stripComments(line: string): string {
  return line.replace(/\/\/.*$/, '')
}

function extractMatcher(src: string): string[] {
  const start = src.indexOf('matcher: [')
  assert.ok(start > -1, 'middleware.ts must export config.matcher')
  const end = src.indexOf('\n  ],', start)
  assert.ok(end > start, 'could not find the end of the matcher array')
  return src
    .slice(start, end)
    .split('\n')
    .map(stripComments)
    .flatMap((line) => Array.from(line.matchAll(/'([^']+)'/g), (m) => m[1]))
}

type ProtectedRoute = { source: string; regex: RegExp; roles: string[] }

function extractProtectedRoutes(src: string): ProtectedRoute[] {
  const start = src.indexOf('const PROTECTED_ROUTES')
  assert.ok(start > -1, 'middleware.ts must declare PROTECTED_ROUTES')
  const end = src.indexOf('\n]', start)
  assert.ok(end > start, 'could not find the end of PROTECTED_ROUTES')
  const body = src
    .slice(start, end)
    .split('\n')
    .map(stripComments)
    .join('\n')

  const out: ProtectedRoute[] = []
  const entries = Array.from(body.matchAll(/pattern:\s*\/(.+?)\/\s*,\s*roles:\s*\[([^\]]*)\]/g))
  for (const m of entries) {
    out.push({
      source: m[1],
      regex: new RegExp(m[1]),
      roles: Array.from(m[2].matchAll(/UserRole\.(\w+)/g), (r) => r[1]),
    })
  }
  assert.ok(out.length > 0, 'parsed zero PROTECTED_ROUTES entries — parser drifted')
  return out
}

const MATCHER = extractMatcher(MIDDLEWARE_SRC)
const MATCHER_REGEXPS = MATCHER.map((source) => ({ source, regex: middlewareRegex(source) }))
const PROTECTED_ROUTES = extractProtectedRoutes(MIDDLEWARE_SRC)

/** The matcher entry that makes middleware RUN for this path (null = never runs). */
function matcherEntryFor(pathname: string): string | null {
  return MATCHER_REGEXPS.find((m) => m.regex.test(pathname))?.source ?? null
}

/** The roles middleware would demand — mirrors the `.find()` in middleware.ts. */
function rolesFor(pathname: string): string[] | null {
  return PROTECTED_ROUTES.find((r) => r.regex.test(pathname))?.roles ?? null
}

/** Both halves must agree, or the gate is decorative. */
function assertGated(pathname: string, roles: string[]): void {
  const entry = matcherEntryFor(pathname)
  assert.ok(
    entry,
    `${pathname} is NOT in config.matcher — middleware never runs for it, so its ` +
      `PROTECTED_ROUTES entry is dead (the /api/files/upload bug class)`
  )
  assert.deepEqual(
    rolesFor(pathname),
    roles,
    `${pathname} matched matcher entry '${entry}' but resolved to the wrong role set`
  )
}

const ADMIN_ROLES = ['OWNER', 'MANAGER']
const CREW_ROLES = ['OWNER', 'MANAGER', 'CREW']

// ── 0. The compilation above is only faithful if these stay unset ─────────
test('next.config sets neither basePath nor i18n (matcher compilation fidelity)', () => {
  const cfg = readFileSync(join(ROOT, 'next.config.mjs'), 'utf8')
    .split('\n')
    .map(stripComments)
    .join('\n')
  assert.ok(!/\bbasePath\s*:/.test(cfg), 'basePath would prefix every matcher source')
  assert.ok(!/\bi18n\s*:/.test(cfg), 'i18n locales would prefix every matcher source')
})

// ── 1. Phase 1 pages ──────────────────────────────────────────────────────
test('Phase 1 admin pages are covered by config.matcher (incl. a concrete [id])', () => {
  for (const p of [
    '/admin/book',
    '/admin/trucks',
    '/admin/leads',
    '/admin/leads/abc123', // the [id] detail page, as a real request path
  ]) {
    assertGated(p, ADMIN_ROLES)
  }
})

// ── 2. Phase 1 API routes ─────────────────────────────────────────────────
test('every Phase 1 /api/admin route is covered, including [id] instances', () => {
  for (const p of [
    '/api/admin/bookings', // POST added in Phase 1
    '/api/admin/trucks',
    '/api/admin/trucks/abc123',
    '/api/admin/leads',
    '/api/admin/leads/abc123',
    '/api/admin/estimate/recommend',
    '/api/admin/customers/search',
    '/api/admin/inventory/catalog',
  ]) {
    assertGated(p, ADMIN_ROLES)
  }
})

// ── 3. Systemic: every admin surface ON DISK, not just the ones we listed ──
// This is what actually closes the bug class. Adding a page or route without a
// matcher entry fails here, the way /admin/leads/[id] would have.
function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

/** app/(admin)/admin/(dashboard)/leads/[id]/page.tsx → /admin/leads/abc123 */
function urlPathFor(file: string, leaf: 'page.tsx' | 'route.ts'): string {
  return file
    .slice(join(ROOT, 'app').length)
    .replace(/\\/g, '/')
    .replace(new RegExp(`/${leaf.replace('.', '\\.')}$`), '')
    .split('/')
    .filter((seg) => !(seg.startsWith('(') && seg.endsWith(')'))) // route groups
    .map((seg) => (seg.startsWith('[') ? 'abc123' : seg)) // dynamic segments
    .join('/')
}

// /admin/login must stay OUT of the matcher: middleware redirects an
// unauthenticated request to /admin/login, so gating that page would redirect
// it to itself forever.
const PAGE_EXEMPT = new Set(['/admin/login'])

test('every admin page on disk is covered by config.matcher', () => {
  const uncovered = walk(join(ROOT, 'app', '(admin)'))
    .filter((f) => f.endsWith('page.tsx'))
    .map((f) => urlPathFor(f, 'page.tsx'))
    .filter((p) => !PAGE_EXEMPT.has(p))
    .filter((p) => !matcherEntryFor(p))

  assert.deepEqual(
    uncovered,
    [],
    `these admin pages exist but middleware never runs for them (add them to ` +
      `config.matcher in middleware.ts):\n  ${uncovered.join('\n  ')}`
  )
})

test('every /api/admin route on disk is covered and resolves to OWNER+MANAGER', () => {
  const routes = walk(join(ROOT, 'app', 'api', 'admin'))
    .filter((f) => f.endsWith('route.ts'))
    .map((f) => urlPathFor(f, 'route.ts'))

  assert.ok(routes.length > 50, `expected the full admin API surface, saw ${routes.length}`)
  for (const p of routes) assertGated(p, ADMIN_ROLES)
})

// ── 4. Proof we did not over-extend ───────────────────────────────────────
test('/admin/login stays unmatched (otherwise the login redirect loops)', () => {
  assert.equal(matcherEntryFor('/admin/login'), null)
  // It is still inside the PROTECTED_ROUTES pattern — that is exactly why it
  // must not be matched.
  assert.deepEqual(rolesFor('/admin/login'), ADMIN_ROLES)
})

// ── 5. Proof we did not weaken anything that already worked ───────────────
test('pre-existing coverage is intact (pages, admin API, crew surface)', () => {
  for (const p of [
    '/admin',
    '/admin/bookings',
    '/admin/bookings/abc123',
    '/admin/customers/abc123',
    '/admin/jobs/abc123',
    '/admin/staff/abc123',
    '/admin/schedule',
    '/admin/scheduling',
    '/admin/queues',
    '/admin/reports/profit-loss',
    '/admin/payments',
    '/admin/discounts',
    '/admin/expenses',
    '/admin/owner-money',
    '/admin/action-center',
    '/admin/roadmap',
    '/admin/logs',
    '/api/admin/expenses/abc123',
  ]) {
    assertGated(p, ADMIN_ROLES)
  }

  // Stage 5 crew surface keeps CREW in its role set (an admin-only role set
  // here would lock the crew out of their own pages).
  for (const p of ['/crew', '/crew/jobs/abc123', '/api/crew/assignments/abc123/clock']) {
    assertGated(p, CREW_ROLES)
  }
})

test('admin surfaces never admit CREW', () => {
  for (const p of ['/admin', '/admin/book', '/admin/trucks', '/api/admin/leads/abc123']) {
    assert.ok(!(rolesFor(p) ?? []).includes('CREW'), `${p} must not admit CREW`)
  }
})

// ── 6. The allowlist/matcher agreement itself ─────────────────────────────
// One probe path per PROTECTED_ROUTES entry. A new allowlist entry with no
// probe fails loudly, so the pairing can't silently rot again.
const PROBES = [
  '/admin/bookings',
  '/api/admin/leads/abc123',
  '/api/files/upload',
  '/crew/jobs/abc123',
  '/api/crew/assignments/abc123/clock',
]

// /api/files/upload is allowlisted but INTENTIONALLY unmatched: the route
// authenticates a staff session OR a customer `x-booking-token` itself
// (app/api/files/upload/route.ts). Matching it would make middleware demand a
// staff session and 401 every customer document upload — and would CSRF-gate a
// POST that customers make without the admin cookie. The route's own check is
// the real gate; this exemption is deliberate, not another instance of the bug.
const MATCHER_EXEMPT_PROBES = new Set(['/api/files/upload'])

test('every PROTECTED_ROUTES entry is reachable by the matcher (or documented)', () => {
  for (const entry of PROTECTED_ROUTES) {
    const hits = PROBES.filter((p) => entry.regex.test(p))
    assert.ok(
      hits.length > 0,
      `PROTECTED_ROUTES entry /${entry.source}/ has no probe path in this test — ` +
        `add one so its matcher coverage is actually verified`
    )
    for (const p of hits) {
      if (MATCHER_EXEMPT_PROBES.has(p)) continue
      assert.ok(
        matcherEntryFor(p),
        `PROTECTED_ROUTES declares roles for ${p} but config.matcher never runs ` +
          `middleware there — the gate is decorative`
      )
    }
  }
})

test('the exemption list stays exactly one documented entry', () => {
  assert.deepEqual(Array.from(MATCHER_EXEMPT_PROBES), ['/api/files/upload'])
})
