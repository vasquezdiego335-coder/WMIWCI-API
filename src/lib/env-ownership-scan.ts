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
//  This scanner is the evidence behind docs/env-ownership.json. It decides,
//  from the static import graph, which entrypoint reaches each reading module:
//    worker = modules reachable from src/worker-host.ts
//    api    = modules reachable from app/** and middleware.ts
//    script = a scanned file neither entrypoint reaches (scripts/, dev
//             entrypoints such as src/workers/index.ts and bull-board.ts)
//  It over-approximates (a reachable module may not call the reading function
//  on that service), so the manifest may declare `workerReachableUnused` with a
//  reason instead of listing the worker as an owner.
//
//  WHY IT IS NOT JUST `process.env.X` (2026-09-15).
//  Until now it matched ONLY literal `process.env.X` / `process.env['X']`, and
//  the manifest it generated was confidently wrong in ways that would break a
//  deploy if an operator trusted it: STRIPE_SECRET_KEY was absent although the
//  worker HALTS without it; DATABASE_URL and DISCORD_APPLICATION_ID were
//  "readBy: none"; DISCORD_PUBLIC_KEY was api-only although checkEnv() requires
//  it on the worker too. The reads it could not see are all COMPUTED:
//    • `process.env[v.key]`           (src/lib/env.ts checkEnv)
//    • `requiredEnv('STRIPE_SECRET_KEY')`, `num('EMAIL_CAP_PER_DAY', …)` and
//      similar one-line helpers
//    • `env.X` where `env` is a NodeJS.ProcessEnv parameter
//    • `env("DATABASE_URL")` in prisma/schema.prisma
//  So this scanner now also resolves those — and, crucially, REFUSES to be
//  silently incomplete: every computed `process.env[…]` site must be declared
//  in DYNAMIC_ENV_RULES below, saying where its keys come from. A new computed
//  read fails src/lib/__tests__/env-ownership.test.ts until someone declares
//  it. That is deliberate friction: an undeclared dynamic read is exactly how
//  the manifest became wrong in the first place.
//
//  KNOWN OVER-APPROXIMATIONS, kept on purpose:
//    • A `process.env.X` inside a comment counts as a read.
//    • `env.X` is harvested from every file that has a NodeJS.ProcessEnv
//      parameter, so an unrelated object called `env` in such a file would be
//      read as environment access.
//    • checkEnv() reports the PRESENCE of optional variables it never uses, so
//      those are attributed to both services. `requiredBy`/`checkedBy` in the
//      manifest separate "must be set" from "merely reported".
//
//  Pure filesystem reads; no environment VALUE is ever touched, and nothing
//  here imports application code.
// ════════════════════════════════════════════════════════════════════════

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'

const EXTS = ['.ts', '.tsx', '.js', '.mjs', '.cjs']
const SKIP_DIRS = new Set(['node_modules', '__tests__', '.next', 'email-previews'])

/**
 * This file is excluded from its own scan. It is full of `process.env[` — in
 * the detection patterns and in the prose above — none of which is a read, and
 * counting them would make the scanner permanently disagree with itself.
 */
const SELF = 'src/lib/env-ownership-scan.ts'

/** Bumped whenever the detection rules change, so a test can prove the broadened scan is in use. */
export const SCAN_PATTERNS_VERSION = 2

export type ServiceTag = 'api' | 'worker' | 'script'
/** How a name was found. Useful when a manifest entry looks surprising. */
export type EnvSource = 'literal' | 'destructure' | 'processEnvParam' | 'dynamicRule' | 'prisma' | 'declaration'

export type EnvReaderEntry = {
  api: boolean
  worker: boolean
  /** A scanned file that neither entrypoint reaches (scripts/, dev entrypoints). */
  script: boolean
  files: string[]
  sources: EnvSource[]
}

/** A declaration parsed out of src/lib/env.ts — what checkEnv() demands or merely reports. */
export type EnvDeclaration = {
  group: string
  key: string
  required: boolean
  /** 'email' = required only when this deployment is expected to send (emailRequired()). */
  conditional: 'email' | null
}

