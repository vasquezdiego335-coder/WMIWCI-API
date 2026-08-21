'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { csrfHeader } from '../(dashboard)/_client'
// PURE and browser-safe (Date + Intl only). The SAME module the customer's page
// formats with, so the owner's list and the customer's page can never disagree
// about which day a move is.
import {
  moveDateInputValue,
  moveTimeInputValue,
  easternTimeMinutes,
  parseCalendarDate,
  parseMoveTime,
  formatMoveWhen,
} from '@/lib/move-date'

// ════════════════════════════════════════════════════════════════════════════
//  The mobile deposit-link creator.
//  ------------------------------------------------------------------------
//  Built for one hand on a phone, mid-conversation in Messenger: a numeric
//  keypad for the amount, a $49 preset, one primary button, and Copy / Share /
//  Copy message right where the link appears.
//
//  IT VALIDATES NOTHING THAT MATTERS. Client-side checks here are courtesy —
//  the amount is re-parsed and the balance re-derived on the server, so a user
//  with dev tools open gains exactly nothing.
// ════════════════════════════════════════════════════════════════════════════

const NAVY = '#0A1628'
const ORANGE = '#FF5A1F'
const ORANGE_CTA = '#D2450F'
const BONE = '#F5F1EA'
const GREEN = '#10B981'
const RED = '#EF4444'
const AMBER = '#F59E0B'
const MUTED = '#6B7280'

type Notifications = { configured: boolean; transport: string | null; channelId: string; reason?: string }

type BookingTarget = {
  id: string
  reference: string
  customerName: string
  customerEmail: string | null
  customerPhone: string | null
  status: string
  moveDate: string | null
  quoteTotalCents: number | null
  unpaidBalanceCents: number | null
  quoteMissing: boolean
  authorizedNotCapturedCents: number
}
type LeadTarget = {
  id: string
  customerName: string
  customerEmail: string | null
  customerPhone: string | null
  moveDate: string | null
  quoteTotalCents: number | null
  jobType: string | null
}

type LinkRow = {
  id: string
  publicToken: string
  url: string
  status: 'ACTIVE' | 'PAID' | 'EXPIRED' | 'CANCELED'
  amountCents: number
  quoteTotalCents: number | null
  amountPaidCents: number | null
  remainingCents: number | null
  customerName: string | null
  serviceSummary: string | null
  moveDetails: string[]
  customerNote: string | null
  /** ADMIN-ONLY — the public projection never selects this column. */
  internalNote: string | null
  moveDate: string | null
  moveTimeMinutes: number | null
  /** Pre-rendered server-side by the one safe formatter. */
  moveWhenLabel: string | null
  expiresAt: string | null
  paidAt: string | null
  createdAt: string
  createdByName: string | null
  bookingReference: string | null
  discordStatus: 'NOT_APPLICABLE' | 'PENDING' | 'SENDING' | 'SENT' | 'FAILED'
  discordNotifiedAt: string | null
  discordRetryCount: number
  discordError: string | null
}

/** Kept in step with deposit-links.ts, which enforces these on the server. */
const SERVICE_MAX = 80
const CUSTOMER_NOTE_MAX = 160
const DETAIL_MAX_LINES = 6

