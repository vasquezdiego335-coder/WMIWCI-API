// ════════════════════════════════════════════════════════════════════════
//  TEST / STAFF / ROLE IDENTITIES — never granted a marketing basis, never
//  enrolled, never sent promotional mail (email consent release 2026-09-16).
//  ---------------------------------------------------------------------
//  The owner tests through the PUBLIC forms, so a form submission from the
//  owner looks exactly like a customer's. Only Booking and Payment carry
//  isInternalTest; Lead and Customer have no test column at all, and the known
//  test addresses lived only in a script (scripts/flag-test-identities.ts).
//
//  One shared answer, checked at grant time, at enrollment and at send time:
//    • reserved domains (RFC 2606/6761): example.com/.net/.org, *.example,
//      *.test, *.invalid, *.localhost, localhost
//    • the business's own domains, current and retired, and their subdomains
//    • OWNER_EMAIL and EMAIL_TEST_RECIPIENT
//    • the known test identities from scripts/flag-test-identities.ts
//    • admin users and crew invitations (loaded from the database)
//    • role / system accounts (info@, noreply@, postmaster@, abuse@, …)
//  +tag variants match their base address, and Gmail dots are ignored, so
//  owner+test1@… and o.w.n.e.r@gmail.com are the owner.
//
//  FAILS CLOSED: if the staff lookup errors, the address is treated as a test
//  identity. A missed marketing email is recoverable; mail to staff is noise
//  and mail to an address nobody consented from is a violation.
// ════════════════════════════════════════════════════════════════════════

import { prisma } from '../db'
import { normalizeEmail } from '../email-tokens'
import { RETIRED_SITE_DOMAINS } from '../site-urls'

/** Domains the business owns or has owned. Subdomains match too. */
export const BUSINESS_EMAIL_DOMAINS: readonly string[] = [
  'moveitclearit.com',
  'moveitclearit.test',
  'moveitclearit.internal',
  ...RETIRED_SITE_DOMAINS.filter((d) => !d.startsWith('www.')),
]

/** Exact reserved domains (RFC 2606). */
const RESERVED_DOMAINS: readonly string[] = ['example.com', 'example.net', 'example.org', 'localhost']
/** Reserved top-level labels (RFC 2606 / 6761). */
const RESERVED_TLDS: readonly string[] = ['test', 'invalid', 'localhost', 'example']

/**
 * The owner's known test identities. Mirrors TEST_EMAILS in
 * scripts/flag-test-identities.ts — add future test addresses to BOTH.
 */
export const KNOWN_TEST_EMAILS: readonly string[] = ['vasquezdiego335@gmail.com']

/**
 * Role and system mailboxes. A shared inbox cannot give personal consent, and
 * these are the addresses scripts type when they fill forms with junk.
 */
export const ROLE_LOCAL_PARTS: readonly string[] = [
  'abuse',
  'admin',
  'administrator',
  'donotreply',
  'do-not-reply',
  'hostmaster',
  'info',
  'mailer-daemon',
  'no-reply',
  'noreply',
  'postmaster',
  'root',
  'security',
  'webmaster',
]

export type TestIdentityReason =
  | 'reserved_domain'
  | 'business_domain'
  | 'owner'
  | 'test_recipient'
  | 'known_test'
  | 'staff'
  | 'crew_invitation'
  | 'role_account'
  | 'staff_lookup_failed'

type Split = { local: string; domain: string }

function split(email: string): Split | null {
  const e = normalizeEmail(email)
  const at = e.lastIndexOf('@')
  if (at <= 0 || at === e.length - 1) return null
  return { local: e.slice(0, at), domain: e.slice(at + 1).replace(/\.+$/, '') }
}

/**
 * The identity an address belongs to: lowercased, "+tag" removed, and for
 * Gmail the dots removed and googlemail.com folded into gmail.com.
 * Returns null for something that is not an address.
 */
export function canonicalIdentity(email: string | null | undefined): string | null {
  const s = split(String(email ?? ''))
  if (!s) return null
  let local = s.local.split('+')[0]
  let domain = s.domain
  if (domain === 'googlemail.com') domain = 'gmail.com'
  if (domain === 'gmail.com') local = local.replace(/\./g, '')
  if (!local) return null
  return `${local}@${domain}`
}

const domainMatches = (domain: string, root: string): boolean => domain === root || domain.endsWith(`.${root}`)

export function isReservedDomain(domain: string): boolean {
  const d = domain.toLowerCase()
  if (RESERVED_DOMAINS.some((r) => domainMatches(d, r))) return true
  const tld = d.split('.').pop() ?? ''
  return RESERVED_TLDS.includes(tld)
}

