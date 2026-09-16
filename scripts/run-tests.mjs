// ════════════════════════════════════════════════════════════════════════════
//  run-tests.mjs — run EXACTLY the files listed in package.json "testFiles".
//  ------------------------------------------------------------------------
//  WHY THIS EXISTS. The gate is an explicit file list, not a glob: it controls
//  ordering and excludes archived trees, and scripts/verify-test-gate.mjs plus
//  src/lib/__tests__/test-registration.test.ts fail the build when a file on
//  disk is missing from it.
//
//  The list used to be spelled out inside the "test" script itself. At 187
//  files that string passed 8191 characters — the Windows command-line limit —
//  and `npm test` died with "The command line is too long." before a single
//  test ran. A developer machine that cannot run the suite is a suite that
//  stops being run.
//
//  So the list moved to a "testFiles" ARRAY in package.json and this runner
//  spawns tsx with it directly (no shell, so only the 32 KB CreateProcess
//  limit applies). The list is still one reviewable place in package.json, and
//  both gate checks read the same array.
//
//  Extra arguments are passed through:  npm test -- --test-name-pattern=foo
// ════════════════════════════════════════════════════════════════════════════
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const files = pkg.testFiles

if (!Array.isArray(files) || files.length === 0) {
  console.error('package.json "testFiles" must be a non-empty array of test paths.')
  process.exit(1)
}

// tsx's own CLI, run by THIS node binary. Not `npx`: on Windows that is a .cmd
// shim, and Node 20 refuses to spawn one without a shell (EINVAL) — and a shell
// is exactly what the long file list must avoid. The path is read from tsx's
// package.json "bin" (its "exports" map does not expose dist/, so
// require.resolve('tsx/dist/cli.mjs') throws ERR_PACKAGE_PATH_NOT_EXPORTED).
const require = createRequire(import.meta.url)
const tsxPkgUrl = new URL('../node_modules/tsx/package.json', import.meta.url)
let tsxCli
try {
  const bin = JSON.parse(readFileSync(tsxPkgUrl, 'utf8')).bin
  const rel = typeof bin === 'string' ? bin : bin.tsx
  tsxCli = fileURLToPath(new URL(rel, tsxPkgUrl))
} catch {
  // A hoisted install (tsx above this package) still resolves by module id.
  tsxCli = require.resolve('tsx')
}

const passthrough = process.argv.slice(2)
const args = [tsxCli, '--test', ...passthrough, ...files]

const child = spawn(process.execPath, args, {
  stdio: 'inherit',
  // No shell: the argument vector goes straight to the OS, so a long file list
  // is never re-parsed by cmd.exe or /bin/sh.
  shell: false,
})

child.on('error', (err) => {
  console.error(`could not start the test runner: ${err.message}`)
  process.exit(1)
})
child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`test runner terminated by signal ${signal}`)
    process.exit(1)
  }
  process.exit(code ?? 1)
})
