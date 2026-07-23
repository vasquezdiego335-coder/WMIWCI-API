// Section gate. Middleware already keeps CREW out of /admin entirely, but the
// permission is re-checked HERE so the rule lives in one server-side place and
// does not depend on navigation being hidden (owner spec 2026-07-21).

import { getSession } from '@/lib/auth'
import { can } from '@/lib/permissions'
import { PageHeader, Card, Empty } from '../_ui'

export default async function EmailMarketingLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession()
  if (!can(session?.role as never, 'email.view')) {
    return (
      <div>
        <PageHeader title="Email Marketing" />
        <Card>
          <Empty>You do not have access to email marketing. Ask Diego or Sebastian if you need it.</Empty>
        </Card>
      </div>
    )
  }
  return <>{children}</>
}