export type DynamicSite = { file: string; line: number; snippet: string }

export type DynamicEnvRule = {
  /** Repository-relative path of the file performing the computed read. */
  file: string
  /** How many computed sites that file has. Hand-maintained: a mismatch fails the test. */
  sites: number
  /** Why the keys are where they are — read by whoever has to update this. */
  why: string
  keys:
    | { kind: 'call'; callees: string[]; scope: 'file' | 'repo' }
    | { kind: 'literals'; exclude?: string[] }
    | { kind: 'property'; property: string; from: string[] }
    | { kind: 'declarations' }
    | { kind: 'explicit'; names: string[] }
}

export type EnvOwnershipScan = {
  /** name → service readers computed from the import graph. */
  readers: Map<string, EnvReaderEntry>
  workerModules: number
  apiModules: number
  scriptModules: number
  /** Every computed `process.env[…]` / `env[…]` site found, for error messages. */
  dynamicSites: DynamicSite[]
  /** Files whose computed-site count disagrees with DYNAMIC_ENV_RULES. */
  unregisteredSites: { file: string; found: number; registered: number; lines: number[] }[]
  /** Rules whose file no longer exists or no longer performs a computed read. */
  staleRules: string[]
  /** Declarations parsed from src/lib/env.ts (checkEnv's own list). */
  declarations: EnvDeclaration[]
  /** Which services reach a repository-relative file. */
  reaches: (relFile: string) => { api: boolean; worker: boolean; script: boolean }
}

