// ════════════════════════════════════════════════════════════════════════
//  LIVE DNS AUTHENTICATION CHECKS (audit pass D, 2026-07-27)
//  ---------------------------------------------------------------------
//  THE GAP: the Deliverability page reported SPF, DKIM and DMARC as
//  "UNVERIFIED, always", explaining that DNS lives outside the application.
//  That is honest, but it is also permanently uninformative — the status could
//  never change, so nothing the owner did would ever be reflected, and a real
//  misconfiguration could sit there indefinitely.
//
//  It is also unnecessary: this process can resolve DNS. When the checks were
//  run by hand during this audit they immediately found something the admin had
//  no way to show — DMARC is published as `p=none` with NO `rua=` address, so
//  the policy that exists to provide VISIBILITY was delivering none, because
//  nobody was receiving the aggregate reports.
//
//  WHAT THIS DELIBERATELY DOES NOT DO: claim more than DNS proves. A published
//  SPF record does not mean mail passes SPF, and a DKIM key existing does not
//  mean messages are signed with it. Each check reports what the record SAYS,
//  and the detail text says what that does and does not establish.
//
//  ALIGNMENT is the subtle part. DMARC passes if EITHER SPF or DKIM aligns with
//  the From domain. Resend sends with its own envelope domain (a subdomain), so
//  SPF aligns under DMARC's default RELAXED mode even though the root SPF has
//  no ESP include. A checker that demanded an ESP include in the root SPF would
//  report a false failure — which is why that is called out rather than flagged.
// ════════════════════════════════════════════════════════════════════════

import { promises as dns } from 'node:dns'
import { apiLogger } from './logger'

const log = apiLogger.child({ mod: 'email-dns' })

export type DnsStatus = 'VERIFIED' | 'UNVERIFIED' | 'MISSING' | 'INVALID'

export type LiveDnsCheck = {
  name: string
  status: DnsStatus
  detail: string
  /** What was actually published, for the operator to copy/compare. */
  record: string | null
  /** Non-blocking observations — real, but not a failure. */
  advice: string[]
  checkedAt: string
}

/** DNS must never hang a page render. */
const LOOKUP_TIMEOUT_MS = Number(process.env.EMAIL_DNS_TIMEOUT_MS) || 4000

async function txt(host: string): Promise<{ records: string[]; error: string | null }> {
  try {
    const records = await Promise.race([
      dns.resolveTxt(host).then((r) => r.map((chunks) => chunks.join(''))),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('DNS lookup timed out')), LOOKUP_TIMEOUT_MS)),
    ])
    return { records, error: null }
  } catch (err) {
    const code = (err as { code?: string })?.code
    // ENODATA/ENOTFOUND are ANSWERS ("no such record"), not failures to look.
    if (code === 'ENODATA' || code === 'ENOTFOUND') return { records: [], error: null }
    return { records: [], error: err instanceof Error ? err.message : String(err) }
  }
}

/** The From-header domain — the one DMARC alignment is judged against. */
export function senderDomain(from = process.env.EMAIL_FROM ?? ''): string | null {
  const match = /<([^>]+)>/.exec(from)
  const addr = (match ? match[1] : from).trim()
  const domain = addr.split('@').pop()?.trim().toLowerCase()
  return domain && domain.includes('.') ? domain : null
}

const unknown = (name: string, reason: string): LiveDnsCheck => ({
  name,
  status: 'UNVERIFIED',
  detail: reason,
  record: null,
  advice: [],
  checkedAt: new Date().toISOString(),
})

// ── SPF ─────────────────────────────────────────────────────────────────

export async function checkSpf(domain: string): Promise<LiveDnsCheck> {
  const { records, error } = await txt(domain)
  if (error) return unknown('SPF', `DNS lookup failed: ${error}. Status is unknown, not necessarily wrong.`)
  const spf = records.find((r) => r.toLowerCase().startsWith('v=spf1'))
  const checkedAt = new Date().toISOString()

  if (!spf) {
    return {
      name: 'SPF', status: 'MISSING', record: null, checkedAt,
      detail: `No SPF record on ${domain}. Receivers have no list of who may send for this domain.`,
      advice: ['Publish a TXT record at the root beginning with v=spf1.'],
    }
  }
  const advice: string[] = []
  // More than one SPF record is a hard error in the RFC — receivers must fail it.
  if (records.filter((r) => r.toLowerCase().startsWith('v=spf1')).length > 1) {
    return {
      name: 'SPF', status: 'INVALID', record: spf, checkedAt,
      detail: `${domain} publishes MORE THAN ONE SPF record. RFC 7208 requires receivers to treat that as a permanent error, so SPF fails outright.`,
      advice: ['Merge them into a single v=spf1 record.'],
    }
  }
  if (/\+all/.test(spf)) {
    return {
      name: 'SPF', status: 'INVALID', record: spf, checkedAt,
      detail: `The record ends in +all, which authorises the entire internet to send as ${domain}. That is worse than having no SPF at all.`,
      advice: ['Change +all to ~all or -all.'],
    }
  }
  if (!/[~-]all/.test(spf)) advice.push('No ~all or -all terminator — receivers will treat unlisted senders as neutral.')
  // NOT flagged as a failure: the ESP include usually lives on the envelope
  // (bounce) subdomain, not the root. Saying otherwise causes false alarms.
  advice.push(
    'Note: the ESP include commonly sits on the bounce subdomain rather than the root. SPF authenticates the envelope sender, so a root record without it is normal and still aligns under DMARC relaxed mode.'
  )
  return {
    name: 'SPF', status: 'VERIFIED', record: spf, checkedAt,
    detail: `A single valid SPF record is published for ${domain}. This proves the record EXISTS — it does not prove a given message passes SPF.`,
    advice,
  }
}

