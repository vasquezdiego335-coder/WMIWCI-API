// ════════════════════════════════════════════════════════════════════════
//  EMAIL DIAGNOSTICS — what the RUNNING service thinks its config is.
//  ---------------------------------------------------------------------
//  WHY THIS EXISTS: during staging verification the hard question is never
//  "does my laptop have the right env" — it is "does the DEPLOYED container
//  have it". Those diverge constantly: a variable set in the wrong Railway
//  environment, a service that did not pick up a redeploy, a secret pasted with
//  a trailing newline. Without this you diagnose by sending real email and
//  watching what breaks.
//
//  Every check here is READ-ONLY and reports PRESENCE, never values. Secrets
//  are described by length and a short fingerprint (first 6 chars of a SHA-256)
//  so two services can be compared for equality WITHOUT either one revealing
//  the secret. That fingerprint is the single most useful field here: it is how
//  you prove the API and the worker share the same EMAIL_TOKEN_SECRET, which is
//  the difference between working unsubscribe links and dead ones.
// ════════════════════════════════════════════════════════════════════════

import crypto from 'node:crypto'
import { prisma } from './db'
import { isSafeUrl } from '../emails/validation'
import { businessPostalAddress } from './marketing-context'
import { signToken, verifyToken, unsubscribeUrl, isTokenSecretConfigured } from './email-tokens'

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'off'

export type Check = {
  name: string
  status: CheckStatus
  detail: string
}

/**
 * Non-reversible fingerprint of a secret. Same secret ⇒ same fingerprint, so
 * two deployments can be compared without either exposing the value.
 */
function fingerprint(value?: string | null): string {
  const v = (value ?? '').trim()
  if (!v) return 'unset'
  return `${crypto.createHash('sha256').update(v).digest('hex').slice(0, 6)}…len${v.length}`
}

const present = (name: string): boolean => Boolean(process.env[name]?.trim())

// ── configuration ───────────────────────────────────────────────────────

export function configChecks(): Check[] {
  const checks: Check[] = []
  const appUrl = process.env.APP_URL?.trim()

  checks.push({
    name: 'APP_URL',
    status: !appUrl ? 'fail' : isSafeUrl(appUrl) ? 'ok' : 'warn',
    detail: !appUrl
      ? 'UNSET — unsubscribe links cannot be built, so every promotional send is blocked'
      : isSafeUrl(appUrl)
      ? appUrl
      : `${appUrl} (fails the production URL gate — localhost/http/preview domain?)`,
  })

  checks.push({
    name: 'EMAIL_TOKEN_SECRET',
    status: present('EMAIL_TOKEN_SECRET') ? 'ok' : isTokenSecretConfigured() ? 'warn' : 'fail',
    detail: present('EMAIL_TOKEN_SECRET')
      ? `set · fingerprint ${fingerprint(process.env.EMAIL_TOKEN_SECRET)} — MUST MATCH on every service`
      : isTokenSecretConfigured()
      ? 'unset, deriving from RESEND_API_KEY — works, but rotating Resend silently breaks every live unsubscribe link'
      : 'UNSET and no usable Resend key — signing THROWS in production; /api/email/unsubscribe will 500',
  })

  checks.push({
    name: 'RESEND_API_KEY',
    status: present('RESEND_API_KEY') && process.env.RESEND_API_KEY !== 're_placeholder' ? 'ok' : 'fail',
    detail: present('RESEND_API_KEY')
      ? process.env.RESEND_API_KEY === 're_placeholder'
        ? 'placeholder — no email can send'
        : `set · ${fingerprint(process.env.RESEND_API_KEY)}`
      : 'UNSET — no email can send',
  })

  checks.push({
    name: 'RESEND_WEBHOOK_SECRET',
    status: present('RESEND_WEBHOOK_SECRET') ? 'ok' : 'fail',
    detail: present('RESEND_WEBHOOK_SECRET')
      ? `set · ${fingerprint(process.env.RESEND_WEBHOOK_SECRET)}`
      : 'UNSET — /api/email/webhook returns 503 and NO bounce or complaint is ever processed',
  })

  checks.push({
    name: 'EMAIL_SUPPRESSION_API_KEY',
    status: present('EMAIL_SUPPRESSION_API_KEY') ? 'ok' : 'warn',
    detail: present('EMAIL_SUPPRESSION_API_KEY')
      ? `set · ${fingerprint(process.env.EMAIL_SUPPRESSION_API_KEY)}`
      : 'unset — /api/email/suppression is disabled (503); Leadtracking cannot check suppression',
  })

  const postal = businessPostalAddress()
  checks.push({
    name: 'BUSINESS_POSTAL_ADDRESS',
    status: postal ? 'ok' : 'fail',
    detail: postal
      ? `set (${postal.length} chars)`
      : 'UNSET or placeholder — EVERY promotional send is blocked (CAN-SPAM). Transactional is unaffected.',
  })

  const reviewUrl = process.env.GOOGLE_REVIEW_URL?.trim()
  checks.push({
    name: 'GOOGLE_REVIEW_URL',
    status: reviewUrl && isSafeUrl(reviewUrl) ? 'ok' : 'warn',
    detail: !reviewUrl
      ? 'unset — review requests are never queued'
      : isSafeUrl(reviewUrl)
      ? reviewUrl
      : `${reviewUrl} — REJECTED (placeholder or unsafe); review requests will not queue`,
  })

  return checks
}

