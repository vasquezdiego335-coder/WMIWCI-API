import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { getSession } from '@/lib/auth'

// ════════════════════════════════════════════════════════════════════════════
//  Crew operational surface (Stage 5). A deliberately narrow, mobile-first shell
//  — NOT the admin. CREW reach only this; owners/managers may use it too while
//  keeping their own permissions. Middleware gates the route group; this adds
//  the shell and a second auth check (defense in depth).
// ════════════════════════════════════════════════════════════════════════════

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Crew — Move It Clear It', robots: 'noindex, nofollow' }

export default async function CrewLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession()
  if (!session) redirect('/admin/login?next=/crew')

  return (
    <div style={{ minHeight: '100vh', backgroundColor: '#F5F1EA', fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif' }}>
      <header style={{ backgroundColor: '#0A1628', color: '#fff', padding: '14px 18px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', position: 'sticky', top: 0, zIndex: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <Link href="/crew" style={{ color: '#FF5A1F', fontWeight: 800, fontSize: '16px', textDecoration: 'none' }}>Move It Clear It</Link>
          <span style={{ fontSize: '12px', color: '#8FA0BD' }}>Crew</span>
        </div>
        <span style={{ fontSize: '13px', color: '#F5F1EA' }}>{session.name}</span>
      </header>
      <main style={{ maxWidth: '560px', margin: '0 auto', padding: '16px' }}>{children}</main>
    </div>
  )
}
