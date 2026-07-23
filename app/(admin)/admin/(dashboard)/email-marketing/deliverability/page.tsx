// DELIVERABILITY (owner spec 2026-07-21).
//
// Whether the provider, the webhook and the compliance configuration are
// actually working IN THIS CONTAINER — not on someone's laptop. Reuses
// email-diagnostics, which reports presence and a non-reversible fingerprint,
// never a secret value.
//
// SPF/DKIM/DMARC are reported as UNVERIFIED, always. Those records live in DNS
// at the registrar and this process cannot see them; printing "verified"
// because an env var is set would be exactly the false green this page exists
// to prevent.

import { getSession } from '@/lib/auth'
import { runDiagnostics } from '@/lib/email-diagnostics'
import { webhookHealth, dnsChecks } from '@/lib/email-admin'
import { PageHeader, Card, COLORS, Callout, tableStyles as T, SoftBadge } from '../../_ui'
import { EmailTabs, dt } from '../_shared'

export const dynamic = 'force-dynamic'

const STATUS_COLOR: Record<string, string> = {
  ok: COLORS.green,
  warn: COLORS.amber,
  fail: COLORS.red,
  off: COLORS.faint,
  unverified: COLORS.blue,
}

export default async function DeliverabilityPage() {
  const session = await getSession()
  const isOwner = session?.role === 'OWNER'

  const [diag, health] = await Promise.all([runDiagnostics(), webhookHealth()])
  const dns = dnsChecks()

  return (
    <div>
      <PageHeader
        title="Deliverability"
        subtitle="What this running container believes its email configuration is."
      />
      <EmailTabs active="/admin/email-marketing/deliverability" isOwner={isOwner} />

      {diag.status === 'blocked' && (
        <Callout tone="danger" title={`${diag.summary.fail} check${diag.summary.fail === 1 ? '' : 's'} failing`}>
          Email is impaired in this environment. Each failing row below names what is unset and what it breaks.
        </Callout>
      )}
      {diag.status === 'degraded' && (
        <Callout tone="warning" title={`${diag.summary.warn} check${diag.summary.warn === 1 ? '' : 's'} need attention`}>
          Email works, but something is configured in a way that will bite later.
        </Callout>
      )}

      {health.pendingSideEffects > 0 && (
        <Callout tone="danger" title={`${health.pendingSideEffects} bounce/complaint suppression${health.pendingSideEffects === 1 ? '' : 's'} never completed`}>
          The provider told us an address bounced or complained, and the address was NOT added to the suppression list.
          It can still be mailed. This must be zero.
        </Callout>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: '18px', marginBottom: '18px' }}>
        <Card title="Configuration" icon="⚙️">
          <ChecksTable checks={diag.config} />
        </Card>

        <Card title="Webhook + provider events" icon="📡">
          <ChecksTable
            checks={[
              {
                name: 'Webhook secret',
                status: health.configured ? 'ok' : 'fail',
                detail: health.configured
                  ? 'Configured — bounce and complaint events can be verified and processed.'
                  : 'UNSET. /api/email/webhook returns 503 and NO bounce or complaint is ever processed.',
              },
              {
                name: 'Last event received',
                status: health.lastEventAt ? 'ok' : 'warn',
                detail: health.lastEventAt
                  ? `${dt(health.lastEventAt)} · ${health.eventsLast7d} event(s) in the last 7 days`
                  : 'No provider event has ever been received. If mail is sending, the webhook is not reaching this service.',
              },
              {
                name: 'Unfinished side effects',
                status: health.pendingSideEffects > 0 ? 'fail' : 'ok',
                detail:
                  health.pendingSideEffects > 0
                    ? `${health.pendingSideEffects} event(s) recorded but their suppression was never written.`
                    : 'Every recorded bounce and complaint has been applied to the suppression list.',
              },
              {
                name: 'Dead-lettered events',
                status: health.deadLettered > 0 ? 'fail' : 'ok',
                detail:
                  health.deadLettered > 0
                    ? `${health.deadLettered} event(s) exhausted their retries and need a human.`
                    : 'None.',
              },
            ]}
          />
        </Card>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: '18px', marginBottom: '18px' }}>
        <Card title="Schema" icon="🗄">
          <ChecksTable checks={diag.schema} />
        </Card>

        <Card title="Token signing" icon="🔑">
          <ChecksTable checks={[diag.token]} />
          <p style={{ fontSize: '11px', color: COLORS.faint, margin: '12px 0 0', lineHeight: 1.6 }}>
            The fingerprint above is a one-way hash. Two services showing the SAME fingerprint share the same secret —
            which is what makes unsubscribe links signed by the API verify in the worker. It never reveals the value.
          </p>
        </Card>
      </div>

      <Card title="DNS authentication" icon="🌐" wide>
        <ChecksTable checks={dns.map((d) => ({ name: d.name, status: d.status, detail: d.detail }))} />
        <p style={{ fontSize: '12px', color: COLORS.muted, margin: '14px 0 0', lineHeight: 1.6 }}>
          These are reported as <strong>unverified</strong> on purpose. SPF, DKIM and DMARC are DNS records at the
          registrar; this application cannot read them, and inferring &ldquo;configured&rdquo; from an environment
          variable would produce a green light that means nothing. Verify them in the Resend dashboard or with a DNS
          lookup, and record the date you checked.
        </p>
      </Card>

      <div style={{ marginTop: '18px' }}>
        <Card title="Journey flags in this environment" icon="🚩" wide>
          <ChecksTable checks={diag.flags} />
        </Card>
      </div>

      <p style={{ fontSize: '11px', color: COLORS.faint, marginTop: '16px' }}>
        Checked at {dt(diag.checkedAt)} · {diag.summary.ok} ok · {diag.summary.warn} warn · {diag.summary.fail} fail
      </p>
    </div>
  )
}

function ChecksTable({ checks }: { checks: Array<{ name: string; status: string; detail: string }> }) {
  return (
    <div style={T.scroll}>
      <table style={T.table}>
        <tbody>
          {checks.map((c) => (
            <tr key={c.name}>
              <td style={{ ...T.td, fontWeight: 600, whiteSpace: 'nowrap', verticalAlign: 'top' }}>{c.name}</td>
              <td style={{ ...T.td, verticalAlign: 'top' }}>
                <SoftBadge color={STATUS_COLOR[c.status] ?? COLORS.faint}>{c.status.toUpperCase()}</SoftBadge>
              </td>
              <td style={{ ...T.td, fontSize: '12px', color: COLORS.muted, lineHeight: 1.5 }}>{c.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
