// ============================================================================
// stage4-allocation-reporting.test.ts — the 40/30/30 policy from the money math
// all the way out to the exports, plus the durability rules that make a
// finalized move a historical RECORD rather than a live opinion.
//
// The two questions every test here is really asking:
//   1. do the owner's numbers come out exactly right?
//   2. can anything that happens LATER change a move that is already closed?
// ============================================================================

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeReserves } from '../closeout-calc'
import { computeOwnerSplit } from '../owner-split'
import {
  buildProfitAllocation, allocationFromSnapshot, allocationFromTotals,
  allocationExportFields, renderAllocationText, bpToPercentLabel,
  ALLOCATION_EXPORT_COLUMNS, ALLOCATION_EXPLANATION,
} from '../profit-allocation'
import { aggregateMoves, selectMoveFigures, type MoveFinancialRow } from '../reporting-basis'
import { REPORT_COLUMNS } from '../report-permissions'
import { toCsv, toPdf, visibleColumns, assertNoForbiddenKeys, sanitizeCell, type ExportMeta } from '../export-service'

const RETAINED_BP = 4000 // owner policy 2026-07-21: the business keeps 40%

/** One move's whole allocation, the way the closeout builds it. */
function allocate(netProfitCents: number) {
  const reserves = computeReserves({ companyNetProfitCents: netProfitCents, businessRetainedBp: RETAINED_BP })
  const split = computeOwnerSplit({
    method: 'OWNERSHIP_PERCENT',
    distributableProfitCents: reserves.distributableProfitCents,
    ownershipBp: { DIEGO: 5000, SEBASTIAN: 5000 },
  })
  return buildProfitAllocation({
    companyNetProfitCents: netProfitCents,
    businessRetainedCents: reserves.businessRetainedCents,
    businessRetainedBp: reserves.businessRetainedBp,
    distributableProfitCents: reserves.distributableProfitCents,
    ownerShares: split.shares.map((s) => ({ owner: s.owner, amountCents: s.amountCents, percentBp: s.percentBp })),
  })
}

const lineFor = (v: ReturnType<typeof allocate>, label: string) => v.lines.find((l) => l.label === label)!

// ── The exact policy ────────────────────────────────────────────────────────

test('EXACT POLICY — $1,000 net: business $400, Diego $300, Sebastian $300', () => {
  const v = allocate(100_000)
  assert.equal(lineFor(v, 'Business retained').amountCents, 40_000)
  assert.equal(lineFor(v, 'Diego allocation').amountCents, 30_000)
  assert.equal(lineFor(v, 'Sebastian allocation').amountCents, 30_000)
  assert.equal(lineFor(v, 'Business retained').ofNetProfitBp, 4000)
  assert.equal(lineFor(v, 'Diego allocation').ofNetProfitBp, 3000)
  assert.equal(lineFor(v, 'Sebastian allocation').ofNetProfitBp, 3000)
  // The three lines account for the whole of net profit — no leakage.
  assert.equal(v.lines.reduce((s, l) => s + l.amountCents, 0), 100_000)
})

test('EXACT POLICY — $1,175 net: business $470, Diego $352.50, Sebastian $352.50', () => {
  const v = allocate(117_500)
  assert.equal(lineFor(v, 'Business retained').amountCents, 47_000)
  assert.equal(lineFor(v, 'Diego allocation').amountCents, 35_250)
  assert.equal(lineFor(v, 'Sebastian allocation').amountCents, 35_250)
  assert.equal(v.lines.reduce((s, l) => s + l.amountCents, 0), 117_500)
})

test('the labels read as 40% / 30% / 30%, not as an unexplained 50/50', () => {
  const v = allocate(100_000)
  const text = renderAllocationText(v)
  assert.match(text, /Business retained — 40%/)
  assert.match(text, /Diego allocation — 30%/)
  assert.match(text, /Sebastian allocation — 30%/)
  // The internal 50/50 is never presented on its own.
  assert.ok(!/50%/.test(text))
  assert.match(v.explanation, /remaining 60% is divided/)
})

