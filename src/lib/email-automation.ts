// ════════════════════════════════════════════════════════════════════════
//  MARKETING AUTOMATION BUILDER (owner spec 2026-07-21)
//  ---------------------------------------------------------------------
//  An automation is: a TRIGGER, an optional approved AUDIENCE condition, and an
//  ordered list of STAGES (delay → approved template), with stop rules, caps
//  and quiet hours. It is a declarative structure, validated against an
//  explicit schema. It is NOT a scripting surface.
//
//  WHAT AN AUTOMATION CANNOT DO, structurally rather than by policy:
//   • it cannot name a trigger outside APPROVED_TRIGGERS;
//   • it cannot name a template outside the registry;
//   • it cannot send a TRANSACTIONAL template (those state a fact about a
//     specific booking; broadcasting one is how a customer gets a receipt for a
//     payment that never happened);
//   • it cannot express a condition — there is no expression field to put one
//     in, only an approved audience segment;
//   • it cannot bypass suppression, eligibility, frequency caps, the postal
//     address requirement, the unsubscribe requirement, the live booking-state
//     recheck or idempotency. It does not send anything: it schedules through
//     the same journey machinery, which sends through `guardedSend`.
//
//  VERSIONING. A definition is immutable once saved. Editing writes a NEW
//  version, and a run already in flight keeps the version that scheduled it.
//  Without that, an owner shortening a delay would silently rewrite the reason
//  an email already in the queue was scheduled when it was.
// ════════════════════════════════════════════════════════════════════════

import { templateByKey } from './email-registry'
import { validateAudienceDefinition } from './email-audience'
import { STOP_RULES, LOCKED_STOP_RULES, MIN_DELAY_MS, MAX_DELAY_MS, MAX_STAGES, type StopRuleKey } from './email-journey-config'

/** Events an automation may hang off. Each corresponds to a real signal. */
export const APPROVED_TRIGGERS = {
  lead_created: 'A lead is created',
  quote_created: 'A quote is recorded on a lead (Lead.quotedAt)',
  booking_started: 'A checkout session is created',
  booking_abandoned: 'A checkout was started and the deposit is still unpaid',
  booking_confirmed: 'A booking is approved and confirmed',
  payment_captured: 'A payment is captured',
  move_date_approaching: 'The move date is approaching',
  move_completed: 'The move is operationally complete',
  move_finalized: 'The move is financially finalized (closeout snapshot written)',
  review_eligible: 'A completed move with no review recorded',
  referral_eligible: 'A positive review with no referral ask sent',
  customer_inactive: 'No customer activity for an approved period',
} as const

export type TriggerKey = keyof typeof APPROVED_TRIGGERS

export const isTriggerKey = (v: unknown): v is TriggerKey =>
  typeof v === 'string' && Object.prototype.hasOwnProperty.call(APPROVED_TRIGGERS, v)

export const AUTOMATION_STATES = ['DRAFT', 'VALIDATING', 'TEST', 'ACTIVE', 'PAUSED', 'ARCHIVED'] as const
export type AutomationState = (typeof AUTOMATION_STATES)[number]

const AUTOMATION_TRANSITIONS: Record<AutomationState, AutomationState[]> = {
  DRAFT: ['VALIDATING', 'ARCHIVED'],
  VALIDATING: ['TEST', 'DRAFT'],
  // TEST sends only to the configured test recipient. It is the rehearsal step
  // between "valid" and "pointed at real customers".
  TEST: ['ACTIVE', 'DRAFT', 'ARCHIVED'],
  ACTIVE: ['PAUSED', 'ARCHIVED'],
  PAUSED: ['ACTIVE', 'ARCHIVED'],
  ARCHIVED: [],
}

export const isAutomationState = (v: unknown): v is AutomationState =>
  typeof v === 'string' && (AUTOMATION_STATES as readonly string[]).includes(v)

