// ════════════════════════════════════════════════════════════════════════
//  ENVIRONMENT OWNERSHIP SCAN — which SERVICE reads which variable
//  ---------------------------------------------------------------------
//  Production runs this repository as TWO Railway services with SEPARATE
//  variable sets: the Next.js API ("wonderful-strength") and the combined
//  worker host ("discord workers": BullMQ workers, the scheduled worker, the
//  Discord bot). On 2026-09-14 EMAIL_MARKETING_AGENT_ENABLED was set on the API
//  and missing on the worker — the only service that runs campaign discovery —
//  so the feature silently never ran while the admin page said ACTIVE.
//
//  This scanner is the evidence behind docs/env-ownership.json. It finds every
//  literal environment-variable read in src/, app/ and middleware.ts and decides,
//  from the static import graph, whether code reachable from each service's
//  entrypoint reads it:
//    worker = modules reachable from src/worker-host.ts
//    api    = modules reachable from app/** and middleware.ts
//  It over-approximates (a reachable module may not call the reading function
//  on that service), so the manifest may declare `workerReachableUnused` with a
//  reason instead of listing the worker as an owner.
//
//  Pure filesystem reads; no environment VALUE is ever touched.
// ════════════════════════════════════════════════════════════════════════

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'

const EXTS = ['.ts', '.tsx', '.js', '.mjs', '.cjs']
const SKIP_DIRS = new Set(['node_modules', '__tests__', '.next', 'email-previews'])

export type EnvRead = { name: string; files: string[] }
export type EnvOwnershipScan = {
  /** name → service readers computed from the import graph. */
  readers: Map<string, { api: boolean; worker: boolean; files: string[] }>
  workerModules: number
  apiModules: number
}

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(p, out)
    } else if (EXTS.includes(extname(e.name)) && !/\.test\.[cm]?[jt]sx?$/.test(e.name)) {
      out.push(p)
    }
  }
  return out
}

function resolveImport(root: string, from: string, spec: string): string | null {
  let base: string
  if (spec.startsWith('@/')) base = join(root, 'src', spec.slice(2))
  else if (spec.startsWith('.')) base = resolve(dirname(from), spec)
  else return null
  const candidates = [base, ...EXTS.map((x) => base + x), ...EXTS.map((x) => join(base, 'index' + x))]
  for (const c of candidates) if (existsSync(c) && statSync(c).isFile()) return c
  return null
}

const IMPORT_RE =
  /(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g
const ENV_RES = [/process\.env\.([A-Z][A-Z0-9_]*)/g, /process\.env\[\s*['"`]([A-Z][A-Z0-9_]*)['"`]\s*\]/g]

export function scanEnvOwnership(root: string): EnvOwnershipScan {
  const files = [...walk(join(root, 'src')), ...walk(join(root, 'app'))]
  const mw = join(root, 'middleware.ts')
  if (existsSync(mw)) files.push(mw)
  const rel = (p: string) => relative(root, p).split(sep).join('/')

  const graph = new Map<string, Set<string>>()
  const source = new Map<string, string>()
  for (const f of files) {
    const text = readFileSync(f, 'utf8')
    source.set(f, text)
    const deps = new Set<string>()
    IMPORT_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = IMPORT_RE.exec(text))) {
      // Type-only imports are erased at compile time and pull in no runtime code.
      if (/^(?:import|export)\s+type\s/.test(m[0])) continue
      const r = resolveImport(root, f, m[1] || m[2] || m[3])
      if (r) deps.add(r)
    }
    graph.set(f, deps)
  }

  const reach = (entries: string[]): Set<string> => {
    const seen = new Set<string>()
    const stack = [...entries]
    while (stack.length) {
      const f = stack.pop() as string
      if (seen.has(f)) continue
      seen.add(f)
      for (const d of graph.get(f) ?? []) stack.push(d)
    }
    return seen
  }
  const worker = reach([join(root, 'src', 'worker-host.ts')])
  const api = reach(files.filter((f) => rel(f).startsWith('app/') || f === mw))

  const readers = new Map<string, { api: boolean; worker: boolean; files: string[] }>()
  for (const [f, text] of source) {
    for (const re of ENV_RES) {
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(text))) {
        const entry = readers.get(m[1]) ?? { api: false, worker: false, files: [] }
        if (worker.has(f)) entry.worker = true
        if (api.has(f)) entry.api = true
        if (!entry.files.includes(rel(f))) entry.files.push(rel(f))
        readers.set(m[1], entry)
      }
    }
  }
  return { readers, workerModules: worker.size, apiModules: api.size }
}
