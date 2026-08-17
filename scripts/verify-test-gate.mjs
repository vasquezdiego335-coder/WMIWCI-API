// ════════════════════════════════════════════════════════════════════════════
//  verify-test-gate.mjs — prove that every test file is actually RUN.
//  ------------------------------------------------------------------------
//  The `test` script in package.json is an explicit list of files, not a glob.
//  That is deliberate (it controls ordering and excludes archived trees), but it
//  has a failure mode a glob does not: a test file can be added, committed and
//  reviewed while never running in CI. It looks like coverage and is not.
//
//  This script fails the build if any *.test.ts under src/ is missing from the
//  gate. Run it as part of verification:  node scripts/verify-test-gate.mjs
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const testScript = JSON.parse(readFileSync('package.json', 'utf8')).scripts.test
const inGate = new Set(testScript.match(/[\w/.\-[\]]+\.test\.ts/g) ?? [])

/** Every *.test.ts that exists on disk, in POSIX form to match the gate list. */
function findTests(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...findTests(full))
    else if (entry.name.endsWith('.test.ts')) out.push(full.split('\\').join('/'))
  }
  return out
}

const found = findTests('src')
const missing = found.filter((f) => !inGate.has(f))
const ghosts = [...inGate].filter((f) => !found.includes(f))

console.log(`test files that EXIST on disk : ${found.length}`)
console.log(`test files listed IN THE GATE : ${inGate.size}`)
console.log(`exist but NOT in the gate     : ${missing.length}`)
console.log(`in the gate but MISSING on disk: ${ghosts.length}`)

for (const m of missing) console.log(`  NOT RUN -> ${m}`)
for (const g of ghosts) console.log(`  GHOST   -> ${g}`)

if (missing.length || ghosts.length) {
  console.error('\nFAIL: the enforced test gate does not match the test files on disk.')
  process.exit(1)
}
console.log('\nPASS: every test file on disk is in the enforced gate.')