export function canTransitionAutomation(from: AutomationState, to: AutomationState): { ok: true } | { ok: false; error: string } {
  if (!isAutomationState(from)) return { ok: false, error: `Unknown state "${from}".` }
  if (!isAutomationState(to)) return { ok: false, error: `Unknown state "${to}".` }
  if (from === to) return { ok: false, error: `The automation is already ${from}.` }
  if (!AUTOMATION_TRANSITIONS[from].includes(to)) {
    return {
      ok: false,
      error: `An automation cannot go from ${from} to ${to}. Allowed: ${AUTOMATION_TRANSITIONS[from].join(', ') || 'nothing — ARCHIVED is terminal'}.`,
    }
  }
  return { ok: true }
}

export type AutomationStage = {
  /** Ordinal label used for the stable queue job id. */
  key: string
  template: string
  delayMs: number
}

export type AutomationDefinition = {
  trigger: TriggerKey
  /** Optional approved audience narrowing. Never a free-form condition. */
  audience: unknown | null
  stages: AutomationStage[]
  stopRules: Record<StopRuleKey, boolean>
  caps: { perRecipientPerMonth: number }
  respectQuietHours: boolean
  maxStages: number
}

export type AutomationValidation =
  | { ok: true; definition: AutomationDefinition; warnings: string[] }
  | { ok: false; errors: string[] }

/**
 * Validate a definition from ANY source — an API body or a stored version row.
 * Stored versions are validated on read for the same reason journey configs
 * are: a row that became invalid must not run.
 */
export function validateAutomationDefinition(raw: unknown): AutomationValidation {
  const errors: string[] = []
  const warnings: string[] = []

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['An automation definition must be an object.'] }
  }
  const input = raw as Record<string, unknown>

  if (!isTriggerKey(input.trigger)) {
    return {
      ok: false,
      errors: [`Unknown trigger "${String(input.trigger)}". Approved triggers: ${Object.keys(APPROVED_TRIGGERS).join(', ')}.`],
    }
  }

  // Audience is optional, but if present it must be an APPROVED segment.
  let audience: unknown = null
  if (input.audience !== undefined && input.audience !== null) {
    const a = validateAudienceDefinition(input.audience)
    if (!a.ok) errors.push(...a.errors.map((e) => `Audience: ${e}`))
    else audience = a.definition
  }

  const maxStagesRaw = input.maxStages
  const maxStages = typeof maxStagesRaw === 'number' ? maxStagesRaw : MAX_STAGES
  if (!Number.isInteger(maxStages) || maxStages < 1 || maxStages > MAX_STAGES) {
    errors.push(`\`maxStages\` must be a whole number between 1 and ${MAX_STAGES}.`)
  }

  const stages: AutomationStage[] = []
  if (!Array.isArray(input.stages) || input.stages.length === 0) {
    errors.push('An automation needs at least one stage.')
  } else if (input.stages.length > Math.min(maxStages, MAX_STAGES)) {
    errors.push(`This automation declares ${input.stages.length} stages but allows at most ${Math.min(maxStages, MAX_STAGES)}.`)
  } else {
    for (let i = 0; i < input.stages.length; i++) {
      const rawStage = input.stages[i]
      if (!rawStage || typeof rawStage !== 'object') {
        errors.push(`Stage ${i + 1} is not an object.`)
        continue
      }
      const st = rawStage as Record<string, unknown>
      const template = typeof st.template === 'string' ? st.template : ''
      const entry = templateByKey(template)
      if (!entry) {
        errors.push(`Stage ${i + 1}: "${template}" is not a registered template.`)
        continue
      }
      // A transactional template states a fact about ONE booking. An automation
      // broadcasting one would tell people about bookings and payments that did
      // not happen to them.
      if (entry.emailClass === 'transactional') {
        errors.push(`Stage ${i + 1}: ${entry.name} is transactional and cannot be used in an automation.`)
        continue
      }
      const delayMs = typeof st.delayMs === 'number' ? st.delayMs : NaN
      if (!Number.isFinite(delayMs) || delayMs < MIN_DELAY_MS || delayMs > MAX_DELAY_MS) {
        errors.push(`Stage ${i + 1}: delay must be between 5 minutes and 180 days.`)
        continue
      }
      if (entry.flag && process.env[entry.flag] !== 'true') {
        warnings.push(`Stage ${i + 1} uses ${entry.name}, whose flag ${entry.flag} is off in this environment.`)
      }
      stages.push({ key: typeof st.key === 'string' && st.key.trim() ? st.key.trim() : `stage-${i + 1}`, template, delayMs })
    }

    for (let i = 1; i < stages.length; i++) {
      if (stages[i].delayMs <= stages[i - 1].delayMs) {
        errors.push(`Stage ${i + 1} is scheduled no later than the stage before it.`)
      }
    }
    const keys = stages.map((s) => s.key)
    if (new Set(keys).size !== keys.length) errors.push('Stage keys must be unique — they form the stable queue job id.')
  }

  // Stop rules: same fixed list, same locked entries as journey config.
  const stopRules = {} as Record<StopRuleKey, boolean>
  const rawRules = (input.stopRules ?? {}) as Record<string, unknown>
  if (typeof rawRules !== 'object' || rawRules === null || Array.isArray(rawRules)) {
    errors.push('`stopRules` must be an object.')
  } else {
    for (const key of Object.keys(rawRules)) {
      if (!(key in STOP_RULES)) errors.push(`Unknown stop rule "${key}".`)
    }
    for (const key of Object.keys(STOP_RULES) as StopRuleKey[]) {
      const v = rawRules[key]
      if (v !== undefined && typeof v !== 'boolean') {
        errors.push(`Stop rule "${key}" must be true or false.`)
        continue
      }
      stopRules[key] = LOCKED_STOP_RULES.includes(key) ? true : (v as boolean | undefined) ?? true
    }
  }

  const rawCaps = (input.caps ?? {}) as Record<string, unknown>
  const perMonth = typeof rawCaps.perRecipientPerMonth === 'number' ? rawCaps.perRecipientPerMonth : 0
  if (!Number.isInteger(perMonth) || perMonth < 0 || perMonth > 30) {
    errors.push('`caps.perRecipientPerMonth` must be a whole number between 0 and 30.')
  }

  const respectQuietHours = input.respectQuietHours
  if (respectQuietHours !== undefined && typeof respectQuietHours !== 'boolean') {
    errors.push('`respectQuietHours` must be true or false.')
  }

  if (errors.length > 0) return { ok: false, errors }

  return {
    ok: true,
    warnings,
    definition: {
      trigger: input.trigger,
      audience,
      stages,
      stopRules,
      caps: { perRecipientPerMonth: perMonth },
      // Automations are promotional by construction (transactional templates
      // are refused above), so quiet hours default ON.
      respectQuietHours: (respectQuietHours as boolean | undefined) ?? true,
      maxStages,
    },
  }
}

