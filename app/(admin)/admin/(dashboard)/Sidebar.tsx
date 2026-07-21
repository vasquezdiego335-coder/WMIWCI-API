'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'

// ── Grouped, collapsible navigation (admin operating system, owner spec
//    2026-07-13). Overview / Operations / Money / Growth / System — not one flat
//    list of 20 buttons. Items that aren't built yet render as muted "soon" rows
//    so the owner sees the full map without hitting 404s. Collapsed groups
//    persist in localStorage. ──

type Item = { href?: string; label: string; icon: string; soon?: boolean }
type Group = { title: string; items: Item[] }

const GROUPS: Group[] = [
  {
    title: 'Overview',
    items: [
      { href: '/admin', label: 'Dashboard', icon: '🏠' },
      { href: '/admin/action-center', label: 'Action Center', icon: '🔔' },
      { href: '/admin/schedule', label: 'Calendar', icon: '📅' },
    ],
  },
  {
    title: 'Operations',
    items: [
      { href: '/admin/jobs', label: 'Jobs', icon: '🚚' },
      { href: '/admin/bookings', label: 'Bookings', icon: '📋' },
      { href: '/admin/customers', label: 'Customers', icon: '👤' },
      { label: 'Leads', icon: '📈', soon: true },
      { href: '/admin/staff', label: 'Crew', icon: '👥' },
    ],
  },
  {
    title: 'Money',
    items: [
      { label: 'Financial Overview', icon: '📊', soon: true },
      { href: '/admin/payments', label: 'Revenue', icon: '💳' },
      { href: '/admin/expenses', label: 'Expenses', icon: '🧾' },
      { href: '/admin/owner-money', label: 'Owner Money', icon: '🏦' },
      { label: 'Payroll', icon: '💵', soon: true },
      { href: '/admin/reports', label: 'Reports', icon: '📑' },
    ],
  },
  {
    title: 'Growth',
    items: [
      { href: '/admin/email-marketing', label: 'Email Marketing', icon: '✉️' },
      { href: '/admin/discounts', label: 'Discounts', icon: '🏷' },
      { label: 'Referrals', icon: '🤝', soon: true },
      { label: 'Marketing Sources', icon: '🧭', soon: true },
    ],
  },
  {
    title: 'System',
    items: [
      { href: '/admin/roadmap', label: 'Ideas & Roadmap', icon: '🗺️' },
      { href: '/admin/logs', label: 'Activity Log', icon: '📜' },
      { label: 'Documents', icon: '📁', soon: true },
      { href: '/admin/queues', label: 'Queues', icon: '⚙️' },
      { label: 'Settings', icon: '🔧', soon: true },
    ],
  },
]

const isActive = (pathname: string, href?: string) => {
  if (!href) return false
  if (href === '/admin') return pathname === '/admin'
  return pathname === href || pathname.startsWith(href + '/')
}

