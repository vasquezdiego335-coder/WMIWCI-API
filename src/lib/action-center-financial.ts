// ============================================================================
// action-center-financial.ts — wiring the Phase 2 closeout rules into the live
// Action Center (Stage 3, owner spec 2026-07-20).
//
// Phase 2 defined the blockers but never surfaced them. This turns each one into
// a deterministic Reminder candidate that the existing reminder-sync diff engine
// can create, dedupe and auto-resolve.
//
// DEDUPE: every candidate carries a stable `dedupeKey` of
// `<rule>:booking:<id>`. Re-running the scan on an unchanged condition is a
// no-op, and when the condition clears the candidate simply stops being
// produced — reminder-sync resolves the orphan. That is what makes "resolved
// automatically when the underlying condition is fixed" true rather than a
// promise.
//
// Pure functions, offline-tested.
// ============================================================================

export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO'

export interface FinancialActionCandidate {
  dedupeKey: string
  rule: string
  title: string
  description: string
  severity: Severity
  category: 'FINANCIAL' | 'CUSTOMER_BALANCE' | 'CREW_PAYROLL' | 'DATA_QUALITY' | 'LEADS'
  /** Deep link straight to the section that fixes it. */
  sourceUrl: string
  bookingId?: string | null
  dueAt?: Date | null
}

export interface CloseoutActionInput {
  bookingId: string
  bookingReference: string | null
  customerName: string
  status: string
  completedAt?: Date | null
  isFinalized: boolean
  reopenedAt?: Date | null
  /** Blocker codes currently active on the move (Phase 2). */
  blockerCodes: string[]
  /** Codes an owner has already overridden — these must NOT alert again. */
  overriddenCodes: string[]
  canFinalize: boolean
  submittedForReview: boolean
  companyNetProfitCents: number | null
  marginBp: number | null
  outstandingBalanceCents: number
  unpaidLaborCents: number
  ownerReimbursementOwedCents: number
  pendingDistributionCents: number
  /** Estimate variance severity from estimate-variance.ts. */
  estimateSeverity?: 'OK' | 'NOTICE' | 'WARNING' | null
  /** Attribution resolved to UNKNOWN/DIRECT. */
  marketingSourceUnknown: boolean
  /** Target margin in basis points. */
  targetMarginBp: number
  /** Days after completion before an unclosed move escalates. */
  closeoutGraceDays: number
  now: Date
}

const daysSince = (from: Date | null | undefined, now: Date): number | null =>
  from ? Math.floor((now.getTime() - from.getTime()) / 86_400_000) : null

/** Blocker code → how it should look in the Action Center. */
const BLOCKER_RULES: Record<string, { rule: string; severity: Severity; section: string; category: FinancialActionCandidate['category'] }> = {
  NO_PAYMENT_DATA: { rule: 'closeout-missing-payment', severity: 'CRITICAL', section: 'revenue', category: 'FINANCIAL' },
  UNKNOWN_REFUND_AMOUNT: { rule: 'closeout-unknown-refund', severity: 'CRITICAL', section: 'refunds', category: 'FINANCIAL' },
  REFUND_EXCEEDS_PAYMENT: { rule: 'closeout-refund-exceeds-payment', severity: 'CRITICAL', section: 'payments', category: 'FINANCIAL' },
  LABOR_NOT_APPROVED: { rule: 'closeout-labor-unapproved', severity: 'HIGH', section: 'labor', category: 'CREW_PAYROLL' },
  LABOR_MISSING: { rule: 'closeout-labor-missing', severity: 'HIGH', section: 'labor', category: 'CREW_PAYROLL' },
  LABOR_MISSING_CLOCK_OUT: { rule: 'closeout-missing-clock-out', severity: 'HIGH', section: 'labor', category: 'CREW_PAYROLL' },
  LABOR_MISSING_RATE: { rule: 'closeout-missing-rate', severity: 'HIGH', section: 'labor', category: 'CREW_PAYROLL' },
  TRUCK_SOURCE_MISSING: { rule: 'closeout-truck-source-missing', severity: 'MEDIUM', section: 'truck', category: 'DATA_QUALITY' },
  TRUCK_COST_MISSING: { rule: 'closeout-truck-cost-missing', severity: 'MEDIUM', section: 'truck', category: 'FINANCIAL' },
  RECEIPT_MISSING: { rule: 'closeout-receipt-missing', severity: 'MEDIUM', section: 'receipts', category: 'DATA_QUALITY' },
  EXPENSES_PENDING_REVIEW: { rule: 'closeout-expenses-pending', severity: 'LOW', section: 'expenses', category: 'DATA_QUALITY' },
  OPEN_DISPUTE: { rule: 'closeout-open-dispute', severity: 'HIGH', section: 'refunds', category: 'FINANCIAL' },
  OUTSTANDING_BALANCE: { rule: 'closeout-outstanding-balance', severity: 'HIGH', section: 'revenue', category: 'CUSTOMER_BALANCE' },
  OWNER_REIMBURSEMENT_PENDING: { rule: 'closeout-reimbursement-pending', severity: 'MEDIUM', section: 'reimbursements', category: 'FINANCIAL' },
  ALLOCATION_EXCEEDS_PROFIT: { rule: 'closeout-allocation-exceeds-profit', severity: 'CRITICAL', section: 'split', category: 'FINANCIAL' },
  RESERVES_EXCEED_PROFIT: { rule: 'closeout-reserves-exceed-profit', severity: 'CRITICAL', section: 'reserves', category: 'FINANCIAL' },
}