/**
 * May this automation move to ACTIVE — that is, start mailing real customers?
 *
 * Deliberately stricter than "is it valid": an automation must have been
 * rehearsed in TEST first. Validation proves the shape; TEST proves someone
 * looked at the resulting email.
 */
export function canActivate(input: {
  state: AutomationState
  activeVersion: number | null
  definition: unknown
}): { ok: true } | { ok: false; error: string } {
  if (input.state !== 'TEST' && input.state !== 'PAUSED') {
    return {
      ok: false,
      error:
        input.state === 'DRAFT' || input.state === 'VALIDATING'
          ? 'Validate the automation and run it in TEST mode before activating it.'
          : `An automation in ${input.state} cannot be activated.`,
    }
  }
  if (input.activeVersion == null) return { ok: false, error: 'No saved version to activate.' }
  const v = validateAutomationDefinition(input.definition)
  if (!v.ok) return { ok: false, error: `The stored definition is invalid: ${v.errors.join(' ')}` }
  return { ok: true }
}

/**
 * Stable queue job id for one stage of one automation run.
 *
 * The VERSION is part of the id. That is what keeps a run reproducible: a
 * re-fired trigger under the same version replaces its own job rather than
 * duplicating it, while a new version schedules a distinguishable job instead
 * of silently overwriting one made under different rules.
 */
export function automationJobId(automationId: string, version: number, stageKey: string, subjectId: string): string {
  return `automation:${automationId}:v${version}:${stageKey}:${subjectId}`
}

/** Summary line for the admin list. */
export function describeAutomation(def: AutomationDefinition): string {
  const stages = def.stages.length
  return `${APPROVED_TRIGGERS[def.trigger]} → ${stages} stage${stages === 1 ? '' : 's'}`
}
