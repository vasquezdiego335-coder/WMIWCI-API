// ════════════════════════════════════════════════════════════════════════
//  REDACTION (owner spec 2026-07-27)
//  ---------------------------------------------------------------------
//  Everything the agent stores or shows a model passes through here first.
//
//  The rule is not "try to avoid secrets". It is: a secret VALUE must be
//  structurally incapable of reaching a finding, an incident, a log line, an
//  AI prompt or the admin UI. Findings say `RESEND_API_KEY is missing`; they
//  never say what it is when it is present.
//
//  Two separate jobs, deliberately not merged:
//    maskEmail()  — customer addresses. The agent reasons about "which
//                   address", so it needs a STABLE identifier, but the owner
//                   reading an incident does not need to read the customer's
//                   inbox. d***o@gmail.com is enough to recognise and not
//                   enough to leak a list.
//    redact()     — anything else. Walks a value, drops keys that name
//                   credentials, and scrubs token-shaped strings.
// ════════════════════════════════════════════════════════════════════════

/** Key names whose VALUE is never stored, whatever it contains. */
const SECRET_KEY_PATTERN =
  /(password|passwd|secret|token|api[-_]?key|apikey|authorization|auth|credential|private[-_]?key|signature|cookie|session|bearer|dsn|connection[-_]?string|database[-_]?url|webhook[-_]?secret)/i

/** Value shapes that are credentials wherever they appear. */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\bre_[A-Za-z0-9_-]{8,}/g, // Resend
  /\bwhsec_[A-Za-z0-9+/=_-]{8,}/g, // Svix / Stripe webhook secrets
  /\bsk-(?:proj-|ant-|or-)?[A-Za-z0-9_-]{16,}/g, // OpenAI / DeepSeek / Anthropic
  /\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{8,}/g, // Stripe
  /\bxox[baprs]-[A-Za-z0-9-]{8,}/g, // Slack
  /\bghp_[A-Za-z0-9]{16,}/g, // GitHub
  /\bAKIA[0-9A-Z]{12,}/g, // AWS access key id
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, // SendGrid
  /\bdiscord(?:app)?\.com\/api\/webhooks\/[0-9]+\/[A-Za-z0-9_-]+/gi, // Discord webhook URL
  /\bBot\s+[A-Za-z0-9_.-]{24,}/g, // Discord bot authorization header
  /\bBearer\s+[A-Za-z0-9_.\-=]{16,}/gi, // any bearer token
  /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, // JWT
  /\b(postgres|postgresql|redis|rediss|mysql|mongodb(\+srv)?):\/\/[^\s"']+/gi, // any DSN
  // A URL carrying a credential in its userinfo, whatever the scheme.
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@"']+:[^\s/@"']+@[^\s"']+/gi,
  // Phone numbers: personal data, never needed to diagnose an operational fault.
  //
  // TWO forms, and both REQUIRE separators or a leading `+`. An earlier version
  // assumed a country-code prefix and so never matched a plain `555-123-4567`.
  // Matching ten BARE digits would be the opposite mistake — it would eat token
  // counts and row ids, and a guard that mangles ordinary findings gets
  // switched off, which protects nobody.
  /\b(?:\+?\d{1,3}[\s.-])?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g,
  /\+\d{10,15}\b/g,
]

const SECRET_MASK = '[redacted]'

const MAX_STRING = 400
const MAX_ARRAY = 25
const MAX_DEPTH = 5

/** Any address that is not already masked. */
// `*` is inside the local-part class deliberately: without it the pattern
// matches `o@x.com` INSIDE the already-masked `d***o@x.com` and masks it a
// second time, corrupting a value that was already safe. Matching the whole
// token lets the '***' check in redactString recognise it and leave it alone.
const BARE_EMAIL = /\b[A-Za-z0-9._%+*-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g

/**
 * Scrub credential- and address-shaped substrings out of free text.
 *
 * Addresses are MASKED rather than removed: an operator reading an incident
 * needs to recognise which customer it is about, and `d***o@gmail.com` does
 * that without producing a mailing list. Secrets are removed outright, because
 * there is no version of a secret that is useful to see.
 *
 * ORDER MATTERS: secrets first, so a DSN's `user:pass@host` is already gone
 * before the address pass goes looking for an `@`.
 */
export function redactString(input: string): string {
  let out = input
  for (const p of SECRET_VALUE_PATTERNS) out = out.replace(p, SECRET_MASK)
  out = out.replace(BARE_EMAIL, (m) => (m.indexOf('***') === -1 ? maskEmail(m) : m))
  return out.length > MAX_STRING ? `${out.slice(0, MAX_STRING)}…` : out
}

/**
 * Mask an email so it stays recognisable and stops being a mailing list.
 *
 * `diego@wemoveitweclearit.com` → `d***o@wemoveitweclearit.com`. The domain is
 * kept because deliverability problems are usually domain-shaped and hiding it
 * would make half the findings unreadable.
 */
export function maskEmail(email: string | null | undefined): string {
  if (!email) return '(none)'
  const trimmed = String(email).trim()
  const at = trimmed.lastIndexOf('@')
  if (at <= 0) return '***'
  const local = trimmed.slice(0, at)
  const domain = trimmed.slice(at + 1)
  if (local.length <= 2) return `${local[0] ?? '*'}***@${domain}`
  return `${local[0]}***${local[local.length - 1]}@${domain}`
}

/**
 * Deep-redact any value for storage or for a prompt.
 *
 * Bounded on purpose: depth, array length and string length are all capped, so
 * a check that accidentally hands over ten thousand rows produces a truncated
 * object rather than a hundred-kilobyte JSON column and a runaway token bill.
 */
export function redact<T>(value: T, depth = 0): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return redactString(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (value instanceof Date) return value.toISOString()
  if (depth >= MAX_DEPTH) return '[truncated]'

  if (Array.isArray(value)) {
    const head = value.slice(0, MAX_ARRAY).map((v) => redact(v, depth + 1))
    return value.length > MAX_ARRAY ? [...head, `…and ${value.length - MAX_ARRAY} more`] : head
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_PATTERN.test(k)) {
        // Presence is useful; the value never is.
        out[k] = v === undefined || v === null || v === '' ? '(not set)' : SECRET_MASK
        continue
      }
      // Address-shaped keys, case-INSENSITIVELY: `email`, `Email`, `EMAIL`,
      // `toEmail`, `customer_email`, `recipient`. The previous pattern was
      // case-sensitive and let `EMAIL` through untouched.
      if (/(^|_)(email|recipient|mailto)($|_)|email$|recipient$/i.test(k) && typeof v === 'string') {
        out[k] = maskEmail(v)
        continue
      }
      // Free-text customer content is never needed to diagnose an operational
      // fault, and it is the most sensitive thing in the system. Dropped
      // entirely rather than truncated — a partial message body is still a
      // message body.
      if (/^(body|html|text|message|content|subject|notes?|comment)$/i.test(k) && typeof v === 'string' && v.length > 120) {
        out[k] = `[omitted ${v.length}-character content]`
        continue
      }
      out[k] = redact(v, depth + 1)
    }
    return out
  }

  return String(value)
}

/** Turn any thrown thing into one short, secret-free line. */
export function safeErrorMessage(err: unknown, max = 300): string {
  const raw = err instanceof Error ? err.message : String(err)
  return redactString(raw.replace(/\s+/g, ' ')).slice(0, max)
}
