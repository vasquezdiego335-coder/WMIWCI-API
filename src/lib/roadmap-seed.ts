// ============================================================================
// Roadmap starter items (increment 2, owner spec 2026-07-13 Parts 4, 6, 7).
// Every known admin gap as a structured, dependency-aware roadmap item.
// seedKey makes seeding idempotent — the seed endpoint skips existing keys, so
// owner edits are never overwritten. NONE of these are implemented; they are
// honest planning records, not claims.
// ============================================================================

type Priority = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'
type Status = 'IDEA' | 'RESEARCHING' | 'PLANNED' | 'READY' | 'IN_PROGRESS' | 'BLOCKED' | 'COMPLETED' | 'REJECTED' | 'ARCHIVED'

export interface SeedItem {
  seedKey: string
  title: string
  summary: string
  problem?: string
  solution?: string
  benefit?: string
  risks?: string
  priority: Priority
  status: Status
  category: string // RoadmapCategory
  impact?: number
  effort?: number
  dependencies?: string
  blockers?: string
  targetIncrement?: string
  notes?: string
}

export const ROADMAP_SEED: SeedItem[] = [
  // ── FINANCIAL ARCHITECTURE (decided this increment) ─────────────────────────
  {
    seedKey: 'financial-labor-source-of-truth',
    title: 'Crew labor single source of truth (DECIDED: JobCrew payroll)',
    summary: 'Crew labor cost comes from JobCrew payroll records — never from a duplicate WORKER_PAY expense for the same labor.',
    problem: 'Crew labor could be recorded twice: once in JobCrew payroll and once as a WORKER_PAY expense, silently understating job profit.',
    solution: 'JobCrew is the single source for accrued crew labor. WORKER_PAY expenses are ONLY for helpers not in the crew system. A data-quality reminder fires when a job has both. Full definitions in docs/financial-architecture.md.',
    benefit: 'Job profit, the future P&L, and per-worker economics all agree on one labor number.',
    priority: 'CRITICAL',
    status: 'COMPLETED',
    category: 'FINANCIAL',
    impact: 5, effort: 2,
    notes: 'Decided + guarded in increment 2 (2026-07-13). Legacy audit found ZERO WORKER_PAY expenses in production, so no reconciliation was needed — the rule starts clean.',
  },
  {
    seedKey: 'financial-accrued-vs-paid-payroll',
    title: 'Separate accrued labor from payroll cash settlement',
    summary: 'Labor cost (earned on job completion) and payroll payment (cash leaving the bank) are two different events and must never both hit the P&L.',
    problem: 'If marking a worker PAID also created an expense, the same $150 of labor would reduce profit twice.',
    solution: 'Accrued labor (JobCrew) feeds job profit and the P&L once. A future payroll payment record reduces CASH only. See docs/financial-architecture.md.',
    priority: 'CRITICAL',
    status: 'PLANNED',
    category: 'FINANCIAL',
    impact: 5, effort: 3,
    dependencies: 'Crew labor single source of truth (decided)',
    targetIncrement: 'Financial foundation',
  },

  // ── CALENDAR & SCHEDULING (priority #2) ─────────────────────────────────────
  {
    seedKey: 'calendar-color-coded',
    title: 'Color-coded job calendar',
    summary: 'Daily / weekly / monthly calendar with job-status colors and direct links to jobs.',
    problem: 'Owners cannot see the week at a glance; the schedule page is a list, not a calendar.',
    benefit: 'One look answers "what is happening this week and is anything red."',
    priority: 'CRITICAL', status: 'PLANNED', category: 'SCHEDULING', impact: 5, effort: 3,
    targetIncrement: 'Calendar & Scheduling',
  },
  {
    seedKey: 'calendar-crew-availability',
    title: 'Crew availability & time off',
    summary: 'Working availability, time-off records, and assignment readiness per crew member.',
    problem: 'Nothing stops assigning a worker who is off that day.',
    priority: 'HIGH', status: 'PLANNED', category: 'SCHEDULING', impact: 4, effort: 3,
    dependencies: 'Color-coded job calendar',
    targetIncrement: 'Calendar & Scheduling',
    notes: 'An Availability table already exists in the schema (per-user, per-date) — the UI and conflict checks are what is missing.',
  },
  {
    seedKey: 'calendar-conflict-detection',
    title: 'Crew scheduling conflict detection',
    summary: 'Warn on overlapping jobs, double booking, unavailable workers, and unrealistic travel time between jobs.',
    priority: 'HIGH', status: 'PLANNED', category: 'SCHEDULING', impact: 4, effort: 3,
    dependencies: 'Crew availability & time off',
    targetIncrement: 'Calendar & Scheduling',
    notes: 'The Action Center already flags same-day overlapping crew assignments (crew-double-booked rule); the calendar version adds travel-time awareness.',
  },
  {
    seedKey: 'calendar-travel-time',
    title: 'Travel-time visualization',
    summary: 'Show time between jobs and origin-to-job distance; warn when back-to-back jobs are physically impossible.',
    priority: 'MEDIUM', status: 'IDEA', category: 'SCHEDULING', impact: 3, effort: 4,
    dependencies: 'Color-coded job calendar',
  },
  {
    seedKey: 'calendar-job-readiness',
    title: 'Job readiness checklist',
    summary: 'Per-job checklist: verified addresses, crew assigned, truck confirmed, customer confirmed, payment known, equipment known.',
    priority: 'HIGH', status: 'PLANNED', category: 'SCHEDULING', impact: 4, effort: 2,
    notes: 'The Action Center rules already detect most of these individually; the checklist is the per-job rollup view.',
    targetIncrement: 'Calendar & Scheduling',
  },

  // ── LEADS & MARKETING (priority #3) ─────────────────────────────────────────
  {
    seedKey: 'leads-pipeline-ui',
    title: 'Lead pipeline UI',
    summary: 'NEW → CONTACTED → QUOTE_SENT → FOLLOW_UP → BOOKED / LOST with list, detail, owner assignment, follow-up dates, notes, and booking linkage.',
    problem: 'The Lead table exists in the database with zero UI — leads live in heads and text messages.',
    benefit: 'No lead is forgotten; conversion rate becomes measurable.',
    priority: 'HIGH', status: 'READY', category: 'LEADS', impact: 5, effort: 3,
    notes: 'Schema shipped in increment 1. Action Center lead rules (not-contacted / follow-up overdue / lost-no-reason) activate automatically once leads exist.',
    targetIncrement: 'Leads & Marketing',
  },
  {
    seedKey: 'marketing-attribution',
    title: 'Marketing source attribution',
    summary: 'Track source / platform / campaign / referral / QR / landing page with first- and last-touch attribution and manual corrections.',
    priority: 'HIGH', status: 'PLANNED', category: 'MARKETING', impact: 4, effort: 3,
    dependencies: 'Lead pipeline UI',
    notes: 'Bookings already carry source + foundUs fields; leads carry LeadSource. The gap is the funnel view connecting them.',
  },
  {
    seedKey: 'marketing-roi',
    title: 'Marketing ROI reporting',
    summary: 'Leads / bookings / revenue by source, conversion rate, cost per lead, CAC, ROAS, profit after marketing cost.',
    risks: 'ROI from incomplete source or spend data is misleading — incomplete data must be labeled incomplete, never silently guessed.',
    priority: 'MEDIUM', status: 'PLANNED', category: 'MARKETING', impact: 4, effort: 4,
    dependencies: 'Marketing source attribution; Financial foundation (for profit-after-marketing)',
  },

  // ── PAYROLL (priority #5) ───────────────────────────────────────────────────
  {
    seedKey: 'payroll-editing-ui',
    title: 'Crew pay editing UI',
    summary: 'Edit scheduled/actual hours, hourly rate, flat pay, tips, bonuses, deductions, reimbursements, and adjustment reasons per crew per job.',
    problem: 'All payroll fields exist in the schema but can only be seen, not edited, in the admin.',
    priority: 'HIGH', status: 'READY', category: 'PAYROLL', impact: 5, effort: 3,
    dependencies: 'Crew labor single source of truth (decided)',
    targetIncrement: 'Payroll',
  },
  {
    seedKey: 'payroll-approval-workflow',
    title: 'Pay approval workflow',
    summary: 'SCHEDULED → CHECKED_IN → WORKING → COMPLETED → PAY_APPROVED → PAID with allowed-transition enforcement and approval audit.',
    priority: 'HIGH', status: 'PLANNED', category: 'PAYROLL', impact: 4, effort: 3,
    dependencies: 'Crew pay editing UI',
    notes: 'CrewPayStatus enum already exists; the workflow, transition guards, and who-approved-when audit are the gap.',
  },
  {
    seedKey: 'payroll-bulk-pay',
    title: 'Bulk pay processing',
    summary: 'Select approved payments, review totals, confirm method, record references, mark paid — with duplicate-processing prevention.',
    priority: 'MEDIUM', status: 'PLANNED', category: 'PAYROLL', impact: 4, effort: 3,
    dependencies: 'Pay approval workflow',
  },
  {
    seedKey: 'payroll-payment-records',
    title: 'Crew payment records (cash settlement)',
    summary: 'Per-payment record: crew member, job, gross/net, method, date, proof, reference, approval history. Reduces CASH — never a second labor expense.',
    priority: 'HIGH', status: 'PLANNED', category: 'PAYROLL', impact: 4, effort: 3,
    dependencies: 'Separate accrued labor from payroll cash settlement',
  },

  // ── REPORTS & FINANCIAL OVERVIEW (priority #7) ──────────────────────────────
  {
    seedKey: 'reports-pnl',
    title: 'Profit & Loss statement',
    summary: 'Recognized revenue − direct expenses − accrued crew labor − processing fees − refunds = operating profit. Owner money excluded on both sides.',
    priority: 'HIGH', status: 'READY', category: 'REPORTS', impact: 5, effort: 3,
    dependencies: 'Crew labor single source of truth (decided); Separate accrued labor from payroll cash settlement',
    notes: 'The accounting definitions are locked in docs/financial-architecture.md and guarded by tests — the report is now buildable.',
    targetIncrement: 'Financial foundation',
  },
  {
    seedKey: 'reports-revenue-breakdown',
    title: 'Revenue reporting (by month / city / service / source)',
    summary: 'Revenue broken down by month, city, service type, lead source, customer type, payment method, and job status.',
    priority: 'MEDIUM', status: 'PLANNED', category: 'REPORTS', impact: 4, effort: 3,
    dependencies: 'Profit & Loss statement',
  },
  {
    seedKey: 'reports-expense-breakdown',
    title: 'Expense reporting (by category / month / job / vendor)',
    priority: 'MEDIUM', status: 'PLANNED', category: 'REPORTS', impact: 3, effort: 2,
    summary: 'Expense breakdowns with approval and receipt status.',
    dependencies: 'Profit & Loss statement',
  },
  {
    seedKey: 'reports-job-profitability',
    title: 'Job profitability report',
    summary: 'Revenue, labor, expenses, fees, refunds, net profit, margin %, revenue and profit per worker-hour — across all jobs.',
    priority: 'HIGH', status: 'PLANNED', category: 'REPORTS', impact: 5, effort: 3,
    dependencies: 'Profit & Loss statement; Crew pay editing UI (hours must be entered to be reportable)',
  },
  {
    seedKey: 'reports-worker-economics',
    title: 'Per-worker economics',
    summary: 'Jobs worked, hours, gross pay, tips, associated revenue, labor-cost %, profit contribution per worker.',
    risks: 'Rankings without sufficient data are unfair and misleading — require minimum sample sizes and context.',
    priority: 'MEDIUM', status: 'PLANNED', category: 'REPORTS', impact: 4, effort: 3,
    dependencies: 'Job profitability report; Pay approval workflow',
  },
  {
    seedKey: 'reports-tax-reserve-forecast',
    title: 'Tax & emergency reserve forecasting',
    summary: 'Estimated taxable operating profit, suggested tax reserve, reserve gap, cash-runway estimate — all clearly labeled as estimates.',
    priority: 'MEDIUM', status: 'IDEA', category: 'REPORTS', impact: 3, effort: 3,
    dependencies: 'Profit & Loss statement',
    notes: 'BusinessConfig already stores tax reserve % and emergency reserve; the Owner Money page already computes safe-to-distribute. This item is the forward-looking forecast.',
  },
  {
    seedKey: 'reports-dashboard-financial-cards',
    title: 'Dashboard financial cards (net profit / cash available / margin)',
    summary: 'Headline net operating profit, cash available, average job margin, tax reserve, business health summary on the dashboard.',
    priority: 'HIGH', status: 'BLOCKED', category: 'REPORTS', impact: 5, effort: 2,
    blockers: 'Deliberately deferred until the P&L is implemented and verified — a wrong headline profit number is worse than none.',
    dependencies: 'Profit & Loss statement',
  },

  // ── CUSTOMER BALANCES & PAYMENTS (priority #8) ──────────────────────────────
  {
    seedKey: 'customers-balance-tracking',
    title: 'Customer balances & payment reconciliation',
    summary: 'Outstanding invoices, balance aging, overdue alerts, failed-payment retries, cash vs Stripe reconciliation, partial payments, credits, mismatch detection.',
    priority: 'HIGH', status: 'PLANNED', category: 'PAYMENTS', impact: 5, effort: 4,
    dependencies: 'Financial foundation',
    notes: 'The Action Center already flags completed-but-unpaid jobs and failed payments; this item is the full ledger view.',
    targetIncrement: 'Customer Balances & Payments',
  },

  // ── NOTIFICATIONS ───────────────────────────────────────────────────────────
  {
    seedKey: 'notifications-delivery',
    title: 'Notification delivery (Discord + admin preferences)',
    summary: 'Push the Action Center reminders outward: Discord alerts, per-owner notification preferences, digest timing.',
    priority: 'MEDIUM', status: 'PLANNED', category: 'NOTIFICATIONS', impact: 4, effort: 3,
    dependencies: 'Action Center (shipped increment 2) — it is the internal foundation these notifications deliver from.',
    notes: 'The scheduled BullMQ worker on Railway (src/workers/scheduled.worker.ts) is the natural home for a periodic reminder scan + Discord push.',
  },

  // ── DOCUMENTS ───────────────────────────────────────────────────────────────
  {
    seedKey: 'documents-system',
    title: 'Documents (templates, agreements, receipts, versions)',
    summary: 'Job/quote templates, agreements, invoices, payroll receipts, customer documents, version history, job-linked storage, signed-agreement history.',
    priority: 'LOW', status: 'IDEA', category: 'DOCUMENTS', impact: 3, effort: 4,
    notes: 'Cloudinary file storage + the File model already exist; this is the organized document layer on top.',
  },

  // ── SETTINGS ────────────────────────────────────────────────────────────────
  {
    seedKey: 'settings-page',
    title: 'Settings (users, permissions, business profile, defaults)',
    summary: 'User management, roles/permissions, business profile, service areas, pricing/tax settings, payroll defaults, expense categories, lead sources, notification preferences.',
    priority: 'MEDIUM', status: 'IDEA', category: 'SYSTEM', impact: 3, effort: 4,
    notes: 'BusinessConfig (split/reserves) shipped in increment 1 and is editable on the Owner Money page; this item is the full settings surface.',
  },

  // ── AI CEO / BUSINESS AGENT (featured future concept — Part 6) ──────────────
  {
    seedKey: 'ai-ceo-the-foreman',
    title: 'AI CEO / Business Agent — "The Foreman"',
    summary: 'A future read-only agent that reviews VERIFIED business data and delivers evidence-based briefings, warnings, and recommendations to Diego & Sebastian.',
    problem: 'Owners have to notice problems themselves. Nothing reviews the whole business daily and says "this job lost money", "this quote went cold", or "tomorrow has no crew."',
    solution: [
      'ARCHITECTURE (documented only — nothing is built or connected):',
      '1. Application code calculates factual totals (profit.ts, job-money.ts, owner-ledger.ts).',
      '2. Deterministic rules detect problems (the Action Center engine — already live).',
      '3. A language model INTERPRETS verified numbers into a daily owner briefing, weekly CEO review, and monthly business review.',
      '4. Every insight cites its evidence and links to the source record.',
      '5. Delivery through the existing Discord bot + an admin insights page, on a scheduled Railway job.',
      '',
      'EXAMPLE INSIGHTS: "This job earned an 18% margin, below target." · "This quote has not been followed up in three days." · "Tomorrow\'s job has no crew assigned." · "This customer still owes $410." · "This expense may duplicate a payroll payment."',
    ].join('\n'),
    benefit: 'A tireless second brain that criticizes the business with evidence, not vibes.',
    risks: [
      'HARD SAFEGUARDS (non-negotiable): read-only first release. It must NEVER automatically send payments, change payroll, issue refunds, change pricing, delete records, message customers, contact leads, or touch Stripe/bank data.',
      'Sensitive actions always require Diego or Sebastian approval; every approved action is audited.',
      'It must not launch until financial, payroll, lead, and operational data are reliable — an AI narrating wrong numbers confidently is worse than no AI.',
    ].join('\n'),
    priority: 'MEDIUM',
    status: 'IDEA',
    category: 'AI',
    impact: 5, effort: 5,
    dependencies: 'Profit & Loss statement; Pay approval workflow; Lead pipeline UI; Action Center (shipped)',
    notes: 'Deliberately NOT implemented in increment 2 per owner spec. No API keys, no model integration, no fake agent responses. Infra when ready: existing Railway API + Neon Postgres + Discord bot + one scheduled job + one affordable LLM API. Rules first, AI explanation second.',
  },
]