const money = (c: number) => `$${(Math.round(c) / 100).toFixed(2)}`

/**
 * Every financial action for ONE move.
 *
 * A blocker an owner has already overridden produces NOTHING — re-alerting on a
 * documented decision is how people learn to ignore the Action Center.
 */
export function financialActionsForMove(i: CloseoutActionInput): FinancialActionCandidate[] {
  const out: FinancialActionCandidate[] = []
  const who = i.bookingReference ? `${i.customerName} (${i.bookingReference})` : i.customerName
  const url = (section: string) => `/admin/jobs/${i.bookingId}#closeout-${section}`
  const overridden = new Set(i.overriddenCodes)

  const push = (c: Omit<FinancialActionCandidate, 'dedupeKey' | 'bookingId'>) =>
    out.push({ ...c, dedupeKey: `${c.rule}:booking:${i.bookingId}`, bookingId: i.bookingId })

  // A finalized move raises nothing except a reopen notice — its problems are
  // resolved or documented by definition.
  if (i.isFinalized) {
    if (i.reopenedAt) {
      push({
        rule: 'closeout-reopened', title: `${who}: finalized move was reopened`,
        description: 'This move was reopened after finalization. Finalize it again once the corrections are recorded.',
        severity: 'MEDIUM', category: 'FINANCIAL', sourceUrl: url('status'),
      })
    }
    if (i.pendingDistributionCents > 0) {
      push({
        rule: 'distribution-pending', title: `${who}: owner distribution pending`,
        description: `${money(i.pendingDistributionCents)} is approved but not yet paid out.`,
        severity: 'LOW', category: 'FINANCIAL', sourceUrl: url('split'),
      })
    }
    return out
  }

  // ── Blocker-derived actions ──
  for (const code of i.blockerCodes) {
    if (overridden.has(code)) continue
    const meta = BLOCKER_RULES[code]
    if (!meta) continue
    let description: string
    switch (code) {
      case 'OUTSTANDING_BALANCE':
        description = `${money(i.outstandingBalanceCents)} is still owed by the customer. Collect it or write it off with a reason.`
        break
      case 'OWNER_REIMBURSEMENT_PENDING':
        description = `${money(i.ownerReimbursementOwedCents)} is owed back to an owner and is held out of distributable profit.`
        break
      default:
        description = `${code.replace(/_/g, ' ').toLowerCase()} — open the closeout to resolve it.`
    }
    push({
      rule: meta.rule,
      title: `${who}: ${meta.rule.replace('closeout-', '').replace(/-/g, ' ')}`,
      description,
      severity: meta.severity,
      category: meta.category,
      sourceUrl: url(meta.section),
    })
  }

  // ── Lifecycle actions ──
  const age = daysSince(i.completedAt, i.now)
  if (i.status === 'COMPLETED' && age != null && age >= i.closeoutGraceDays) {
    push({
      rule: 'move-not-closed-out',
      title: `${who}: completed ${age} days ago and not financially closed`,
      description: 'Finish the financial closeout so this move counts correctly in company reporting.',
      severity: age >= i.closeoutGraceDays * 3 ? 'HIGH' : 'MEDIUM',
      category: 'FINANCIAL',
      sourceUrl: url('status'),
    })
  }
  if (i.canFinalize && !i.submittedForReview) {
    push({
      rule: 'closeout-ready-to-finalize', title: `${who}: ready to finalize`,
      description: 'Every blocker is resolved. Finalize the move to lock its financial record.',
      severity: 'LOW', category: 'FINANCIAL', sourceUrl: url('status'),
    })
  }
  if (i.submittedForReview && i.canFinalize) {
    push({
      rule: 'closeout-ready-for-owner-review', title: `${who}: awaiting owner review`,
      description: 'The closeout was submitted and is waiting for an owner to finalize it.',
      severity: 'MEDIUM', category: 'FINANCIAL', sourceUrl: url('status'),
    })
  }

  // ── Profitability ──
  if (i.companyNetProfitCents != null && i.companyNetProfitCents < 0) {
    push({
      rule: 'move-lost-money', title: `${who}: move lost money (${money(i.companyNetProfitCents)})`,
      description: 'Review the labor, truck and expense costs against what was charged before pricing a similar move.',
      severity: 'HIGH', category: 'FINANCIAL', sourceUrl: url('profit'),
    })
  } else if (i.marginBp != null && i.marginBp < i.targetMarginBp) {
    push({
      rule: 'move-margin-below-target',
      title: `${who}: margin ${(i.marginBp / 100).toFixed(1)}% below target`,
      description: `Company net margin is under the ${(i.targetMarginBp / 100).toFixed(0)}% target for this move.`,
      severity: 'LOW', category: 'FINANCIAL', sourceUrl: url('profit'),
    })
  }

  if (i.unpaidLaborCents > 0) {
    push({
      rule: 'labor-payment-pending', title: `${who}: ${money(i.unpaidLaborCents)} of crew pay outstanding`,
      description: 'Approved labor has not been paid. It is held back from distributable profit until it is.',
      severity: 'MEDIUM', category: 'CREW_PAYROLL', sourceUrl: url('labor'),
    })
  }
  if (i.estimateSeverity === 'WARNING') {
    push({
      rule: 'estimate-significantly-off', title: `${who}: estimate was significantly off`,
      description: 'Actual time or cost differed materially from the estimate. Review before quoting a similar move.',
      severity: 'LOW', category: 'DATA_QUALITY', sourceUrl: url('profit'),
    })
  }
  if (i.marketingSourceUnknown) {
    push({
      rule: 'lead-source-unknown', title: `${who}: no marketing source recorded`,
      description: 'This move cannot be credited to any campaign, so marketing profitability is incomplete.',
      severity: 'LOW', category: 'LEADS', sourceUrl: `/admin/jobs/${i.bookingId}`,
    })
  }

  return out
}