test('a provisional block says so in its own text', () => {
  assert.match(renderAllocationText(allocate(100_000), { basis: 'PROVISIONAL' }), /\(Provisional\)/)
})

// ── Losses ──────────────────────────────────────────────────────────────────

test('a LOSS allocates zero to everyone, and the loss stays visible', () => {
  const v = allocate(-45_000)
  assert.equal(v.hasDistribution, false)
  assert.equal(lineFor(v, 'Business retained').amountCents, 0)
  assert.equal(lineFor(v, 'Diego allocation').amountCents, 0)
  assert.equal(lineFor(v, 'Sebastian allocation').amountCents, 0)
  // The loss itself is NOT zeroed — it is reported.
  assert.equal(v.companyNetProfitCents, -45_000)
})

test('a losing move can still be finalized — nothing is over-allocated', () => {
  const r = computeReserves({ companyNetProfitCents: -45_000, businessRetainedBp: RETAINED_BP })
  assert.equal(r.overAllocated, false)
  assert.equal(r.businessRetainedCents, 0)
  assert.equal(r.distributableProfitCents, 0)
})

test('a zero-profit move allocates nothing', () => {
  const v = allocate(0)
  assert.equal(v.hasDistribution, false)
  assert.equal(v.lines.every((l) => l.amountCents === 0), true)
})

// ── Rounding ────────────────────────────────────────────────────────────────

test('an ODD CENT remainder stays with the business', () => {
  // $10.01 net → retained $4.00 (floor of 40%), distributable $6.01, each owner
  // $3.00, and the stray cent belongs to the business.
  const v = allocate(1001)
  const business = lineFor(v, 'Business retained')
  const diego = lineFor(v, 'Diego allocation')
  const sebastian = lineFor(v, 'Sebastian allocation')
  assert.equal(diego.amountCents + sebastian.amountCents, 600)
  assert.equal(v.roundingRemainderCents, 1)
  assert.equal(business.amountCents, v.businessRetainedCents + 1)
  assert.equal(v.lines.reduce((s, l) => s + l.amountCents, 0), 1001)
})

test('owner distributions can never exceed the available profit', () => {
  for (const net of [1, 7, 33, 999, 1001, 100_001, 117_501]) {
    const v = allocate(net)
    const owners = v.lines.filter((l) => !l.isBusiness).reduce((s, l) => s + l.amountCents, 0)
    assert.ok(owners <= v.ownerDistributableCents, `owners over-allocated at ${net}`)
    assert.ok(v.lines.reduce((s, l) => s + l.amountCents, 0) <= net, `total over net at ${net}`)
  }
})

// ── Snapshot persistence ────────────────────────────────────────────────────

/** A FinancialSnapshot row as the database holds it. */
function snapshotOf(net: number) {
  const v = allocate(net)
  return {
    companyNetProfitCents: v.companyNetProfitCents,
    businessRetainedCents: v.businessRetainedCents,
    businessRetainedBp: v.businessRetainedBp,
    distributableProfitCents: v.ownerDistributableCents,
    roundingRemainderCents: v.roundingRemainderCents,
    ownerAllocations: v.lines.filter((l) => !l.isBusiness).map((l) => ({
      owner: l.label.replace(' allocation', '').toUpperCase(),
      amountCents: l.amountCents,
      percentBp: 5000,
    })),
    allocationLines: v.lines,
    calculationVersion: 'phase2.1',
  }
}

test('every 40/30/30 value persists onto the snapshot and reads back identically', () => {
  const row = snapshotOf(117_500)
  const back = allocationFromSnapshot(row)
  assert.equal(back.companyNetProfitCents, 117_500)
  assert.equal(back.businessRetainedBp, 4000)
  assert.equal(back.businessRetainedCents, 47_000)
  assert.equal(back.ownerDistributableCents, 70_500)
  assert.equal(lineFor(back, 'Business retained').amountCents, 47_000)
  assert.equal(lineFor(back, 'Diego allocation').amountCents, 35_250)
  assert.equal(lineFor(back, 'Sebastian allocation').amountCents, 35_250)
  assert.equal(back.roundingRemainderCents, 0)
})