/** True for info@, noreply@, postmaster@, abuse@ and the other role mailboxes. */
export function isRoleAddress(email: string | null | undefined): boolean {
  const s = split(String(email ?? ''))
  if (!s) return false
  return ROLE_LOCAL_PARTS.includes(s.local.split('+')[0])
}

/** A comma/semicolon/space separated env value → canonical identities. */
function identitiesFromEnv(value: string | undefined): string[] {
  return String(value ?? '')
    .split(/[,;\s]+/)
    .map((v) => canonicalIdentity(v))
    .filter((v): v is string => Boolean(v))
}

type IdentityEnv = { OWNER_EMAIL?: string; EMAIL_TEST_RECIPIENT?: string; [name: string]: string | undefined }

/** The two addresses configured per deployment, read at call time. */
function configuredIdentities(env: IdentityEnv = process.env): { owner: string[]; testRecipient: string[] } {
  return { owner: identitiesFromEnv(env.OWNER_EMAIL), testRecipient: identitiesFromEnv(env.EMAIL_TEST_RECIPIENT) }
}

export type TestIdentityContext = {
  /** Defaults to process.env. */
  env?: IdentityEnv
  /** Admin/staff user emails. */
  staffEmails?: Iterable<string>
  /** Crew invitation emails. */
  invitationEmails?: Iterable<string>
}

/**
 * PURE classification. Returns why the address is a test/staff/role identity,
 * or null for an ordinary address. Checks run most-specific first so the
 * reason is informative; any non-null answer means "never market to this".
 */
export function classifyTestIdentity(email: string | null | undefined, ctx: TestIdentityContext = {}): TestIdentityReason | null {
  const s = split(String(email ?? ''))
  if (!s) return null
  const configured = configuredIdentities(ctx.env)
  const canonical = canonicalIdentity(email)

  if (isReservedDomain(s.domain)) return 'reserved_domain'
  if (BUSINESS_EMAIL_DOMAINS.some((d) => domainMatches(s.domain, d))) return 'business_domain'
  if (canonical && configured.owner.includes(canonical)) return 'owner'
  if (canonical && configured.testRecipient.includes(canonical)) return 'test_recipient'
  if (canonical && KNOWN_TEST_EMAILS.map((e) => canonicalIdentity(e)).includes(canonical)) return 'known_test'
  if (canonical && ctx.staffEmails) {
    for (const staff of ctx.staffEmails) if (canonicalIdentity(staff) === canonical) return 'staff'
  }
  if (canonical && ctx.invitationEmails) {
    for (const inv of ctx.invitationEmails) if (canonicalIdentity(inv) === canonical) return 'crew_invitation'
  }
  if (isRoleAddress(email)) return 'role_account'
  return null
}

export type StaffEmails = { staff: string[]; invitations: string[] }

/**
 * Admin users and crew invitations, from the database. Loaded per call: both
 * tables are tiny, and a cache would keep a removed employee exempt, or a new
 * one eligible, for as long as the process lives.
 */
export async function loadStaffEmails(): Promise<StaffEmails> {
  const [users, invitations] = await Promise.all([
    prisma.user.findMany({ select: { email: true } }),
    prisma.crewInvitation.findMany({ select: { email: true } }),
  ])
  return { staff: users.map((u) => u.email), invitations: invitations.map((i) => i.email) }
}

export type TestIdentityDeps = {
  env?: TestIdentityContext['env']
  loadStaffEmails?: () => Promise<StaffEmails>
}

/**
 * Why this address is a test/staff/role identity, or null. The static checks
 * run first, so a reserved or business address never costs a query.
 * FAILS CLOSED: a lookup error answers 'staff_lookup_failed'.
 */
export async function testIdentityReason(email: string | null | undefined, deps: TestIdentityDeps = {}): Promise<TestIdentityReason | null> {
  const staticReason = classifyTestIdentity(email, { env: deps.env })
  if (staticReason) return staticReason
  if (!canonicalIdentity(email)) return null
  try {
    const { staff, invitations } = await (deps.loadStaffEmails ?? loadStaffEmails)()
    return classifyTestIdentity(email, { env: deps.env, staffEmails: staff, invitationEmails: invitations })
  } catch {
    return 'staff_lookup_failed'
  }
}

/** True when the address must never get a marketing basis, enrollment or promotional send. */
export async function isTestIdentity(email: string | null | undefined, deps: TestIdentityDeps = {}): Promise<boolean> {
  return (await testIdentityReason(email, deps)) !== null
}
