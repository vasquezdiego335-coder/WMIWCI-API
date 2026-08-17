'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { csrfHeader } from '../(dashboard)/_client'

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
  moveDate: string | null
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

const money = (cents: number | null | undefined): string =>
  cents == null ? '—' : `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

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

  const [firstName, setFirstName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [quoteTotal, setQuoteTotal] = useState('')
  const [amount, setAmount] = useState('')
  const [moveDate, setMoveDate] = useState('')
  const [service, setService] = useState('')
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

  const flash = useCallback((m: string) => {
    setToast(m)
    setTimeout(() => setToast(null), 2200)
  }, [])

  const loadHistory = useCallback(async (q = '') => {
    setLoadingHistory(true)
    try {
      const res = await fetch(`/api/admin/deposit-links?limit=50${q ? `&q=${encodeURIComponent(q)}` : ''}`, { cache: 'no-store' })
      if (res.ok) {
        const data = (await res.json()) as { links: LinkRow[] }
        setHistory(data.links ?? [])
      }
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
    setFirstName(b.customerName?.split(/\s+/)[0] ?? '')
    setEmail(b.customerEmail ?? '')
    setPhone(b.customerPhone ?? '')
    setQuoteTotal(b.quoteTotalCents != null ? (b.quoteTotalCents / 100).toFixed(2) : '')
    setMoveDate(b.moveDate ? b.moveDate.slice(0, 10) : '')
    setError(null)
  }

  const pickLead = (l: LeadTarget) => {
    setLead(l)
    setBooking(null)
    setFirstName(l.customerName?.split(/\s+/)[0] ?? '')
    setEmail(l.customerEmail ?? '')
    setPhone(l.customerPhone ?? '')
    setQuoteTotal(l.quoteTotalCents != null ? (l.quoteTotalCents / 100).toFixed(2) : '')
    setMoveDate(l.moveDate ? l.moveDate.slice(0, 10) : '')
    setError(null)
  }

  const clearTarget = () => {
    setBooking(null)
    setLead(null)
  }

  // Local preview only. The server computes the figure that is stored.
  const previewRemaining = useMemo(() => {
    const base = booking?.unpaidBalanceCents ?? (quoteTotal ? Math.round(Number(quoteTotal) * 100) : null)
    const amt = amount ? Math.round(Number(amount) * 100) : null
    if (base == null || amt == null || Number.isNaN(base) || Number.isNaN(amt)) return null
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
          customerName: firstName || null,
          customerEmail: email || null,
          customerPhone: phone || null,
          quoteTotal: quoteTotal || null,
          serviceSummary: service || null,
          moveDate: moveDate || null,
          expiresAt: expiresAt || null,
        }),
      })
      const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string; warning?: string | null; publicToken?: string; amountCents?: number }
      if (!res.ok) {
        setError(data.error ?? 'Could not create the link')
        return
      }
      const row: LinkRow = {
        id: '', publicToken: data.publicToken ?? '', url: data.url ?? '', status: 'ACTIVE',
        amountCents: data.amountCents ?? 0, quoteTotalCents: quoteTotal ? Math.round(Number(quoteTotal) * 100) : null,
        amountPaidCents: null, remainingCents: previewRemaining, customerName: firstName || null,
        serviceSummary: service || null, moveDate: moveDate || null, expiresAt: expiresAt || null,
        paidAt: null, createdAt: new Date().toISOString(), createdByName: null,
        bookingReference: booking?.reference ?? null, discordStatus: 'NOT_APPLICABLE',
        discordNotifiedAt: null, discordRetryCount: 0, discordError: null,
      }
      setCreated(row)
      setWarning(data.warning ?? null)
      await copy(data.url ?? '', 'Link copied')
      void loadHistory(historyQuery)
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
            <button type="button" onClick={() => { setCreated(null); setAmount(''); setService('') }} style={ghostButton}>
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

          <Field label="Customer first name">
            <input value={firstName} onChange={(e) => setFirstName(e.target.value)} style={input} autoComplete="off" />
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
                placeholder="49.00"
                style={{ ...input, fontSize: '22px', fontWeight: 700, flex: 1 }}
                aria-label="Deposit amount in dollars"
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

          <div style={two}>
            <Field label="Move date (optional)">
              <input type="date" value={moveDate} onChange={(e) => setMoveDate(e.target.value)} style={input} />
            </Field>
            <Field label="Expires (optional)">
              <input type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} style={input} />
            </Field>
          </div>

          <Field label="Service description (optional)">
            <input value={service} onChange={(e) => setService(e.target.value)} placeholder="2 movers + truck, 3 hours" style={input} maxLength={200} />
          </Field>

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
        {!loadingHistory && history.length === 0 && <p style={{ fontSize: '13px', color: MUTED, fontStyle: 'italic' }}>No deposit links yet.</p>}

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
                  {shortDate(row.createdAt)}
                  {row.createdByName ? ` · ${row.createdByName}` : ''}
                </p>
              </div>
              <StatusChip status={row.status} />
            </div>

            <p style={{ ...urlText, fontSize: '12px', margin: '8px 0 0' }}>{row.url}</p>

            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', margin: '8px 0 0', fontSize: '12px', color: MUTED }}>
              {row.quoteTotalCents != null && <span>Quote {money(row.quoteTotalCents)}</span>}
              {row.remainingCents != null && <span>Remaining {money(row.remainingCents)}</span>}
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

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label style={{ display: 'block', marginBottom: '12px' }}>
      <span style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: MUTED, marginBottom: '5px' }}>
        {label}
        {required && <span style={{ color: ORANGE }}> *</span>}
      </span>
      {children}
    </label>
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
const two: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }
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
