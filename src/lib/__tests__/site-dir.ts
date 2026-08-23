// ════════════════════════════════════════════════════════════════════════
//  site-dir.ts — WHICH WMIWCI-SITE checkout the cross-repository tests grade.
//
//  NOT a test file (no `.test.ts`), so the enforced test gate ignores it.
//
//  ── WHY THERE IS NO SIBLING FALLBACK ANY MORE ─────────────────────────
//  These tests used to default to `../../../../WMIWCI-SITE`, so they graded
//  whatever branch happened to be checked out next door rather than the branch
//  being released. That is how a mirror missing its `legacy` flags reached
//  production while the suite stayed green — and it made a local run and a CI
//  run mean different things, because CI has no sibling directory at all.
//
//  So the tree is now OPT-IN and explicit:
//
//    WMIWCI_SITE_DIR set   → grade exactly that tree; if it is wrong, THROW.
//                            A pointed-at tree may never silently skip.
//    WMIWCI_SITE_DIR unset → SKIP, and say so. A cross-repository claim
//                            nobody asked for is not a claim worth making.
//
//  CI runs the whole cross-repository gate in its own job with the variable
//  set, so "skipped" locally never hides "unverified" on a release.
// ════════════════════════════════════════════════════════════════════════
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

/** The site tree under test, or null when the gate was not asked for. */
export const SITE_DIR: string | null = process.env.WMIWCI_SITE_DIR
  ? resolve(process.env.WMIWCI_SITE_DIR)
  : null

if (SITE_DIR && !existsSync(SITE_DIR)) {
  throw new Error(
    `WMIWCI_SITE_DIR=${process.env.WMIWCI_SITE_DIR} does not exist — ` +
      'the cross-repository gate cannot be proven against a tree that is not there',
  )
}

/** `{ skip }` for node:test. Falsey when the gate should run. */
export const SKIP_WITHOUT_SITE: false | string = SITE_DIR
  ? false
  : 'set WMIWCI_SITE_DIR to run the cross-repository gate (CI does this in the pricing-parity job)'

/** Absolute path to a file inside the site tree. Never call without SITE_DIR;
 *  every caller is guarded by SKIP_WITHOUT_SITE. */
export function siteFile(relative: string): string {
  return SITE_DIR ? resolve(SITE_DIR, relative) : ''
}