// ── Company-level actions ───────────────────────────────────────────────────

export interface CampaignActionInput {
  campaignId: string
  name: string
  status: string
  hasSpendRecorded: boolean
  attributedBookings: number
}

export function financialActionsForCampaign(c: CampaignActionInput): FinancialActionCandidate[] {
  const out: FinancialActionCandidate[] = []
  if (['ACTIVE', 'COMPLETED'].includes(c.status) && !c.hasSpendRecorded) {
    out.push({
      dedupeKey: `campaign-missing-spend:campaign:${c.campaignId}`,
      rule: 'campaign-missing-spend',
      title: `${c.name}: no marketing spend recorded`,
      description: 'Return on ad spend cannot be calculated for this campaign until its cost is recorded.',
      severity: c.attributedBookings > 0 ? 'MEDIUM' : 'LOW',
      category: 'LEADS',
      sourceUrl: `/admin/marketing/${c.campaignId}`,
      bookingId: null,
    })
  }
  return out
}

/**
 * Collapse candidates by dedupeKey, keeping the most severe.
 * Two rules can legitimately describe the same underlying problem; the owner
 * should see it once.
 */
const SEVERITY_ORDER: Severity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']

export function dedupeActions(candidates: FinancialActionCandidate[]): FinancialActionCandidate[] {
  const byKey = new Map<string, FinancialActionCandidate>()
  for (const c of candidates) {
    const existing = byKey.get(c.dedupeKey)
    if (!existing || SEVERITY_ORDER.indexOf(c.severity) < SEVERITY_ORDER.indexOf(existing.severity)) {
      byKey.set(c.dedupeKey, c)
    }
  }
  return Array.from(byKey.values()).sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity))
}

/**
 * Which existing reminders should auto-resolve: any financial reminder whose
 * condition no longer produces a candidate. This is the mechanism behind
 * "resolved automatically when the underlying condition is fixed".
 */
export function resolvedKeys(existingKeys: string[], currentCandidates: FinancialActionCandidate[]): string[] {
  const live = new Set(currentCandidates.map((c) => c.dedupeKey))
  return existingKeys.filter((k) => !live.has(k))
}
