import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import Link from 'next/link'
import { describeLaborSetup, OWNER_RATE_EXPLANATION, LABOR_SETUP_TITLE, type RateProfile } from '@/lib/labor-rates'
import StaffActions from './StaffActions'
import StaffRates from './StaffRates'
import InviteCrew from './InviteCrew'

export const revalidate = 0

const ROLE_COLORS: Record<string, { bg: string; text: string }> = {
  OWNER: { bg: '#FEF3C7', text: '#92400E' },
  MANAGER: { bg: '#DBEAFE', text: '#1E40AF' },
  CREW: { bg: '#F3F4F6', text: '#374151' },
}

export default async function AdminStaff() {
  const session = await getSession()

  const isOwner = session?.role === 'OWNER'

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
      // ── Stage 4 rate configuration. Selected ONLY for an owner session:
      //    pay and owner-labor rates are owner-financial settings, and a
      //    manager viewing this page must not receive them at all. ──
      ...(isOwner
        ? {
            ownerEconomicRateCents: true as const,
            payRate: true as const,
            defaultFlatRateCents: true as const,
            defaultPayModel: true as const,
            rateEffectiveOn: true as const,
            rateNotes: true as const,
            rateUpdatedAt: true as const,
            canDrive: true as const,
            canLeadCrew: true as const,
            preferredRole: true as const,
            workerType: true as const,
          }
        : {}),
    },
  })

  // The "Financial labor setup" panel. Reports what is configured; it never
  // supplies a rate of its own — see src/lib/labor-rates.ts.
  const setup = describeLaborSetup(
    staff.map((u): RateProfile => ({
      id: u.id,
      name: u.name,
      role: u.role as RateProfile['role'],
      active: u.active,
      ownerEconomicRateCents: 'ownerEconomicRateCents' in u ? u.ownerEconomicRateCents : null,
    })),
  )

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px' }}>
        <div>
          <h1 style={h1}>Staff</h1>
          <p style={subtitle}>{staff.length} team members</p>
        </div>
        {/* Stage 5: the real invitation flow (owner-only, expiring token,
            duplicate-protected, audited). Account creation from an accepted
            invite still depends on the auth onboarding step — documented in the
            invite panel, not faked. */}
        {isOwner && <InviteCrew />}
      </div>

      {/* Owners-can-staff message when there is no crew yet — zero crew is not a
          failure state when the owners do the jobs. */}
      {isOwner && setup.activeCrewLine.value === '0' && (
        <div style={{ backgroundColor: '#EFF6FF', border: '1px solid #BFDBFE', borderRadius: '12px', padding: '14px 16px', marginBottom: '20px', fontSize: '13px', color: '#1E3A8A', lineHeight: 1.6 }}>
          <strong>No crew accounts yet — that is fine.</strong> Diego and Sebastian can staff jobs as owners
          (assign them to a job with worker type OWNER). Add crew here when the business hires workers.
        </div>
      )}

      {/* ── Financial labor setup (Stage 4, D6) ──
          Owner-only. "Not configured" is a real answer here: the system refuses
          to guess what an owner hour is worth, and says so plainly rather than
          showing a number nobody chose. */}
      {isOwner && (
        <div style={{ backgroundColor: '#FFFFFF', borderRadius: '12px', padding: '20px', marginBottom: '24px', boxShadow: '0 1px 4px rgba(0,0,0,0.06)', borderLeft: `4px solid ${setup.ownerRatesReady ? '#10B981' : '#F59E0B'}` }}>
          <h2 style={{ fontSize: '13px', fontWeight: 700, color: '#0A1628', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 12px' }}>
            {LABOR_SETUP_TITLE}
          </h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxWidth: '520px' }}>
            {setup.lines.map((l) => (
              <div key={l.label} style={{ display: 'flex', justifyContent: 'space-between', gap: '16px', fontSize: '13px' }}>
                <span style={{ color: '#6B7280' }}>{l.label}</span>
                <span style={{ fontWeight: 700, color: l.configured ? '#0A1628' : '#B45309', fontVariantNumeric: 'tabular-nums' }}>{l.value}</span>
              </div>
            ))}
          </div>
          {!setup.ownerRatesReady && (
            <p style={{ fontSize: '12px', color: '#B45309', margin: '12px 0 0', fontWeight: 600 }}>
              Financial setup required — a move cannot be financially closed while an owner&rsquo;s labor
              rate is unknown. A missing rate is never treated as $0.
            </p>
          )}
          <p style={{ fontSize: '12px', color: '#6B7280', margin: '10px 0 0', lineHeight: 1.6, maxWidth: '620px' }}>
            {OWNER_RATE_EXPLANATION}
          </p>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {staff.map((u) => {
          const rc = ROLE_COLORS[u.role] ?? ROLE_COLORS.CREW
          return (
            <div key={u.id} style={{ ...staffCard, opacity: u.active ? 1 : 0.5, flexDirection: 'column', alignItems: 'stretch' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flex: 1, flexWrap: 'wrap' }}>
                <div style={avatar}>
                  {u.name.charAt(0).toUpperCase()}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '2px' }}>
                    <Link href={`/admin/staff/${u.id}`} style={{ fontWeight: '600', color: '#0A1628', fontSize: '15px', textDecoration: 'none' }}>{u.name}</Link>
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
              <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'space-between' }}>
                {/* Rates are owner-only. An owner may edit their OWN rate here —
                    unlike StaffActions, which refuses self-edits so nobody can
                    deactivate or demote themselves by accident. */}
                {isOwner && 'ownerEconomicRateCents' in u && (
                  <StaffRates
                    userId={u.id}
                    isOwnerProfile={u.role === 'OWNER'}
                    fields={{
                      ownerEconomicRateCents: u.ownerEconomicRateCents ?? null,
                      payRateCents: u.payRate ?? null,
                      defaultFlatRateCents: u.defaultFlatRateCents ?? null,
                      defaultPayModel: (u.defaultPayModel ?? null) as 'HOURLY' | 'FLAT' | 'DAY_RATE' | null,
                      rateEffectiveOn: u.rateEffectiveOn ? u.rateEffectiveOn.toISOString() : null,
                      rateNotes: u.rateNotes ?? null,
                      active: u.active,
                      canDrive: u.canDrive ?? false,
                      canLeadCrew: u.canLeadCrew ?? false,
                      preferredRole: u.preferredRole ?? null,
                      rateUpdatedAt: u.rateUpdatedAt ? u.rateUpdatedAt.toISOString() : null,
                      rateUpdatedByName: null,
                    }}
                  />
                )}
                {isOwner && u.id !== session?.userId && (
                  <StaffActions userId={u.id} active={u.active} role={u.role} />
                )}
              </div>
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
