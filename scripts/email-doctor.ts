/**
 * EMAIL DOCTOR — full local diagnosis of the email system.
 *
 *   npm run email:doctor
 *
 * Runs the same checks as GET /api/email/health, but against whatever env and
 * DATABASE_URL your shell has. Use BOTH: this tells you what your machine sees,
 * the endpoint tells you what the deployed container sees. When they disagree,
 * the disagreement IS the bug.
 *
 * Read-only. Sends nothing, writes nothing, never prints a secret value.
 * Exit 0 = healthy or degraded, 1 = a check failed, 2 = could not run.
 */
import { prisma } from '../src/lib/db'
import { runDiagnostics, recentBlocks, type Check } from '../src/lib/email-diagnostics'

const ICON: Record<string, string> = { ok: '  OK  ', warn: ' WARN ', fail: ' FAIL ', off: '  ..  ' }

function line(c: Check) {
  console.log(`${ICON[c.status] ?? '  ??  '} ${c.name.padEnd(28)} ${c.detail}`)
}

async function main() {
  console.log('\n══ EMAIL DOCTOR ═══════════════════════════════════════════════')
  console.log(`node ${process.version} · NODE_ENV=${process.env.NODE_ENV ?? '(unset)'}`)
  console.log(`DATABASE_URL host: ${hostOf(process.env.DATABASE_URL)}`)
  console.log('')

  const d = await runDiagnostics()

  console.log('── CONFIGURATION ─────────────────────────────────────────────')
  d.config.forEach(line)
  console.log('')

  console.log('── TOKEN SIGNING ─────────────────────────────────────────────')
  line(d.token)
  console.log('')

  console.log('── SCHEMA (is the migration applied?) ────────────────────────')
  d.schema.forEach(line)
  console.log('')

  console.log('── JOURNEY FLAGS (all should be off until staging passes) ────')
  d.flags.forEach(line)
  console.log('')

  console.log('── ACTIVITY (last 7 days) ────────────────────────────────────')
  console.log(JSON.stringify(d.activity, null, 2))
  console.log('')

  const blocks = await recentBlocks(10)
  if (blocks.length) {
    console.log('── RECENT REFUSALS (why an email did not send) ───────────────')
    for (const b of blocks) {
      console.log(
        `  ${b.createdAt.toISOString().slice(0, 19)}  ${String(b.template).padEnd(22)} ` +
          `${String(b.status).padEnd(18)} ${b.blockedReason ?? ''}`
      )
    }
    console.log('')
  }

  console.log('══ RESULT ════════════════════════════════════════════════════')
  console.log(`${d.summary.ok} ok · ${d.summary.warn} warn · ${d.summary.fail} fail → ${d.status.toUpperCase()}`)

  if (d.summary.fail > 0) {
    console.log('\nFAILING CHECKS BLOCK SENDING. Fix these before enabling anything.')
    process.exit(1)
  }
  if (d.summary.warn > 0) {
    console.log('\nWarnings do not block transactional email, but read each one.')
  }
  console.log('')
}

/** Host only — never print credentials from a connection string. */
function hostOf(url?: string): string {
  if (!url) return '(unset)'
  try {
    return new URL(url).host
  } catch {
    return '(unparseable)'
  }
}

main()
  .catch((err) => {
    console.error('\nemail doctor could not run:', err instanceof Error ? err.message : err)
    console.error('Most common cause: DATABASE_URL is unset or unreachable from here.')
    process.exit(2)
  })
  .finally(() => prisma.$disconnect())