// ── DKIM ────────────────────────────────────────────────────────────────

/** Selectors to probe, most likely first. Resend publishes `resend`. */
const DKIM_SELECTORS = (process.env.EMAIL_DKIM_SELECTORS ?? 'resend,default,google,k1,s1')
  .split(',').map((s) => s.trim()).filter(Boolean)

export async function checkDkim(domain: string): Promise<LiveDnsCheck> {
  const checkedAt = new Date().toISOString()
  for (const selector of DKIM_SELECTORS) {
    const { records, error } = await txt(`${selector}._domainkey.${domain}`)
    if (error) continue
    const key = records.find((r) => /p=/.test(r))
    if (key) {
      const empty = /p=\s*(;|$)/.test(key)
      if (empty) {
        return {
          name: 'DKIM', status: 'INVALID', record: `${selector}._domainkey`, checkedAt,
          detail: `The ${selector} DKIM record exists but its public key is EMPTY, which is how a revoked key is published. Signatures will fail.`,
          advice: ['Re-issue the DKIM key in the sending provider and republish it.'],
        }
      }
      return {
        name: 'DKIM', status: 'VERIFIED', record: `${selector}._domainkey.${domain}`, checkedAt,
        detail: `A DKIM public key is published under the "${selector}" selector, and its domain matches the From domain — so DKIM can align for DMARC.`,
        advice: [],
      }
    }
  }
  return {
    name: 'DKIM', status: 'MISSING', record: null, checkedAt,
    detail: `No DKIM key found for ${domain} under any of: ${DKIM_SELECTORS.join(', ')}. Without DKIM, DMARC has to pass on SPF alone.`,
    advice: [`If a different selector is used, set EMAIL_DKIM_SELECTORS to include it.`],
  }
}

// ── DMARC ───────────────────────────────────────────────────────────────

export async function checkDmarc(domain: string): Promise<LiveDnsCheck> {
  const { records, error } = await txt(`_dmarc.${domain}`)
  const checkedAt = new Date().toISOString()
  if (error) return unknown('DMARC', `DNS lookup failed: ${error}. Status is unknown, not necessarily wrong.`)

  const dmarc = records.find((r) => r.toLowerCase().startsWith('v=dmarc1'))
  if (!dmarc) {
    return {
      name: 'DMARC', status: 'MISSING', record: null, checkedAt,
      detail: `No DMARC record on _dmarc.${domain}. Nothing tells receivers what to do with mail that fails authentication, and nobody can spoof-report it.`,
      advice: ['Publish: v=DMARC1; p=none; rua=mailto:dmarc@' + domain],
    }
  }

  const policy = /p=([a-z]+)/i.exec(dmarc)?.[1]?.toLowerCase() ?? null
  const rua = /rua=([^;]+)/i.exec(dmarc)?.[1]?.trim() ?? null
  const advice: string[] = []

  // THE FINDING THIS CHECK EXISTS FOR. p=none means "monitor only" — its entire
  // value is the aggregate reports. Without rua nobody receives them, so the
  // policy is doing literally nothing.
  if (!rua) {
    advice.push(
      'NO rua= REPORTING ADDRESS. ' +
        (policy === 'none'
          ? 'p=none exists only to gather reports, and with no rua= address nobody receives any — this policy is currently doing nothing at all.'
          : 'Without rua= there is no visibility into what is being rejected.')
    )
  }
  if (policy === 'none') {
    advice.push('p=none does not protect the domain — nothing is quarantined or rejected. Move to p=quarantine once reports look clean.')
  }

  const status: DnsStatus = policy === 'none' && !rua ? 'INVALID' : 'VERIFIED'
  return {
    name: 'DMARC', status, record: dmarc, checkedAt,
    detail:
      status === 'INVALID'
        ? `DMARC is published but INEFFECTIVE: policy is p=none with no rua= address, so it neither protects the domain nor reports anything.`
        : `DMARC is published with policy p=${policy}${rua ? ` and reports to ${rua}` : ''}.`,
    advice,
  }
}

// ── Aggregate ───────────────────────────────────────────────────────────

export async function liveDnsChecks(): Promise<{ domain: string | null; checks: LiveDnsCheck[] }> {
  const domain = senderDomain()
  if (!domain) {
    return {
      domain: null,
      checks: [unknown('SPF', 'EMAIL_FROM is unset or unparseable, so there is no domain to check.'),
               unknown('DKIM', 'EMAIL_FROM is unset or unparseable, so there is no domain to check.'),
               unknown('DMARC', 'EMAIL_FROM is unset or unparseable, so there is no domain to check.')],
    }
  }
  try {
    const checks = await Promise.all([checkSpf(domain), checkDkim(domain), checkDmarc(domain)])
    return { domain, checks }
  } catch (err) {
    log.warn({ err: String(err), domain }, 'live DNS checks failed')
    const reason = `The DNS check itself failed: ${err instanceof Error ? err.message : String(err)}`
    return { domain, checks: [unknown('SPF', reason), unknown('DKIM', reason), unknown('DMARC', reason)] }
  }
}
