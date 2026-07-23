// ════════════════════════════════════════════════════════════════════════
//  EMAIL CAMPAIGN LIFECYCLE (owner spec 2026-07-21)
//  ---------------------------------------------------------------------
//  An email campaign is a `MarketingCampaign` with `channel = EMAIL` plus a 1:1
//  `EmailCampaignConfig`. There is deliberately NO second campaign record: the
//  same row a door hanger uses carries the name, source key, status and spend,
//  so every channel is reported by one attribution system.
//
//  THE RULE THAT SHAPES EVERYTHING HERE: a campaign never sends because someone
//  created it. Reaching a sendable state requires, in order —
//
//      DRAFT → VALIDATING → READY → (owner approval) → SCHEDULED → ACTIVE
//
//  — and the approval step is a separate action by a human with the
//  `email.manage_campaign` permission. Creation and dispatch are not the same
//  event, and no transition here collapses them.
//
//  Pure functions: the state machine and the validator take data and return
//  verdicts. Nothing in this module sends anything.
// ════════════════════════════════════════════════════════════════════════

import { templateByKey } from './email-registry'
import { isSafeUrl } from '../emails/validation'
import { businessPostalAddress } from './marketing-context'
import { validateAudienceDefinition, type AudienceDefinition } from './email-audience'

export type CampaignState =
  | 'DRAFT'
  | 'VALIDATING'
  | 'READY'
  | 'SCHEDULED'
  | 'ACTIVE'
  | 'PAUSED'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'FAILED'
  | 'ARCHIVED'

/**
 * Legal transitions. Everything absent from this table is refused — including
 * the tempting DRAFT → ACTIVE shortcut, which is exactly the "created it, so it
 * sent" failure this state machine exists to prevent.
 */
const TRANSITIONS: Record<CampaignState, CampaignState[]> = {
  DRAFT: ['VALIDATING', 'CANCELLED', 'ARCHIVED'],
  VALIDATING: ['READY', 'DRAFT', 'FAILED', 'CANCELLED'],
  // READY means "validated and approved". Scheduling is the next deliberate act.
  READY: ['SCHEDULED', 'DRAFT', 'CANCELLED'],
  SCHEDULED: ['ACTIVE', 'PAUSED', 'CANCELLED', 'FAILED'],
  ACTIVE: ['PAUSED', 'COMPLETED', 'FAILED'],
  PAUSED: ['ACTIVE', 'CANCELLED', 'COMPLETED'],
  // Terminal states. A finished campaign is history; re-running it means
  // creating a new one, so the record of what was sent stays intact.
  COMPLETED: ['ARCHIVED'],
  CANCELLED: ['ARCHIVED'],
  FAILED: ['DRAFT', 'ARCHIVED'],
  ARCHIVED: [],
}

/** States in which a campaign may put mail in front of a real customer. */
export const SENDING_STATES: CampaignState[] = ['SCHEDULED', 'ACTIVE']

export const isCampaignState = (v: unknown): v is CampaignState =>
  typeof v === 'string' && Object.prototype.hasOwnProperty.call(TRANSITIONS, v)

export type TransitionResult = { ok: true } | { ok: false; error: string }

export function canTransition(from: CampaignState, to: CampaignState): TransitionResult {
  if (!isCampaignState(from)) return { ok: false, error: `Unknown current state "${from}".` }
  if (!isCampaignState(to)) return { ok: false, error: `Unknown target state "${to}".` }
  if (from === to) return { ok: false, error: `The campaign is already ${from}.` }
  if (!TRANSITIONS[from].includes(to)) {
    return {
      ok: false,
      error: `A campaign cannot go from ${from} to ${to}. Allowed from ${from}: ${TRANSITIONS[from].join(', ') || 'nothing — this is a terminal state'}.`,
    }
  }
  return { ok: true }
}

export const allowedTransitions = (from: CampaignState): CampaignState[] => TRANSITIONS[from] ?? []

// ── Validation ──────────────────────────────────────────────────────────

export type CampaignSpec = {
  name: string
  sourceKey: string
  template: string
  subject?: string | null
  audienceDefinition?: unknown
  scheduledAt?: Date | string | null
  approvedAt?: Date | string | null
  utmSource?: string | null
  utmMedium?: string | null
  utmCampaign?: string | null
  utmContent?: string | null
  discountCode?: string | null
}

export type CampaignValidation = {
  ok: boolean
  errors: string[]
  warnings: string[]
  checkedAt: string
}

/**
 * Everything that must be true before a campaign may be approved.
 *
 * ERRORS block. WARNINGS do not — they are things an owner should see but may
 * legitimately accept (a promotional template with no discount code, say).
 * The distinction matters: a validator that blocks on preferences trains people
 * to bypass it.
 */
