// ════════════════════════════════════════════════════════════════════════
//  _consent-fake-db.ts — an in-memory Prisma stand-in for the consent suites.
//  ---------------------------------------------------------------------
//  Offline: no Postgres, no network. It implements exactly the calls
//  src/lib/consent/* makes, and it EVALUATES every WHERE clause it is given
//  (equals/insensitive, in, gt/gte/lt/lte, null, OR/AND, the booking→customer
//  relation, distinct, orderBy, take, select). A fake that ignored its filters
//  would make the forward-only and throttle tests meaningless.
//
//  UNIQUE constraints raise P2002 like Prisma does: (request_id, kind) on
//  events, (email, kind, window_start) on enrollments. $transaction snapshots
//  every table and restores it when the callback throws, so a failed
//  transaction leaves nothing behind — the property the real code relies on.
//
//  Not a test file: the leading underscore keeps it out of the test gate, the
//  same convention as _journeys-env.ts.
// ════════════════════════════════════════════════════════════════════════

type Row = Record<string, any>

export type FakeTables = {
  events: Row[]
  status: Row[]
  enrollments: Row[]
  suppressions: Row[]
  customers: Row[]
  leads: Row[]
  bookings: Row[]
  users: Row[]
  invitations: Row[]
}

const uniqueViolation = () => Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })

const clone = <T>(v: T): T => {
  if (v instanceof Date) return new Date(v.getTime()) as unknown as T
  if (Array.isArray(v)) return v.map(clone) as unknown as T
  if (v && typeof v === 'object') {
    const out: Row = {}
    for (const [k, x] of Object.entries(v as Row)) out[k] = clone(x)
    return out as T
  }
  return v
}

const cmp = (a: unknown): number | string | boolean | null =>
  a instanceof Date ? a.getTime() : (a as number | string | boolean | null)

function matchValue(value: unknown, cond: unknown): boolean {
  if (cond === null) return value === null || value === undefined
  if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime()
  if (typeof cond !== 'object') return value === cond
  const c = cond as Row
  const insensitive = c.mode === 'insensitive'
  const norm = (x: unknown) => (insensitive && typeof x === 'string' ? x.toLowerCase() : cmp(x))
  if ('equals' in c && norm(value) !== norm(c.equals)) return false
  if ('in' in c && !(c.in as unknown[]).map(norm).includes(norm(value))) return false
  if ('notIn' in c && (c.notIn as unknown[]).map(norm).includes(norm(value))) return false
  if ('not' in c) {
    if (c.not === null ? value === null || value === undefined : matchValue(value, c.not)) return false
  }
  const v = cmp(value)
  if (v === null || v === undefined) {
    if ('gt' in c || 'gte' in c || 'lt' in c || 'lte' in c) return false
    return true
  }
  if ('gt' in c && !(v > (cmp(c.gt) as any))) return false
  if ('gte' in c && !(v >= (cmp(c.gte) as any))) return false
  if ('lt' in c && !(v < (cmp(c.lt) as any))) return false
  if ('lte' in c && !(v <= (cmp(c.lte) as any))) return false
  return true
}

function makeMatcher(relations: Record<string, (row: Row) => Row | null> = {}) {
  const matches = (row: Row, where: Row | undefined): boolean => {
    if (!where) return true
    for (const [key, cond] of Object.entries(where)) {
      if (cond === undefined) continue
      if (key === 'OR') {
        if (!(cond as Row[]).some((w) => matches(row, w))) return false
        continue
      }
      if (key === 'AND') {
        if (!(cond as Row[]).every((w) => matches(row, w))) return false
        continue
      }
      if (relations[key]) {
        const related = relations[key](row)
        if (!related || !matches(related, cond as Row)) return false
        continue
      }
      if (!matchValue(row[key], cond)) return false
    }
    return true
  }
  return matches
}

function project(row: Row, select?: Row): Row {
  if (!select) return clone(row)
  const out: Row = {}
  for (const [k, on] of Object.entries(select)) if (on) out[k] = clone(row[k] ?? null)
  return out
}

function ordered(rows: Row[], orderBy?: Row | Row[]): Row[] {
  if (!orderBy) return rows
  const specs = Array.isArray(orderBy) ? orderBy : [orderBy]
  return [...rows].sort((a, b) => {
    for (const spec of specs) {
      const [k, dir] = Object.entries(spec)[0]
      const x = cmp(a[k]) as any
      const y = cmp(b[k]) as any
      if (x === y) continue
      return (x < y ? -1 : 1) * (dir === 'desc' ? -1 : 1)
    }
    return 0
  })
}

export type FakeDbOptions = {
  /** Throw from every read/write whose model name is listed. */
  failModels?: Set<string>
  now?: () => Date
}