// ── WHERE COMPUTED ENV KEYS COME FROM ───────────────────────────────────
//  One entry per file that indexes process.env (or a ProcessEnv parameter)
//  with something other than a plain literal. `sites` is the number of such
//  places in that file; the test fails when the count drifts, which is what
//  forces a new dynamic read to be declared instead of silently vanishing
//  from the deploy checklist.
export const DYNAMIC_ENV_RULES: readonly DynamicEnvRule[] = [
  {
    file: 'src/lib/env.ts',
    sites: 1,
    why: 'checkEnv() walks its own declaration lists. The keys ARE those declarations, parsed structurally (never regex-harvested, or the PLACEHOLDERS set would contribute "REPLACE_ME").',
    keys: { kind: 'declarations' },
  },
  {
    file: 'src/lib/stripe.ts',
    sites: 1,
    why: 'requiredEnv(name) throws when unset; called with literal names in the same file.',
    keys: { kind: 'call', callees: ['requiredEnv'], scope: 'file' },
  },
  {
    file: 'src/lib/email-guard.ts',
    sites: 1,
    why: 'num(name, fallback) reads the send caps and quiet hours. Both services run guardedSend, so these must match or customers see different timing on each.',
    keys: { kind: 'call', callees: ['num'], scope: 'file' },
  },
  {
    file: 'src/lib/deposit-notify.ts',
    sites: 1,
    why: 'a local env(k) helper; every call in the file passes a literal.',
    keys: { kind: 'call', callees: ['env'], scope: 'file' },
  },
  {
    file: 'src/lib/email-diagnostics.ts',
    sites: 2,
    why: 'present(name) and flag(name) report configuration on the diagnostics page.',
    keys: { kind: 'call', callees: ['present', 'flag'], scope: 'file' },
  },
  {
    file: 'src/lib/email-admin.ts',
    sites: 2,
    why: 'check(label, envName, why) builds the required-URL list; the DNS override read is a template literal EMAIL_DNS_<record> whose records are SPF/DKIM/DMARC.',
    keys: { kind: 'explicit', names: ['APP_URL', 'GOOGLE_REVIEW_URL', 'EMAIL_DNS_SPF', 'EMAIL_DNS_DKIM', 'EMAIL_DNS_DMARC'] },
  },
  {
    file: 'src/lib/journeys.ts',
    sites: 1,
    why: 'enabled(name) builds EMAIL_JOURNEY_<NAME>_DISABLED from a template literal; the journeys are abandoned, reminders, balance, quote and lead-nurture.',
    keys: {
      kind: 'explicit',
      names: [
        'EMAIL_JOURNEY_ABANDONED_DISABLED',
        'EMAIL_JOURNEY_REMINDERS_DISABLED',
        'EMAIL_JOURNEY_BALANCE_DISABLED',
        'EMAIL_JOURNEY_QUOTE_DISABLED',
        'EMAIL_JOURNEY_LEAD_NURTURE_DISABLED',
      ],
    },
  },
  {
    file: 'src/lib/email-agent/checks/infrastructure.ts',
    sites: 3,
    why: 'EMAIL_REQUIRED_VARS and the link-building URL list are literal arrays in the file.',
    // PASTE_ALERTS_CHANNEL_ID appears only in a comment about a placeholder value.
    keys: { kind: 'literals', exclude: ['PASTE_ALERTS_CHANNEL_ID'] },
  },
  {
    file: 'src/lib/email-agent/environment.ts',
    sites: 1,
    why: 'env[PRODUCTION_WRITE_OVERRIDE]; the constant is the only environment-shaped literal in the file.',
    keys: { kind: 'literals' },
  },
  {
    file: 'src/lib/ops-alert.ts',
    sites: 1,
    why: 'postToChannels(channelVars, …) takes the candidate names from its callers, so they are harvested repository-wide and attributed to the CALLING file (which by definition imports this one).',
    keys: { kind: 'call', callees: ['postToChannels'], scope: 'repo' },
  },
  {
    file: 'src/lib/lead-alert.ts',
    sites: 0,
    why: 'no computed read of its own, but it passes LEAD_CHANNELS (a const, not literals) to postToChannels, so the repo-scoped rule above cannot see the names. Listed here; keep in step with the LEAD_CHANNELS array.',
    keys: { kind: 'explicit', names: ['DISCORD_CHANNEL_LEADS', 'DISCORD_CHANNEL_NEWS', 'DISCORD_CHANNEL_OPERATIONS'] },
  },
  {
    file: 'src/bot/discord-rest.ts',
    sites: 2,
    why: 'restSendToChannel(envKey) and restSendFirst(envKeys) are private to this file and every call passes literal channel names.',
    keys: { kind: 'call', callees: ['restSendToChannel', 'restSendFirst'], scope: 'file' },
  },
  {
    file: 'src/bot/discord-actions.ts',
    sites: 2,
    why: 'getChannel(envKey) and the ENV_GROUPS startup banner; both take literal names from this file.',
    // REPLACE_ME is a placeholder VALUE; PHOTO_BEFORE is a JobPhoto type.
    keys: { kind: 'literals', exclude: ['REPLACE_ME', 'PHOTO_BEFORE'] },
  },
  {
    file: 'src/lib/email-recipient-context.ts',
    sites: 1,
    why: 'deps.env(name) is the injected lookup; every call in the file passes a literal.',
    keys: { kind: 'call', callees: ['deps.env'], scope: 'file' },
  },
  {
    file: 'src/lib/email-registry.ts',
    sites: 1,
    why: 'flagOn(name) gates a template; the names are the registry `flag:` properties.',
    keys: { kind: 'property', property: 'flag', from: ['src/lib/email-registry.ts'] },
  },
  {
    file: 'src/lib/email-campaign.ts',
    sites: 1,
    why: 'process.env[template.flag] — the flags are declared on the registry entries.',
    keys: { kind: 'property', property: 'flag', from: ['src/lib/email-registry.ts'] },
  },
  {
    file: 'src/lib/email-automation.ts',
    sites: 1,
    why: 'process.env[entry.flag] — same registry entries.',
    keys: { kind: 'property', property: 'flag', from: ['src/lib/email-registry.ts'] },
  },
  {
    file: 'app/(admin)/admin/(dashboard)/email-marketing/templates/page.tsx',
    sites: 1,
    why: 'renders each registry template flag and whether it is on.',
    keys: { kind: 'property', property: 'flag', from: ['src/lib/email-registry.ts'] },
  },
  {
    file: 'app/(admin)/admin/(dashboard)/email-marketing/templates/[key]/page.tsx',
    sites: 2,
    why: 'same, on the single-template page.',
    keys: { kind: 'property', property: 'flag', from: ['src/lib/email-registry.ts'] },
  },
  {
    file: 'app/api/health/route.ts',
    sites: 2,
    why: 'urlVarHealth(name) and a local flag(name); both are called with literals in the file.',
    keys: { kind: 'call', callees: ['urlVarHealth', 'flag'], scope: 'file' },
  },
  {
    file: 'scripts/deposit-preflight.mjs',
    sites: 1,
    why: 'a preflight script: a local env(k) helper, called with literals throughout the file.',
    keys: { kind: 'call', callees: ['env'], scope: 'file' },
  },
  {
    file: 'scripts/email-rollout-preflight.ts',
    sites: 3,
    why: 'a preflight script: flag(name), a literal required list, and EMAIL_JOURNEY_<J>_DISABLED built from a template literal.',
    keys: {
      kind: 'explicit',
      names: [
        'EMAIL_JOURNEYS_ENABLED',
        'MARKETING_FOLLOWUPS_ENABLED',
        'EMAIL_JOURNEY_QUOTE_DISABLED',
        'EMAIL_JOURNEY_LEAD_NURTURE_DISABLED',
        'EMAIL_JOURNEY_ABANDONED_DISABLED',
        'EMAIL_JOURNEY_REMINDERS_DISABLED',
        'EMAIL_JOURNEY_BALANCE_DISABLED',
        'EMAIL_TOKEN_SECRET',
        'RESEND_API_KEY',
        'RESEND_WEBHOOK_SECRET',
        'APP_URL',
        'MARKETING_SITE_URL',
      ],
    },
  },
]