test('a CONFIGURATION CHANGE does not rewrite a snapshot', () => {
  const row = snapshotOf(100_000)
  const before = allocationFromSnapshot(row)

  // The owner later changes the retained share to 60% and the split to 70/30.
  // Reading the SAME row must produce the SAME answer: nothing in
  // allocationFromSnapshot consults live configuration.
  const after = allocationFromSnapshot(row)
  assert.deepEqual(after, before)
  assert.equal(after.businessRetainedBp, 4000)
  assert.equal(lineFor(after, 'Diego allocation').amountCents, 30_000)

  // And a live recomputation under the new policy is a DIFFERENT number, which
  // is exactly why the frozen one has to be stored.
  const underNewPolicy = computeReserves({ companyNetProfitCents: 100_000, businessRetainedBp: 6000 })
  assert.equal(underNewPolicy.businessRetainedCents, 60_000)
  assert.notEqual(underNewPolicy.businessRetainedCents, after.businessRetainedCents)
})

test('a snapshot written before Stage 4 is restated from its frozen amounts, still without live config', () => {
  const row = { ...snapshotOf(100_000), allocationLines: undefined }
  const back = allocationFromSnapshot(row as never)
  assert.equal(lineFor(back, 'Business retained').amountCents, 40_000)
  assert.equal(lineFor(back, 'Diego allocation').amountCents, 30_000)
})

test('a malformed allocationLines column cannot fabricate a line', () => {
  const row = { ...snapshotOf(100_000), allocationLines: ['nonsense', { label: 5 }] }
  const back = allocationFromSnapshot(row as never)
  // Falls back to the frozen amounts rather than inventing anything.
  assert.equal(lineFor(back, 'Business retained').amountCents, 40_000)
})

test('the calculation version persists with the figures', () => {
  assert.equal(snapshotOf(100_000).calculationVersion, 'phase2.1')
})

// ── Versioning across a reopen ──────────────────────────────────────────────

test('reopening preserves version one and version two carries the NEW facts', () => {
  // v1: $1,000 net.
  const v1 = { ...snapshotOf(100_000), version: 1, supersededAt: null as Date | null }
  const v1Before = allocationFromSnapshot(v1)

  // Reopened; a late $175 of profit is recognized. v1 is SUPERSEDED, not edited.
  v1.supersededAt = new Date()
  const v2 = { ...snapshotOf(117_500), version: 2, supersededAt: null as Date | null }

  assert.deepEqual(allocationFromSnapshot(v1), v1Before)
  assert.equal(lineFor(allocationFromSnapshot(v1), 'Diego allocation').amountCents, 30_000)
  assert.equal(lineFor(allocationFromSnapshot(v2), 'Diego allocation').amountCents, 35_250)
  assert.equal(v1.version, 1)
  assert.equal(v2.version, 2)
  assert.notEqual(v1.supersededAt, null)
  assert.equal(v2.supersededAt, null)
})

// ── Reporting: finalized reads the snapshot, provisional reads live ─────────

