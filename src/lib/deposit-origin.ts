// ════════════════════════════════════════════════════════════════════════════
//  deposit-origin.ts — which hosts this app is legitimately reached on, and
//  where Stripe should send the customer back to.
//  ------------------------------------------------------------------------
//  THIS PAGE IS SERVED THROUGH A PROXY, and both rules below exist because of
//  it. The customer's link is `https://www.moveitclearit.com/deposit/…`, which
//  WMIWCI-SITE's vercel.json REWRITES to the Railway host. A rewrite is not a
//  redirect: the browser still believes it is on the brand domain and sends
//  `Origin: https://www.moveitclearit.com`, while this app sees a `Host` of
//  `…up.railway.app`.
//
//  Consequences, both of which were live defects:
//
//    1. A same-origin guard that compared the Origin against the app's own Host
//       compared the brand domain to the proxy target. They never match, so the
//       Pay button returned 403 for every browser that does not send
//       `Sec-Fetch-Site` — Safari only shipped those headers in 16.4, and this
//       link is designed to be opened inside Messenger's in-app browser.
//
//    2. A return URL built from an environment variable does not know which
//       hostname the customer actually opened. With DEPOSIT_LINK_BASE_URL unset
//       (the documented current state) a customer paid on the brand domain and
//       was returned to a raw `…up.railway.app` URL — an unfamiliar domain, in
//       the second after they entered a card.
//
//  `x-forwarded-host` carries the ORIGINAL host, so it is the value that
//  actually corresponds to the Origin the browser sent. It is ATTACKER-
//  CONTROLLABLE in principle, so it is never trusted on its own: it is only
//  honoured when it matches a host this app is otherwise known to serve.
//
//  PURE. Headers in, decision out — no Next types, no `process` except through
//  an explicitly passed env object, so every rule here is testable offline.
// ════════════════════════════════════════════════════════════════════════════

/** The subset of a request these rules read. */
export type OriginHeaders = {
  get(name: string): string | null
}

/**
 * The subset of the environment these rules read.
 *
 * `process.env` satisfies it, and so does a two-key object in a test — without
 * having to fake NODE_ENV. The index signature is what keeps this from being a
 * "weak type": with only optional named keys, TypeScript refuses an assignment
 * from `ProcessEnv` on the grounds that they share no properties.
 */
export type OriginEnv = {
  DEPOSIT_LINK_BASE_URL?: string
  APP_URL?: string
  [key: string]: string | undefined
}

const clean = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')

/** The first entry of a possibly comma-joined proxy header. */
export function firstForwarded(value: string | null | undefined): string | null {
  if (!value) return null
  const first = value.split(',')[0]
  const host = first ? clean(first) : ''
  return host || null
}

/**
 * The company's own hostnames, which are always legitimate.
 *
 * Built in rather than configured because `depositBaseUrl()` already falls back
 * to `https://www.moveitclearit.com`: the brand domain is a constant of this
 * codebase, not a deployment detail. Having it here is what lets the forwarded
 * host be VALIDATED instead of merely believed.
 */
const BRAND_HOSTS = ['moveitclearit.com', 'www.moveitclearit.com']

/**
 * Every host this app may legitimately be reached on.
 *
 * NOTE WHAT IS NOT IN HERE: `x-forwarded-host`.
 *
 * That header is the CANDIDATE being checked, and a set that contains the
 * candidate always vouches for it — which is not a check, it is a formality.
 * Including it would have let a forged `x-forwarded-host: evil.example` both
 * pass the origin guard and become a Stripe redirect target. The trusted set is
 * therefore the immediate host, the configured public bases, and the brand's own
 * domains; the forwarded host is only ever ACCEPTED BY, never a member of, it.
 */
export function allowedHosts(headers: OriginHeaders, env: OriginEnv = process.env): Set<string> {
  const hosts = new Set<string>(BRAND_HOSTS)
  const add = (value?: string | null) => {
    if (!value) return
    for (const part of value.split(',')) {
      const host = clean(part)
      if (host) hosts.add(host)
    }
  }
  add(headers.get('host'))
  for (const configured of [env.DEPOSIT_LINK_BASE_URL, env.APP_URL]) {
    if (!configured) continue
    try {
      add(new URL(configured).host)
    } catch {
      // A malformed env var must neither open nor close the guard.
    }
  }
  return hosts
}

/**
 * Is this POST same-origin?
 *
 * `Sec-Fetch-Site` is authoritative where the browser sends it. Where it does
 * not, the Origin is compared against the hosts above rather than against the
 * proxied Host. A request with no Origin at all is a non-browser client (curl,
 * a health check) and is allowed — there is no ambient authority to abuse here,
 * and the worst a forged cross-site POST could do is mint an unused Checkout
 * Session for a link the attacker already holds the token for.
 */
export function isSameOrigin(headers: OriginHeaders, env: OriginEnv = process.env): boolean {
  const fetchSite = headers.get('sec-fetch-site')
  if (fetchSite) return fetchSite === 'same-origin' || fetchSite === 'none'

  const origin = headers.get('origin')
  if (!origin) return true

  let originHost: string
  try {
    originHost = new URL(origin).host.toLowerCase()
  } catch {
    return false
  }
  return allowedHosts(headers, env).has(originHost)
}

/**
 * The base URL Stripe returns the customer to.
 *
 * Prefers the host they are ACTUALLY on, validated against `allowedHosts`, and
 * falls back to the caller's configured base. `http` is only ever honoured for
 * localhost, so a stripped-TLS proxy cannot downgrade a payment return URL.
 */
export function depositReturnBase(
  headers: OriginHeaders,
  fallbackBase: string,
  env: OriginEnv = process.env
): string {
  const forwarded = firstForwarded(headers.get('x-forwarded-host'))
  if (!forwarded || !allowedHosts(headers, env).has(forwarded)) return fallbackBase

  const proto = firstForwarded(headers.get('x-forwarded-proto'))
  const isLocal = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(forwarded)
  const scheme = proto === 'http' && isLocal ? 'http' : 'https'
  return `${scheme}://${forwarded}`
}
