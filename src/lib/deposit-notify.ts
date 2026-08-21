// ════════════════════════════════════════════════════════════════════════════
//  deposit-notify.ts — the confirmed-deposit Discord CARD and how it is sent.
//  ------------------------------------------------------------------------
//  Split out of discord-payments.ts deliberately: this half imports NO prisma
//  and NO queues, so the embed shape, the mention policy, the rate-limit
//  handling and the retry policy are all testable offline, with a stub `fetch`
//  and no database anywhere near them. discord-payments.ts keeps the half that
//  genuinely needs the DB (claiming a row, recording the outcome).
//
//  WHEN THE CARD IS SENT: only after a signature-verified Stripe event reported
//  the Checkout Session as PAID and the payment was recorded (see
//  stripe-events.handleDepositSession). Opening the payment page, starting
//  checkout, reaching the success URL and an unpaid completed session all
//  produce NOTHING here — this card is a statement that money moved.
//
//  TRANSPORT — two, in this order:
//    1. DISCORD_PAYMENTS_WEBHOOK_URL, when set. An incoming webhook created
//       inside the target channel. Preferred when present because only a
//       webhook can carry the sender name + company avatar the owner asked for.
//       THE URL IS A SECRET: never logged, never stored, never sent to a
//       browser, never in an error message. `scrub()` below is the last line of
//       defence for the case where the runtime puts it in an error message.
//    2. The EXISTING bot (DISCORD_BOT_TOKEN), posting to
//       DISCORD_PAYMENTS_CHANNEL_ID. This reuses the same authenticated
//       transport every other card in this system already uses.
//
//  A channel id on its own CANNOT authenticate anything. If neither a webhook
//  URL nor a bot token is configured, this module reports "not configured" and
//  the payment still completes — it never pretends to have notified anyone.
// ════════════════════════════════════════════════════════════════════════════
import { botLogger } from './logger'
import { discordSafe } from './booking-display'
import { formatCents, formatMoveWhenEn, formatPaymentTime, firstNameOf } from './deposit-links'

const log = botLogger.child({ mod: 'deposit-notify' })

/**
 * The channel the owner named for confirmed deposit payments.
 *
 * Hard-coded as a DEFAULT, not a secret: a channel id is public information
 * inside the server, and this one was given in the specification. It is still
 * overridable by DISCORD_PAYMENTS_CHANNEL_ID so the destination can be moved
 * without a deploy.
 */
export const DEFAULT_PAYMENTS_CHANNEL_ID = '1524853745064869990'

/** Brand orange (#FF5A1F) — the embed accent. */
export const EMBED_COLOR = 0xff5a1f
export const WEBHOOK_USERNAME = 'Move It Clear It Payments'

const PLACEHOLDERS = new Set(['', 'REPLACE_ME', 'placeholder'])
const configured = (v?: string | null): v is string =>
  !!v && !PLACEHOLDERS.has(v.trim()) && !v.includes('REPLACE_ME')

const env = (k: string): string | undefined => process.env[k]?.trim()

export type NotifyTransport = 'webhook' | 'bot' | null

export type NotifyConfig = {
  configured: boolean
  transport: NotifyTransport
  /** Documented destination. With a webhook, the URL itself selects the channel. */
  channelId: string
  /** Human explanation shown in the admin UI when nothing is configured. */
  reason?: string
}

export function depositNotifyConfig(): NotifyConfig {
  const channelId = env('DISCORD_PAYMENTS_CHANNEL_ID') || DEFAULT_PAYMENTS_CHANNEL_ID
  if (configured(env('DISCORD_PAYMENTS_WEBHOOK_URL'))) {
    return { configured: true, transport: 'webhook', channelId }
  }
  if (configured(env('DISCORD_BOT_TOKEN'))) {
    return { configured: true, transport: 'bot', channelId }
  }
  return {
    configured: false,
    transport: null,
    channelId,
    reason:
      'Set DISCORD_PAYMENTS_WEBHOOK_URL (an incoming webhook created inside the channel) or DISCORD_BOT_TOKEN. ' +
      'A channel id alone cannot authenticate a Discord request.',
  }
}

/** The company logo used as the webhook avatar. Public, absolute, cacheable. */
export function avatarUrl(): string {
  const explicit = env('DISCORD_PAYMENTS_AVATAR_URL')
  if (configured(explicit)) return explicit
  const app = (env('APP_URL') ?? 'https://www.moveitclearit.com').replace(/\/+$/, '')
  return `${app}/logo/icon.png`
}

// ── Embed ───────────────────────────────────────────────────────────────────

export type DepositPaidEmbedInput = {
  customerName?: string | null
  amountPaidCents: number
  quoteTotalCents?: number | null
  remainingCents?: number | null
  moveDate?: Date | null
  /** Minutes after midnight Eastern, or null when no time was recorded. */
  moveTimeMinutes?: number | null
  /** The CUSTOMER-FACING service line, so the owner's card and the customer's
   *  page describe the same job. */
  serviceSummary?: string | null
  /** The PRIVATE crew note. This channel is owner-only, which is the whole
   *  reason the note now has somewhere to go other than the customer's page. */
  internalNote?: string | null
  bookingReference?: string | null
  paidAt?: Date | null
  /** false ⇒ Stripe test mode ⇒ the card says so, loudly. */
  livemode?: boolean | null
  /** Private admin URL for the booking/payment. Omitted when there is none. */
  adminUrl?: string | null
}