const figures = (net: number, extra: Partial<NonNullable<MoveFinancialRow['snapshot']>> = {}) => {
  const v = allocate(net)
  return {
    netBilledRevenueCents: 200_000, netCollectedRevenueCents: 200_000, outstandingBalanceCents: 0,
    directJobCostCents: 200_000 - net, crewLaborCents: 0, ownerEconomicLaborCents: 0,
    allocatedOverheadCents: 0, cashGrossProfitCents: net, economicProfitCents: net,
    companyNetProfitCents: net, economicNetProfitCents: net, taxReserveCents: 0,
    businessReserveCents: 0, retainedEarningsCents: 0,
    distributableProfitCents: v.ownerDistributableCents,
    businessRetainedCents: v.businessRetainedCents,
    businessRetainedBp: v.businessRetainedBp,
    roundingRemainderCents: v.roundingRemainderCents,
    ownerAllocations: v.lines.filter((l) => !l.isBusiness).map((l) => ({
      owner: l.label.replace(' allocation', '').toUpperCase(), amountCents: l.amountCents, percentBp: 5000,
    })),
    ...extra,
  }
}

test('a FINALIZED move reports its snapshot, never the live recomputation', () => {
  const row: MoveFinancialRow = {
    bookingId: 'b1',
    isFinalized: true,
    snapshot: figures(100_000),
    // Live figures have since drifted — rates changed, an expense was added.
    provisional: figures(20_000),
  }
  const picked = selectMoveFigures(row, 'COMBINED')
  assert.equal(picked?.companyNetProfitCents, 100_000)
  assert.equal(picked?.businessRetainedCents, 40_000)
})

test('an UNFINALIZED move reports the live provisional calculation', () => {
  const row: MoveFinancialRow = { bookingId: 'b2', isFinalized: false, snapshot: null, provisional: figures(50_000) }
  const picked = selectMoveFigures(row, 'COMBINED')
  assert.equal(picked?.companyNetProfitCents, 50_000)
})

test('changing live configuration does not alter FINALIZED report totals', () => {
  const finalized: MoveFinancialRow = { bookingId: 'b1', isFinalized: true, snapshot: figures(100_000), provisional: null }
  const before = aggregateMoves([finalized], 'FINALIZED_ONLY')

  // Simulate the whole world moving: the retained share, the owner split and
  // the owner labor rates all change, so every LIVE figure would be different.
  const afterConfigChange: MoveFinancialRow = {
    ...finalized,
    provisional: figures(10_000), // what a live recomputation would now say
  }
  const after = aggregateMoves([afterConfigChange], 'FINALIZED_ONLY')

  assert.equal(after.companyNetProfitCents, before.companyNetProfitCents)
  assert.equal(after.businessRetainedCents, before.businessRetainedCents)
  assert.deepEqual(after.ownerAllocationCents, before.ownerAllocationCents)
  assert.equal(after.businessRetainedCents, 40_000)
  assert.deepEqual(after.ownerAllocationCents, { DIEGO: 30_000, SEBASTIAN: 30_000 })
})

test('period totals carry the allocation, and a mixed period is labelled provisional', () => {
  const rows: MoveFinancialRow[] = [
    { bookingId: 'a', isFinalized: true, snapshot: figures(100_000), provisional: null },
    { bookingId: 'b', isFinalized: false, snapshot: null, provisional: figures(100_000) },
  ]
  const t = aggregateMoves(rows, 'COMBINED')
  assert.equal(t.finalizedCount, 1)
  assert.equal(t.provisionalCount, 1)
  assert.equal(t.businessRetainedCents, 80_000)
  assert.deepEqual(t.ownerAllocationCents, { DIEGO: 60_000, SEBASTIAN: 60_000 })

  const v = allocationFromTotals(t)
  assert.equal(lineFor(v, 'Business retained').amountCents, 80_000)
  assert.equal(bpToPercentLabel(lineFor(v, 'Business retained').ofNetProfitBp), '40%')
  assert.equal(bpToPercentLabel(lineFor(v, 'Diego allocation').ofNetProfitBp), '30%')
})

