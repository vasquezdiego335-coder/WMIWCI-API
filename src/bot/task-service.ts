// ════════════════════════════════════════════════════════════════════════
//  Owner task board — shared service (transport-agnostic)
//  ----------------------------------------------------------------------
//  Used by BOTH the HTTP interactions endpoint (app/api/discord/interactions)
//  and the gateway command-handler. DB ops + tolerant date/time parsing +
//  embed builders live here once; each transport just wraps the returned
//  embed (raw Discord embed JSON, accepted by both fetch responses and
//  discord.js editReply).
//
//  Ranking everywhere: importance DESC (5 = highest), then due date ASC, then
//  due time ASC (Postgres sorts NULLS LAST, so timed tasks lead untimed ones).
// ════════════════════════════════════════════════════════════════════════
import { prisma } from '../lib/db'
import type { Task, TaskOwner } from '@prisma/client'

const ORANGE = 0xff5a1f
const NAVY = 0x0a1628
const GREEN = 0x22c55e
const RED = 0xef4444

export type Embed = {
  title?: string
  description?: string
  color?: number
  fields?: Array<{ name: string; value: string; inline?: boolean }>
  footer?: { text: string }
  timestamp?: string
}

// Canonical open-task ordering (importance 5 → 1, then soonest due, then time).
const OPEN_ORDER = [{ importance: 'desc' as const }, { dueDate: 'asc' as const }, { dueTime: 'asc' as const }]

// ── parsing ────────────────────────────────────────────────────────────────

export function parseOwner(raw?: string): TaskOwner | null {
  const v = (raw ?? '').trim().toLowerCase()
  if (!v) return null
  if (v.startsWith('d')) return 'DIEGO'
  if (v.startsWith('s')) return 'SEBASTIAN'
  return null
}

export function parseImportance(raw?: string | number): number {
  const n = typeof raw === 'number' ? raw : parseInt(String(raw ?? ''), 10)
  if (Number.isNaN(n)) return 3
  return Math.min(5, Math.max(1, n))
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
}

// "Today" as a Date at UTC midnight for the current Eastern calendar day.
export function etToday(): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date()) // "YYYY-MM-DD"
  return new Date(`${parts}T00:00:00.000Z`)
}

function utcMidnight(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m, d, 0, 0, 0, 0))
}

// Tolerant date parser → Date at UTC midnight of the calendar day. null if unparseable.
// Handles: today/tomorrow, YYYY-MM-DD, M/D[/YY[YY]], "Mon D[, YYYY]", "D Mon[, YYYY]".
export function parseDueDate(raw?: string): Date | null {
  const s = (raw ?? '').trim().toLowerCase()
  if (!s) return null

  const today = etToday()
  if (s === 'today' || s === 'tod') return today
  if (s === 'tomorrow' || s === 'tom' || s === 'tmrw') {
    const t = new Date(today)
    t.setUTCDate(t.getUTCDate() + 1)
    return t
  }

  const thisYear = today.getUTCFullYear()

  // YYYY-MM-DD
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (m) return utcMidnight(+m[1], +m[2] - 1, +m[3])

  // M/D or M/D/YY or M/D/YYYY
  m = s.match(/^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?$/)
  if (m) {
    let yr = m[3] ? +m[3] : thisYear
    if (yr < 100) yr += 2000
    return utcMidnight(yr, +m[1] - 1, +m[2])
  }

  // "Mon D" / "Mon D, YYYY" / "Month D YYYY"
  m = s.match(/^([a-z]{3,9})\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?$/)
  if (m && MONTHS[m[1].slice(0, 3)] !== undefined) {
    return utcMidnight(m[3] ? +m[3] : thisYear, MONTHS[m[1].slice(0, 3)], +m[2])
  }

  // "D Mon" / "D Mon YYYY"
  m = s.match(/^(\d{1,2})\s+([a-z]{3,9})\.?(?:,?\s+(\d{4}))?$/)
  if (m && MONTHS[m[2].slice(0, 3)] !== undefined) {
    return utcMidnight(m[3] ? +m[3] : thisYear, MONTHS[m[2].slice(0, 3)], +m[1])
  }

  // Last resort: native Date parse, normalized to UTC midnight of that day.
  const native = new Date(raw as string)
  if (!Number.isNaN(native.getTime())) {
    return utcMidnight(native.getFullYear(), native.getMonth(), native.getDate())
  }
  return null
}

// Optional time → normalized "HH:MM" (24h, zero-padded, sortable). null if none/invalid.
export function parseDueTime(raw?: string): string | null {
  const s = (raw ?? '').trim().toLowerCase().replace(/\s+/g, '')
  if (!s) return null
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)?$/)
  if (!m) return null
  let h = parseInt(m[1], 10)
  const min = m[2] ? parseInt(m[2], 10) : 0
  const ap = m[3]
  if (h > 23 || min > 59) return null
  if (ap === 'pm' && h < 12) h += 12
  if (ap === 'am' && h === 12) h = 0
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
}

// ── display ──────────────────────────────────────────────────────────────

export const shortId = (id: string): string => id.slice(-6)

function importanceBadge(n: number): string {
  return `${'🔴🟠🟡🟢🔵'[5 - n] ?? '⚪'} ${n}/5`
}

function timeLabel(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number)
  const ap = h < 12 ? 'AM' : 'PM'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}:${String(m).padStart(2, '0')} ${ap}`
}

export function formatDue(dueDate: Date, dueTime: string | null): string {
  // dueDate is stored at UTC midnight, so format in UTC to keep the calendar day.
  const datePart = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(dueDate)
  return dueTime ? `${datePart} · ${timeLabel(dueTime)}` : datePart
}

export function taskEmbed(task: Task, opts: { title?: string; color?: number } = {}): Embed {
  const fields = [
    { name: '👤 Owner', value: task.owner, inline: true },
    { name: '⭐ Importance', value: importanceBadge(task.importance), inline: true },
    { name: '📅 Due', value: formatDue(task.dueDate, task.dueTime), inline: true },
  ]
  if (task.description) fields.push({ name: '📝 Description', value: task.description.slice(0, 1024), inline: false })
  return {
    title: opts.title ?? `📋 ${task.title}`,
    color: opts.color ?? ORANGE,
    fields,
    footer: { text: `Task ${shortId(task.id)} · ${task.status}` },
    timestamp: new Date().toISOString(),
  }
}

export function taskListEmbed(tasks: Task[], heading: string): Embed {
  const description =
    tasks.length === 0
      ? 'No tasks. 🎉'
      : tasks
          .map(
            (t) =>
              `${importanceBadge(t.importance)} **${t.title}** — ${t.owner}\n` +
              `   📅 ${formatDue(t.dueDate, t.dueTime)} · \`${shortId(t.id)}\``
          )
          .join('\n')
          .slice(0, 4000)
  return {
    title: heading,
    color: NAVY,
    description,
    footer: { text: `${tasks.length} task${tasks.length === 1 ? '' : 's'}` },
    timestamp: new Date().toISOString(),
  }
}

const errEmbed = (msg: string): Embed => ({ title: '⚠️ ' + msg, color: RED })

// Resolve a task by full cuid or by the 6-char short id shown in listings.
async function resolveTask(idOrShort: string): Promise<Task | null> {
  const id = (idOrShort ?? '').trim()
  if (!id) return null
  const exact = await prisma.task.findUnique({ where: { id } })
  if (exact) return exact
  return prisma.task.findFirst({ where: { id: { endsWith: id } } })
}

// ── command operations (each returns a ready-to-send embed) ─────────────────

export async function addTask(input: {
  owner?: string
  title?: string
  importance?: string
  due?: string
  time?: string
  notes?: string
}): Promise<Embed> {
  const owner = parseOwner(input.owner)
  if (!owner) return errEmbed('Owner must be Diego or Sebastian.')
  const title = (input.title ?? '').trim()
  if (!title) return errEmbed('A task title is required.')
  const dueDate = parseDueDate(input.due)
  if (!dueDate) return errEmbed(`Could not read the due date "${input.due ?? ''}". Try 2026-06-25, 6/25, "Jun 25", today, or tomorrow.`)

  const task = await prisma.task.create({
    data: {
      owner,
      title,
      description: (input.notes ?? '').trim() || null,
      importance: parseImportance(input.importance),
      dueDate,
      dueTime: parseDueTime(input.time),
    },
  })
  return taskEmbed(task, { title: `✅ Task added — ${task.title}`, color: GREEN })
}

export async function listTasks(ownerRaw?: string): Promise<Embed> {
  const owner = ownerRaw ? parseOwner(ownerRaw) : null
  if (ownerRaw && !owner) return errEmbed('Owner must be Diego or Sebastian.')
  const tasks = await prisma.task.findMany({
    where: { status: 'OPEN', ...(owner ? { owner } : {}) },
    orderBy: OPEN_ORDER,
  })
  return taskListEmbed(tasks, owner ? `🗂️ Open tasks — ${owner}` : '🗂️ Open tasks')
}

export async function todayTasks(): Promise<Embed> {
  const start = etToday()
  const end = new Date(start)
  end.setUTCDate(end.getUTCDate() + 1)
  const tasks = await prisma.task.findMany({
    where: { status: 'OPEN', dueDate: { gte: start, lt: end } },
    orderBy: OPEN_ORDER,
  })
  return taskListEmbed(tasks, '📆 Due today')
}

export async function overdueTasks(): Promise<Embed> {
  const tasks = await prisma.task.findMany({
    where: { status: 'OPEN', dueDate: { lt: etToday() } },
    orderBy: OPEN_ORDER,
  })
  return taskListEmbed(tasks, '⏰ Overdue')
}

export async function completeTask(idOrShort: string): Promise<Embed> {
  const task = await resolveTask(idOrShort)
  if (!task) return errEmbed(`No task found for "${idOrShort}".`)
  if (task.status === 'DONE') return taskEmbed(task, { title: `✅ Already done — ${task.title}`, color: GREEN })
  const done = await prisma.task.update({
    where: { id: task.id },
    data: { status: 'DONE', completedAt: new Date() },
  })
  return taskEmbed(done, { title: `✅ Marked done — ${done.title}`, color: GREEN })
}

export async function deleteTask(idOrShort: string): Promise<Embed> {
  const task = await resolveTask(idOrShort)
  if (!task) return errEmbed(`No task found for "${idOrShort}".`)
  await prisma.task.delete({ where: { id: task.id } })
  return { title: `🗑️ Deleted — ${task.title}`, color: RED, footer: { text: `Task ${shortId(task.id)}` } }
}

export async function editTask(input: {
  id?: string
  title?: string
  importance?: string
  owner?: string
  due?: string
  time?: string
  notes?: string
}): Promise<Embed> {
  const task = await resolveTask(input.id ?? '')
  if (!task) return errEmbed(`No task found for "${input.id ?? ''}".`)

  const data: Record<string, unknown> = {}
  if (input.title?.trim()) data.title = input.title.trim()
  if (input.importance !== undefined && input.importance !== '') data.importance = parseImportance(input.importance)
  if (input.owner) {
    const o = parseOwner(input.owner)
    if (!o) return errEmbed('Owner must be Diego or Sebastian.')
    data.owner = o
  }
  if (input.due) {
    const d = parseDueDate(input.due)
    if (!d) return errEmbed(`Could not read the due date "${input.due}".`)
    data.dueDate = d
  }
  if (input.time !== undefined && input.time !== '') data.dueTime = parseDueTime(input.time)
  if (input.notes !== undefined) data.description = input.notes.trim() || null

  if (Object.keys(data).length === 0) return errEmbed('Nothing to update — pass at least one field to change.')

  const updated = await prisma.task.update({ where: { id: task.id }, data })
  return taskEmbed(updated, { title: `✏️ Updated — ${updated.title}`, color: ORANGE })
}
