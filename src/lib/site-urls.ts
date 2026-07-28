// ════════════════════════════════════════════════════════════════════════
//  CANONICAL PUBLIC URLS (owner report 2026-07-28)
//  ---------------------------------------------------------------------
//  WHAT WENT WRONG. `app/my-booking/page.tsx` fell back to
//  `https://www.wemoveitweclearit.com` when NEXT_PUBLIC_MARKETING_SITE_URL was
//  unset — and that variable WAS unset in production. That domain is the
//  retired brand name (WMIWCI = We Move It We Clear It) and it no longer
//  resolves at all: no A record, no MX, nothing. So the customer portal was
//  rendering links to a dead host, silently, with nothing broken-looking on
//  the page to reveal it.
//
//  A fallback that points somewhere WRONG is worse than no fallback. A missing
//  URL is an obvious bug; a plausible-looking dead one survives review.
//
//  THE RULE: the live domain appears in exactly one place — here. A default
//  that is wrong in one file and right in another is how the two drift, and
//  drift is what produced this.
// ════════════════════════════════════════════════════════════════════════

/**
 * The live public website.
 *
 * Verified 2026-07-28: `www.moveitclearit.com` resolves and serves the site;
 * `wemoveitweclearit.com` does not resolve at all.
 */
export const CANONICAL_SITE_URL = 'https://www.moveitclearit.com'

/** The retired brand domain. Kept ONLY so it can be recognised and rejected. */
export const RETIRED_SITE_DOMAINS = ['wemoveitweclearit.com', 'www.wemoveitweclearit.com'] as const

const strip = (u: string): string => u.trim().replace(/\/+$/, '')

/**
 * Resolve the public marketing site URL.
 *
 * Falls back to the CANONICAL domain, never the retired one — and refuses a
 * configured value that points at a retired domain, because an environment
 * variable copied forward from an old deployment is exactly how this
 * reappears.
 */
export function marketingSiteUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configured = strip(env.NEXT_PUBLIC_MARKETING_SITE_URL ?? env.MARKETING_SITE_URL ?? '')
  if (!configured) return CANONICAL_SITE_URL
  if (isRetiredDomain(configured)) return CANONICAL_SITE_URL
  return configured
}

/** Does this URL point at a domain we no longer own or use? */
export function isRetiredDomain(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return (RETIRED_SITE_DOMAINS as readonly string[]).includes(host)
  } catch {
    return false
  }
}