export default function Sidebar({ name, role }: { name: string; role: string }) {
  const pathname = usePathname()
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  // Restore collapsed groups on mount (client-only, avoids hydration mismatch).
  useEffect(() => {
    try {
      const raw = localStorage.getItem('wmiwci_nav_collapsed')
      if (raw) setCollapsed(JSON.parse(raw))
    } catch {
      /* ignore */
    }
  }, [])

  function toggle(title: string) {
    setCollapsed((prev) => {
      const next = { ...prev, [title]: !prev[title] }
      try {
        localStorage.setItem('wmiwci_nav_collapsed', JSON.stringify(next))
      } catch {
        /* ignore */
      }
      return next
    })
  }

  return (
    <aside style={aside}>
      <div style={brandBox}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
          <span style={logoChip}>
            <img src="/icon.svg" alt="" width={28} height={28} style={{ display: 'block' }} />
          </span>
          <div>
            {/* Brand name only — the old "We Move It. We Clear It." slogan was
                retired by the owner on 2026-07-17. */}
            <p style={brandLine}>MOVE IT</p>
            <p style={brandLine}>CLEAR IT</p>
          </div>
        </div>
        <p style={{ color: '#8B9BC1', fontSize: '11px', margin: 0 }}>
          {name} · {role}
        </p>
      </div>

      <nav style={{ padding: '10px 0 90px', overflowY: 'auto', flex: 1 }}>
        {GROUPS.map((group) => {
          const isCollapsed = collapsed[group.title]
          return (
            <div key={group.title} style={{ marginBottom: '6px' }}>
              <button onClick={() => toggle(group.title)} style={groupHeader} aria-expanded={!isCollapsed}>
                <span>{group.title}</span>
                <span style={{ fontSize: '9px', opacity: 0.7, transform: isCollapsed ? 'rotate(-90deg)' : 'none', transition: 'transform .15s' }}>▼</span>
              </button>
              {!isCollapsed &&
                group.items.map((item) => {
                  const active = isActive(pathname, item.href)
                  if (item.soon || !item.href) {
                    return (
                      <div key={item.label} style={{ ...navItem, color: '#5A6B8C', cursor: 'default' }} title="Coming soon">
                        <span style={navIcon}>{item.icon}</span>
                        <span style={{ flex: 1 }}>{item.label}</span>
                        <span style={soonTag}>soon</span>
                      </div>
                    )
                  }
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      style={{
                        ...navItem,
                        color: active ? '#FFFFFF' : '#CBD5E1',
                        backgroundColor: active ? 'rgba(255,90,31,0.16)' : 'transparent',
                        borderLeft: active ? '3px solid #FF5A1F' : '3px solid transparent',
                        fontWeight: active ? 700 : 500,
                      }}
                    >
                      <span style={navIcon}>{item.icon}</span>
                      <span style={{ flex: 1 }}>{item.label}</span>
                    </Link>
                  )
                })}
            </div>
          )
        })}
      </nav>

      <div style={signOutBox}>
        <form action="/api/auth/logout" method="POST">
          <button type="submit" style={signOutBtn}>Sign out</button>
        </form>
      </div>
    </aside>
  )
}

const aside: React.CSSProperties = { width: '230px', backgroundColor: '#0A1628', flexShrink: 0, position: 'fixed', height: '100vh', display: 'flex', flexDirection: 'column' }
const brandBox: React.CSSProperties = { padding: '22px 20px 16px', borderBottom: '1px solid rgba(255,90,31,0.2)' }
const logoChip: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '36px', height: '36px', background: '#F5F1EA', borderRadius: '8px', padding: '4px', flexShrink: 0, boxShadow: '0 2px 6px rgba(0,0,0,0.18)' }
const brandLine: React.CSSProperties = { color: '#FF5A1F', fontWeight: 700, fontSize: '12px', margin: 0, letterSpacing: '0.04em', lineHeight: 1.2 }
const groupHeader: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', padding: '10px 20px 6px', background: 'none', border: 'none', color: '#8B9BC1', fontSize: '10px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', cursor: 'pointer' }
const navItem: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 20px', fontSize: '13px', textDecoration: 'none', lineHeight: 1.2 }
const navIcon: React.CSSProperties = { fontSize: '14px', width: '18px', textAlign: 'center', flexShrink: 0 }
const soonTag: React.CSSProperties = { fontSize: '8px', fontWeight: 700, letterSpacing: '0.05em', color: '#5A6B8C', border: '1px solid #33415A', borderRadius: '4px', padding: '1px 4px', textTransform: 'uppercase' }
const signOutBox: React.CSSProperties = { padding: '14px 20px', borderTop: '1px solid rgba(255,255,255,0.08)', backgroundColor: '#0A1628' }
const signOutBtn: React.CSSProperties = { background: 'none', border: '1px solid rgba(255,255,255,0.2)', color: '#CBD5E1', fontSize: '12px', padding: '8px 12px', borderRadius: '6px', cursor: 'pointer', width: '100%' }
