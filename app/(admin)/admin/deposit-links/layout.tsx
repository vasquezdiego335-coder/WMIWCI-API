import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth'

// ════════════════════════════════════════════════════════════════════════════
//  Deposit links live OUTSIDE the (dashboard) layout, on purpose.
//  ------------------------------------------------------------------------
//  That layout pins a 230px sidebar and adds `marginLeft: 230px` with no mobile
//  breakpoint. On a 375px phone it leaves about 80px of usable width — which is
//  exactly the device this page exists for. Rather than rework the whole admin
//  chrome inside this feature, this segment gets its own thin shell: a single
//  full-width column, a back link, and nothing that assumes a mouse.
//
//  Auth is enforced three times over: the middleware matcher, this layout, and
//  the permission check inside every route handler.
// ════════════════════════════════════════════════════════════════════════════

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Deposit Links — Move It Clear It',
  robots: 'noindex, nofollow',
}

export default async function DepositLinksLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession()
  if (!session || !['OWNER', 'MANAGER'].includes(session.role)) {
    redirect('/admin/login?next=/admin/deposit-links')
  }

  return (
    <div style={{ minHeight: '100vh', background: '#F5F1EA' }}>
      <header
        style={{
          background: '#0A1628',
          padding: '12px 16px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px',
          position: 'sticky',
          top: 0,
          zIndex: 10,
        }}
      >
        <Link href="/admin" style={{ color: '#CBD5E1', fontSize: '14px', textDecoration: 'none', padding: '8px 4px' }}>
          ‹ Admin
        </Link>
        <span style={{ color: '#FF5A1F', fontWeight: 700, fontSize: '13px', letterSpacing: '0.06em' }}>DEPOSIT LINKS</span>
        <span style={{ color: '#8B9BC1', fontSize: '12px' }}>{session.name}</span>
      </header>
      <main style={{ maxWidth: '560px', margin: '0 auto', padding: '16px 14px 56px' }}>{children}</main>
    </div>
  )
}
