// admin-csrf-guard.test.ts — a source guard, not a runtime test.
//
// The admin middleware CSRF-gates every state-mutating call to `/api/admin/*`
// and `/api/crew/*` (double-submit cookie → X-CSRF-Token header). A client
// component that fires a POST/PATCH/DELETE to those routes WITHOUT sending the
// token gets a 403 "Invalid CSRF token" in the browser — even though it works
// in an API-level test that sets the header by hand. The entire email-marketing
// admin shipped with exactly this bug (every write 403'd); this guard fails the
// build if any admin client component regresses the same way.
//
// The contract a mutating admin component must satisfy: it either imports the
// shared `csrfHeader` helper, or reads the `moveit_csrf` cookie inline and sets
// `X-CSRF-Token` itself (a couple of older components do the latter).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ADMIN_ROOT = join(process.cwd(), 'app', '(admin)')

// Routes the middleware CSRF-gates. A mutating fetch to one of these needs the token.
const GATED = /\/api\/(admin|crew)\//

// Login posts to /api/auth/login, which is NOT in the middleware matcher, so it
// is intentionally exempt from the CSRF requirement.
const EXEMPT_FILES = new Set(['login/page.tsx'])

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (p.endsWith('.tsx') || p.endsWith('.ts')) out.push(p)
  }
  return out
}

test('every mutating admin client component sends the CSRF token', () => {
  const offenders: string[] = []

  for (const file of walk(ADMIN_ROOT)) {
    const rel = file.slice(ADMIN_ROOT.length + 1).replace(/\\/g, '/')
    if ([...EXEMPT_FILES].some((e) => rel.endsWith(e))) continue

    const src = readFileSync(file, 'utf8')

    // Only client components issue browser fetches.
    const mutates = /method:\s*['"](POST|PATCH|DELETE|PUT)['"]/.test(src)
    if (!mutates) continue

    // Does it touch a CSRF-gated route at all? (Server-relative or absolute.)
    const hitsGated = GATED.test(src)
    if (!hitsGated) continue

    // Contract: imports/uses the shared helper, OR sends X-CSRF-Token inline.
    const sendsToken = src.includes('csrfHeader') || src.includes('X-CSRF-Token')
    if (!sendsToken) offenders.push(rel)
  }

  assert.deepEqual(
    offenders,
    [],
    `these admin client components fire a mutating fetch to /api/admin or /api/crew ` +
      `without sending the CSRF token (they will 403 in the browser):\n  ${offenders.join('\n  ')}`
  )
})
