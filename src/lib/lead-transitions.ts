// ════════════════════════════════════════════════════════════════════════
//  lead-transitions.ts — the PURE lead-pipeline state machine (Moving OS
//  Phase 1, Stage 2C). The audit found that nothing ever wrote CONTACTED /
//  FOLLOW_UP / LOST / contactedAt / lostReason / assignedTo, so open leads
//  silted up forever. This module is the single rulebook the admin PATCH
//  route applies; keeping it pure (no prisma, no I/O) makes every transition
//  offline-testable (lead-transitions.test.ts).
//
//  HARD RULE: BOOKED is NEVER settable by hand. The only writer of BOOKED is
//  markLeadConverted() in src/lib/leads.ts, which fires when a real booking
//  is created — a human clicking a button cannot fabricate a conversion.
// ════════════════════════════════════════════════════════════════════════
import { LeadStatus, LeadLostReason, LeadSource } from '@prisma/client'

/** Statuses considered "open" — mirrors OPEN_STATUSES in src/lib/leads.ts
 *  (kept local so this module stays import-light for offline tests). */
export const OPEN_LEAD_STATUSES: readonly LeadStatus[] = [
  LeadStatus.NEW,
  LeadStatus.CONTACTED,
  LeadStatus.QUOTE_SENT,
  LeadStatus.FOLLOW_UP,
]

export type LeadAction = 'mark_contacted' | 'set_follow_up' | 'mark_lost' | 'reopen' | 'assign'

/**
 * Which statuses each action may be applied FROM. This is the whole pipeline
 * policy in one table:
 *   mark_contacted  NEW → CONTACTED (the owner recorded a call)
 *   set_follow_up   CONTACTED/QUOTE_SENT → FOLLOW_UP (needs another touch)
 *   mark_lost       any OPEN status → LOST (reason required)
 *   reopen          LOST → NEW (loss fields cleared)
 *   assign          any status — assignment is bookkeeping, not a transition
 * No action lists BOOKED as a *destination*; see the hard rule above.
 */
export const ALLOWED_LEAD_ACTIONS: Record<LeadAction, readonly LeadStatus[]> = {
  mark_contacted: [LeadStatus.NEW],
  set_follow_up: [LeadStatus.CONTACTED, LeadStatus.QUOTE_SENT],
  mark_lost: OPEN_LEAD_STATUSES,
  reopen: [LeadStatus.LOST],
  assign: Object.values(LeadStatus),
}

export const LEAD_ACTIONS = Object.keys(ALLOWED_LEAD_ACTIONS) as LeadAction[]

/** The actions currently offered for a lead in this status (drives the detail
 *  page's action island, so the UI can never offer an illegal button). */
export function allowedActionsFor(status: LeadStatus): LeadAction[] {
  return LEAD_ACTIONS.filter((a) => ALLOWED_LEAD_ACTIONS[a].includes(status))
}

export type LeadForTransition = {
  status: LeadStatus
  /** Read so mark_contacted can be FIRST-WINS: a second click (or a re-contact
   *  after reopen) never rewrites when the first conversation happened. */
  contactedAt: Date | null
}

export type LeadActionPayload = {
  /** REQUIRED for mark_lost — a closed lead with no reason teaches nothing. */
  lostReason?: LeadLostReason | null
  /** For assign: a name/id string, or null to unassign. Must be present. */
  assignedTo?: string | null
}

export type LeadActionResult =
  | { data: Record<string, unknown>; error?: undefined }
  | { data?: undefined; error: string }

const LOST_REASONS = Object.values(LeadLostReason) as string[]

/**
 * Validate + build the prisma update patch for one pipeline action.
 * Returns { data } (never touches fields it does not own) or { error } with an
 * owner-readable message. Every successful action bumps lastActivityAt, the
 * same convention every other Lead writer follows.
 */
export function applyLeadAction(
  lead: LeadForTransition,
  action: LeadAction,
  payload: LeadActionPayload = {},
  now: Date = new Date()
): LeadActionResult {
  const allowed = ALLOWED_LEAD_ACTIONS[action]
  if (!allowed) return { error: `Unknown action "${String(action)}"` }
  if (!allowed.includes(lead.status)) {
    return { error: `Cannot ${action.replace(/_/g, ' ')} a ${lead.status.replace(/_/g, ' ').toLowerCase()} lead` }
  }

  switch (action) {
    case 'mark_contacted':
      return {
        data: {
          status: LeadStatus.CONTACTED,
          lastActivityAt: now,
          // FIRST-WINS: only stamp the first real contact time.
          ...(lead.contactedAt ? {} : { contactedAt: now }),
        },
      }
    case 'set_follow_up':
      return { data: { status: LeadStatus.FOLLOW_UP, lastActivityAt: now } }
    case 'mark_lost': {
      const reason = payload.lostReason
      if (!reason || !LOST_REASONS.includes(reason)) {
        return { error: 'A loss reason is required to mark a lead lost' }
      }
      return { data: { status: LeadStatus.LOST, lostReason: reason, lostAt: now, lastActivityAt: now } }
    }
    case 'reopen':
      // Clears the loss fields so a reopened lead reads like a live one — the
      // LOST decision remains recoverable from the LEAD_STATUS_CHANGED audit.
      return { data: { status: LeadStatus.NEW, lostReason: null, lostAt: null, lastActivityAt: now } }
    case 'assign': {
      if (payload.assignedTo === undefined) {
        return { error: 'assignedTo is required (a name, or null to unassign)' }
      }
      const trimmed = typeof payload.assignedTo === 'string' ? payload.assignedTo.trim() : null
      return { data: { assignedTo: trimmed || null, lastActivityAt: now } }
    }
  }
}

// ── Manual lead entry (POST /api/admin/leads) ────────────────────────────────

const clean = (v?: string | null): string | null => {
  const s = (v ?? '').trim()
  return s.length ? s : null
}

export type ManualLeadInput = {
  name?: string | null
  phone?: string | null
  email?: string | null
  moveDate?: Date | null
  moveSize?: string | null
  originZip?: string | null
  destinationZip?: string | null
  notes?: string | null
  serviceInterest?: string | null
}

/**
 * The row to CREATE from the owner's manual entry. Pure.
 *
 * CONSENT: manual entry NEVER grants marketing consent. The owner typing a
 * customer's email is not that customer agreeing to marketing, so all four
 * consent columns are left at their schema default (null = "never asked") —
 * the same tri-state convention as src/lib/leads.ts. serviceInterest lands in
 * jobType, mirroring buildPartialLeadCreate.
 */
export function buildManualLeadCreate(input: ManualLeadInput, now: Date) {
  // Local normalizeEmail twin of leads.ts (kept inline so this module has no
  // import beyond the prisma enums; the rule is identical).
  const e = (input.email ?? '').trim().toLowerCase()
  return {
    name: clean(input.name) ?? 'Manual lead',
    phone: clean(input.phone),
    email: e.length > 3 && e.includes('@') ? e : null,
    source: LeadSource.MANUAL_ENTRY,
    status: LeadStatus.NEW,
    moveDate: input.moveDate ?? null,
    moveSize: clean(input.moveSize),
    originZip: clean(input.originZip),
    destinationZip: clean(input.destinationZip),
    notes: clean(input.notes),
    jobType: clean(input.serviceInterest),
    lastActivityAt: now,
  }
}
