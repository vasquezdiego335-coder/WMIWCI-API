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
import { liveDnsChecks } from '@/lib/email-dns'
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

  // LIVE DNS (audit pass D). The page used to report SPF/DKIM/DMARC as
  // "unverified, always" because the records live at the registrar. But this
  // process CAN resolve DNS, and the permanent-unknown made a real problem
  // invisible: DMARC was published as p=none with no rua=, so the policy whose
  // only purpose is reporting was reporting to nobody.
  const [diag, health, live] = await Promise.all([runDiagnostics(), webhookHealth(), liveDnsChecks()])
  // The env-var attestations remain as an operator override/audit trail.
  const attested = dnsChecks()

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
        <p style={{ fontSize: '12px', color: COLORS.muted, margin: '0 0 12px', lineHeight: 1.6 }}>
          Resolved live from DNS just now for <strong>{live.domain ?? 'an unknown domain'}</strong> — the From-header
          domain, which is the one DMARC alignment is judged against.
        </p>
        <ChecksTable checks={live.checks.map((d) => ({ name: d.name, status: d.status, detail: d.detail }))} />

        {live.checks.some((c) => c.advice.length > 0) && (
          <div style={{ marginTop: '14px' }}>
            {live.checks.filter((c) => c.advice.length > 0).map((c) => (
              <div key={c.name} style={{ marginBottom: '10px' }}>
                <p style={{ fontSize: '12px', fontWeight: 700, color: COLORS.navy, margin: '0 0 4px' }}>{c.name}</p>
                {c.advice.map((a) => (
                  <p key={a} style={{ fontSize: '12px', color: COLORS.muted, margin: '0 0 4px', lineHeight: 1.6 }}>• {a}</p>
                ))}
                {c.record && (
                  <code style={{ fontSize: '11px', color: COLORS.muted, wordBreak: 'break-all', display: 'block', marginTop: '4px' }}>
                    {c.record}
                  </code>
                )}
              </div>
            ))}
          </div>
        )}

        <p style={{ fontSize: '12px', color: COLORS.muted, margin: '14px 0 0', lineHeight: 1.6 }}>
          A published record proves the record <strong>exists</strong>. It does not prove that a given message passes
          authentication — only the receiving mail server can tell you that, which is what the DMARC{' '}
          <code>rua=</code> reports are for.
        </p>
      </Card>

      {attested.some((d) => d.status !== 'UNVERIFIED') && (
        <div style={{ marginTop: '18px' }}>
          <Card title="Recorded attestations" icon="📝" wide>
            <ChecksTable checks={attested.map((d) => ({ name: d.name, status: d.status, detail: d.detail }))} />
            <p style={{ fontSize: '12px', color: COLORS.muted, margin: '14px 0 0', lineHeight: 1.6 }}>
              Manually recorded via <code>EMAIL_DNS_*</code>. The live lookup above is authoritative; these are kept as
              an audit trail of what an operator previously asserted.
            </p>
          </Card>
        </div>
      )}

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
