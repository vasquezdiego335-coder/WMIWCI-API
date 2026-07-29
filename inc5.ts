import { readFileSync } from 'node:fs'
for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '')
}
import('@prisma/client').then(async ({ PrismaClient }) => {
  const p = new PrismaClient() as any
  const g = await p.emailAgentIncident.groupBy({ by: ['status', 'severity'], _count: { _all: true } })
  console.log('INCIDENTS:')
  for (const r of g) console.log(`  ${String(r.status).padEnd(12)} ${String(r.severity).padEnd(9)} ${r._count._all}`)
  const open = await p.emailAgentIncident.count({ where: { status: { notIn: ['resolved', 'closed'] } } })
  console.log(`GENUINELY OPEN: ${open}`)
  const r = await p.emailAgentIncident.findFirst({ where: { recommendation: { not: null } }, select: { recommendation: true } })
  console.log('recommendation typeof:', typeof r?.recommendation, '| value:', JSON.stringify(r?.recommendation).slice(0, 260))
  await p.$disconnect()
})
