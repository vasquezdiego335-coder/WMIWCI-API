import { getSession } from '@/lib/auth'
import { can, type Role } from '@/lib/permissions'
import { depositNotifyConfig } from '@/lib/discord-payments'
import { PRESET_DEPOSIT_CENTS } from '@/lib/deposit-links'
import DepositLinksClient from './DepositLinksClient'

export const dynamic = 'force-dynamic'

export default async function DepositLinksPage() {
  const session = await getSession()
  const role = (session?.role ?? 'MANAGER') as Role

  // The Discord state is read on the SERVER — env vars are never shipped to the
  // browser, and the page states plainly whether notifications are configured
  // rather than letting the owner assume they are.
  const notify = depositNotifyConfig()

  return (
    <DepositLinksClient
      canCreate={can(role, 'deposit.create')}
      canCancel={can(role, 'deposit.cancel')}
      canTest={can(role, 'deposit.notify_test')}
      presetCents={PRESET_DEPOSIT_CENTS}
      notifications={{ configured: notify.configured, transport: notify.transport, channelId: notify.channelId, reason: notify.reason }}
    />
  )
}