export function validateCampaign(spec: CampaignSpec): CampaignValidation {
  const errors: string[] = []
  const warnings: string[] = []

  if (!spec.name?.trim()) errors.push('The campaign needs a name.')
  if (!spec.sourceKey?.trim()) {
    errors.push('A source key is required — it is how attributed bookings are found later.')
  } else if (!/^[A-Za-z0-9_-]{2,80}$/.test(spec.sourceKey.trim())) {
    errors.push('The source key may contain only letters, numbers, hyphens and underscores.')
  }

  const template = templateByKey(spec.template)
  if (!template) {
    errors.push(
      `"${spec.template}" is not a registered template. Campaigns may only send approved templates — arbitrary HTML is never accepted.`
    )
  } else {
    if (template.emailClass === 'transactional') {
      errors.push(
        `${template.name} is a TRANSACTIONAL template. It tells a customer about a booking they already made, so it cannot be broadcast to an audience.`
      )
    }
    // A promotional campaign needs the compliance block to exist at all.
    if (template.emailClass === 'promotional' && !businessPostalAddress()) {
      errors.push(
        'BUSINESS_POSTAL_ADDRESS is unset. Every promotional send would be blocked by the compliance gate, so this campaign cannot go out.'
      )
    }
    if (template.flag && process.env[template.flag] !== 'true') {
      warnings.push(`${template.flag} is off in this environment, so this template is not currently sending.`)
    }
  }

  const appUrl = process.env.APP_URL?.trim()
  if (!appUrl) {
    errors.push('APP_URL is unset, so no unsubscribe link can be built and every promotional send would be blocked.')
  } else if (!isSafeUrl(appUrl)) {
    errors.push(`APP_URL (${appUrl}) fails the production URL gate.`)
  }

  if (spec.audienceDefinition === undefined || spec.audienceDefinition === null) {
    errors.push('A campaign needs an audience. Previewing one is not enough — it must be attached.')
  } else {
    const audience = validateAudienceDefinition(spec.audienceDefinition)
    if (!audience.ok) errors.push(...audience.errors.map((e) => `Audience: ${e}`))
  }

  if (spec.subject && spec.subject.length > 150) warnings.push('The subject is long and will be truncated in most inboxes.')

  if (spec.scheduledAt) {
    const when = new Date(spec.scheduledAt)
    if (Number.isNaN(when.getTime())) {
      errors.push('The scheduled time is not a valid date.')
    } else if (when.getTime() < Date.now() - 60_000) {
      errors.push('The scheduled time is in the past.')
    }
  }

  if (!spec.utmSource && !spec.utmCampaign) {
    warnings.push('No UTM values set. Clicks from this campaign will be harder to attribute to a booking.')
  }

  return { ok: errors.length === 0, errors, warnings, checkedAt: new Date().toISOString() }
}

/**
 * May this campaign be approved right now?
 *
 * Approval is separated from validation on purpose. Validation asks "is this
 * well-formed?"; approval asks "does a human with authority accept sending it?"
 * A campaign that validates is still not one that may send.
 */
export function canApprove(state: CampaignState, validation: CampaignValidation | null): TransitionResult {
  if (state !== 'VALIDATING' && state !== 'READY') {
    return { ok: false, error: `Only a validated campaign can be approved. This one is ${state}.` }
  }
  if (!validation) return { ok: false, error: 'Run validation before approving.' }
  if (!validation.ok) {
    return { ok: false, error: `Validation is failing: ${validation.errors.join(' ')}` }
  }
  const age = Date.now() - new Date(validation.checkedAt).getTime()
  // A stale pass is not a pass. Configuration, suppression and the audience all
  // move; approving on a week-old check would approve a different campaign.
  if (age > 24 * 60 * 60 * 1000) {
    return { ok: false, error: 'The last validation is more than 24 hours old. Re-validate before approving.' }
  }
  return { ok: true }
}

/** May this campaign dispatch to real people right now? */
export function canDispatch(input: {
  state: CampaignState
  approvedAt: Date | null
  scheduledAt: Date | null
  now?: Date
}): TransitionResult {
  const now = input.now ?? new Date()
  if (!SENDING_STATES.includes(input.state)) {
    return { ok: false, error: `A campaign in ${input.state} does not dispatch.` }
  }
  if (!input.approvedAt) return { ok: false, error: 'The campaign has not been approved by an owner.' }
  if (input.scheduledAt && input.scheduledAt.getTime() > now.getTime()) {
    return { ok: false, error: `Scheduled for ${input.scheduledAt.toISOString()}, which has not arrived.` }
  }
  return { ok: true }
}

/** UTM values a campaign stamps on its links, for the click-to-booking chain. */
export function campaignUtm(spec: CampaignSpec): Record<string, string> {
  const out: Record<string, string> = {}
  if (spec.utmSource) out.utm_source = spec.utmSource
  if (spec.utmMedium) out.utm_medium = spec.utmMedium
  if (spec.utmCampaign) out.utm_campaign = spec.utmCampaign
  if (spec.utmContent) out.utm_content = spec.utmContent
  return out
}

export type { AudienceDefinition }
