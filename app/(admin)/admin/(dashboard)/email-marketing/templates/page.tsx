// TEMPLATE REGISTRY (owner spec 2026-07-21).
//
// Every email that exists, what fires it, and whether it is actually reachable.
// The `wiring` column is the honest part: a template file on disk is not a
// feature. Nine legacy templates live in email-archive/ that no send path can
// reach; they are absent here rather than listed as active.

import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { templateRegistry } from '@/lib/email-registry'
import { parseRange } from '@/lib/email-admin'
import { PageHeader, Card, COLORS, Empty, tableStyles as T, SoftBadge } from '../../_ui'
import { EmailTabs, ClassBadge } from '../_shared'
import Link from 'next/link'

export const dynamic = 'force-dynamic'

const WIRING_TONE: Record<string, { color: string; label: string; hint: string }> = {
  wired: { color: COLORS.green, label: 'Live', hint: 'A production code path sends this.' },
  'flag-gated': { color: COLORS.amber, label: 'Flag-gated', hint: 'Wired, but the environment flag is the switch.' },
  manual: { color: COLORS.blue, label: 'Manual', hint: 'Only sent when an operator triggers it.' },
}

export default async function TemplatesPage() {
  const session = await getSession()
  const isOwner = session?.role === 'OWNER'
  const templates = templateRegistry()

  // Real send counts, so "registered" and "ever actually used" are distinguishable.
  let counts: Record<string, number> = {}
  let countError: string | null = null
  try {
    const rows = await prisma.emailSend.groupBy({ by: ['template'], _count: true, where: { status: 'delivered' } })
    counts = Object.fromEntries(rows.map((r) => [r.template, r._count]))
  } catch (err) {
    countError = err instanceof Error ? err.message : String(err)
  }

  const byCategory = new Map<string, typeof templates>()
  for (const t of templates) {
    byCategory.set(t.category, [...(byCategory.get(t.category) ?? []), t])
  }

  const CATEGORY_LABELS: Record<string, string> = {
    booking: 'Booking lifecycle',
    payment: 'Payment',
    'move-day': 'Move day',
    'post-move': 'After the move',
    recovery: 'Recovery',
    lead: 'Leads',
    internal: 'Internal',
  }

  return (
    <div>
      <PageHeader
        title="Templates"
        subtitle={`${templates.length} registered templates. Every one is checked against the worker allowlist by a conformance test.`}
      />
      <EmailTabs active="/admin/email-marketing/templates" isOwner={isOwner} />

      {countError && (
        <p style={{ fontSize: '12px', color: COLORS.red, marginBottom: '14px' }}>
          Send counts unavailable: {countError}
        </p>
      )}

      {Array.from(byCategory.entries()).map(([category, list]) => (
        <div key={category} style={{ marginBottom: '20px' }}>
          <Card title={CATEGORY_LABELS[category] ?? category} icon="✉️" wide>
            <div style={T.scroll}>
              <table style={T.table}>
                <thead>
                  <tr>
                    <th style={T.th}>Template</th>
                    <th style={T.th}>Class</th>
                    <th style={T.th}>Status</th>
                    <th style={T.th}>What triggers it</th>
                    <th style={{ ...T.th, textAlign: 'right' }}>Sent</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((t) => {
                    const w = WIRING_TONE[t.wiring]
                    return (
                      <tr key={t.key}>
                        <td style={{ ...T.td, minWidth: '190px' }}>
                          <Link
                            href={`/admin/email-marketing/templates/${encodeURIComponent(t.key)}`}
                            style={{ fontWeight: 700, color: COLORS.navy, textDecoration: 'none' }}
                          >
                            {t.name}
                          </Link>
                          <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: '11px', color: COLORS.faint, marginTop: '3px' }}>
                            {t.key}
                          </div>
                        </td>
                        <td style={T.td}>
                          <ClassBadge emailClass={t.emailClass} />
                        </td>
                        <td style={T.td}>
                          <SoftBadge color={w.color}>{w.label}</SoftBadge>
                          {t.flag && (
                            <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: '10px', color: COLORS.faint, marginTop: '4px' }}>
                              {t.flag}={process.env[t.flag] === 'true' ? 'true' : 'off'}
                            </div>
                          )}
                        </td>
                        <td style={{ ...T.td, fontSize: '12px', color: COLORS.muted, maxWidth: '380px' }}>{t.trigger}</td>
                        <td style={{ ...T.td, textAlign: 'right', fontWeight: 700, color: (counts[t.key] ?? 0) > 0 ? COLORS.green : COLORS.faint }}>
                          {counts[t.key] ?? 0}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      ))}

      {templates.length === 0 && <Empty>No templates registered.</Empty>}

      <div style={{ padding: '14px 18px', backgroundColor: '#F9FAFB', borderRadius: '10px', fontSize: '12px', color: COLORS.muted, lineHeight: 1.6 }}>
        <strong style={{ color: COLORS.ink }}>Live</strong> — a production code path sends it.{' '}
        <strong style={{ color: COLORS.ink }}>Flag-gated</strong> — wired, but an environment flag decides whether it
        ever fires. <strong style={{ color: COLORS.ink }}>Manual</strong> — only sent when an operator triggers it.
        Templates in <code>email-archive/</code> are deliberately excluded: no send path can reach them.
      </div>
    </div>
  )
}
