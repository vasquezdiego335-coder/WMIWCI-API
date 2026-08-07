// ════════════════════════════════════════════════════════════════════════
//  MARKETING DISCOVERY — the FLOW, proved end to end, offline.
//  (owner spec 2026-08-07)
//  ---------------------------------------------------------------------
//  DiscoveryDeps models every outward edge honestly: the campaign store, the
//  notification ledger, and Discord. What is asserted here is the business
//  contract — eligible audience → ONE draft → ONE correct notice → recorded —
//  and every failure mode the owner named: Discord down, duplicate sweeps,
//  ledger unreadable, audience too small.
// ════════════════════════════════════════════════════════════════════════
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  MIN_AUDIENCE,
  PLAYBOOK,
  buildOpportunityMessage,
  describeSegment,
  discoverCampaignOpportunities,
  nextDiscoveryCheck,
  type AgentCampaignRow,
  type CampaignCopy,
  type DiscoveryDeps,
  type OpportunityNotice,
} from '../email-marketing-agent'
import type { AudiencePreview } from '../email-audience'

const NOW = new Date('2026-08-21T15:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000

function preview(eligible: number, over: Partial<AudiencePreview['excluded']> = {}): AudiencePreview {
  return {
    segment: 'quick_quote_reactivation',
    segmentLabel: 'Quoted 14+ days ago, opted in, never booked',
    totalCandidates: eligible + 8,
    excluded: {
      invalidAddress: 0, unsubscribed: 2, hardBounce: 1, complaint: 0,
      otherSuppression: 0, marketingOptOut: 0, noConsent: 0, duplicate: 1,
      activeLifecycle: 4, ...over,
    },
    eligible,
    truncated: false,
    sample: [],
    error: null,
  }
}

type World = {
  deps: DiscoveryDeps
  campaigns: Array<AgentCampaignRow & { sourceKey: string }>
  notices: OpportunityNotice[]
  ledger: Array<{ campaignId: string; delivered: boolean }>
  sweeps: number
  eligibleBySegment: Map<string, number>
  discordUp: boolean
  ledgerReadable: boolean
  aiCopy: CampaignCopy | null
}

function world(over: Partial<Pick<World, 'campaigns' | 'eligibleBySegment' | 'discordUp' | 'ledgerReadable' | 'aiCopy'>> = {}): World {
  const w: World = {
    deps: null as unknown as DiscoveryDeps,
    campaigns: over.campaigns ?? [],
    notices: [],
    ledger: [],
    sweeps: 0,
    eligibleBySegment: over.eligibleBySegment ?? new Map([['quick_quote_reactivation', 27]]),
    discordUp: over.discordUp ?? true,
    ledgerReadable: over.ledgerReadable ?? true,
    aiCopy: over.aiCopy ?? null,
  }
  let idSeq = 0
  w.deps = {
    now: () => NOW,
    async preview(def) {
      return { ...preview(w.eligibleBySegment.get(def.segment) ?? 0), segment: def.segment }
    },
    async recentAgentCampaign(segment, since) {
      return (
        w.campaigns
          .filter((c) => c.sourceKey.startsWith(`agent-${segment}`) && c.createdAt >= since)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null
      )
    },
    async lastNotification(campaignId) {
      if (!w.ledgerReadable) throw new Error('ledger unreadable')
      const rows = w.ledger.filter((l) => l.campaignId === campaignId)
      const last = rows[rows.length - 1]
      return last ? { delivered: last.delivered } : null
    },
    async draftCopy() {
      return w.aiCopy
    },
    async createDraft({ entry, sourceKey, now }) {
      const row = {
        id: `camp_${++idSeq}`,
        name: `${entry.campaignName} — ${now.toISOString().slice(0, 10)}`,
        status: 'DRAFT',
        createdAt: now,
        sourceKey,
      }
      w.campaigns.push(row)
      return { id: row.id, name: row.name }
    },
    async postDiscord(input) {
      if (!w.discordUp) return false
      w.notices.push(input)
      return true
    },
    async recordNotification(campaignId, delivered) {
      w.ledger.push({ campaignId, delivered })
    },
    async recordSweep() {
      w.sweeps++
    },
  }
  return w
}

beforeEach(() => {
  process.env.EMAIL_MARKETING_AGENT_ENABLED = 'true'
})

// ── The happy path, end to end ──────────────────────────────────────────

test('E2E: eligible audience → ONE draft → ONE Discord notice → ledger records it', async () => {
  const w = world()
  const report = await discoverCampaignOpportunities(w.deps)

  assert.equal(w.campaigns.length, 1, 'exactly one campaign created')
  assert.equal(w.campaigns[0].status, 'DRAFT')
  assert.match(w.campaigns[0].sourceKey, /^agent-quick_quote_reactivation-20260821$/)

  assert.equal(w.notices.length, 1, 'exactly one Discord notice')
  const n = w.notices[0]
  assert.equal(n.campaignId, w.campaigns[0].id)
  assert.equal(n.eligible, 27)

  assert.deepEqual(w.ledger, [{ campaignId: w.campaigns[0].id, delivered: true }])
  assert.equal(w.sweeps, 1, 'the sweep itself is recorded for the ops agent')
  assert.equal(report.created?.discordPosted, true)
})

test('E2E: the message the owner reads contains everything and leaks nothing', () => {
  process.env.APP_URL = 'https://api.example.com'
  const msg = buildOpportunityMessage({
    campaignName: 'Quick quote reactivation — 2026-08-21',
    campaignId: 'camp_42',
    segment: 'quick_quote_reactivation',
    rationale: PLAYBOOK[0].draft.rationale,
    subject: 'Still planning your move?',
    eligible: 27,
    excluded: preview(27).excluded,
    useDiscount: true,
  })
  delete process.env.APP_URL

  // Everything the owner needs to decide:
  assert.match(msg, /EMAIL CAMPAIGN READY/)
  assert.match(msg, /Quick quote reactivation — 2026-08-21/)
  assert.match(msg, /27 eligible people/)
  assert.match(msg, /requested a moving estimate at least 14 days ago/, 'owner language, not SQL')
  assert.match(msg, /4 in an active lifecycle/)
  assert.match(msg, /2 unsubscribed/)
  assert.match(msg, /10% first-time discount \(applied automatically at booking — no code needed\)/)
  assert.match(msg, /Still planning your move\?/)
  assert.match(msg, /DRAFT — nothing sends until you approve it/)
  assert.match(msg, /Campaign ID:\*\* camp_42/)
  assert.match(msg, /https:\/\/api\.example\.com\/admin\/email-marketing\/campaigns/)

  // ...and nothing about any individual person:
  for (const pii of ['@gmail', '@yahoo', 'phone', 'address:', 'sample']) {
    assert.ok(!msg.toLowerCase().includes(pii), `message must not contain ${pii}`)
  }
})

// ── Idempotency + cooldown ──────────────────────────────────────────────

test('running discovery twice creates ONE campaign and ONE notice', async () => {
  const w = world()
  await discoverCampaignOpportunities(w.deps)
  await discoverCampaignOpportunities(w.deps)
  await discoverCampaignOpportunities(w.deps)

  assert.equal(w.campaigns.length, 1, 'restart/deploy/manual re-run cannot duplicate the campaign')
  assert.equal(w.notices.length, 1, 'and cannot re-post the notice')
})

test('a campaign the owner APPROVED (left DRAFT) still holds the cooldown — no daily re-nag', async () => {
  const w = world({
    campaigns: [{ id: 'c1', name: 'Quick quote reactivation — 2026-08-15', status: 'ACTIVE', createdAt: new Date(NOW.getTime() - 6 * DAY), sourceKey: 'agent-quick_quote_reactivation-20260815' }],
  })
  const report = await discoverCampaignOpportunities(w.deps)
  assert.equal(w.campaigns.length, 1, 'no new campaign inside the cooldown')
  assert.equal(w.notices.length, 0)
  assert.ok(report.considered.some((c) => c.outcome === 'cooldown'))
})

test('below the audience threshold nothing happens at all', async () => {
  const w = world({ eligibleBySegment: new Map([['quick_quote_reactivation', MIN_AUDIENCE - 1]]) })
  const report = await discoverCampaignOpportunities(w.deps)
  assert.equal(w.campaigns.length, 0)
  assert.equal(w.notices.length, 0)
  assert.ok(report.considered.every((c) => c.outcome === 'audience_too_small'))
})

test('the flag off → the sweep does not run and records nothing', async () => {
  delete process.env.EMAIL_MARKETING_AGENT_ENABLED
  const w = world()
  const report = await discoverCampaignOpportunities(w.deps)
  assert.equal(report.ran, false)
  assert.equal(w.campaigns.length + w.notices.length + w.sweeps, 0)
})

// ── Discord failure: the owner's hard requirements ──────────────────────

test('DISCORD DOWN: the campaign is still created, stays DRAFT, and the failure is recorded', async () => {
  const w = world({ discordUp: false })
  const report = await discoverCampaignOpportunities(w.deps)

  assert.equal(w.campaigns.length, 1, 'a Discord outage never costs the draft')
  assert.equal(w.campaigns[0].status, 'DRAFT', 'and never advances its state')
  assert.deepEqual(w.ledger, [{ campaignId: w.campaigns[0].id, delivered: false }], 'the failure is on the ledger')
  assert.equal(report.created?.discordPosted, false, 'reported honestly, not swallowed')
})

test('SELF-HEAL: the next sweep retries the notice for the un-notified draft — it never re-creates the campaign', async () => {
  const w = world({ discordUp: false })
  await discoverCampaignOpportunities(w.deps) // creates draft, notice fails

  w.discordUp = true
  const second = await discoverCampaignOpportunities(w.deps)

  assert.equal(w.campaigns.length, 1, 'still one campaign')
  assert.equal(w.notices.length, 1, 'the notice finally went out')
  assert.equal(w.notices[0].campaignId, w.campaigns[0].id, 'for the SAME campaign')
  assert.deepEqual(w.ledger.map((l) => l.delivered), [false, true])
  assert.ok(second.considered.some((c) => c.outcome === 'notification_retried'))

  // And once delivered, later sweeps stop touching it.
  const third = await discoverCampaignOpportunities(w.deps)
  assert.equal(w.notices.length, 1, 'no re-post after success')
  assert.ok(third.considered.some((c) => c.outcome === 'cooldown'))
})

test('LEDGER UNREADABLE: fail SAFE — no retry post, because "was the owner told?" is unknowable', async () => {
  const w = world({ discordUp: false })
  await discoverCampaignOpportunities(w.deps)
  w.discordUp = true
  w.ledgerReadable = false

  const report = await discoverCampaignOpportunities(w.deps)
  assert.equal(w.notices.length, 0, 'a blind retry loop is the daily-spam failure the ledger exists to stop')
  assert.ok(report.considered.some((c) => c.outcome === 'ledger_unreadable'))
})

// ── AI copy is advisory, never load-bearing ─────────────────────────────

test('AI copy refinement is used when present and its absence changes nothing structural', async () => {
  const ai: CampaignCopy = { subject: 'Your move, 10% lighter', previewText: 'Come back and save.', rationale: 'Aged, opted-in, unbooked.', useDiscount: true }
  const withAi = world({ aiCopy: ai })
  await discoverCampaignOpportunities(withAi.deps)
  assert.equal(withAi.notices[0].subject, 'Your move, 10% lighter')

  const withoutAi = world()
  await discoverCampaignOpportunities(withoutAi.deps)
  assert.equal(withoutAi.notices[0].subject, PLAYBOOK[0].draft.subject, 'deterministic draft carries the day')
})

// ── The status helpers the admin renders ────────────────────────────────

test('describeSegment speaks owner language for every playbook segment', () => {
  for (const entry of PLAYBOOK) {
    const text = describeSegment(entry.segment)
    assert.ok(text.length > 40, `${entry.segment} has a real sentence`)
    assert.ok(!text.includes('_'), 'no snake_case leaks into the owner text')
  }
})

test('nextDiscoveryCheck always lands on 10:05 ET, in the future', () => {
  for (const from of ['2026-08-21T13:00:00.000Z', '2026-08-21T14:05:00.000Z', '2026-08-21T23:00:00.000Z']) {
    const next = nextDiscoveryCheck(new Date(from))
    assert.ok(next.getTime() > new Date(from).getTime(), 'strictly in the future')
    const et = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(next)
    assert.equal(et, '10:05', `from ${from} → ${et}`)
  }
})