// ── PATTERNS ────────────────────────────────────────────────────────────

/** A name shaped like an environment variable: SCREAMING_SNAKE with at least one underscore. */
const ENV_NAME = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/
/** Environment-shaped string literals, used only when harvesting arguments and lists. */
const LITERAL_STR = /['"`]([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)['"`]/g

/** Literal reads. Deliberately looser than ENV_NAME so single-word names (PORT, TIMEZONE) still count. */
const ENV_RES = [/process\.env\.([A-Z][A-Z0-9_]*)/g, /process\.env\[\s*['"`]([A-Z][A-Z0-9_]*)['"`]\s*\]/g]

/** `const { A, B } = process.env` — the names are literal, the site is not. */
const DESTRUCTURE_RE = /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*process\.env\b/g

/**
 * A computed index. The negative lookahead skips a COMPLETE simple literal
 * (`process.env['X']`), so an interpolated template such as
 * `process.env[\`EMAIL_DNS_${record}\`]` is still counted as computed.
 */
const PROCESS_ENV_COMPUTED = /process\.env\[\s*(?!['"`][A-Za-z_$][A-Za-z0-9_$]*['"`]\s*\])/g
const ENV_PARAM_COMPUTED = /(?<![A-Za-z0-9_$.])env\[\s*(?!['"`][A-Za-z_$][A-Za-z0-9_$]*['"`]\s*\])/g

/** Files that take the environment as a parameter, where `env.X` is an environment read. */
const PROCESS_ENV_PARAM_FILE = /NodeJS\.ProcessEnv|=\s*process\.env\s*[),]/
const ENV_PARAM_DOT = /(?<![A-Za-z0-9_$.])env\.([A-Z][A-Z0-9_]*)\b/g
const ENV_PARAM_LITERAL = /(?<![A-Za-z0-9_$.])env\[\s*['"`]([A-Z][A-Z0-9_]*)['"`]\s*\]/g

// ── FILE WALK AND IMPORT GRAPH ──────────────────────────────────────────

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

// ── SMALL PARSERS ───────────────────────────────────────────────────────

/** Text of the argument list starting at the '(' at `open`, without the parentheses. */
function balancedArgs(text: string, open: number): string {
  let depth = 0
  let quote: string | null = null
  for (let i = open; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c
      continue
    }
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') {
      depth--
      if (depth === 0) return text.slice(open + 1, i)
    }
  }
  return ''
}

function calleeRegex(callee: string): RegExp {
  return new RegExp(`(?<![A-Za-z0-9_$.])${callee.replace(/\./g, '\\.')}\\s*\\(`, 'g')
}

function harvestFromCalls(text: string, callees: string[]): string[] {
  const found: string[] = []
  for (const callee of callees) {
    const re = calleeRegex(callee)
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      const args = balancedArgs(text, m.index + m[0].length - 1)
      LITERAL_STR.lastIndex = 0
      let lm: RegExpExecArray | null
      while ((lm = LITERAL_STR.exec(args))) found.push(lm[1])
    }
  }
  return found
}

function harvestLiterals(text: string, exclude: string[] = []): string[] {
  const found: string[] = []
  LITERAL_STR.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = LITERAL_STR.exec(text))) if (!exclude.includes(m[1])) found.push(m[1])
  return found
}

function harvestProperty(text: string, property: string): string[] {
  // `property` is always a plain identifier (see DYNAMIC_ENV_RULES), so no escaping is needed.
  const re = new RegExp(`\\b${property}\\s*:\\s*['"\`]([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)['"\`]`, 'g')
  const found: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) found.push(m[1])
  return found
}

/**
 * Parse src/lib/env.ts's own declaration lists.
 *
 * Structural on purpose: only `key:` properties inside a `const X: EnvVar[] = [`
 * array count, so the PLACEHOLDERS set ('REPLACE_ME', 'sk_test_xxx', …) can
 * never be mistaken for a variable name. A GROUPS map decides the group label.
 */
export function parseEnvDeclarations(envSource: string): EnvDeclaration[] {
  const arrays = new Map<string, { key: string; required: boolean }[]>()
  const arrayRe = /const\s+([A-Z_][A-Z0-9_]*)\s*:\s*EnvVar\[\]\s*=\s*\[([\s\S]*?)\n\]/g
  let m: RegExpExecArray | null
  while ((m = arrayRe.exec(envSource))) {
    const entries: { key: string; required: boolean }[] = []
    const entryRe = /\{\s*(?:\/\/[^\n]*\n\s*)*key:\s*['"]([A-Z][A-Z0-9_]*)['"]\s*,\s*required:\s*(true|false)/g
    let e: RegExpExecArray | null
    while ((e = entryRe.exec(m[2]))) entries.push({ key: e[1], required: e[2] === 'true' })
    arrays.set(m[1], entries)
  }

  const groups = new Map<string, string>() // array name → group label
  const groupsBlock = /const\s+GROUPS\s*:[^=]*=\s*\{([\s\S]*?)\n\}/.exec(envSource)
  if (groupsBlock) {
    const pairRe = /(\w+)\s*:\s*([A-Z_][A-Z0-9_]*)\s*,/g
    let g: RegExpExecArray | null
    while ((g = pairRe.exec(groupsBlock[1]))) groups.set(g[2], g[1])
  }

  const out: EnvDeclaration[] = []
  for (const [arrayName, entries] of arrays) {
    const group = groups.get(arrayName)
    if (!group) continue // an EnvVar[] that checkEnv never walks reports nothing
    for (const e of entries) {
      out.push({ group, key: e.key, required: e.required, conditional: group === 'Email' ? 'email' : null })
    }
  }
  return out
}

/** `url`/`directUrl`/`shadowDatabaseUrl = env("X")` inside the datasource block. */
export function parsePrismaDatasourceEnv(schema: string): { field: string; name: string }[] {
  const block = /datasource\s+\w+\s*\{([\s\S]*?)\n\}/.exec(schema)
  if (!block) return []
  const out: { field: string; name: string }[] = []
  const re = /(\w+)\s*=\s*env\(\s*"([A-Z][A-Z0-9_]*)"\s*\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(block[1]))) out.push({ field: m[1], name: m[2] })
  return out
}

// ── THE SCAN ────────────────────────────────────────────────────────────

/**
 * @param opts.rules override DYNAMIC_ENV_RULES. Only the scanner's own tests
 *   pass this, so a synthetic fixture can exercise every access shape without
 *   inheriting rules that name real repository paths.
 */
export function scanEnvOwnership(root: string, opts: { rules?: readonly DynamicEnvRule[] } = {}): EnvOwnershipScan {
  const rules = opts.rules ?? DYNAMIC_ENV_RULES
  const files = [...walk(join(root, 'src')), ...walk(join(root, 'app')), ...walk(join(root, 'scripts'))]
  const mw = join(root, 'middleware.ts')
  if (existsSync(mw)) files.push(mw)
  const rel = (p: string) => relative(root, p).split(sep).join('/')
  const abs = (r: string) => join(root, r.split('/').join(sep))

  const graph = new Map<string, Set<string>>()
  const source = new Map<string, string>()
  for (const f of files) {
    const text = readFileSync(f, 'utf8')
    if (rel(f) !== SELF) source.set(f, text)
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
  // Anything scanned that neither service reaches: scripts/ and the dev-only
  // entrypoints (src/workers/index.ts, src/workers/bull-board.ts, src/bot/index.ts).
  const scriptFiles = new Set(files.filter((f) => !worker.has(f) && !api.has(f)))

  const readers = new Map<string, EnvReaderEntry>()
  const record = (name: string, file: string | null, sourceKind: EnvSource) => {
    const entry = readers.get(name) ?? { api: false, worker: false, script: false, files: [], sources: [] }
    if (file) {
      const a = abs(file)
      if (worker.has(a)) entry.worker = true
      if (api.has(a)) entry.api = true
      if (scriptFiles.has(a)) entry.script = true
      if (!entry.files.includes(file)) entry.files.push(file)
    }
    if (!entry.sources.includes(sourceKind)) entry.sources.push(sourceKind)
    readers.set(name, entry)
  }

  // 1. Literal reads, and `const { X } = process.env`.
  for (const [f, text] of source) {
    for (const re of ENV_RES) {
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(text))) record(m[1], rel(f), 'literal')
    }
    DESTRUCTURE_RE.lastIndex = 0
    let d: RegExpExecArray | null
    while ((d = DESTRUCTURE_RE.exec(text))) {
      for (const raw of d[1].split(',')) {
        const name = raw.split(':')[0].trim()
        if (ENV_NAME.test(name)) record(name, rel(f), 'destructure')
      }
    }
  }

  // 2. `env.X` in files that take the environment as a parameter.
  for (const [f, text] of source) {
    if (!PROCESS_ENV_PARAM_FILE.test(text)) continue
    for (const re of [ENV_PARAM_DOT, ENV_PARAM_LITERAL]) {
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(text))) record(m[1], rel(f), 'processEnvParam')
    }
  }

  // 3. Computed sites: find them all, then satisfy each from its declared rule.
  const dynamicSites: DynamicSite[] = []
  const foundPerFile = new Map<string, number[]>()
  for (const [f, text] of source) {
    const isParamFile = PROCESS_ENV_PARAM_FILE.test(text)
    const lines = text.split('\n')
    const hits: number[] = []
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      for (const re of isParamFile ? [PROCESS_ENV_COMPUTED, ENV_PARAM_COMPUTED] : [PROCESS_ENV_COMPUTED]) {
        re.lastIndex = 0
        while (re.exec(line)) {
          hits.push(i + 1)
          dynamicSites.push({ file: rel(f), line: i + 1, snippet: line.trim().slice(0, 160) })
        }
      }
    }
    if (hits.length) foundPerFile.set(rel(f), hits)
  }

  const declarations = (() => {
    const envFile = join(root, 'src', 'lib', 'env.ts')
    return existsSync(envFile) ? parseEnvDeclarations(readFileSync(envFile, 'utf8')) : []
  })()

  const staleRules: string[] = []
  for (const rule of rules) {
    const f = abs(rule.file)
    if (!source.has(f)) {
      staleRules.push(`${rule.file}: the file no longer exists (or is no longer scanned)`)
      continue
    }
    const text = source.get(f) as string
    let keys: string[] = []
    switch (rule.keys.kind) {
      case 'call':
        keys =
          rule.keys.scope === 'file'
            ? harvestFromCalls(text, rule.keys.callees)
            : // Repo scope: the CALLER supplies the names, and the caller by
              // definition imports the reading module, so attributing the key
              // to the calling file keeps reachability honest.
              []
        break
      case 'literals':
        keys = harvestLiterals(text, rule.keys.exclude)
        break
      case 'property':
        for (const from of rule.keys.from) {
          const ff = abs(from)
          if (source.has(ff)) keys.push(...harvestProperty(source.get(ff) as string, rule.keys.property))
        }
        break
      case 'declarations':
        keys = declarations.map((d) => d.key)
        break
      case 'explicit':
        keys = [...rule.keys.names]
        break
    }
    for (const k of keys) if (ENV_NAME.test(k)) record(k, rule.file, 'dynamicRule')

    if (rule.keys.kind === 'call' && rule.keys.scope === 'repo') {
      const callees = rule.keys.callees
      for (const [cf, ctext] of source) {
        for (const k of harvestFromCalls(ctext, callees)) if (ENV_NAME.test(k)) record(k, rel(cf), 'dynamicRule')
      }
    }

    if (rule.sites > 0 && !foundPerFile.has(rule.file)) {
      staleRules.push(`${rule.file}: declares ${rule.sites} computed env read(s) but the file performs none`)
    }
  }

  const registeredSites = new Map(rules.map((r) => [r.file, r.sites]))
  const unregisteredSites: EnvOwnershipScan['unregisteredSites'] = []
  for (const [file, lines] of foundPerFile) {
    const registered = registeredSites.get(file) ?? 0
    if (lines.length !== registered) unregisteredSites.push({ file, found: lines.length, registered, lines })
  }
  unregisteredSites.sort((a, b) => a.file.localeCompare(b.file))

  // 4. Prisma's datasource. `url` is what PrismaClient itself reads at runtime,
  //    so it belongs to whichever services construct one (src/lib/db.ts, which
  //    both reach). `shadowDatabaseUrl` is read only by the migrate CLI, so it
  //    is recorded against the schema file and owned by no service.
  const schemaPath = join(root, 'prisma', 'schema.prisma')
  if (existsSync(schemaPath)) {
    const clientFiles = [...source].filter(([, t]) => /new\s+PrismaClient\s*\(/.test(t)).map(([f]) => rel(f))
    for (const { field, name } of parsePrismaDatasourceEnv(readFileSync(schemaPath, 'utf8'))) {
      if (field === 'shadowDatabaseUrl') {
        record(name, null, 'prisma')
        const entry = readers.get(name) as EnvReaderEntry
        if (!entry.files.includes('prisma/schema.prisma')) entry.files.push('prisma/schema.prisma')
      } else {
        for (const cf of clientFiles) record(name, cf, 'prisma')
      }
    }
  }

  const reaches = (relFile: string) => {
    const a = abs(relFile)
    return { api: api.has(a), worker: worker.has(a), script: scriptFiles.has(a) }
  }

  return {
    readers,
    workerModules: worker.size,
    apiModules: api.size,
    scriptModules: scriptFiles.size,
    dynamicSites,
    unregisteredSites,
    staleRules,
    declarations,
    reaches,
  }
}
