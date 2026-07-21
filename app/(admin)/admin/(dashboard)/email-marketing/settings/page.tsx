// EMAIL SETTINGS (owner spec 2026-07-21).
//
// READ-ONLY by design. Every value here is an environment variable read by the
// running container, and changing one takes effect on redeploy — so a form that
// appeared to save would be lying. The page shows what IS configured, what is
// MISSING, and exactly what each gap breaks.
//
// Secrets are never displayed. Presence and a non-reversible fingerprint only.

import { getSession } from '@/lib/auth'
import { can } from '@/lib/permissions'
import { CAPS } from '@/lib/email-guard'
import { businessPostalAddress } from '@/lib/marketing-context'
import { configChecks, flagChecks } from '@/lib/email-diagnostics'
import { PageHeader, Card, COLORS, Callout, tableStyles as T, SoftBadge } from '../../_ui'
import { EmailTabs } from '../_shared'

export const dynamic = 'force-dynamic'

const STATUS_COLOR: Record<string, string> = { ok: COLORS.green, warn: COLORS.amber, fail: COLORS.red, off: COLORS.faint }

export default async function EmailSettingsPage() {
  const session = await getSession()
  const isOwner = session?.role === 'OWNER'
  const mayConfigure = can(session?.role as never, 'email.configure')

  const config = configChecks()
  const flags = flagChecks()
  const postal = businessPostalAddress()

  const identity: Array<{ label: string; value: string; ok: boolean; note?: string }> = [
    { label: 'From address', value: process.env.EMAIL_FROM ?? '', ok: Boolean(process.env.EMAIL_FROM?.trim()) },
    { label: 'Reply-to', value: process.env.EMAIL_REPLY_TO ?? '', ok: Boolean(process.env.EMAIL_REPLY_TO?.trim()) },
    { label: 'App URL', value: process.env.APP_URL ?? '', ok: Boolean(process.env.APP_URL?.trim()), note: 'Every unsubscribe and portal link is built from this.' },
    {
      label: 'Business postal address',
      value: postal ?? '',
      ok: Boolean(postal),
      note: 'Required on promotional email. Missing = every promotional send is BLOCKED, by design.',
    },
    { label: 'Owner alert inbox', value: process.env.OWNER_EMAIL ?? '', ok: Boolean(process.env.OWNER_EMAIL?.trim()), note: 'Internal alerts only — never customer mail.' },
    { label: 'Google review URL', value: process.env.GOOGLE_REVIEW_URL ?? '', ok: Boolean(process.env.GOOGLE_REVIEW_URL?.trim()), note: 'Missing = review requests never queue.' },
    { label: 'Test recipient', value: process.env.EMAIL_TEST_RECIPIENT ?? '', ok: Boolean(process.env.EMAIL_TEST_RECIPIENT?.trim()), note: 'The ONLY address a test send may go to.' },
  ]

  return (
    <div>
      <PageHeader
        title="Email settings"
        subtitle="What this container is configured with. Read-only — these are environment variables."
      />
      <EmailTabs active="/admin/email-marketing/settings" isOwner={isOwner} />

      <Callout tone="info" title="These settings are not editable from the admin">
        Every value below comes from the deployment environment (Railway). A form here would appear to save and change
        nothing until the next deploy, so there isn&apos;t one. Change them in Railway, redeploy, and re-check this page
        — it reads the live process, which is the only way to prove the deployed container actually picked the change up.
        {!mayConfigure && (
          <div style={{ marginTop: '6px' }}>
            Your role can view this configuration but not change it.
          </div>
        )}
      </Callout>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: '18px', marginBottom: '18px' }}>
        <Card title="Sender identity" icon="📧">
          <div style={T.scroll}>
            <table style={T.table}>
              <tbody>
                {identity.map((row) => (
                  <tr key={row.label}>
                    <td style={{ ...T.td, fontWeight: 600, whiteSpace: 'nowrap', verticalAlign: 'top' }}>{row.label}</td>
                    <td style={{ ...T.td, verticalAlign: 'top' }}>
                      {row.ok ? (
                        <span style={{ fontSize: '12px', fontFamily: 'ui-monospace, monospace', color: COLORS.ink, wordBreak: 'break-all' }}>
                          {row.value}
                        </span>
                      ) : (
                        <SoftBadge color={COLORS.red}>MISSING</SoftBadge>
                      )}
                      {row.note && (
                        <div style={{ fontSize: '11px', color: COLORS.faint, marginTop: '4px', lineHeight: 1.5 }}>{row.note}</div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="Sending policy" icon="⏱">
          <div style={T.scroll}>
            <table style={T.table}>
              <tbody>
                <Policy label="Promotional per day" value={String(CAPS.perDay)} env="EMAIL_CAP_PER_DAY" />
                <Policy label="Promotional per week" value={String(CAPS.perWeek)} env="EMAIL_CAP_PER_WEEK" />
                <Policy label="Promotional per month" value={String(CAPS.perMonth)} env="EMAIL_CAP_PER_MONTH" />
                <Policy label="Quiet hours" value={`${CAPS.quietStartHour}:00 – ${CAPS.quietEndHour}:00 ET`} env="EMAIL_QUIET_START_HOUR / EMAIL_QUIET_END_HOUR" />
                <Policy label="Gap after transactional" value={`${CAPS.transactionalGapMinutes} min`} env="EMAIL_TRANSACTIONAL_GAP_MINUTES" />
              </tbody>
            </table>
          </div>
          <p style={{ fontSize: '11px', color: COLORS.faint, margin: '12px 0 0', lineHeight: 1.6 }}>
            Caps and quiet hours apply to <strong>promotional</strong> email only. A receipt or a move-day reminder must
            arrive when the event happens, not when a marketing window opens.
          </p>
        </Card>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: '18px' }}>
        <Card title="Provider + compliance" icon="🔐">
          <div style={T.scroll}>
            <table style={T.table}>
              <tbody>
                {config.map((c) => (
                  <tr key={c.name}>
                    <td style={{ ...T.td, fontFamily: 'ui-monospace, monospace', fontSize: '11px', whiteSpace: 'nowrap', verticalAlign: 'top' }}>{c.name}</td>
                    <td style={{ ...T.td, verticalAlign: 'top' }}>
                      <SoftBadge color={STATUS_COLOR[c.status] ?? COLORS.faint}>{c.status.toUpperCase()}</SoftBadge>
                    </td>
                    <td style={{ ...T.td, fontSize: '12px', color: COLORS.muted, lineHeight: 1.5 }}>{c.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="Feature flags" icon="🚩">
          <div style={T.scroll}>
            <table style={T.table}>
              <tbody>
                {flags.map((f) => (
                  <tr key={f.name}>
                    <td style={{ ...T.td, fontFamily: 'ui-monospace, monospace', fontSize: '11px' }}>{f.name}</td>
                    <td style={{ ...T.td, textAlign: 'right' }}>
                      <SoftBadge color={f.detail === 'ON' ? COLORS.green : COLORS.faint}>{f.detail}</SoftBadge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p style={{ fontSize: '11px', color: COLORS.faint, margin: '12px 0 0', lineHeight: 1.6 }}>
            All journey flags default to OFF. Turning the marketing engine on is a deliberate act, and these are the
            switches that do it.
          </p>
        </Card>
      </div>
    </div>
  )
}

function Policy({ label, value, env }: { label: string; value: string; env: string }) {
  return (
    <tr>
      <td style={{ ...T.td, fontWeight: 600 }}>
        {label}
        <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: '10px', color: COLORS.faint, marginTop: '3px' }}>{env}</div>
      </td>
      <td style={{ ...T.td, textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{value}</td>
    </tr>
  )
}