export function createFakeConsentDb(opts: FakeDbOptions = {}) {
  const t: FakeTables = {
    events: [],
    status: [],
    enrollments: [],
    suppressions: [],
    customers: [],
    leads: [],
    bookings: [],
    users: [],
    invitations: [],
  }
  let seq = 0
  const now = opts.now ?? (() => new Date())
  const guard = (model: string) => {
    if (opts.failModels?.has(model)) throw new Error(`simulated ${model} outage`)
  }
  const plain = makeMatcher()
  const bookingMatch = makeMatcher({
    customer: (row) => t.customers.find((c) => c.id === row.customerId) ?? null,
  })

  function findMany(table: () => Row[], model: string, matcher = plain) {
    return async (args: Row = {}) => {
      guard(model)
      let rows = ordered(table().filter((r) => matcher(r, args.where)), args.orderBy)
      if (args.distinct) {
        const seen = new Set<string>()
        rows = rows.filter((r) => {
          const key = (args.distinct as string[]).map((k) => String(r[k])).join('|')
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
      }
      if (typeof args.take === 'number') rows = rows.slice(0, args.take)
      return rows.map((r) => project(r, args.select))
    }
  }

  const db: Row = {
    tables: t,
    emailConsentEvent: {
      async create({ data, select }: Row) {
        guard('emailConsentEvent')
        if (t.events.some((e) => e.requestId === data.requestId && e.kind === data.kind)) throw uniqueViolation()
        const row = { occurredAt: now(), ...clone(data), id: `evt_${++seq}` }
        t.events.push(row)
        return project(row, select)
      },
      async findUnique({ where, select }: Row) {
        guard('emailConsentEvent')
        const row = where.id
          ? t.events.find((e) => e.id === where.id)
          : t.events.find((e) => e.requestId === where.requestId_kind.requestId && e.kind === where.requestId_kind.kind)
        return row ? project(row, select) : null
      },
      findMany: findMany(() => t.events, 'emailConsentEvent'),
      async count({ where }: Row = {}) {
        guard('emailConsentEvent')
        return t.events.filter((e) => plain(e, where)).length
      },
      async update() {
        throw new Error('append-only: the application must never update email_consent_events')
      },
      async deleteMany() {
        throw new Error('append-only: the application must never delete email_consent_events')
      },
    },
    emailMarketingStatus: {
      async createMany({ data, skipDuplicates }: Row) {
        guard('emailMarketingStatus')
        let count = 0
        for (const d of data as Row[]) {
          if (t.status.some((s) => s.emailNormalized === d.emailNormalized)) {
            if (!skipDuplicates) throw uniqueViolation()
            continue
          }
          t.status.push({
            expressOptInAt: null,
            expressEventId: null,
            optedOutAt: null,
            declinedAt: null,
            lastNoticeAt: null,
            lastNoticeEventId: null,
            ...clone(d),
            updatedAt: now(),
          })
          count++
        }
        return { count }
      },
      async updateMany({ where, data }: Row) {
        guard('emailMarketingStatus')
        const hits = t.status.filter((s) => plain(s, where))
        for (const h of hits) Object.assign(h, clone(data), { updatedAt: now() })
        return { count: hits.length }
      },
      async findUnique({ where }: Row) {
        guard('emailMarketingStatus')
        const row = t.status.find((s) => s.emailNormalized === where.emailNormalized)
        return row ? clone(row) : null
      },
    },
    sequenceEnrollment: {
      async create({ data }: Row) {
        guard('sequenceEnrollment')
        const clash = t.enrollments.some(
          (e) =>
            e.emailNormalized === data.emailNormalized &&
            e.sequenceKind === data.sequenceKind &&
            e.windowStart.getTime() === data.windowStart.getTime(),
        )
        if (clash) throw uniqueViolation()
        const row = { stopReason: null, status: 'active', createdAt: now(), ...clone(data), id: `enr_${++seq}`, updatedAt: now() }
        t.enrollments.push(row)
        return clone(row)
      },
      async findUnique({ where }: Row) {
        guard('sequenceEnrollment')
        const k = where.emailNormalized_sequenceKind_windowStart
        const row = t.enrollments.find(
          (e) => e.emailNormalized === k.emailNormalized && e.sequenceKind === k.sequenceKind && e.windowStart.getTime() === k.windowStart.getTime(),
        )
        return row ? clone(row) : null
      },
      async findFirst(args: Row = {}) {
        guard('sequenceEnrollment')
        const rows = ordered(t.enrollments.filter((e) => plain(e, args.where)), args.orderBy)
        return rows[0] ? project(rows[0], args.select) : null
      },
      findMany: findMany(() => t.enrollments, 'sequenceEnrollment'),
      async updateMany({ where, data }: Row) {
        guard('sequenceEnrollment')
        const hits = t.enrollments.filter((e) => plain(e, where))
        for (const h of hits) Object.assign(h, clone(data), { updatedAt: now() })
        return { count: hits.length }
      },
      async count({ where }: Row = {}) {
        guard('sequenceEnrollment')
        return t.enrollments.filter((e) => plain(e, where)).length
      },
    },
    emailSuppression: {
      async findUnique({ where, select }: Row) {
        guard('emailSuppression')
        const row = t.suppressions.find((s) => s.email === where.email)
        return row ? project(row, select) : null
      },
    },
    customer: { findMany: findMany(() => t.customers, 'customer') },
    lead: {
      findMany: findMany(() => t.leads, 'lead'),
      async findUnique({ where, select }: Row) {
        guard('lead')
        const row = t.leads.find((l) => l.id === where.id)
        return row ? project(row, select) : null
      },
    },
    booking: {
      findMany: findMany(() => t.bookings, 'booking', bookingMatch),
      async findUnique({ where, select }: Row) {
        guard('booking')
        const row = t.bookings.find((b) => b.id === where.id)
        return row ? project(row, select) : null
      },
      async findFirst(args: Row = {}) {
        guard('booking')
        const row = t.bookings.find((b) => bookingMatch(b, args.where))
        return row ? project(row, args.select) : null
      },
    },
    user: { findMany: findMany(() => t.users, 'user') },
    crewInvitation: { findMany: findMany(() => t.invitations, 'crewInvitation') },
    async $transaction(fn: (tx: Row) => Promise<unknown>) {
      const snapshot = clone(t)
      try {
        return await fn(db)
      } catch (err) {
        for (const k of Object.keys(t) as Array<keyof FakeTables>) t[k] = snapshot[k]
        throw err
      }
    },
  }
  return db as Row & { tables: FakeTables }
}