const money = (cents: number | null | undefined): string =>
  cents == null ? '—' : `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** The LINK's expiry — a real instant, so genuinely shown in Eastern. */
const expiryLabel = (iso: string | null): string | null =>
  iso
    ? `${new Date(iso).toLocaleString('en-US', {
        timeZone: 'America/New_York', month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit',
      })} ET`
    : null

const shortDate = (iso: string | null): string | null =>
  iso ? new Date(iso).toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric' }) : null

export default function DepositLinksClient({
  canCreate,
  canCancel,
  canTest,
  presetCents,
  notifications,
}: {
  canCreate: boolean
  canCancel: boolean
  canTest: boolean
  presetCents: number
  notifications: Notifications
}) {
  // ── Form state ────────────────────────────────────────────────────────────
  const [mode, setMode] = useState<'booking' | 'standalone'>('booking')
  const [search, setSearch] = useState('')
  const [targets, setTargets] = useState<{ bookings: BookingTarget[]; leads: LeadTarget[] }>({ bookings: [], leads: [] })
  const [booking, setBooking] = useState<BookingTarget | null>(null)
  const [lead, setLead] = useState<LeadTarget | null>(null)

  // THE FULL NAME. It used to be "first name", which overwrote a booking's
  // stored full name with just its first word. The public page shows only the
  // first name anyway (deposit-links.firstNameOf), so there is nothing to gain
  // by discarding the surname and a record to lose.
  const [customerName, setCustomerName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [quoteTotal, setQuoteTotal] = useState('')
  const [amount, setAmount] = useState('')
  const [moveDate, setMoveDate] = useState('')
  const [moveTime, setMoveTime] = useState('')
  const [service, setService] = useState('')
  const [details, setDetails] = useState('')
  const [customerNote, setCustomerNote] = useState('')
  const [internalNote, setInternalNote] = useState('')
  const [expiresAt, setExpiresAt] = useState('')

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<LinkRow | null>(null)
  const [warning, setWarning] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  // ── History ───────────────────────────────────────────────────────────────
  const [history, setHistory] = useState<LinkRow[]>([])
  const [historyQuery, setHistoryQuery] = useState('')
  const [loadingHistory, setLoadingHistory] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)

  const flash = useCallback((m: string) => {
    setToast(m)
    setTimeout(() => setToast(null), 2200)
  }, [])

  /** Loads the list AND returns it, so a caller can read the row it just made. */
  const loadHistory = useCallback(async (q = ''): Promise<LinkRow[]> => {
    setLoadingHistory(true)
    try {
      const res = await fetch(`/api/admin/deposit-links?limit=50${q ? `&q=${encodeURIComponent(q)}` : ''}`, { cache: 'no-store' })
      if (!res.ok) {
        // A failed load must not render as "No deposit links yet." — that reads
        // as "nothing exists", which is a different and alarming fact.
        setHistoryError('Could not load history. Check your connection and try again.')
        return []
      }
      const data = (await res.json()) as { links: LinkRow[] }
      setHistoryError(null)
      setHistory(data.links ?? [])
      return data.links ?? []
    } catch {
      setHistoryError('Could not load history. Check your connection and try again.')
      return []
    } finally {
      setLoadingHistory(false)
    }
  }, [])

  useEffect(() => {
    void loadHistory()
  }, [loadHistory])

  // Debounced target search.
  useEffect(() => {
    if (mode !== 'booking') return
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/admin/deposit-links/targets?q=${encodeURIComponent(search)}`, { cache: 'no-store' })
        if (res.ok) setTargets((await res.json()) as { bookings: BookingTarget[]; leads: LeadTarget[] })
      } catch {
        /* the picker is a convenience; a failed search must not block the form */
      }
    }, 250)
    return () => clearTimeout(t)
  }, [search, mode])

  const pickBooking = (b: BookingTarget) => {
    setBooking(b)
    setLead(null)
    setCustomerName(b.customerName ?? '')
    setEmail(b.customerEmail ?? '')
    setPhone(b.customerPhone ?? '')
    setQuoteTotal(b.quoteTotalCents != null ? (b.quoteTotalCents / 100).toFixed(2) : '')
    prefillWhen(b.moveDate)
    setError(null)
  }

  const pickLead = (l: LeadTarget) => {
    setLead(l)
    setBooking(null)
    setCustomerName(l.customerName ?? '')
    setEmail(l.customerEmail ?? '')
    setPhone(l.customerPhone ?? '')
    setQuoteTotal(l.quoteTotalCents != null ? (l.quoteTotalCents / 100).toFixed(2) : '')
    prefillWhen(l.moveDate)
    setError(null)
  }

  /**
   * Prefill the date and time from a booking's or lead's stored instant.
   *
   * `iso.slice(0, 10)` used to be used here, which reads the UTC day: a job at
   * 9pm Eastern is already the NEXT day in UTC, so the form pre-filled the wrong
   * date and the owner would have shipped it without noticing. Going through
   * move-date takes the EASTERN calendar day, the same way the page reads it.
   */
  const prefillWhen = (iso: string | null) => {
    if (!iso) {
      setMoveDate('')
      setMoveTime('')
      return
    }
    const at = new Date(iso)
    if (Number.isNaN(at.getTime())) {
      setMoveDate('')
      setMoveTime('')
      return
    }
    setMoveDate(moveDateInputValue(at))
    // A booking's requestedDate carries a real time; a lead's date-only value
    // does not, and midnight is not a move time anybody means.
    const minutes = easternTimeMinutes(at)
    setMoveTime(minutes && minutes > 0 ? moveTimeInputValue(minutes) : '')
  }

  /**
   * A genuinely blank form.
   *
   * "Create another" used to clear the amount and the service line and leave
   * the previous customer's name, email, phone, quote total, move date and the
   * selected booking in place — so the next link was minted against the last
   * customer's details unless every field was cleared by hand. On a page whose
   * output is a payable URL sent to a named person, that is the wrong default.
   */
  const resetForm = () => {
    setCreated(null)
    setWarning(null)
    setError(null)
    setBooking(null)
    setLead(null)
    setSearch('')
    setCustomerName('')
    setEmail('')
    setPhone('')
    setQuoteTotal('')
    setAmount('')
    setMoveDate('')
    setMoveTime('')
    setService('')
    setDetails('')
    setCustomerNote('')
    setInternalNote('')
    setExpiresAt('')
  }

  const clearTarget = () => {
    setBooking(null)
    setLead(null)
  }

  /** Exactly what the customer will read, rendered by the customer's formatter. */
  const previewWhen = useMemo(() => {
    const at = parseCalendarDate(moveDate)
    if (!at) return ''
    return formatMoveWhen(at, moveTime ? parseMoveTime(moveTime) : null, 'en') ?? ''
  }, [moveDate, moveTime])

  // Local preview only. The server computes the figure that is stored.
  const previewRemaining = useMemo(() => {
    const base = booking?.unpaidBalanceCents ?? parseDollarsToCents(quoteTotal)
    const amt = parseDollarsToCents(amount)
    if (base == null || amt == null) return null
    return Math.max(0, base - amt)
  }, [booking, quoteTotal, amount])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setWarning(null)
    setBusy(true)
    try {
      const res = await fetch('/api/admin/deposit-links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...csrfHeader() },
        body: JSON.stringify({
          amount,
          bookingId: booking?.id ?? null,
          leadId: lead?.id ?? null,
          customerName: customerName || null,
          customerEmail: email || null,
          customerPhone: phone || null,
          quoteTotal: quoteTotal || null,
          // Customer-facing.
          serviceSummary: service || null,
          moveDetails: details || null,
          customerNote: customerNote || null,
          // Private.
          internalNote: internalNote || null,
          moveDate: moveDate || null,
          moveTime: moveTime || null,
          expiresAt: expiresAt || null,
        }),
      })
      const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string; warning?: string | null; publicToken?: string; amountCents?: number }
      if (!res.ok) {
        setError(data.error ?? 'Could not create the link')
        return
      }
      // THE STORED ROW, NOT THE TYPED ONE.
      // The success card used to be assembled from the form's own state, so it
      // reported what the owner typed rather than what the server saved — the
      // two differ whenever the server normalises something (a booking's own
      // quote total wins over a typed one), and a comma-grouped total the
      // server accepted rendered here as "$NaN". Re-reading history is a request
      // this handler was already making; using its answer costs nothing and
      // means the card can only ever show what a customer would see.
      const fresh = await loadHistory(historyQuery)
      const stored = fresh.find((r) => r.publicToken === data.publicToken)
      setCreated(
        stored ?? {
          // Fallback only if the reload failed — the link IS created either way,
          // and the owner still needs the URL.
          id: '', publicToken: data.publicToken ?? '', url: data.url ?? '', status: 'ACTIVE',
          amountCents: data.amountCents ?? 0, quoteTotalCents: parseDollarsToCents(quoteTotal),
          amountPaidCents: null, remainingCents: previewRemaining, customerName: customerName || null,
          serviceSummary: service || null,
          moveDetails: detailLines(details),
          customerNote: customerNote || null, internalNote: internalNote || null,
          moveDate: moveDate || null, moveTimeMinutes: moveTime ? parseMoveTime(moveTime) : null,
          moveWhenLabel: previewWhen || null, expiresAt: expiresAt || null,
          paidAt: null, createdAt: new Date().toISOString(), createdByName: null,
          bookingReference: booking?.reference ?? null, discordStatus: 'NOT_APPLICABLE',
          discordNotifiedAt: null, discordRetryCount: 0, discordError: null,
        }
      )
      setWarning(data.warning ?? null)
      await copy(data.url ?? '', 'Link copied')
    } catch {
      setError('Network error — the link was not created')
    } finally {
      setBusy(false)
    }
  }

  // Clipboard with a fallback: iOS Safari refuses navigator.clipboard outside a
  // secure context, and a silently-failed copy is worse than a visible one.
  const copy = async (text: string, label = 'Copied') => {
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      flash(label)
    } catch {
      try {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.setAttribute('readonly', '')
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
        flash(label)
      } catch {
        flash('Copy failed — long-press the link to copy')
      }
    }
  }

  const share = async (row: LinkRow) => {
    const text = customerMessage(row)
    if (typeof navigator !== 'undefined' && 'share' in navigator) {
      try {
        await (navigator as Navigator & { share: (d: ShareData) => Promise<void> }).share({
          title: 'Move It Clear It deposit',
          text,
          url: row.url,
        })
        return
      } catch {
        /* user dismissed the sheet, or the browser has no share target */
      }
    }
    await copy(text, 'Message copied')
  }

  const customerMessage = (row: LinkRow): string => {
    const name = row.customerName?.trim().split(/\s+/)[0] || 'there'
    return `Hi ${name}, you can securely pay the ${money(row.amountCents)} deposit for your move here: ${row.url}. This deposit will be applied toward your remaining balance.`
  }

  const cancelLink = async (id: string) => {
    if (!confirm('Cancel this deposit link? The customer will no longer be able to pay it.')) return
    const res = await fetch(`/api/admin/deposit-links/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...csrfHeader() },
      body: JSON.stringify({ action: 'cancel' }),
    })
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    flash(res.ok ? 'Link canceled' : data.error ?? 'Could not cancel')
    void loadHistory(historyQuery)
  }

  const retryNotify = async (id: string) => {
    const res = await fetch(`/api/admin/deposit-links/${id}/notify`, { method: 'POST', headers: { ...csrfHeader() } })
    const data = (await res.json().catch(() => ({}))) as { error?: string; note?: string }
    flash(res.ok ? data.note ?? 'Discord notification sent' : data.error ?? 'Retry failed')
    void loadHistory(historyQuery)
  }

  const sendTest = async () => {
    const res = await fetch('/api/admin/deposit-links/test-notification', { method: 'POST', headers: { ...csrfHeader() } })
    const data = (await res.json().catch(() => ({}))) as { error?: string; detail?: string; transport?: string }
    flash(res.ok ? `Test sent via ${data.transport}` : data.error ?? 'Test failed')
  }

  return (
    <>
      {toast && <div style={toastStyle} role="status">{toast}</div>}

      {/* ── Discord configuration state — stated, never assumed ── */}
      {!notifications.configured ? (
        <div style={{ ...banner, background: '#FEF2F2', borderColor: '#FECACA', color: '#B91C1C' }}>
          <strong>Discord notifications are NOT configured.</strong> Payments will still work and will still be recorded —
          but nobody will be notified in Discord. {notifications.reason}
        </div>
      ) : (
        <div style={{ ...banner, background: '#ECFDF5', borderColor: '#A7F3D0', color: '#065F46' }}>
          Discord notifications on via <strong>{notifications.transport}</strong>
          {notifications.transport === 'bot' ? ` → channel ${notifications.channelId}` : ' (webhook selects the channel)'}.
          {canTest && (
            <button type="button" onClick={sendTest} style={{ ...linkButton, color: '#065F46' }}>
              Send test
            </button>
          )}
        </div>
      )}

      {/* ── The created link ── */}
      {created && (
        <section style={{ ...card, borderColor: GREEN, borderWidth: '2px' }}>
          <p style={cardTitle}>Link ready</p>
          <p style={{ fontSize: '28px', fontWeight: 800, color: ORANGE_CTA, margin: '0 0 4px' }}>{money(created.amountCents)}</p>
          <p style={{ ...urlText }}>{created.url}</p>

          <div style={rowGrid}>
            {created.quoteTotalCents != null && <Fig label="Quote total" value={money(created.quoteTotalCents)} />}
            {created.remainingCents != null && <Fig label="Remaining after" value={money(created.remainingCents)} />}
            <Fig label="Status" value="Active" />
            <Fig label="Discord" value="Not applicable (unpaid)" />
          </div>

          {warning && <p style={{ ...banner, background: '#FFFBEB', borderColor: '#FDE68A', color: '#92400E', marginTop: '12px' }}>{warning}</p>}

          <div style={{ display: 'grid', gap: '8px', marginTop: '14px' }}>
            <button type="button" onClick={() => copy(created.url, 'Link copied')} style={primaryButton}>Copy Link</button>
            <button type="button" onClick={() => share(created)} style={secondaryButton}>Share Link</button>
            <button type="button" onClick={() => copy(customerMessage(created), 'Message copied')} style={secondaryButton}>
              Copy Customer Message
            </button>
            <button type="button" onClick={resetForm} style={ghostButton}>
              Create another
            </button>
          </div>
        </section>
      )}

      {/* ── The form ── */}
      {!created && (
        <form onSubmit={submit} style={card}>
          <p style={cardTitle}>New deposit link</p>

          <div style={{ display: 'flex', gap: '8px', marginBottom: '14px' }}>
            <Toggle active={mode === 'booking'} onClick={() => setMode('booking')} label="Booking / lead" />
            <Toggle active={mode === 'standalone'} onClick={() => { setMode('standalone'); clearTarget() }} label="Standalone" />
          </div>

          {mode === 'booking' && !booking && !lead && (
            <>
              <Field label="Find a booking, lead or customer">
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Name, phone, email or WMIC-…"
                  style={input}
                  autoComplete="off"
                />
              </Field>
              <div style={{ maxHeight: '230px', overflowY: 'auto', margin: '0 0 14px' }}>
                {targets.bookings.map((b) => (
                  <button key={b.id} type="button" onClick={() => pickBooking(b)} style={pickRow}>
                    <span style={{ fontWeight: 700, color: NAVY }}>{b.customerName || 'No name'}</span>
                    <span style={{ fontSize: '12px', color: MUTED }}>
                      {b.reference} · {b.status}
                      {b.unpaidBalanceCents != null ? ` · ${money(b.unpaidBalanceCents)} unpaid` : ' · no quote stored'}
                    </span>
                  </button>
                ))}
                {targets.leads.map((l) => (
                  <button key={l.id} type="button" onClick={() => pickLead(l)} style={pickRow}>
                    <span style={{ fontWeight: 700, color: NAVY }}>{l.customerName || 'No name'}</span>
                    <span style={{ fontSize: '12px', color: MUTED }}>Lead{l.jobType ? ` · ${l.jobType}` : ''}</span>
                  </button>
                ))}
                {search && targets.bookings.length === 0 && targets.leads.length === 0 && (
                  <p style={{ fontSize: '13px', color: MUTED, fontStyle: 'italic', padding: '8px 0' }}>
                    No match. Use <strong>Standalone</strong> for a quote that is not in the system yet.
                  </p>
                )}
              </div>
            </>
          )}

          {(booking || lead) && (
            <div style={selected}>
              <div style={{ minWidth: 0 }}>
                <p style={{ margin: 0, fontWeight: 700, color: NAVY }}>{booking?.customerName ?? lead?.customerName}</p>
                <p style={{ margin: '2px 0 0', fontSize: '12px', color: MUTED }}>
                  {booking ? `${booking.reference} · ${booking.status}` : 'Lead'}
                </p>
                {booking && (
                  <p style={{ margin: '6px 0 0', fontSize: '13px', color: NAVY }}>
                    {booking.unpaidBalanceCents != null
                      ? `Unpaid balance ${money(booking.unpaidBalanceCents)}`
                      : 'No accepted quote stored — balance unknown'}
                  </p>
                )}
                {booking && booking.authorizedNotCapturedCents > 0 && (
                  <p style={{ margin: '6px 0 0', fontSize: '12px', color: '#92400E' }}>
                    ⚠ {money(booking.authorizedNotCapturedCents)} already authorized (held, not captured) on this booking.
                  </p>
                )}
              </div>
              <button type="button" onClick={clearTarget} style={{ ...linkButton, color: MUTED }}>Change</button>
            </div>
          )}

          <Field
            label="Customer name"
            required
            audience="customer"
            hint="Only the first name is shown to the customer, but the full name is kept on the record."
          >
            <input value={customerName} onChange={(e) => setCustomerName(e.target.value)} style={input} autoComplete="off" />
          </Field>

          <div style={two}>
            <Field label="Email (optional)">
              <input type="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} style={input} autoComplete="off" />
            </Field>
            <Field label="Phone (optional)">
              <input type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} style={input} autoComplete="off" />
            </Field>
          </div>

          <Field label="Quote total (optional)">
            <input
              inputMode="decimal"
              value={quoteTotal}
              onChange={(e) => setQuoteTotal(e.target.value)}
              placeholder="495.00"
              style={input}
              // Read-only when the booking knows its own total: a hand-typed
              // number that disagrees with the accepted quote is exactly how a
              // customer gets shown a figure nobody owes.
              readOnly={!!booking && !booking.quoteMissing}
            />
          </Field>

          <Field label="Deposit amount" required>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                // inputMode="decimal" gives the phone numeric keypad; type=text
                // keeps "49.50" intact instead of a browser-localised number.
                inputMode="decimal"
                required
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                // NO NUMERIC PLACEHOLDER. At 22px bold, a grey "49.00" sitting
                // in an empty field is indistinguishable at a glance from an
                // entered amount — on the one field where being wrong charges
                // a real card. The $49 preset button beside it is the shortcut.
                placeholder="Enter amount"
                style={{
                  ...input, fontSize: '22px', fontWeight: 700, flex: 1,
                  // An empty required money field should look unfinished.
                  borderColor: amount ? '#D1D5DB' : ORANGE,
                }}
              />
              <button type="button" onClick={() => setAmount((presetCents / 100).toFixed(2))} style={presetButton}>
                ${(presetCents / 100).toFixed(0)}
              </button>
            </div>
            {previewRemaining != null && amount && (
              <p style={{ fontSize: '12px', color: MUTED, margin: '6px 0 0' }}>
                Remaining after payment: <strong style={{ color: NAVY }}>{money(previewRemaining)}</strong>
              </p>
            )}
          </Field>

          {/* ── THE MOVE ──────────────────────────────────────────────────
              The move date and the link expiry used to sit side by side in one
              unlabelled two-column row, one called "Move date" and the other
              just "Expires". They are unrelated facts, and putting them in
              separate titled groups is the fix — the customer's appointment
              can never expire, and the form should not imply that it can. */}
          <Group title="The move" note="Shown to the customer on the payment page.">
            <div style={two}>
              <Field label="Move date" optional audience="customer">
                <input
                  type="date"
                  value={moveDate}
                  onChange={(e) => setMoveDate(e.target.value)}
                  style={input}
                  aria-describedby="dl-movedate-help"
                />
              </Field>
              <Field label="Move time" optional audience="customer">
                <input
                  type="time"
                  value={moveTime}
                  onChange={(e) => setMoveTime(e.target.value)}
                  style={input}
                  disabled={!moveDate}
                  step={300}
                />
              </Field>
            </div>
            <p id="dl-movedate-help" style={helpText}>
              The day of the job — <strong>not</strong> when the payment link stops working.
              {moveDate ? ` Customer sees: ${previewWhen}` : ' Add a date to enable the time.'}
            </p>

            <Field
              label="Service"
              optional
              audience="customer"
              hint="One short line — the headline for the job. e.g. Labor-Only Move · 2 Movers"
            >
              <input
                value={service}
                onChange={(e) => setService(e.target.value)}
                placeholder="e.g. Labor-Only Move · 2 Movers"
                style={input}
                maxLength={SERVICE_MAX}
              />
              <Counter value={service} max={SERVICE_MAX} />
            </Field>

            <Field
              label="Move details"
              optional
              audience="customer"
              hint={`One per line, up to ${DETAIL_MAX_LINES}. Short facts the customer should see.`}
            >
              <textarea
                value={details}
                onChange={(e) => setDetails(e.target.value)}
                placeholder={'Apartment next door\nOld wooden bed frame removal\n15 stairs at pickup · 7 stairs at drop-off'}
                style={{ ...input, minHeight: '92px', resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.45 }}
                rows={4}
              />
              <LineCounter value={details} max={DETAIL_MAX_LINES} />
            </Field>

            <Field
              label="What we need from you"
              optional
              audience="customer"
              hint="One line the customer must act on. e.g. Customer to provide all necessary hardware/screws."
            >
              <input
                value={customerNote}
                onChange={(e) => setCustomerNote(e.target.value)}
                placeholder="e.g. Customer to provide all necessary hardware/screws."
                style={input}
                maxLength={CUSTOMER_NOTE_MAX}
              />
              <Counter value={customerNote} max={CUSTOMER_NOTE_MAX} />
            </Field>
          </Group>

          {/* ── INTERNAL ─────────────────────────────────────────────────── */}
          <Group
            title="Internal"
            note="Never shown to the customer, never sent to Stripe, never on the receipt."
          >
            <Field label="Internal job note" optional audience="internal">
              <textarea
                value={internalNote}
                onChange={(e) => setInternalNote(e.target.value)}
                placeholder={'Crew instructions, access notes, anything the customer should not read.'}
                style={{ ...input, minHeight: '80px', resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.45, background: '#F8FAFC' }}
                rows={3}
                maxLength={2000}
              />
            </Field>
          </Group>

          {/* ── THE LINK ─────────────────────────────────────────────────── */}
          <Group
            title="The payment link"
            note="About the link itself — nothing here changes the customer's appointment."
          >
            <Field
              label="Deposit link expires"
              optional
              hint="After this, the link stops taking payment and asks the customer to contact you. The move is unaffected. Leave blank for no expiry. Times are New Jersey (Eastern)."
            >
              <input type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} style={input} />
            </Field>
          </Group>

          {/* WHAT THE CUSTOMER WILL ACTUALLY SEE.
              The reported defect was an internal note printed on a customer's
              payment page. No amount of labelling proves as much as showing the
              owner the result before he sends it. */}
          <CustomerPreview
            name={customerName}
            when={previewWhen}
            service={service}
            details={detailLines(details)}
            note={customerNote}
          />

          {error && <p role="alert" style={{ ...banner, background: '#FEF2F2', borderColor: '#FECACA', color: '#B91C1C' }}>{error}</p>}

          <button type="submit" disabled={busy || !canCreate} style={{ ...primaryButton, opacity: busy || !canCreate ? 0.6 : 1 }}>
            {busy ? 'Creating…' : 'Create & Copy Link'}
          </button>
          {!canCreate && (
            <p style={{ fontSize: '12px', color: MUTED, margin: '8px 0 0' }}>
              Your role can view deposit links but not create them.
            </p>
          )}
        </form>
      )}

      {/* ── History ── */}
      <section style={{ ...card, marginTop: '14px' }}>
        <p style={cardTitle}>History</p>
        <input
          value={historyQuery}
          onChange={(e) => { setHistoryQuery(e.target.value); void loadHistory(e.target.value) }}
          placeholder="Search name, phone, token or booking"
          style={{ ...input, marginBottom: '12px' }}
          autoComplete="off"
        />
        {loadingHistory && <p style={{ fontSize: '13px', color: MUTED }}>Loading…</p>}
        {historyError && (
          <p role="alert" style={{ ...banner, background: '#FEF2F2', borderColor: '#FECACA', color: '#B91C1C' }}>{historyError}</p>
        )}
        {!loadingHistory && !historyError && history.length === 0 && (
          <p style={{ fontSize: '13px', color: MUTED, fontStyle: 'italic' }}>No deposit links yet.</p>
        )}

        {history.map((row) => (
          <article key={row.id} style={historyRow}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'flex-start' }}>
              <div style={{ minWidth: 0 }}>
                <p style={{ margin: 0, fontWeight: 700, color: NAVY, fontSize: '15px' }}>
                  {money(row.amountPaidCents ?? row.amountCents)}
                  {row.customerName ? ` · ${row.customerName}` : ''}
                </p>
                <p style={{ margin: '3px 0 0', fontSize: '12px', color: MUTED }}>
                  {row.bookingReference ? `${row.bookingReference} · ` : ''}
                  {/* LABELLED. An unlabelled date on a PAID row read as the
                      payment date; it is the date the link was created. */}
                  Created {shortDate(row.createdAt)}
                  {row.createdByName ? ` · ${row.createdByName}` : ''}
                </p>
              </div>
              <StatusChip status={row.status} />
            </div>

            <p style={{ ...urlText, fontSize: '12px', margin: '8px 0 0' }}>{row.url}</p>

            {/* THE MOVE, and the LINK, named as two different things. The list
                showed neither, so an owner could not see that a stored move
                date was wrong without opening the customer's own page. */}
            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', margin: '8px 0 0', fontSize: '12px', color: '#1B2430' }}>
              {row.moveWhenLabel && <span><strong>Move:</strong> {row.moveWhenLabel}</span>}
              {row.serviceSummary && <span>· {row.serviceSummary}</span>}
            </div>

            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', margin: '6px 0 0', fontSize: '12px', color: MUTED }}>
              {row.quoteTotalCents != null && <span>Quote {money(row.quoteTotalCents)}</span>}
              {row.remainingCents != null && <span>Remaining {money(row.remainingCents)}</span>}
              {row.paidAt && <span>Paid {shortDate(row.paidAt)}</span>}
              {row.expiresAt && row.status !== 'PAID' && (
                <span>{row.status === 'EXPIRED' ? 'Link expired' : 'Link expires'} {expiryLabel(row.expiresAt)}</span>
              )}
              <span>
                Discord: <DiscordChip status={row.discordStatus} />
                {row.discordRetryCount > 0 ? ` (${row.discordRetryCount} ${row.discordRetryCount === 1 ? 'retry' : 'retries'})` : ''}
              </span>
            </div>
            {row.discordError && <p style={{ fontSize: '11px', color: RED, margin: '4px 0 0' }}>{row.discordError}</p>}

            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '10px' }}>
              <button type="button" onClick={() => copy(row.url, 'Link copied')} style={chipButton}>Copy link</button>
              <button type="button" onClick={() => share(row)} style={chipButton}>Share</button>
              <button type="button" onClick={() => copy(customerMessage(row), 'Message copied')} style={chipButton}>Copy message</button>
              {row.status === 'PAID' && row.discordStatus !== 'SENT' && (
                <button type="button" onClick={() => retryNotify(row.id)} style={{ ...chipButton, borderColor: AMBER, color: '#92400E' }}>
                  Retry Discord
                </button>
              )}
              {canCancel && (row.status === 'ACTIVE' || row.status === 'EXPIRED') && (
                <button type="button" onClick={() => cancelLink(row.id)} style={{ ...chipButton, borderColor: RED, color: RED }}>
                  Cancel
                </button>
              )}
            </div>
          </article>
        ))}
      </section>
    </>
  )
}

// ── Small presentational pieces ─────────────────────────────────────────────

/**
 * One labelled field.
 *
 * `audience` is the point of this component now. The whole reported defect —
 * an internal job note printed on a customer's payment page — happened because
 * the form gave no signal about who reads what. Every text field now says so,
 * in colour and in words, next to the label.
 *
 * `optional` is shown explicitly rather than left blank: an empty optional field
 * and a required field the owner has not filled in yet looked identical.
 */
function Field({
  label, required, optional, hint, audience, children,
}: {
  label: string
  required?: boolean
  optional?: boolean
  hint?: string
  audience?: 'customer' | 'internal'
  children: React.ReactNode
}) {
  return (
    <label style={{ display: 'block', marginBottom: '12px' }}>
      <span style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '6px', marginBottom: '5px' }}>
        <span style={{ fontSize: '12px', fontWeight: 700, color: NAVY }}>
          {label}
          {required && <span style={{ color: ORANGE }}> *</span>}
        </span>
        {optional && <span style={{ fontSize: '11px', color: MUTED, fontWeight: 500 }}>optional</span>}
        {audience && <AudienceTag audience={audience} />}
      </span>
      {hint && <span style={{ display: 'block', fontSize: '11px', color: MUTED, margin: '0 0 5px', lineHeight: 1.4 }}>{hint}</span>}
      {children}
    </label>
  )
}

/** Who reads this field. The single most important thing this form can say. */
function AudienceTag({ audience }: { audience: 'customer' | 'internal' }) {
  const customer = audience === 'customer'
  return (
    <span
      style={{
        fontSize: '10px', fontWeight: 800, letterSpacing: '0.04em', textTransform: 'uppercase',
        padding: '2px 7px', borderRadius: '999px', whiteSpace: 'nowrap',
        background: customer ? '#FFF3EE' : '#EEF2F7',
        color: customer ? ORANGE_CTA : '#475569',
        border: `1px solid ${customer ? 'rgba(210,69,15,0.28)' : '#CBD5E1'}`,
      }}
    >
      {customer ? 'Customer sees this' : 'Private — staff only'}
    </span>
  )
}

/**
 * Dollars as typed → cents, or null.
 *
 * Mirrors the tolerance of the SERVER's `parseAmountToCents` (which is the only
 * thing that actually decides an amount). `Number("1,495.00")` is NaN, so the
 * previous `Math.round(Number(x) * 100)` rendered "$NaN" on the success card for
 * a comma-grouped total the server had accepted perfectly well.
 */
function parseDollarsToCents(input: string): number | null {
  const raw = input.trim().replace(/^\$/, '')
  if (!raw) return null
  const flat = /^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(raw) ? raw.replace(/,/g, '') : raw
  if (!/^\d+(\.\d{1,2})?$/.test(flat)) return null
  const n = Number(flat)
  return Number.isFinite(n) ? Math.round(n * 100) : null
}

/**
 * A miniature of the customer's card, live as the owner types.
 *
 * Deliberately renders ONLY the customer-facing fields. If a value is not in
 * here, a customer cannot see it — which is the whole point: the internal note
 * is absent from this component, so its absence from the payment page is
 * visible rather than promised.
 */
function CustomerPreview({
  name, when, service, details, note,
}: {
  name: string
  when: string
  service: string
  details: string[]
  note: string
}) {
  const first = name.trim().split(/\s+/)[0]
  const empty = !when && !service && details.length === 0 && !note
  return (
    <section style={previewCard} aria-label="Preview of the customer's page">
      <p style={{ ...cardTitle, margin: '0 0 8px' }}>What the customer sees</p>
      {empty ? (
        <p style={{ fontSize: '13px', color: MUTED, fontStyle: 'italic', margin: 0 }}>
          Fill in the move details above and they will appear here.
        </p>
      ) : (
        <div style={{ background: '#FFFFFF', border: '1px solid #EFEAE1', borderRadius: '10px', padding: '12px' }}>
          <p style={{ margin: 0, fontSize: '14px', fontWeight: 700, color: NAVY }}>
            {first ? `Hi ${first} — here are your move details.` : 'Here are your move details.'}
          </p>
          {when && <p style={{ margin: '7px 0 0', fontSize: '16px', fontWeight: 700, color: NAVY }}>{when}</p>}
          {service && <p style={{ margin: '2px 0 0', fontSize: '14px', fontWeight: 600, color: '#1B2430' }}>{service}</p>}
          {details.length > 0 && (
            <>
              <p style={{ margin: '10px 0 4px', fontSize: '10px', fontWeight: 800, letterSpacing: '0.05em', textTransform: 'uppercase', color: NAVY }}>
                Move details
              </p>
              <ul style={{ margin: 0, paddingLeft: '16px', color: '#3F4854', fontSize: '13px', lineHeight: 1.5 }}>
                {details.map((d, i) => <li key={i}>{d}</li>)}
              </ul>
            </>
          )}
          {note && (
            <>
              <p style={{ margin: '10px 0 3px', fontSize: '10px', fontWeight: 800, letterSpacing: '0.05em', textTransform: 'uppercase', color: NAVY }}>
                What we need from you
              </p>
              <p style={{ margin: 0, color: '#3F4854', fontSize: '13px', lineHeight: 1.5 }}>{note}</p>
            </>
          )}
        </div>
      )}
    </section>
  )
}

/** The textarea's lines as the server will store them: trimmed, empty dropped, capped. */
function detailLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*[-*\u2022\u00b7]\s*/, '').trim())
    .filter(Boolean)
    .slice(0, DETAIL_MAX_LINES)
}

/** Character budget, so a silent truncation is never the first sign of a limit. */
function Counter({ value, max }: { value: string; max: number }) {
  const left = max - value.length
  const tight = left <= 15
  if (!value) return null
  return (
    <span style={{ display: 'block', fontSize: '11px', color: tight ? ORANGE_CTA : MUTED, marginTop: '4px' }}>
      {left} character{left === 1 ? '' : 's'} left
    </span>
  )
}

/** Line budget for the bullet list — the same idea, counted in bullets. */
function LineCounter({ value, max }: { value: string; max: number }) {
  const lines = value.split(/\r?\n/).filter((l) => l.trim()).length
  if (!lines) return null
  const over = lines > max
  return (
    <span style={{ display: 'block', fontSize: '11px', color: over ? ORANGE_CTA : MUTED, marginTop: '4px' }}>
      {lines} of {max} {over ? '— extra lines will not be shown' : 'lines'}
    </span>
  )
}

/** A titled group, so two unrelated dates can never sit side by side again. */
function Group({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <fieldset style={groupStyle}>
      <legend style={legendStyle}>{title}</legend>
      {note && <p style={{ fontSize: '11px', color: MUTED, margin: '0 0 10px', lineHeight: 1.45 }}>{note}</p>}
      {children}
    </fieldset>
  )
}

function Fig({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p style={{ margin: 0, fontSize: '11px', color: MUTED, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</p>
      <p style={{ margin: '2px 0 0', fontSize: '14px', fontWeight: 700, color: NAVY }}>{value}</p>
    </div>
  )
}

function Toggle({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        flex: 1, padding: '11px 8px', borderRadius: '10px', fontSize: '13px', fontWeight: 700, cursor: 'pointer',
        border: `1px solid ${active ? ORANGE : '#E5E7EB'}`,
        background: active ? '#FFF3EE' : '#FFFFFF',
        color: active ? ORANGE_CTA : MUTED,
      }}
    >
      {label}
    </button>
  )
}

function StatusChip({ status }: { status: LinkRow['status'] }) {
  const map: Record<LinkRow['status'], { bg: string; fg: string }> = {
    ACTIVE: { bg: '#EFF6FF', fg: '#1D4ED8' },
    PAID: { bg: '#ECFDF5', fg: '#047857' },
    EXPIRED: { bg: '#F3F4F6', fg: '#6B7280' },
    CANCELED: { bg: '#FEF2F2', fg: '#B91C1C' },
  }
  const c = map[status]
  const label = status.charAt(0) + status.slice(1).toLowerCase()
  return (
    <span style={{ background: c.bg, color: c.fg, borderRadius: '999px', padding: '3px 10px', fontSize: '11px', fontWeight: 700, whiteSpace: 'nowrap' }}>
      {label}
    </span>
  )
}

function DiscordChip({ status }: { status: LinkRow['discordStatus'] }) {
  const label: Record<LinkRow['discordStatus'], string> = {
    NOT_APPLICABLE: 'Not applicable',
    PENDING: 'Pending',
    SENDING: 'Pending',
    SENT: 'Sent',
    FAILED: 'Failed',
  }
  const color: Record<LinkRow['discordStatus'], string> = {
    NOT_APPLICABLE: MUTED, PENDING: AMBER, SENDING: AMBER, SENT: GREEN, FAILED: RED,
  }
  return <strong style={{ color: color[status] }}>{label[status]}</strong>
}

// ── Styles (mobile-first; every tap target ≥ 44px) ──────────────────────────
const card: React.CSSProperties = {
  background: '#FFFFFF', border: '1px solid #EFEAE1', borderRadius: '14px', padding: '16px', marginBottom: '14px',
}
const cardTitle: React.CSSProperties = {
  fontSize: '12px', fontWeight: 700, color: MUTED, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 12px',
}
const input: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '13px 12px', borderRadius: '10px', border: '1px solid #D1D5DB',
  // 16px minimum: anything smaller makes iOS Safari zoom the whole page on focus.
  fontSize: '16px', color: NAVY, background: '#FFFFFF', WebkitAppearance: 'none',
}
// A native date or time picker needs more room than half a phone. `auto-fit` +
// a 150px floor puts them side by side only when they genuinely fit, and stacks
// them otherwise — the rigid 1fr 1fr grid squeezed both.
const two: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '10px',
}
// A titled group. Two unrelated dates sitting in one unlabelled row is what made
// "Move date" and "Expires" look like the same idea.
const groupStyle: React.CSSProperties = {
  border: '1px solid #E8E3D9', borderRadius: '12px', padding: '12px 12px 4px',
  margin: '0 0 14px', minWidth: 0,
}
const legendStyle: React.CSSProperties = {
  fontSize: '11px', fontWeight: 800, color: NAVY, textTransform: 'uppercase',
  letterSpacing: '0.07em', padding: '0 6px',
}
const primaryButton: React.CSSProperties = {
  width: '100%', border: 'none', borderRadius: '12px', background: ORANGE_CTA, color: '#FFFFFF',
  fontSize: '17px', fontWeight: 700, padding: '16px', cursor: 'pointer', WebkitAppearance: 'none',
}
const secondaryButton: React.CSSProperties = {
  width: '100%', borderRadius: '12px', border: `1px solid ${ORANGE_CTA}`, background: '#FFFFFF', color: ORANGE_CTA,
  fontSize: '16px', fontWeight: 700, padding: '15px', cursor: 'pointer',
}
const ghostButton: React.CSSProperties = {
  width: '100%', borderRadius: '12px', border: '1px solid #E5E7EB', background: '#FFFFFF', color: MUTED,
  fontSize: '15px', fontWeight: 600, padding: '13px', cursor: 'pointer',
}
const presetButton: React.CSSProperties = {
  borderRadius: '10px', border: `1px solid ${ORANGE}`, background: '#FFF3EE', color: ORANGE_CTA,
  fontSize: '17px', fontWeight: 800, padding: '0 18px', cursor: 'pointer', minWidth: '72px',
}
const chipButton: React.CSSProperties = {
  borderRadius: '8px', border: '1px solid #D1D5DB', background: '#FFFFFF', color: NAVY,
  fontSize: '13px', fontWeight: 600, padding: '9px 12px', cursor: 'pointer',
}
const linkButton: React.CSSProperties = {
  background: 'none', border: 'none', textDecoration: 'underline', fontSize: '13px', fontWeight: 600,
  cursor: 'pointer', padding: '6px 4px', marginLeft: '6px',
}
const pickRow: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: '2px', alignItems: 'flex-start', width: '100%',
  textAlign: 'left', background: '#FFFFFF', border: '1px solid #EFEAE1', borderRadius: '10px',
  padding: '11px 12px', marginBottom: '6px', cursor: 'pointer',
}
const selected: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'flex-start',
  background: BONE, borderRadius: '10px', padding: '12px', marginBottom: '14px',
}
const banner: React.CSSProperties = {
  border: '1px solid', borderRadius: '10px', padding: '11px 12px', fontSize: '13px',
  lineHeight: 1.5, margin: '0 0 12px',
}
const previewCard: React.CSSProperties = {
  background: BONE, border: '1px solid #E8E3D9', borderRadius: '12px',
  padding: '12px', margin: '0 0 14px',
}
const helpText: React.CSSProperties = {
  fontSize: '11px', color: MUTED, lineHeight: 1.45, margin: '-4px 0 12px',
}
const historyRow: React.CSSProperties = { borderTop: '1px solid #F1F1F1', padding: '13px 0' }
const rowGrid: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '10px', marginTop: '10px',
}
const urlText: React.CSSProperties = {
  fontSize: '13px', color: MUTED, wordBreak: 'break-all', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', margin: '0 0 12px',
}
const toastStyle: React.CSSProperties = {
  position: 'fixed', left: '50%', transform: 'translateX(-50%)', bottom: '22px', zIndex: 50,
  background: NAVY, color: '#FFFFFF', padding: '11px 18px', borderRadius: '999px', fontSize: '14px', fontWeight: 600,
  boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
}
