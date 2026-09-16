// ════════════════════════════════════════════════════════════════════════
//  IN-MEMORY `lifecycle_enqueue_retries` — a Prisma delegate, not a store.
//  ---------------------------------------------------------------------
//  Deliberately NOT a hand-written RetryStore: the upsert-by-job_id rules
//  (which status may return to pending, what a unique violation means, which
//  transitions are conditional) are the part that can be wrong, so the
//  PRODUCTION store code must be the code under test. Everything this fake
//  models is something the real table does:
//    • the UNIQUE index on job_id → a duplicate `create` throws Prisma's P2002;
//    • `updateMany` filters and `{ increment }` updates;
//    • `findMany` ordering + take, and `count` with the same filters.
//
//  Shared by lifecycle-enqueue-durability.test.ts (the store's behaviour) and
//  lifecycle-retry-backlog-check.test.ts (the email-agent health check).
//  Not a test file; never listed in `npm test`.
// ════════════════════════════════════════════════════════════════════════
import { prismaRetryStore, type RetryPrismaClient, type RetryStore } from '../lifecycle-enqueue'

export type MemoryRetryRow = {
  id: string
  queueName: string
  jobName: string
  jobId: string
  data: Record<string, unknown>
  fireAt: Date
  notAfter: Date
  path: string
  subjectType: string
  subjectId: string
  status: string
  attempts: number
  lastError: string | null
  nextAttemptAt: Date
  createdAt: Date
  updatedAt: Date
  resolvedAt: Date | null
}

type Cond = Record<string, unknown>

const ord = (v: unknown): number | string => (v instanceof Date ? v.getTime() : (v as number | string))

/** The subset of Prisma `where` the store actually uses. */
export function matchesWhere(row: MemoryRetryRow, where: Cond): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (key === 'NOT') {
      if (matchesWhere(row, cond as Cond)) return false
      continue
    }
    const value = (row as unknown as Record<string, unknown>)[key]
    if (cond instanceof Date) {
      if (!(value instanceof Date) || value.getTime() !== cond.getTime()) return false
      continue
    }
    if (cond !== null && typeof cond === 'object') {
      const c = cond as Record<string, unknown>
      if ('in' in c && !(c.in as unknown[]).includes(value)) return false
      if ('lt' in c && !(ord(value) < ord(c.lt))) return false
      if ('lte' in c && !(ord(value) <= ord(c.lte))) return false
      if ('gt' in c && !(ord(value) > ord(c.gt))) return false
      if ('gte' in c && !(ord(value) >= ord(c.gte))) return false
      if ('startsWith' in c && !(typeof value === 'string' && value.startsWith(c.startsWith as string))) return false
      continue
    }
    if (value !== cond) return false
  }
  return true
}

function applyData(row: MemoryRetryRow, data: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(data)) {
    if (value !== null && typeof value === 'object' && !(value instanceof Date) && 'increment' in (value as object)) {
      const current = (row as unknown as Record<string, number>)[key] ?? 0
      ;(row as unknown as Record<string, number>)[key] = current + ((value as { increment: number }).increment ?? 0)
      continue
    }
    ;(row as unknown as Record<string, unknown>)[key] = value
  }
  row.updatedAt = new Date()
}

export type MemoryRetryDb = {
  rows: MemoryRetryRow[]
  delegate: RetryPrismaClient['lifecycleEnqueueRetry']
  byJobId(jobId: string): MemoryRetryRow | undefined
  reset(): void
}

export function memoryRetryDb(opts: { createThrows?: boolean } = {}): MemoryRetryDb {
  const rows: MemoryRetryRow[] = []
  let seq = 0
  const delegate = {
    async create({ data }: { data: Record<string, unknown> }) {
      if (opts.createThrows) throw new Error('relation "lifecycle_enqueue_retries" does not exist')
      if (rows.some((r) => r.jobId === data.jobId)) {
        // Exactly what the unique index gives us: Prisma's P2002.
        throw Object.assign(new Error('Unique constraint failed on the fields: (`job_id`)'), { code: 'P2002' })
      }
      const stamp = new Date()
      const given = data as unknown as Partial<MemoryRetryRow>
      // Column defaults, exactly as the migration declares them.
      const row: MemoryRetryRow = {
        ...(given as MemoryRetryRow),
        id: `retry_${++seq}`,
        status: given.status ?? 'pending',
        attempts: given.attempts ?? 0,
        lastError: given.lastError ?? null,
        nextAttemptAt: given.nextAttemptAt ?? stamp,
        createdAt: stamp,
        updatedAt: stamp,
        resolvedAt: null,
      }
      rows.push(row)
      return { ...row }
    },
    async updateMany({ where, data }: { where: Cond; data: Record<string, unknown> }) {
      const hits = rows.filter((r) => matchesWhere(r, where))
      for (const r of hits) applyData(r, data)
      return { count: hits.length }
    },
    async findMany({ where, orderBy, take }: { where: Cond; orderBy?: { nextAttemptAt: 'asc' | 'desc' }; take?: number }) {
      let hits = rows.filter((r) => matchesWhere(r, where))
      if (orderBy?.nextAttemptAt) {
        hits = hits
          .slice()
          .sort((a, b) => (orderBy.nextAttemptAt === 'asc' ? 1 : -1) * (a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime()))
      }
      if (take !== undefined) hits = hits.slice(0, take)
      return hits.map((r) => ({ ...r }))
    },
    async count({ where }: { where: Cond }) {
      return rows.filter((r) => matchesWhere(r, where)).length
    },
  }
  return {
    rows,
    delegate: delegate as unknown as RetryPrismaClient['lifecycleEnqueueRetry'],
    byJobId: (jobId) => rows.find((r) => r.jobId === jobId),
    reset: () => {
      rows.length = 0
      seq = 0
    },
  }
}

/** The PRODUCTION store on top of the in-memory delegate. */
export function memoryRetryStore(opts: { createThrows?: boolean } = {}): { db: MemoryRetryDb; store: RetryStore } {
  const db = memoryRetryDb(opts)
  return { db, store: prismaRetryStore({ lifecycleEnqueueRetry: db.delegate }) }
}