test('a period containing a loss shows a smaller REALIZED share, never a fabricated 40%', () => {
  const rows: MoveFinancialRow[] = [
    { bookingId: 'a', isFinalized: true, snapshot: figures(100_000), provisional: null },
    { bookingId: 'b', isFinalized: true, snapshot: figures(-50_000), provisional: null },
  ]
  const t = aggregateMoves(rows, 'FINALIZED_ONLY')
  assert.equal(t.companyNetProfitCents, 50_000)
  // $400 retained against $500 of net profit is 80% realized — the honest
  // number, because the losing move allocated nothing.
  const v = allocationFromTotals(t)
  assert.equal(v.businessRetainedCents, 40_000)
  assert.equal(lineFor(v, 'Business retained').ofNetProfitBp, 8000)
})

test('a snapshot from before Stage 4 contributes zero allocation, not a guess', () => {
  const legacy = figures(100_000)
  delete (legacy as Record<string, unknown>).businessRetainedCents
  delete (legacy as Record<string, unknown>).ownerAllocations
  const t = aggregateMoves([{ bookingId: 'old', isFinalized: true, snapshot: legacy, provisional: null }], 'FINALIZED_ONLY')
  assert.equal(t.businessRetainedCents, 0)
  assert.deepEqual(t.ownerAllocationCents, {})
})

// ── Exports ─────────────────────────────────────────────────────────────────

const META: ExportMeta = {
  businessName: 'Move It Clear It', reportTitle: 'Move profitability', generatedAt: new Date('2026-07-21T12:00:00Z'),
  basisLabel: 'Cash basis - finalized moves only', periodLabel: 'July 2026', currency: 'USD', recordCount: 1,
}

test('the export fields carry every required 40/30/30 value', () => {
  const f = allocationExportFields(allocate(117_500), { basis: 'FINALIZED', snapshotVersion: 2 })
  assert.equal(f.companyNetProfit, 1175)
  assert.equal(f.businessRetainedBp, 4000)
  assert.equal(f.businessRetainedPercent, '40%')
  assert.equal(f.businessRetained, 470)
  assert.equal(f.diegoPercent, '30%')
  assert.equal(f.diegoAllocation, 352.5)
  assert.equal(f.sebastianPercent, '30%')
  assert.equal(f.sebastianAllocation, 352.5)
  assert.equal(f.roundingRemainder, 0)
  assert.equal(f.allocationStatus, 'Finalized')
  assert.equal(f.snapshotVersion, 2)
})

test('a provisional export says Provisional rather than leaving it blank', () => {
  const f = allocationExportFields(allocate(100_000), { basis: 'PROVISIONAL' })
  assert.equal(f.allocationStatus, 'Provisional')
  assert.equal(f.snapshotVersion, '')
})

test('every profit report’s columns include the whole 40/30/30 block', () => {
  const required = ALLOCATION_EXPORT_COLUMNS.map((c) => c.key)
  for (const report of ['overview', 'profit-loss', 'moves', 'revenue-profit', 'customers', 'marketing'] as const) {
    const keys = REPORT_COLUMNS[report].map((c) => c.key)
    for (const k of required) {
      assert.ok(keys.includes(k), `${report} export is missing ${k}`)
    }
  }
})

test('allocation money columns are OWNER-only', () => {
  const managerColumns = visibleColumns(REPORT_COLUMNS.moves, 'MANAGER').map((c) => c.key)
  assert.ok(!managerColumns.includes('diegoAllocation'))
  assert.ok(!managerColumns.includes('sebastianAllocation'))
  assert.ok(!managerColumns.includes('businessRetained'))
  assert.ok(!managerColumns.includes('companyNetProfit'))
})

test('no allocation column is a restricted field', () => {
  for (const report of ['overview', 'profit-loss', 'moves', 'revenue-profit', 'customers', 'marketing'] as const) {
    assert.equal(assertNoForbiddenKeys(REPORT_COLUMNS[report]).ok, true)
  }
})

test('a CSV export contains the allocation values', () => {
  const columns = visibleColumns(REPORT_COLUMNS.moves, 'OWNER')
  const row = { bookingReference: 'WMIC-1001', ...allocationExportFields(allocate(117_500), { basis: 'FINALIZED', snapshotVersion: 1 }) }
  const csv = toCsv(columns, [row], META)
  assert.match(csv, /Business retained %/)
  assert.match(csv, /Diego allocation/)
  assert.match(csv, /Sebastian allocation/)
  assert.match(csv, /470/)
  assert.match(csv, /352\.5/)
  assert.match(csv, /Finalized/)
})