/** Journey flags — all default OFF. Reported so "why did nothing send?" is answerable. */
export function flagChecks(): Check[] {
  const flag = (name: string) => (process.env[name] === 'true' ? 'ON' : 'off')
  return [
    { name: 'EMAIL_JOURNEYS_ENABLED', status: 'off', detail: flag('EMAIL_JOURNEYS_ENABLED') },
    { name: 'MARKETING_FOLLOWUPS_ENABLED', status: 'off', detail: flag('MARKETING_FOLLOWUPS_ENABLED') },
    { name: 'REFERRAL_PROGRAM_ENABLED', status: 'off', detail: flag('REFERRAL_PROGRAM_ENABLED') },
    { name: 'OUTBOX_ENABLED', status: 'off', detail: flag('OUTBOX_ENABLED') },
    { name: 'OUTBOX_EMAIL_DRYRUN', status: 'off', detail: flag('OUTBOX_EMAIL_DRYRUN') },
  ].map((c) => ({ ...c, status: (c.detail === 'ON' ? 'warn' : 'off') as CheckStatus }))
}

/**
 * Sign and verify a token in-process. This is the check that catches a secret
 * pasted with a trailing newline or a stray quote — the value is "set", the
 * fingerprint looks fine, and signing still fails.
 */
export function tokenRoundTrip(): Check {
  try {
    const probe = 'diagnostics-probe@example.com'
    const token = signToken(probe, 'unsubscribe')
    const back = verifyToken(token, 'unsubscribe')
    if (back?.email !== probe) {
      return { name: 'token round-trip', status: 'fail', detail: 'signed a token that did not verify' }
    }
    const url = unsubscribeUrl(probe)
    if (!url) {
      return { name: 'token round-trip', status: 'fail', detail: 'signing works but APP_URL is unset, so no link can be built' }
    }
    if (!isSafeUrl(url)) {
      return { name: 'token round-trip', status: 'fail', detail: `built ${url}, which the URL gate REJECTS` }
    }
    return { name: 'token round-trip', status: 'ok', detail: 'sign → verify → build URL all succeed' }
  } catch (err) {
    return {
      name: 'token round-trip',
      status: 'fail',
      detail: `THREW: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

// ── database ────────────────────────────────────────────────────────────

/** Are the email tables actually present and readable from THIS container? */
export async function schemaChecks(): Promise<Check[]> {
  const out: Check[] = []
  const probes: Array<[string, () => Promise<number>]> = [
    ['email_suppressions', () => prisma.emailSuppression.count()],
    ['email_sends', () => prisma.emailSend.count()],
    ['email_events', () => prisma.emailEvent.count()],
    ['followup_ledger', () => prisma.followUpLedger.count()],
  ]
  for (const [table, probe] of probes) {
    try {
      const n = await probe()
      out.push({ name: table, status: 'ok', detail: `readable · ${n} row(s)` })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // A missing relation is the signature of an unapplied migration.
      const missing = /does not exist|relation .* does not exist|P2021/i.test(msg)
      out.push({
        name: table,
        status: 'fail',
        detail: missing
          ? 'TABLE MISSING — run `npx prisma migrate deploy`, then `npm run email:preflight`'
          : msg.slice(0, 160),
      })
    }
  }
  return out
}

/** Live counts that answer "is anything actually happening?" */
export async function activitySummary(): Promise<Record<string, unknown>> {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  try {
    const [byStatus, byClass, suppressions, events, stuck] = await Promise.all([
      prisma.emailSend.groupBy({ by: ['status'], _count: true, where: { createdAt: { gte: since } } }),
      prisma.emailSend.groupBy({ by: ['emailClass'], _count: true, where: { createdAt: { gte: since } } }),
      prisma.emailSuppression.groupBy({ by: ['reason'], _count: true }),
      prisma.emailEvent.groupBy({ by: ['type'], _count: true, where: { occurredAt: { gte: since } } }),
      prisma.emailEvent.count({ where: { processingStatus: { in: ['side_effect_failed', 'dead_letter'] } } }),
    ])
    return {
      window: '7 days',
      sendsByStatus: Object.fromEntries(byStatus.map((r) => [r.status, r._count])),
      sendsByClass: Object.fromEntries(byClass.map((r) => [r.emailClass, r._count])),
      suppressionsByReason: Object.fromEntries(suppressions.map((r) => [r.reason, r._count])),
      eventsByType: Object.fromEntries(events.map((r) => [r.type, r._count])),
      // The number that must stay ZERO — an unfinished suppression means a
      // bounced or complaining address is still sendable.
      unfinishedSuppressionSideEffects: stuck,
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/** The most recent refusals, with reasons. Answers "why didn't it send?" */
export async function recentBlocks(limit = 20) {
  try {
    return await prisma.emailSend.findMany({
      where: { status: { in: ['blocked_terminal', 'blocked_retryable', 'deferred', 'failed_terminal', 'ambiguous'] } },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        createdAt: true,
        template: true,
        emailClass: true,
        status: true,
        blockedReason: true,
        attempts: true,
        nextAttemptAt: true,
        journey: true,
      },
    })
  } catch {
    return []
  }
}

// ── the whole picture ───────────────────────────────────────────────────

export type Diagnostics = {
  status: 'ok' | 'degraded' | 'blocked'
  checkedAt: string
  config: Check[]
  flags: Check[]
  token: Check
  schema: Check[]
  activity: Record<string, unknown>
  summary: { ok: number; warn: number; fail: number }
}

export async function runDiagnostics(): Promise<Diagnostics> {
  const config = configChecks()
  const flags = flagChecks()
  const token = tokenRoundTrip()
  const schema = await schemaChecks()
  const activity = await activitySummary()

  const all = [...config, token, ...schema]
  const fail = all.filter((c) => c.status === 'fail').length
  const warn = all.filter((c) => c.status === 'warn').length
  const ok = all.filter((c) => c.status === 'ok').length

  return {
    status: fail > 0 ? 'blocked' : warn > 0 ? 'degraded' : 'ok',
    checkedAt: new Date().toISOString(),
    config,
    flags,
    token,
    schema,
    activity,
    summary: { ok, warn, fail },
  }
}
