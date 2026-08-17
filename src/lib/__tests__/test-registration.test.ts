// ════════════════════════════════════════════════════════════════════════
//  test-registration.test.ts — the test list polices itself.
//
//  `npm test` runs an EXPLICIT file list (tsx --test needs the paths spelled
//  out on Node 20), which means a new *.test.ts file that nobody adds to
//  package.json silently never runs — green CI, zero coverage. Four quote-*
//  suites were found unregistered exactly this way (2026-08-17 audit).
//
//  This test makes that failure LOUD: every *.test.ts under the two test
//  roots must appear in the npm test script, and every listed file must
//  exist. Registering THIS file is enough to protect all future ones.
// ════════════════════════════════════════════════════════════════════════
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'

const ROOT = resolve(__dirname, '../../..')

const TEST_DIRS = ['src/lib/__tests__', 'src/emails/__tests__']

function registeredFiles(): Set<string> {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    scripts: { test: string }
  }
  return new Set(pkg.scripts.test.match(/\S+\.test\.ts/g) ?? [])
}

function diskFiles(): string[] {
  return TEST_DIRS.flatMap((dir) =>
    readdirSync(join(ROOT, dir))
      .filter((f) => f.endsWith('.test.ts'))
      .map((f) => `${dir}/${f}`),
  )
}

test('every *.test.ts on disk is registered in the npm test script', () => {
  const reg = registeredFiles()
  const missing = diskFiles().filter((f) => !reg.has(f))
  assert.deepEqual(
    missing,
    [],
    `Unregistered test files — add them to the "test" script in package.json:\n  ${missing.join('\n  ')}`,
  )
})

test('every file the npm test script lists actually exists', () => {
  const gone = Array.from(registeredFiles()).filter((f) => !existsSync(join(ROOT, f)))
  assert.deepEqual(
    gone,
    [],
    `The npm test script references files that do not exist:\n  ${gone.join('\n  ')}`,
  )
})
