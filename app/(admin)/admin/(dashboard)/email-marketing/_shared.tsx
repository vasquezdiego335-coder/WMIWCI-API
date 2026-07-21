// Shared chrome for the Email Marketing section (owner spec 2026-07-21).
// Server-safe: no 'use client', so server components import it directly.

import Link from 'next/link'
import { COLORS, SoftBadge } from '../_ui'
import { RANGE_LABELS, type RangeKey, type Rate, formatRate } from '@/lib/email-admin'

export const EMAIL_TABS: Array<{ href: string; label: string; ownerOnly?: boolean }> = [
  { href: '/admin/email-marketing', label: 'Overview' },
  { href: '/admin/email-marketing/templates', label: 'Templates' },
  { href: '/admin/email-marketing/journeys', label: 'Journeys' },
  { href: '/admin/email-marketing/scheduled', label: 'Scheduled' },
  { href: '/admin/email-marketing/sends', label: 'Send history' },
  { href: '/admin/email-marketing/suppressions', label: 'Suppressions' },
  { href: '/admin/email-marketing/deliverability', label: 'Deliverability' },
  { href: '/admin/email-marketing/campaigns', label: 'Campaigns', ownerOnly: true },
  { href: '/admin/email-marketing/settings', label: 'Settings' },
]

export function EmailTabs({ active, isOwner }: { active: string; isOwner: boolean }) {
  return (
    <nav
      aria-label="Email marketing sections"
      style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', borderBottom: `1px solid ${COLORS.line}`, marginBottom: '20px', paddingBottom: '2px' }}
    >
      {EMAIL_TABS.filter((t) => isOwner || !t.ownerOnly).map((t) => {
        const on = t.href === active
        return (
          <Link
            key={t.href}
            href={t.href}
            style={{
              padding: '8px 13px',
              fontSize: '13px',
              fontWeight: on ? 700 : 500,
              color: on ? COLORS.navy : COLORS.muted,
              textDecoration: 'none',
              borderBottom: `2px solid ${on ? COLORS.orange : 'transparent'}`,
              whiteSpace: 'nowrap',
            }}
          >
            {t.label}
          </Link>
        )
      })}
    </nav>
  )
}

/** Range picker as plain links — works without JavaScript. */
export function RangePicker({ base, active }: { base: string; active: RangeKey }) {
  return (
    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
      {(Object.keys(RANGE_LABELS) as RangeKey[]).map((k) => (
        <Link
          key={k}
          href={`${base}?range=${k}`}
          style={{
            fontSize: '12px',
            fontWeight: k === active ? 700 : 500,
            padding: '5px 10px',
            borderRadius: '7px',
            textDecoration: 'none',
            color: k === active ? '#FFFFFF' : COLORS.muted,
            backgroundColor: k === active ? COLORS.navy : '#F3F4F6',
          }}
        >
          {RANGE_LABELS[k]}
        </Link>
      ))}
    </div>
  )
}

const TONES: Record<string, string> = {
  good: COLORS.green,
  warn: COLORS.amber,
  bad: COLORS.red,
  muted: COLORS.faint,
}

export function ToneBadge({ tone, children }: { tone: string; children: React.ReactNode }) {
  return <SoftBadge color={TONES[tone] ?? COLORS.faint}>{children}</SoftBadge>
}

/**
 * A rate with the counts it came from. "—" when there is no denominator: a
 * delivery rate over zero sends is unknown, not 0% and not 100%.
 */
export function RateCell({ rate, label }: { rate: Rate; label?: string }) {
  return (
    <span style={{ fontVariantNumeric: 'tabular-nums' }}>
      <strong>{formatRate(rate)}</strong>{' '}
      <span style={{ color: COLORS.faint, fontSize: '11px' }}>
        ({rate.numerator}/{rate.denominator}
        {label ? ` ${label}` : ''})
      </span>
    </span>
  )
}

/** Read-only chip for a class of email. */
export function ClassBadge({ emailClass }: { emailClass: string }) {
  return (
    <SoftBadge color={emailClass === 'transactional' ? COLORS.blue : COLORS.orange}>
      {emailClass === 'transactional' ? 'Transactional' : 'Promotional'}
    </SoftBadge>
  )
}

export function dt(d: Date | string | null | undefined): string {
  if (!d) return '—'
  return new Date(d).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/New_York',
  })
}

export const money = (cents: number): string =>
  `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** The section-wide "this is what you're not seeing" note. */
export function CompletenessNote({ notes, degraded }: { notes: string[]; degraded?: boolean }) {
  if (notes.length === 0 && !degraded) return null
  return (
    <div
      style={{
        backgroundColor: degraded ? '#FEF2F2' : '#F9FAFB',
        border: `1px solid ${degraded ? '#FECACA' : COLORS.line}`,
        borderRadius: '10px',
        padding: '12px 15px',
        marginBottom: '20px',
      }}
    >
      <p style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: degraded ? COLORS.red : COLORS.muted, margin: '0 0 7px' }}>
        {degraded ? 'Incomplete data' : 'Data completeness'}
      </p>
      <ul style={{ margin: 0, paddingLeft: '17px', fontSize: '12px', color: COLORS.ink, lineHeight: 1.6 }}>
        {notes.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
    </div>
  )
}
