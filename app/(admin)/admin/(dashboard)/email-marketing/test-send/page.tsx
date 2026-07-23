// TEST SEND (owner spec 2026-07-21). Owner-only.
//
// Preview a real template with obviously-synthetic data, check its required
// variables, then send it to the approved test recipient through the SAME
// guarded path a customer email uses.

import { getSession } from '@/lib/auth'
import { can } from '@/lib/permissions'
import { templateRegistry } from '@/lib/email-registry'
import { configuredTestRecipient } from '@/lib/email-test-send'
import { renderableTemplates } from '@/lib/email-render'
import { PageHeader, Card, Empty, Callout, COLORS } from '../../_ui'
import { EmailTabs } from '../_shared'
import TestSendPanel from './TestSendPanel'

export const dynamic = 'force-dynamic'

export default async function TestSendPage() {
  const session = await getSession()
  const isOwner = session?.role === 'OWNER'

  if (!can(session?.role as never, 'email.send_test')) {
    return (
      <div>
        <PageHeader title="Test send" />
        <EmailTabs active="/admin/email-marketing/test-send" isOwner={isOwner} />
        <Card>
          <Empty>Test sends are limited to owners.</Empty>
        </Card>
      </div>
    )
  }

  const renderable = new Set(renderableTemplates())
  const templates = templateRegistry()
    .filter((t) => renderable.has(t.key))
    .map((t) => ({ key: t.key, name: t.name, emailClass: t.emailClass, category: t.category }))

  const recipient = configuredTestRecipient()

  return (
    <div>
      <PageHeader
        title="Test send"
        subtitle="Rehearse a real template against the real send guard — without touching a customer."
      />
      <EmailTabs active="/admin/email-marketing/test-send" isOwner={isOwner} />

      {!recipient && (
        <Callout tone="warning" title="EMAIL_TEST_RECIPIENT is not set">
          Without a configured test address, every test needs the explicit override below. Set{' '}
          <code>EMAIL_TEST_RECIPIENT</code> in Railway so routine tests have one safe destination.
        </Callout>
      )}

      <Callout tone="info" title="A test send is a real send">
        It goes through <strong>guardedSend</strong>, the same door as customer mail: suppression, URL safety, required
        fields and the promotional postal-address rule all apply. What makes it a test is that the subject is prefixed{' '}
        <code>[TEST]</code> and the ledger row is flagged, which excludes it from every conversion, revenue, profit and
        frequency-cap number. No booking, review, referral or payment state is touched.
      </Callout>

      <TestSendPanel templates={templates} configuredRecipient={recipient} />

      <p style={{ fontSize: '11px', color: COLORS.faint, marginTop: '18px', lineHeight: 1.6 }}>
        Only templates with a registered renderer are listed. Every test send is recorded in the audit log with the
        template, the recipient and whether the override was used.
      </p>
    </div>
  )
}
