// Shared presentational building blocks for the admin operating system pages
// (owner spec 2026-07-13). Server-safe (no 'use client') so server components
// can import directly. Brand palette per wmiwci-brand-identity: Navy #0A1628,
// Orange #FF5A1F, Bone #F5F1EA, Gold #C9A961 (financial highlights), green =
// paid/complete, red = real warnings only.

import Link from 'next/link'

export const COLORS = {
  navy: '#0A1628',
  orange: '#FF5A1F',
  bone: '#F5F1EA',
  gold: '#C9A961',
  green: '#10B981',
  red: '#EF4444',
  amber: '#F59E0B',
  blue: '#3B82F6',
  ink: '#374151',
  muted: '#6B7280',
  faint: '#9CA3AF',
  line: '#F1F1F1',
  card: '#FFFFFF',
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: '16px', flexWrap: 'wrap', marginBottom: '24px' }}>
      <div>
        <h1 style={{ fontSize: '24px', fontWeight: 700, color: COLORS.navy, margin: '0 0 4px' }}>{title}</h1>
        {subtitle && <p style={{ fontSize: '14px', color: COLORS.muted, margin: 0 }}>{subtitle}</p>}
      </div>
      {actions && <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>{actions}</div>}
    </div>
  )
}

/** Big, readable KPI card. `accent` tints the number; `sub` is a small note. */
export function StatCard({ label, value, accent, sub, href }: { label: string; value: string; accent?: string; sub?: string; href?: string }) {
  const body = (
    <div style={{ backgroundColor: COLORS.card, borderRadius: '12px', padding: '18px 20px', boxShadow: '0 1px 4px rgba(0,0,0,0.06)', border: '1px solid #EFEFEF', height: '100%' }}>
      <p style={{ fontSize: '11px', color: COLORS.muted, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', margin: '0 0 8px' }}>{label}</p>
      <p style={{ fontSize: '26px', fontWeight: 800, color: accent ?? COLORS.navy, margin: 0, lineHeight: 1.1 }}>{value}</p>
      {sub && <p style={{ fontSize: '12px', color: COLORS.faint, margin: '6px 0 0' }}>{sub}</p>}
    </div>
  )
  return href ? <Link href={href} style={{ textDecoration: 'none', display: 'block' }}>{body}</Link> : body
}

export function StatGrid({ children, min = 190 }: { children: React.ReactNode; min?: number }) {
  return <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fill, minmax(${min}px, 1fr))`, gap: '14px', marginBottom: '24px' }}>{children}</div>
}

export function Card({ title, icon, children, action, wide }: { title?: string; icon?: string; children: React.ReactNode; action?: React.ReactNode; wide?: boolean }) {
  return (
    <div style={{ backgroundColor: COLORS.card, borderRadius: '14px', padding: '20px 22px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)', border: `1px solid ${COLORS.line}`, marginBottom: wide ? '20px' : 0 }}>
      {title && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '0 0 16px' }}>
          <h3 style={{ fontSize: '13px', fontWeight: 700, color: COLORS.ink, textTransform: 'uppercase', letterSpacing: '0.05em', margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
            {icon && <span style={{ fontSize: '15px' }}>{icon}</span>}
            {title}
          </h3>
          {action}
        </div>
      )}
      {children}
    </div>
  )
}

export function Badge({ color, children }: { color: string; children: React.ReactNode }) {
  return <span style={{ color: '#FFFFFF', backgroundColor: color, fontSize: '10px', fontWeight: 700, padding: '3px 9px', borderRadius: '100px', letterSpacing: '0.03em', whiteSpace: 'nowrap' }}>{children}</span>
}

export function SoftBadge({ color, children }: { color: string; children: React.ReactNode }) {
  return <span style={{ color, backgroundColor: `${color}18`, border: `1px solid ${color}33`, fontSize: '10px', fontWeight: 700, padding: '2px 8px', borderRadius: '100px', letterSpacing: '0.03em', whiteSpace: 'nowrap' }}>{children}</span>
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p style={{ fontSize: '13px', color: COLORS.faint, fontStyle: 'italic', margin: 0 }}>{children}</p>
}

/** A loud, unmissable banner. Phase 0 uses this for incomplete financial data —
 *  the owner spec is explicit that a missing-labor warning must be a clear
 *  warning state, not a subtle tooltip. */
export function Callout({
  tone = 'warning',
  title,
  children,
}: {
  tone?: 'warning' | 'danger' | 'info'
  title: string
  children?: React.ReactNode
}) {
  const palette = {
    warning: { bg: '#FFFBEB', border: '#FDE68A', text: '#B45309', icon: '⚠️' },
    danger: { bg: '#FEF2F2', border: '#FECACA', text: '#B91C1C', icon: '🛑' },
    info: { bg: '#EFF6FF', border: '#BFDBFE', text: '#1D4ED8', icon: 'ℹ️' },
  }[tone]
  return (
    <div
      role="alert"
      style={{
        backgroundColor: palette.bg,
        border: `1px solid ${palette.border}`,
        borderLeft: `4px solid ${palette.text}`,
        borderRadius: '10px',
        padding: '12px 14px',
        margin: '0 0 14px',
      }}
    >
      <div style={{ display: 'flex', gap: '9px', alignItems: 'flex-start' }}>
        <span style={{ fontSize: '15px', lineHeight: 1.3 }} aria-hidden>{palette.icon}</span>
        <div style={{ minWidth: 0 }}>
          <p style={{ fontSize: '13px', fontWeight: 700, color: palette.text, margin: 0, lineHeight: 1.4 }}>{title}</p>
          {children && <div style={{ fontSize: '12px', color: COLORS.ink, marginTop: '5px', lineHeight: 1.5 }}>{children}</div>}
        </div>
      </div>
    </div>
  )
}

/** Complete / Missing labor / … chip for a move's financial record. */
export function CompletenessBadge({ label, complete, notApplicable }: { label: string; complete: boolean; notApplicable?: boolean }) {
  const color = notApplicable ? COLORS.faint : complete ? COLORS.green : COLORS.amber
  return <SoftBadge color={color}>{complete ? '✓ ' : notApplicable ? '' : '⚠ '}{label}</SoftBadge>
}

/** A money row: label left, amount right. `negative` renders red with a minus. */
export function MoneyRow({ label, value, strong, negative, positive }: { label: string; value: string; strong?: boolean; negative?: boolean; positive?: boolean }) {
  const color = negative ? COLORS.red : positive ? COLORS.green : COLORS.ink
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '16px', padding: '6px 0' }}>
      <span style={{ fontSize: '13px', color: COLORS.muted }}>{label}</span>
      <span style={{ fontSize: strong ? '15px' : '13px', color, fontWeight: strong ? 800 : 600, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  )
}

export const tableStyles = {
  wrap: { backgroundColor: COLORS.card, borderRadius: '12px', overflow: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.06)', border: '1px solid #EFEFEF' } as React.CSSProperties,
  scroll: { overflowX: 'auto' } as React.CSSProperties,
  table: { width: '100%', borderCollapse: 'collapse' } as React.CSSProperties,
  th: { padding: '11px 14px', textAlign: 'left', fontSize: '11px', fontWeight: 600, color: COLORS.muted, letterSpacing: '0.05em', textTransform: 'uppercase', backgroundColor: '#F9FAFB', borderBottom: '1px solid #E5E7EB', whiteSpace: 'nowrap' } as React.CSSProperties,
  td: { padding: '11px 14px', fontSize: '13px', color: COLORS.ink, borderBottom: '1px solid #F3F4F6', verticalAlign: 'middle' } as React.CSSProperties,
}