export type EmbedJson = Record<string, unknown>

/**
 * Build the card. PURE — no env reads, no I/O — so the exact JSON that goes to
 * Discord is asserted in tests.
 *
 * WHAT IS DELIBERATELY ABSENT, and stays absent:
 *   pickup/delivery addresses · card details · customer email · customer phone
 *   · the public deposit token · any Stripe key or session/URL secret.
 * A field whose value is unknown is OMITTED, never rendered as "undefined" or
 * a misleading "$0.00".
 */
export function buildDepositPaidEmbed(input: DepositPaidEmbedInput): EmbedJson {
  const test = input.livemode === false
  const fields: Array<{ name: string; value: string; inline?: boolean }> = []

  const first = firstNameOf(input.customerName)
  if (first) fields.push({ name: 'Customer', value: discordSafe(first, 100), inline: true })

  fields.push({ name: 'Deposit received', value: formatCents(input.amountPaidCents), inline: true })

  if (input.quoteTotalCents != null) {
    fields.push({ name: 'Quote total', value: formatCents(input.quoteTotalCents), inline: true })
  }
  if (input.remainingCents != null) {
    fields.push({ name: 'Remaining balance', value: formatCents(input.remainingCents), inline: true })
  }
  // ONE formatter, shared with the customer's page. This card printed the day
  // BEFORE the move for every date the admin form stored — and this is the copy
  // a crew gets dispatched from.
  const moveWhen = formatMoveWhenEn(input.moveDate, input.moveTimeMinutes)
  if (moveWhen) fields.push({ name: 'Move', value: moveWhen, inline: true })

  if (input.serviceSummary) {
    fields.push({ name: 'Service', value: discordSafe(input.serviceSummary, 200), inline: true })
  }

  if (input.bookingReference) {
    fields.push({ name: 'Booking', value: discordSafe(input.bookingReference, 40), inline: true })
  }

  fields.push({ name: 'Payment status', value: 'Confirmed', inline: true })

  const paidAt = formatPaymentTime(input.paidAt)
  if (paidAt) fields.push({ name: 'Payment time', value: paidAt, inline: true })

  // LAST, and full width: it is the longest field and the only private one.
  if (input.internalNote) {
    fields.push({ name: 'Internal note', value: discordSafe(input.internalNote, 900), inline: false })
  }

  if (input.adminUrl) {
    fields.push({ name: 'Open booking', value: `[View in admin](${input.adminUrl})`, inline: false })
  }

  const embed: EmbedJson = {
    title: test ? '🧪 TEST — Deposit Paid' : '✅ Deposit Paid',
    color: EMBED_COLOR,
    fields,
    timestamp: (input.paidAt ?? new Date()).toISOString(),
    footer: { text: 'Stripe-confirmed payment • Move It Clear It' },
  }
  // The title links to the private admin page when there is one, so the card is
  // one tap from the booking on a phone.
  if (input.adminUrl) embed.url = input.adminUrl
  return embed
}

/** The test card. Says TEST in three places and touches no payment record. */
export function buildTestEmbed(byName?: string | null): EmbedJson {
  return {
    title: '🧪 TEST — Deposit notification check',
    color: EMBED_COLOR,
    description:
      'This is a TEST message sent from the admin deposit-links page. ' +
      'No payment was created, changed or refunded.',
    fields: [
      { name: 'Payment status', value: 'Not a payment', inline: true },
      ...(byName ? [{ name: 'Sent by', value: discordSafe(byName, 60), inline: true }] : []),
    ],
    timestamp: new Date().toISOString(),
    footer: { text: 'Test message • Move It Clear It' },
  }
}

// ── Delivery ────────────────────────────────────────────────────────────────

export type SendResult = {
  delivered: boolean
  messageId: string | null
  transport: NotifyTransport
  /** Already scrubbed of any URL/token. Safe to store and to show an admin. */
  error?: string
  attempts: number
}

/** Never let a webhook URL or a bot token reach a log line, the DB or a screen. */
export function scrub(text: string): string {
  return text
    .replace(/https:\/\/discord(?:app)?\.com\/api\/webhooks\/\S+/gi, '[discord webhook url redacted]')
    .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b/g, '[token redacted]')
    .slice(0, 300)
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Injection seams, used ONLY by tests.
 *
 * `fetchImpl` lets a test drive 429 / 503 / network-error paths deterministically
 * without a network, and `sleepImpl` keeps the backoff assertions instant instead
 * of making the suite wait out real delays. Production passes neither, so the
 * shipped path is the plain global fetch.
 */
export type SendDeps = {
  fetchImpl?: typeof fetch
  sleepImpl?: (ms: number) => Promise<void>
}

