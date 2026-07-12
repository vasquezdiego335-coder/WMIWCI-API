import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import StaffActions from './StaffActions'

export const revalidate = 0

const ROLE_COLORS: Record<string, { bg: string; text: string }> = {
  OWNER: { bg: '#FEF3C7', text: '#92400E' },
  MANAGER: { bg: '#DBEAFE', text: '#1E40AF' },
  CREW: { bg: '#F3F4F6', text: '#374151' },
}

export default async function AdminStaff() {
  const session = await getSession()

  const staff = await prisma.user.findMany({
    orderBy: [{ role: 'asc' }, { name: 'asc' }],
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      role: true,
      active: true,
      discordId: true,
      createdAt: true,
      _count: { select: { assignedJobs: true } },
    },
  })

  const isOwner = session?.role === 'OWNER'

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px' }}>
        <div>
          <h1 style={h1}>Staff</h1>
          <p style={subtitle}>{staff.length} team members</p>
        </div>
        {isOwner && (
          <a href="/admin/staff/invite" style={inviteBtn}>+ Invite team member</a>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {staff.map((u) => {
          const rc = ROLE_COLORS[u.role] ?? ROLE_COLORS.CREW
          return (
            <div key={u.id} style={{ ...staffCard, opacity: u.active ? 1 : 0.5 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flex: 1, flexWrap: 'wrap' }}>
                <div style={avatar}>
                  {u.name.charAt(0).toUpperCase()}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '2px' }}>
                    <span style={{ fontWeight: '600', color: '#0A1628', fontSize: '15px' }}>{u.name}</span>
                    <span style={{ ...roleBadge, backgroundColor: rc.bg, color: rc.text }}>{u.role}</span>
                    {!u.active && <span style={{ ...roleBadge, backgroundColor: '#FEE2E2', color: '#991B1B' }}>INACTIVE</span>}
                  </div>
                  <div style={{ fontSize: '12px', color: '#6B7280' }}>{u.email}</div>
                  {u.phone && <div style={{ fontSize: '12px', color: '#9CA3AF' }}>{u.phone}</div>}
                </div>
                <div style={{ display: 'flex', gap: '24px', alignItems: 'center', flexShrink: 0 }}>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: '18px', fontWeight: '700', color: '#0A1628' }}>{u._count.assignedJobs}</div>
                    <div style={{ fontSize: '10px', color: '#9CA3AF', letterSpacing: '0.04em', textTransform: 'uppercase' }}>Jobs</div>
                  </div>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: '12px', color: u.discordId ? '#10B981' : '#9CA3AF' }}>
                      {u.discordId ? '✓ Discord' : '✗ Discord'}
                    </div>
                  </div>
                </div>
              </div>
              {isOwner && u.id !== session?.userId && (
                <StaffActions userId={u.id} active={u.active} role={u.role} />
              )}
            </div>
          )
        })}
      </div>

      {/* Role explanation */}
      <div style={{ marginTop: '32px', backgroundColor: '#FFFFFF', borderRadius: '12px', padding: '20px', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
        <h3 style={{ fontSize: '13px', fontWeight: '700', color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 16px' }}>Role Permissions</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px' }}>
          {[
            { role: 'OWNER', perms: ['Full admin access', 'Approve discounts', 'Manage staff', 'View financials', 'Delete/archive data'] },
            { role: 'MANAGER', perms: ['Approve/deny bookings', 'View all bookings', 'Manage schedule', 'View payments', 'No staff management'] },
            { role: 'CREW', perms: ['View own job assignments', 'Update job status', 'Upload photos', 'No booking access'] },
          ].map(({ role, perms }) => {
            const rc = ROLE_COLORS[role] ?? ROLE_COLORS.CREW
            return (
              <div key={role} style={{ padding: '16px', backgroundColor: '#F9FAFB', borderRadius: '8px' }}>
                <span style={{ ...roleBadge, backgroundColor: rc.bg, color: rc.text, marginBottom: '10px', display: 'inline-block' }}>{role}</span>
                <ul style={{ margin: '0', padding: '0 0 0 16px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  {perms.map((p) => (
                    <li key={p} style={{ fontSize: '12px', color: '#374151' }}>{p}</li>
                  ))}
                </ul>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

const h1: React.CSSProperties = { fontSize: '24px', fontWeight: '700', color: '#0A1628', margin: '0 0 4px' }
const subtitle: React.CSSProperties = { fontSize: '13px', color: '#6B7280', margin: '0' }
const inviteBtn: React.CSSProperties = { padding: '10px 20px', backgroundColor: '#FF5A1F', color: '#FFFFFF', borderRadius: '8px', fontSize: '13px', fontWeight: '600', textDecoration: 'none' }
const staffCard: React.CSSProperties = { backgroundColor: '#FFFFFF', borderRadius: '12px', padding: '20px', display: 'flex', gap: '16px', alignItems: 'center', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }
const avatar: React.CSSProperties = { width: '44px', height: '44px', borderRadius: '50%', backgroundColor: '#0A1628', color: '#FF5A1F', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '18px', fontWeight: '700', flexShrink: 0 }
const roleBadge: React.CSSProperties = { fontSize: '10px', fontWeight: '700', padding: '3px 8px', borderRadius: '100px', letterSpacing: '0.04em' }
