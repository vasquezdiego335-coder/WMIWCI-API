// ════════════════════════════════════════════════════════════════════════
//  parity-registration.test.ts — every SITE-dependent test must be in the
//  cross-repository command, and must resolve the SITE the opt-in way.
//
//  WHY THIS EXISTS. Three cross-repository suites — booking-access-review,
//  deposit-social-meta, deposit-terms-parity — were absent from `test:parity`
//  AND resolved the SITE from a hard-coded sibling path. The combination is
//  the worst of both: locally they graded whatever branch happened to sit in
//  the next directory, and in CI, where no sibling exists, all of their
//  assertions skipped and the run still went green. Coverage that reports
//  itself as passing while executing nothing is worse than no coverage,
//  because it is quoted in a release report.
//
//  A file is SITE-DEPENDENT if its CODE — comments stripped — reads
//  WMIWCI_SITE_DIR, mentions the WMIWCI-SITE checkout, or calls siteFile().
//  Comments are stripped because a suite that merely explains what the SITE is
//  should not be dragged into the cross-repository job.
//
//  Pure text analysis. No database, no network, no SITE checkout required.
// ════════════════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(__dirname, '../../..')
const TESTS_DIR = resolve(ROOT, 'src/lib/__tests__')

/** Comments are prose. Line comments are stripped only at line start so a
 *  `https://` inside a string survives. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

const SITE_MARKER = /WMIWCI_SITE_DIR|WMIWCI-SITE|siteFile\(/

function testFiles(): string[] {
  return readdirSync(TESTS_DIR).filter((f) => f.endsWith('.test.ts')).sort()
}

function siteDependent(): string[] {
  return testFiles().filter((f) => SITE_MARKER.test(stripComments(readFileSync(resolve(TESTS_DIR, f), 'utf8'))))
}

const parityScript = (): string =>
  JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).scripts['test:parity'] as string

test('every SITE-dependent test file is registered in test:parity', () => {
  const script = parityScript()
  const missing = siteDependent().filter((f) => !script.includes(`src/lib/__tests__/${f}`))
  assert.deepEqual(
    missing,
    [],
    'these suites need the SITE checkout but are absent from `npm run test:parity`, so they skip ' +
      'in CI while the run reports success:\n  ' + missing.join('\n  '),
  )
})

test('the SITE-dependent set is not empty', () => {
  // A detector that silently matches nothing would make the test above pass
  // forever. If the marker regex or the directory ever moves, fail here.
  const dep = siteDependent()
  assert.ok(dep.length >= 10, `expected the cross-repository set to be substantial, found ${dep.length}`)
  for (const required of [
    'pricing-parity.test.ts',
    'quote-page-browser.test.ts',
    'booking-access-review.test.ts',
    'deposit-social-meta.test.ts',
    'deposit-terms-parity.test.ts',
  ]) {
    assert.ok(dep.includes(required), `${required} must be detected as SITE-dependent`)
  }
})

test('no SITE-dependent test resolves a hard-coded sibling checkout', () => {
  // The other half of the defect. Registration alone does not help a file that
  // reads `../WMIWCI-SITE` or `C:\WMIWCI-SITE` directly: pointing the job at
  // the released commit would still grade a stranger's working copy.
  const offenders: string[] = []
  for (const f of siteDependent()) {
    const code = stripComments(readFileSync(resolve(TESTS_DIR, f), 'utf8'))
    if (/['"`][^'"`]*\.\.[\\/]+WMIWCI-SITE/.test(code) || /['"`]\s*[A-Za-z]:\\\\?WMIWCI-SITE/.test(code)) {
      offenders.push(f)
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'these suites resolve a hard-coded WMIWCI-SITE path instead of WMIWCI_SITE_DIR, so they grade ' +
      'whatever tree sits next door:\n  ' + offenders.join('\n  '),
  )
})

test('test:parity and the enforced test gate stay in step', () => {
  // Every parity entry must be a file that exists, or the job dies on a
  // missing path and the failure looks like a test failure.
  const script = parityScript()
  const refRe = /src\/lib\/__tests__\/([\w.-]+\.test\.ts)/g
  const referenced: string[] = []
  for (let m = refRe.exec(script); m; m = refRe.exec(script)) referenced.push(m[1])
  const present = new Set(testFiles())
  const ghosts = referenced.filter((f) => !present.has(f))
  assert.deepEqual(ghosts, [], `test:parity names files that do not exist:\n  ${ghosts.join('\n  ')}`)
})