/**
 * POST one message, honouring Discord's rate limits.
 *
 * 429 → wait the Retry-After Discord names (capped, so a pathological value
 * cannot hang a worker) and try again. 5xx / network → bounded exponential
 * backoff. 4xx other than 429 is a permanent error and is NOT retried: a bad
 * channel id or a revoked token will fail identically forever, and hammering it
 * only delays the FAILED status the owner needs to see.
 */
export async function postWithRetry(
  doPost: () => Promise<Response>,
  maxAttempts = 3,
  sleepImpl: (ms: number) => Promise<void> = sleep
): Promise<{ ok: boolean; body: unknown; status: number; error?: string; attempts: number; waits: number[] }> {
  const waits: number[] = []
  let lastError = 'unknown error'
  let lastStatus = 0

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await doPost()
      lastStatus = res.status

      if (res.status === 429) {
        const retryAfterHeader = res.headers.get('retry-after')
        const bodyJson = (await res.json().catch(() => ({}))) as { retry_after?: number }
        // Discord sends seconds in both places; the body is more precise.
        const seconds = bodyJson.retry_after ?? Number(retryAfterHeader) ?? 1
        const waitMs = Math.min(Math.max(Number.isFinite(seconds) ? seconds * 1000 : 1000, 250), 10_000)
        lastError = `rate limited (429), waited ${Math.round(waitMs)}ms`
        waits.push(waitMs)
        if (attempt < maxAttempts) {
          await sleepImpl(waitMs)
          continue
        }
        return { ok: false, body: null, status: 429, error: lastError, attempts: attempt, waits }
      }

      if (res.status >= 500) {
        lastError = `discord ${res.status}`
        if (attempt < maxAttempts) {
          const backoff = Math.min(500 * 2 ** (attempt - 1), 4000)
          waits.push(backoff)
          await sleepImpl(backoff)
          continue
        }
        return { ok: false, body: null, status: res.status, error: lastError, attempts: attempt, waits }
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        // Permanent — do not retry.
        return { ok: false, body: null, status: res.status, error: scrub(`discord ${res.status}: ${text}`), attempts: attempt, waits }
      }

      const body = res.status === 204 ? null : await res.json().catch(() => null)
      return { ok: true, body, status: res.status, attempts: attempt, waits }
    } catch (err) {
      lastError = scrub(err instanceof Error ? err.message : String(err))
      if (attempt < maxAttempts) {
        const backoff = Math.min(500 * 2 ** (attempt - 1), 4000)
        waits.push(backoff)
        await sleepImpl(backoff)
        continue
      }
    }
  }
  return { ok: false, body: null, status: lastStatus, error: lastError, attempts: maxAttempts, waits }
}

/**
 * Send an embed to the payments destination.
 *
 * `allowed_mentions: { parse: [] }` is not optional. A customer picks their own
 * name, and without this an "@everyone" typed into a name field would ping the
 * whole server from an official-looking payment card. discordSafe() already
 * breaks the text; this makes it structurally impossible.
 */
export async function sendPaymentEmbed(embed: EmbedJson, deps: SendDeps = {}): Promise<SendResult> {
  const cfg = depositNotifyConfig()
  const doFetch = deps.fetchImpl ?? fetch

  if (cfg.transport === 'webhook') {
    const url = env('DISCORD_PAYMENTS_WEBHOOK_URL') as string
    // ?wait=true makes Discord return the created message so its id can be
    // stored — without it the response is a 204 with no body.
    const target = url.includes('?') ? `${url}&wait=true` : `${url}?wait=true`
    const r = await postWithRetry(() =>
      doFetch(target, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: WEBHOOK_USERNAME,
          avatar_url: avatarUrl(),
          embeds: [embed],
          allowed_mentions: { parse: [] },
        }),
      }),
      3,
      deps.sleepImpl
    )
    const messageId = (r.body as { id?: string } | null)?.id ?? null
    if (!r.ok) log.error({ transport: 'webhook', error: r.error, attempts: r.attempts }, 'deposit notification failed')
    return { delivered: r.ok, messageId, transport: 'webhook', error: r.error, attempts: r.attempts }
  }

  if (cfg.transport === 'bot') {
    const token = env('DISCORD_BOT_TOKEN') as string
    const r = await postWithRetry(() =>
      doFetch(`https://discord.com/api/v10/channels/${cfg.channelId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bot ${token}` },
        body: JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] } }),
      }),
      3,
      deps.sleepImpl
    )
    const messageId = (r.body as { id?: string } | null)?.id ?? null
    if (!r.ok) log.error({ transport: 'bot', channelId: cfg.channelId, error: r.error, attempts: r.attempts }, 'deposit notification failed')
    return { delivered: r.ok, messageId, transport: 'bot', error: r.error, attempts: r.attempts }
  }

  log.error('deposit notification NOT sent — no Discord webhook URL and no bot token configured')
  return { delivered: false, messageId: null, transport: null, error: cfg.reason, attempts: 0 }
}

