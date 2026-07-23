// AUDIENCES (owner spec 2026-07-21). Owner-only.
//
// Build an audience from APPROVED segments and filters, and see exactly who
// would be excluded before anything is sent. There is no raw query field here
// and no way to add one: the server accepts only the vocabulary below.

import { getSession } from '@/lib/auth'
import { can } from '@/lib/permissions'
import { prisma } from '@/lib/db'
import { SEGMENTS, FILTERS, SERVICE_TYPES, SERVICE_AREA_ZONES, LOCALES, MAX_AUDIENCE } from '@/lib/email-audience'
import { PageHeader, Card, Empty, COLORS, Callout } from '../../_ui'
import { EmailTabs } from '../_shared'
import AudienceBuilder from './AudienceBuilder'

export const dynamic = 'force-dynamic'

export default async function AudiencesPage() {
  const session = await getSession()
  const isOwner = session?.role === 'OWNER'

  if (!can(session?.role as never, 'email.manage_campaign')) {
    return (
      <div>
        <PageHeader title="Audiences" />
        <EmailTabs active="/admin/email-marketing/audiences" isOwner={isOwner} />
        <Card>
          <Empty>Audience building is limited to owners.</Empty>
        </Card>
      </div>
    )
  }

  let saved: Array<{ id: string; name: string; description: string | null; definition: unknown; lastPreviewCount: number | null; lastPreviewAt: Date | null }> = []
  let error: string | null = null
  try {
    saved = await prisma.emailAudience.findMany({ orderBy: { updatedAt: 'desc' }, take: 50 })
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }

  return (
    <div>
      <PageHeader
        title="Audiences"
        subtitle="Approved segments only. Every preview shows who is excluded and why."
      />
      <EmailTabs active="/admin/email-marketing/audiences" isOwner={isOwner} />

      <Callout tone="info" title="A preview is not authorization to send">
        These counts describe who a send <em>would</em> reach right now. When a campaign dispatches, the audience is
        recomputed from scratch and every individual message still passes the send guard — so an audience previewed
        today can never be the list that mails next week.
      </Callout>

      <AudienceBuilder
        vocabulary={{
          segments: SEGMENTS as unknown as Record<string, string>,
          filters: Object.fromEntries(Object.entries(FILTERS).map(([k, v]) => [k, v.label])),
          serviceTypes: Array.from(SERVICE_TYPES),
          serviceAreaZones: Array.from(SERVICE_AREA_ZONES),
          locales: Array.from(LOCALES),
          maxAudience: MAX_AUDIENCE,
        }}
        saved={saved.map((s) => ({
          id: s.id,
          name: s.name,
          description: s.description,
          definition: s.definition,
          lastPreviewCount: s.lastPreviewCount,
          lastPreviewAt: s.lastPreviewAt ? s.lastPreviewAt.toISOString() : null,
        }))}
      />

      {error && <p style={{ fontSize: '12px', color: COLORS.red, marginTop: '14px' }}>Saved audiences unavailable: {error}</p>}

      <div style={{ marginTop: '18px', padding: '14px 18px', backgroundColor: '#F9FAFB', borderRadius: '10px', fontSize: '12px', color: COLORS.muted, lineHeight: 1.6 }}>
        Audiences are capped at {MAX_AUDIENCE.toLocaleString()} candidates. When a segment hits that bound the preview
        says so, because a truncated count that looks complete is worse than no count.
        Suppressed addresses, spam complaints, hard bounces, marketing opt-outs and internal test records are excluded
        before the eligible figure — and each exclusion is counted separately so nothing hides inside a total.
      </div>
    </div>
  )
}
