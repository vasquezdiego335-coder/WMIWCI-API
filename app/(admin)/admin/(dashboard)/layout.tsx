import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth'
import Sidebar from './Sidebar'

// Auth-gated + session/DB-backed — render per request, never statically
// prerender. Also keeps this segment out of the build-time prerender pass
// (defense-in-depth; the root cause of prerender crashes is a non-standard
// NODE_ENV on the host, fixed separately). Cascades to all /admin/* routes.
export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Admin — We Move It. We Clear It.',
  robots: 'noindex, nofollow',
}

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession()
  if (!session || !['OWNER', 'MANAGER'].includes(session.role)) {
    redirect('/admin/login')
  }

  return (
    <div style={{ display: 'flex', minHeight: '100vh', backgroundColor: '#F5F1EA' }}>
      <Sidebar name={session.name} role={session.role} />
      <main style={{ marginLeft: '230px', flex: 1, padding: '32px', minHeight: '100vh', minWidth: 0 }}>
        {children}
      </main>
    </div>
  )
}
