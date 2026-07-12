import { getSession } from '@/lib/auth'
import { redis } from '@/lib/redis'
import Link from 'next/link'

export const revalidate = 0

const QUEUES = ['email', 'sms', 'discord', 'webhook-retry', 'scheduled']

async function getQueueStats(name: string) {
  try {
    const prefix = `bull:${name}:`
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      redis.llen(`${prefix}wait`),
      redis.llen(`${prefix}active`),
      redis.zcard(`${prefix}completed`),
      redis.zcard(`${prefix}failed`),
      redis.zcard(`${prefix}delayed`),
    ])
    return { name, waiting, active, completed, failed, delayed }
  } catch {
    return { name, waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, error: true }
  }
}

export default async function AdminQueues() {
  await getSession()

  const stats = await Promise.all(QUEUES.map(getQueueStats))

  const totalFailed = stats.reduce((sum, q) => sum + q.failed, 0)
  const totalActive = stats.reduce((sum, q) => sum + q.active, 0)
  const totalWaiting = stats.reduce((sum, q) => sum + q.waiting, 0)

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px' }}>
        <div>
          <h1 style={h1}>Job Queues</h1>
          <p style={subtitle}>BullMQ worker status via Redis</p>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <a
            href="/api/admin/queues/bull-board"
            target="_blank"
            rel="noreferrer"
            style={{ padding: '8px 16px', backgroundColor: '#0A1628', color: '#FFFFFF', borderRadius: '8px', fontSize: '13px', fontWeight: '600', textDecoration: 'none' }}
          >
            Open Bull Board →
          </a>
        </div>
      </div>

      {/* Summary */}
      <div style={summaryGrid}>
        <SummaryCard label="Active Jobs" value={totalActive} color={totalActive > 0 ? '#F59E0B' : '#10B981'} />
        <SummaryCard label="Waiting" value={totalWaiting} color={totalWaiting > 0 ? '#3B82F6' : '#10B981'} />
        <SummaryCard label="Failed" value={totalFailed} color={totalFailed > 0 ? '#EF4444' : '#10B981'} />
      </div>

      {totalFailed > 0 && (
        <div style={alert}>
          ⚠️ {totalFailed} failed job{totalFailed > 1 ? 's' : ''} require attention.{' '}
          <a href="/api/admin/queues/bull-board" target="_blank" rel="noreferrer" style={{ color: '#FF5A1F' }}>
            Open Bull Board to retry →
          </a>
        </div>
      )}

      {/* Queue cards */}
      <div style={grid}>
        {stats.map((q) => (
          <div key={q.name} style={queueCard}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
              <h3 style={{ fontSize: '14px', fontWeight: '700', color: '#0A1628', margin: '0', textTransform: 'capitalize' }}>
                {q.name}
              </h3>
              <span style={{
                fontSize: '10px', fontWeight: '700', padding: '3px 8px', borderRadius: '100px',
                backgroundColor: q.active > 0 ? '#FEF3C7' : '#F0FDF4',
                color: q.active > 0 ? '#92400E' : '#065F46',
              }}>
                {q.active > 0 ? 'PROCESSING' : 'IDLE'}
              </span>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '10px' }}>
              <Metric label="Waiting" value={q.waiting} color="#3B82F6" />
              <Metric label="Active" value={q.active} color="#F59E0B" />
              <Metric label="Completed" value={q.completed} color="#10B981" />
              <Metric label="Failed" value={q.failed} color={q.failed > 0 ? '#EF4444' : '#9CA3AF'} warn={q.failed > 0} />
            </div>

            {q.delayed > 0 && (
              <div style={{ marginTop: '10px', fontSize: '11px', color: '#6366F1', backgroundColor: '#EDE9FE', padding: '4px 10px', borderRadius: '6px' }}>
                {q.delayed} delayed job{q.delayed > 1 ? 's' : ''} scheduled
              </div>
            )}

            {'error' in q && (
              <div style={{ marginTop: '10px', fontSize: '11px', color: '#EF4444', backgroundColor: '#FEF2F2', padding: '4px 10px', borderRadius: '6px' }}>
                Could not read queue stats — Redis may be unreachable
              </div>
            )}
          </div>
        ))}
      </div>

      <div style={{ marginTop: '24px', padding: '16px 20px', backgroundColor: '#F9FAFB', borderRadius: '10px', fontSize: '12px', color: '#6B7280' }}>
        <strong style={{ color: '#374151' }}>Workers:</strong>{' '}
        Workers run in a separate process (`npm run workers`). Failed jobs auto-retry 3× with exponential backoff.
        Use Bull Board for detailed inspection and manual retries.
        Redis key prefix: <code style={{ fontFamily: 'monospace', backgroundColor: '#FFFFFF', padding: '1px 6px', borderRadius: '4px' }}>bull:</code>
      </div>
    </div>
  )
}

function SummaryCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ backgroundColor: '#FFFFFF', borderRadius: '12px', padding: '20px 24px', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
      <p style={{ fontSize: '12px', color: '#6B7280', fontWeight: '600', letterSpacing: '0.06em', textTransform: 'uppercase', margin: '0 0 8px' }}>{label}</p>
      <p style={{ fontSize: '28px', fontWeight: '700', color, margin: '0' }}>{value}</p>
    </div>
  )
}

function Metric({ label, value, color, warn }: { label: string; value: number; color: string; warn?: boolean }) {
  return (
    <div style={{ backgroundColor: warn ? '#FEF2F2' : '#F9FAFB', borderRadius: '6px', padding: '8px 12px' }}>
      <div style={{ fontSize: '18px', fontWeight: '700', color }}>{value}</div>
      <div style={{ fontSize: '10px', color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
    </div>
  )
}

const h1: React.CSSProperties = { fontSize: '24px', fontWeight: '700', color: '#0A1628', margin: '0 0 4px' }
const subtitle: React.CSSProperties = { fontSize: '13px', color: '#6B7280', margin: '0' }
const summaryGrid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px', marginBottom: '20px' }
const alert: React.CSSProperties = { backgroundColor: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '8px', padding: '12px 16px', fontSize: '14px', color: '#374151', marginBottom: '20px' }
const grid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '16px' }
const queueCard: React.CSSProperties = { backgroundColor: '#FFFFFF', borderRadius: '12px', padding: '20px', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }
