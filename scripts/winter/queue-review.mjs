#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════════
//  scripts/winter/queue-review.mjs — what would run if the workers started now?
//  ------------------------------------------------------------------------
//  Run BEFORE starting the worker host in spring (and once at shutdown, to keep
//  a record). READ-ONLY: it lists, it never removes, sends or changes anything.
//
//  Redis (BullMQ): per-queue counts by state, every delayed/waiting job with its
//  name, due time and the KEYS of its data (never values), and the repeatable
//  schedules.
//  Postgres: email rows that a sweep could still send, outbox rows, active
//  sequence/automation enrollments, ACTIVE deposit links, and bookings still in
//  a pre-confirmation state.
//
//  Usage (Git Bash):
//    export REDIS_URL='redis://…'          # optional; skip Redis if unset
//    export DATABASE_URL='postgresql://…'  # optional; skip Postgres if unset
//    export PGBIN="$HOME/pgclient/bin"
//    node scripts/winter/queue-review.mjs > queue-review.txt
//
//  Anything listed here is reviewed by the owner BEFORE SEASONAL_CLOSURE is
//  turned off. While the switch is on, the email guard drops every non-receipt
//  email for good, so starting the workers with the switch on is the safe way to
//  let stale jobs run out harmlessly.
// ════════════════════════════════════════════════════════════════════════════
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const QUEUES = ['email', 'discord', 'webhook-retry', 'scheduled', 'marketing']
const out = (s = '') => process.stdout.write(s + '\n')

if (process.env.REDIS_URL) {
  const { Queue } = await import('bullmq')
  const { default: IORedis } = await import('ioredis')
  const connection = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: false })
  out('== Redis / BullMQ')
  for (const name of QUEUES) {
    const q = new Queue(name, { connection })
    const counts = await q.getJobCounts('waiting', 'delayed', 'active', 'paused', 'prioritized', 'failed', 'completed')
    out(`-- queue ${name}: ${JSON.stringify(counts)}`)
    for (const state of ['delayed', 'waiting', 'paused', 'prioritized']) {
      const jobs = await q.getJobs([state], 0, 199)
      for (const j of jobs) {
        const due = new Date((j.timestamp ?? 0) + (j.opts?.delay ?? 0)).toISOString()
        out(`   ${state.padEnd(8)} ${String(j.name).padEnd(28)} due ${due}  created ${new Date(j.timestamp ?? 0).toISOString()}  dataKeys=[${Object.keys(j.data ?? {}).join(',')}]`)
      }
    }
    const reps = await q.getRepeatableJobs()
    for (const r of reps) out(`   repeat   ${String(r.name).padEnd(28)} ${r.pattern ?? r.every} tz=${r.tz ?? 'UTC'} next ${new Date(r.next).toISOString()}`)
    await q.close()
  }
  await connection.quit()
} else {
  out('== Redis: skipped (REDIS_URL not set)')
}

if (process.env.DATABASE_URL) {
  const u = new URL(process.env.DATABASE_URL)
  const env = { ...process.env, PGPASSWORD: decodeURIComponent(u.password), PGSSLMODE: u.searchParams.get('sslmode') || 'require', PGOPTIONS: '-c default_transaction_read_only=on' }
  const cs = `host=${u.hostname} port=${u.port || 5432} dbname=${decodeURIComponent(u.pathname.slice(1))} user=${decodeURIComponent(u.username)}`
  const psql = (title, sql) => {
    const r = spawnSync(process.env.PGBIN ? join(process.env.PGBIN, process.platform === 'win32' ? 'psql.exe' : 'psql') : 'psql', [cs, '-X', '-v', 'ON_ERROR_STOP=1', '-P', 'pager=off', '-c', sql], { env, encoding: 'utf8' })
    out(`-- ${title}`)
    out(r.status === 0 ? r.stdout.trimEnd() : `   (query failed: ${(r.stderr || '').split('\n')[0]})`)
  }
  out('\n== Postgres (read-only)')
  psql('email rows not yet sent (a sweep could still send these)', `select status, email_class, template, count(*), min(next_attempt_at) next_attempt, min(created_at)::date oldest from email_sends where sent_at is null and status not in ('blocked_terminal','failed','suppressed','cancelled') group by 1,2,3 order by 4 desc`)
  psql('outbox email_jobs not sent', `select status, count(*) from email_jobs where status <> 'sent' group by 1`)
  psql('active sequence enrollments', `select status, count(*) from sequence_enrollments group by 1`)
  psql('automation enrollments', `select status, count(*) from email_automation_enrollments group by 1`)
  psql('ACTIVE deposit links (payable if checkout is open)', `select count(*) active, min(move_date)::date earliest_move, max(move_date)::date latest_move from deposit_requests where status = 'ACTIVE'`)
  psql('bookings still awaiting payment/approval', `select status, count(*), max(coalesce(confirmed_date, requested_date))::date latest_move from bookings where not is_internal_test and status in ('DRAFT','PENDING_PAYMENT','PENDING_APPROVAL','CONFIRMED','SCHEDULED') group by 1`)
} else {
  out('\n== Postgres: skipped (DATABASE_URL not set)')
}