test('formula-injection protection still applies to every cell', () => {
  assert.equal(sanitizeCell('=HYPERLINK("http://evil","click")'), "'=HYPERLINK(\"http://evil\",\"click\")")
  assert.equal(sanitizeCell(' \t=cmd'), "' \t=cmd")
  const csv = toCsv(visibleColumns(REPORT_COLUMNS.moves, 'OWNER'), [{ customerName: '=cmd|calc', ...allocationExportFields(allocate(100_000), { basis: 'FINALIZED' }) }], META)
  assert.ok(csv.includes("'=cmd|calc"))
})

test('a PDF export is a real PDF and contains the allocation', () => {
  const columns = visibleColumns(REPORT_COLUMNS.moves, 'OWNER')
  const row = { bookingReference: 'WMIC-1001', ...allocationExportFields(allocate(117_500), { basis: 'FINALIZED', snapshotVersion: 1 }) }
  const pdf = toPdf(columns, [row], META).toString('latin1')
  assert.ok(pdf.startsWith('%PDF-1.4'))
  assert.ok(pdf.trimEnd().endsWith('%%EOF'))
  assert.match(pdf, /\/Type \/Catalog/)
  assert.match(pdf, /xref/)
  assert.match(pdf, /startxref/)
  assert.match(pdf, /Diego allocation: 352\.5/)
  assert.match(pdf, /Business retained %: 40%/)
})

test('the PDF cross-reference offsets point at real objects', () => {
  const pdf = toPdf(visibleColumns(REPORT_COLUMNS.moves, 'OWNER'), [{ bookingReference: 'X' }], META).toString('latin1')
  const xrefAt = Number(pdf.slice(pdf.lastIndexOf('startxref') + 9).trim().split('\n')[0])
  assert.equal(pdf.slice(xrefAt, xrefAt + 4), 'xref')
  const offsets = Array.from(pdf.matchAll(/^(\d{10}) 00000 n $/gm)).map((m) => Number(m[1]))
  assert.ok(offsets.length >= 4)
  offsets.forEach((off, i) => {
    assert.match(pdf.slice(off, off + 12), new RegExp(`^${i + 1} 0 obj`), `object ${i + 1} offset is wrong`)
  })
})

test('an empty report still produces a valid PDF', () => {
  const pdf = toPdf(visibleColumns(REPORT_COLUMNS.moves, 'OWNER'), [], META).toString('latin1')
  assert.ok(pdf.startsWith('%PDF-1.4'))
  // Parentheses inside a PDF string are escaped, which is itself the proof that
  // the text went through the escaper rather than straight into the stream.
  assert.match(pdf, /\(\\\(no records\\\)\) Tj/)
})

// ── The presentation rule ───────────────────────────────────────────────────

test('the explanation is attached to every view, so no surface can drop it', () => {
  assert.equal(allocate(100_000).explanation, ALLOCATION_EXPLANATION)
  assert.equal(allocationFromSnapshot(snapshotOf(100_000)).explanation, ALLOCATION_EXPLANATION)
  assert.equal(allocationFromTotals({
    companyNetProfitCents: 100_000, businessRetainedCents: 40_000, roundingRemainderCents: 0,
    distributableProfitCents: 60_000, ownerAllocationCents: { DIEGO: 30_000, SEBASTIAN: 30_000 },
  }).explanation, ALLOCATION_EXPLANATION)
})

test('the explanation states the 60% the owners actually divide', () => {
  assert.match(ALLOCATION_EXPLANATION, /business retains 40%/i)
  assert.match(ALLOCATION_EXPLANATION, /30% of total final profit/i)
})
