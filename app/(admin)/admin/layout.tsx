import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth'
import Link from 'next/link'

// Auth-gated + session/DB-backed — render per request, never statically
// prerender. Also keeps this segment out of the build-time prerender pass
// (defense-in-depth; the root cause of prerender crashes is a non-standard
// NODE_ENV on the host, fixed separately). Cascades to all /admin/* routes.
export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Admin — We Move It. We Clear It.',
  robots: 'noindex, nofollow',
}

const NAV = [
  { href: '/admin', label: '🏠 Dashboard' },
  { href: '/admin/bookings', label: '📋 Bookings' },
  { href: '/admin/schedule', label: '📅 Schedule' },
  { href: '/admin/payments', label: '💳 Payments' },
  { href: '/admin/discounts', label: '🏷 Discounts' },
  { href: '/admin/customers', label: '👤 Customers' },
  { href: '/admin/staff', label: '👥 Staff' },
  { href: '/admin/logs', label: '📜 Logs' },
  { href: '/admin/queues', label: '⚙️ Queues' },
]

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession()
  if (!session || !['OWNER', 'MANAGER'].includes(session.role)) {
    redirect('/admin/login')
  }

  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: 'Inter, -apple-system, sans-serif', backgroundColor: '#F5F1EA' }}>
        <div style={{ display: 'flex', minHeight: '100vh' }}>
          {/* Sidebar */}
          <aside style={{ width: '220px', backgroundColor: '#0A1628', padding: '24px 0', flexShrink: 0, position: 'fixed', height: '100vh', overflowY: 'auto' }}>
            <div style={{ padding: '0 20px 24px', borderBottom: '1px solid rgba(255,90,31,0.2)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '36px', height: '36px', background: '#F5F1EA', borderRadius: '8px', padding: '4px', flexShrink: 0, boxShadow: '0 2px 6px rgba(0,0,0,0.18)' }}>
                  <img src="/icon.svg" alt="" width={28} height={28} style={{ display: 'block' }} />
                </span>
                <div>
                  <p style={{ color: '#FF5A1F', fontWeight: '700', fontSize: '12px', margin: '0', letterSpacing: '0.04em', lineHeight: '1.2' }}>WE MOVE IT.</p>
                  <p style={{ color: '#FF5A1F', fontWeight: '700', fontSize: '12px', margin: '0', letterSpacing: '0.04em', lineHeight: '1.2' }}>WE CLEAR IT.</p>
                </div>
              </div>
              <p style={{ color: '#8B9BC1', fontSize: '11px', margin: '0' }}>{session.name} · {session.role}</p>
            </div>
            <nav style={{ padding: '16px 0' }}>
              {NAV.map((item) => (
                <Link key={item.href} href={item.href} style={{ display: 'block', padding: '10px 20px', color: '#CBD5E1', fontSize: '13px', fontWeight: '500', textDecoration: 'none' }}>
                  {item.label}
                </Link>
              ))}
            </nav>
            <div style={{ padding: '16px 20px', borderTop: '1px solid rgba(255,255,255,0.08)', position: 'absolute', bottom: 0, width: '180px' }}>
              <form action="/api/auth/logout" method="POST">
                <button type="submit" style={{ background: 'none', border: '1px solid rgba(255,255,255,0.2)', color: '#CBD5E1', fontSize: '12px', padding: '8px 12px', borderRadius: '6px', cursor: 'pointer', width: '100%' }}>Sign out</button>
              </form>
            </div>
          </aside>

          {/* Main content */}
          <main style={{ marginLeft: '220px', flex: 1, padding: '32px', minHeight: '100vh' }}>
            {children}
          </main>
        </div>
      </body>
    </html>
  )
}
