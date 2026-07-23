// ════════════════════════════════════════════════════════════════════════
//  JOURNEY CONFIGURATION (owner spec 2026-07-21)
//  ---------------------------------------------------------------------
//  Owners can change journey delays, caps and stop rules from the admin. Three
//  properties make that safe:
//
//  1. THE CODE CONSTANTS REMAIN THE SAFE DEFAULTS. `src/lib/journeys.ts` is
//     still the source of truth for what a journey does with no configuration.
//     A missing row, a disabled row, or a row that fails validation ALL mean
//     "use the defaults" — never "send with whatever is in the database".
//
//  2. IT FAILS CLOSED. Validation runs on write and again on read. A row edited
//     directly in the database to say `delayMs: 0` on every stage does not
//     produce an instant four-email burst; it fails validation and degrades to
//     the defaults, with the reason recorded.
//
//  3. IT IS VERSIONED. `version` increments on every saved change and is
//     stamped onto sends scheduled under it (EmailSend.journeyConfigVersion).
//     Editing a delay must never rewrite a decision already made for a send in
//     flight — the history of why an email went out when it did stays true.
//
//  NOTHING EXECUTABLE IS STORED. Stop rules are booleans chosen from a fixed
//  list of named conditions, each of which maps to a real check in the send
//  path. There is no expression language and no place to put one.
// ════════════════════════════════════════════════════════════════════════

import { journeyRegistry, templateByKey, type JourneyEntry } from './email-registry'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Bounds every configurable delay. A stage cannot fire instantly or a year on. */
export const MIN_DELAY_MS = 5 * MINUTE
export const MAX_DELAY_MS = 180 * DAY
/** A countdown stage (before an anchor) may be at most this far ahead. */
export const MAX_LEAD_MS = 30 * DAY
export const MAX_STAGES = 6

/**
 * The stop rules an owner may toggle. Each maps to a real check that already
 * exists in the send path — this list cannot describe a condition the code
 * does not enforce.
 */
export const STOP_RULES = {
  stopAfterBooking: 'Stop once the customer books',
  stopAfterCancellation: 'Stop if the booking is cancelled',
  stopAfterPayment: 'Stop once the deposit is paid',
  stopAfterReview: 'Stop once a review is recorded',
  stopAfterReferral: 'Stop once a referral ask has been sent',
  stopAfterUnsubscribe: 'Stop if the customer unsubscribes',
  stopAfterHardBounce: 'Stop if the address hard-bounces',
  stopAfterComplaint: 'Stop if the customer files a spam complaint',
} as const

export type StopRuleKey = keyof typeof STOP_RULES

/**
 * Stop rules that may NEVER be turned off. Unsubscribe, hard bounce and
 * complaint are enforced by the suppression list inside the send guard; a
 * toggle that appeared to disable them would be lying, because the guard would
 * refuse the send anyway. They are shown as locked rather than omitted, so the
 * owner can see the protection exists.
 */
export const LOCKED_STOP_RULES: StopRuleKey[] = ['stopAfterUnsubscribe', 'stopAfterHardBounce', 'stopAfterComplaint']

export type JourneyStageConfig = {
  type: string
  template: string
  delayMs: number
}

export type JourneyConfig = {
  enabled: boolean
  stages: JourneyStageConfig[]
  stopRules: Record<StopRuleKey, boolean>
  caps: {
    /** Max sends from THIS journey per recipient per 30 days. 0 = no extra cap. */
    perRecipientPerMonth: number
  }
  respectQuietHours: boolean
}

export type ConfigValidation =
  | { ok: true; config: JourneyConfig }
  | { ok: false; errors: string[] }

/** The safe defaults, derived from the code constants the scheduler runs. */
export function defaultConfigFor(journey: JourneyEntry): JourneyConfig {
  const stopRules = Object.fromEntries(Object.keys(STOP_RULES).map((k) => [k, true])) as Record<StopRuleKey, boolean>
  return {
    enabled: journey.enabled,
    stages: journey.stages.map((s) => ({ type: s.type, template: s.template, delayMs: s.delayMs })),
    stopRules,
    caps: { perRecipientPerMonth: 0 },
    // Transactional journeys deliberately ignore quiet hours: a move-day
    // reminder must arrive when the event demands, not when a marketing
    // window opens.
    respectQuietHours: journey.emailClass === 'promotional',
  }
}

export function defaultConfig(journeyKey: string): JourneyConfig | null {
  const j = journeyRegistry().find((x) => x.key === journeyKey)
  return j ? defaultConfigFor(j) : null
}

/**
 * Validate a configuration from ANY source — an API body or a database row.
 * Reading is validated too, which is what makes a hand-edited row harmless.
 */
export function validateJourneyConfig(journeyKey: string, raw: unknown): ConfigValidation {
  const journey = journeyRegistry().find((x) => x.key === journeyKey)
  if (!journey) return { ok: false, errors: [`Unknown journey "${journeyKey}".`] }

  const errors: string[] = []
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['A journey configuration must be an object.'] }
  }
  const input = raw as Record<string, unknown>

  if (typeof input.enabled !== 'boolean') errors.push('`enabled` must be true or false.')
  if (typeof input.respectQuietHours !== 'boolean') errors.push('`respectQuietHours` must be true or false.')

  // ── Stages ──
  const stages: JourneyStageConfig[] = []
  if (!Array.isArray(input.stages)) {
    errors.push('`stages` must be an array.')
  } else if (input.stages.length === 0) {
    errors.push('A journey needs at least one stage.')
  } else if (input.stages.length > MAX_STAGES) {
    errors.push(`A journey may have at most ${MAX_STAGES} stages.`)
  } else {
    const allowedTypes = new Set(journey.stages.map((s) => s.type))
    const seen = new Set<string>()
    for (let i = 0; i < input.stages.length; i++) {
      const rawStage = input.stages[i]
      if (!rawStage || typeof rawStage !== 'object') {
        errors.push(`Stage ${i + 1} is not an object.`)
        continue
      }
      const st = rawStage as Record<string, unknown>
      const type = typeof st.type === 'string' ? st.type : ''
      // A stage TYPE is a job the worker knows how to dispatch. Inventing one
      // would schedule a job nothing handles, so only the journey's own
      // declared stages are accepted.
      if (!allowedTypes.has(type)) {
        errors.push(`Stage ${i + 1}: "${type}" is not a stage of the ${journey.name} journey.`)
        continue
      }
      if (seen.has(type)) {
        errors.push(`Stage ${i + 1}: "${type}" appears more than once.`)
        continue
      }
      seen.add(type)

      const template = typeof st.template === 'string' ? st.template : ''
      if (!templateByKey(template)) {
        errors.push(`Stage ${i + 1}: "${template}" is not a registered template.`)
        continue
      }

      const delayMs = typeof st.delayMs === 'number' ? st.delayMs : NaN
      if (!Number.isFinite(delayMs)) {
        errors.push(`Stage ${i + 1}: delay must be a number of milliseconds.`)
        continue
      }
      // THREE KINDS OF STAGE, and they have different timing rules.
      //
      // The distinction matters: a booking confirmation and a payment receipt
      // fire the moment the event happens. An earlier version of this validator
      // applied the "at least 5 minutes" follow-up rule to every stage, which
      // would have made the safe defaults for the booking journey INVALID and,
      // worse, would have let an owner put a delay on a receipt. A receipt that
      // arrives five minutes after payment reads as a system that is broken.
      const defaultDelay = journey.stages.find((s) => s.type === type)?.delayMs ?? 0

      if (defaultDelay === 0) {
        // IMMEDIATE, event-driven. It is not schedulable and must stay at zero.
        if (delayMs !== 0) {
          errors.push(
            `Stage ${i + 1}: this email fires the moment its event happens and cannot be delayed. A confirmation or receipt that arrives late reads as a malfunction.`
          )
        }
      } else if (defaultDelay < 0) {
        // COUNTDOWN before an anchor: negative, bounded lead time.
        if (delayMs >= 0) {
          errors.push(`Stage ${i + 1}: this stage fires BEFORE the move date, so its delay must be negative.`)
        } else if (Math.abs(delayMs) < MIN_DELAY_MS || Math.abs(delayMs) > MAX_LEAD_MS) {
          errors.push(`Stage ${i + 1}: lead time must be between 5 minutes and 30 days before the anchor.`)
        }
      } else {
        // FOLLOW-UP after an anchor.
        if (delayMs < MIN_DELAY_MS) {
          errors.push(`Stage ${i + 1}: delay must be at least 5 minutes. An instant follow-up reads as a malfunction.`)
        } else if (delayMs > MAX_DELAY_MS) {
          errors.push(`Stage ${i + 1}: delay may be at most 180 days.`)
        }
      }
      stages.push({ type, template, delayMs })
    }

    // Follow-up stages must move forward in time; a later stage that fires
    // before an earlier one would arrive out of order. Immediate (0) stages are
    // excluded: an event-driven journey has several, all at zero, and they are
    // ordered by the events themselves rather than by a delay.
    const forward = stages.filter((s) => s.delayMs > 0)
    for (let i = 1; i < forward.length; i++) {
      if (forward[i].delayMs <= forward[i - 1].delayMs) {
        errors.push(`Stage "${forward[i].type}" is scheduled no later than the stage before it.`)
      }
    }
  }

  // ── Stop rules ──
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
      // A locked rule is forced on regardless of what was submitted. The
      // suppression list enforces these inside the guard; letting the config
      // claim otherwise would be a lie the UI then displays.
      stopRules[key] = LOCKED_STOP_RULES.includes(key) ? true : (v as boolean | undefined) ?? true
    }
  }

  // ── Caps ──
  const rawCaps = (input.caps ?? {}) as Record<string, unknown>
  const perMonth = typeof rawCaps.perRecipientPerMonth === 'number' ? rawCaps.perRecipientPerMonth : 0
  if (!Number.isInteger(perMonth) || perMonth < 0 || perMonth > 30) {
    errors.push('`caps.perRecipientPerMonth` must be a whole number between 0 and 30.')
  }

  if (errors.length > 0) return { ok: false, errors }

  return {
    ok: true,
    config: {
      enabled: input.enabled as boolean,
      stages,
      stopRules,
      caps: { perRecipientPerMonth: perMonth },
      respectQuietHours: input.respectQuietHours as boolean,
    },
  }
}

export type EffectiveConfig = {
  config: JourneyConfig
  version: number
  /** 'defaults' | 'database' — where the running values came from. */
  source: 'defaults' | 'database'
  /** Set when a stored row was refused and the defaults were used instead. */
  degradedReason: string | null
}

/**
 * The configuration actually in force for a journey.
 *
 * This is the function the scheduler would call. It can only ever return a
 * VALID config: a stored row that fails validation is reported and discarded in
 * favour of the code defaults, because running a half-understood configuration
 * against real customers is worse than ignoring it.
 */
export function effectiveConfig(
  journeyKey: string,
  stored: { enabled: boolean; version: number; config: unknown } | null
): EffectiveConfig | null {
  const defaults = defaultConfig(journeyKey)
  if (!defaults) return null

  if (!stored) return { config: defaults, version: 0, source: 'defaults', degradedReason: null }

  const parsed = validateJourneyConfig(journeyKey, stored.config)
  if (!parsed.ok) {
    return {
      config: defaults,
      version: stored.version,
      source: 'defaults',
      degradedReason: `The stored configuration is invalid and was ignored: ${parsed.errors.join(' ')}`,
    }
  }

  return {
    config: { ...parsed.config, enabled: stored.enabled && parsed.config.enabled },
    version: stored.version,
    source: 'database',
    degradedReason: null,
  }
}

/** Human summary of how a stored config differs from the safe defaults. */
export function diffFromDefaults(journeyKey: string, config: JourneyConfig): string[] {
  const defaults = defaultConfig(journeyKey)
  if (!defaults) return []
  const out: string[] = []

  if (config.enabled !== defaults.enabled) out.push(`Enabled: ${defaults.enabled} → ${config.enabled}`)
  if (config.respectQuietHours !== defaults.respectQuietHours) {
    out.push(`Respect quiet hours: ${defaults.respectQuietHours} → ${config.respectQuietHours}`)
  }
  if (config.caps.perRecipientPerMonth !== defaults.caps.perRecipientPerMonth) {
    out.push(`Journey cap per month: ${defaults.caps.perRecipientPerMonth || 'none'} → ${config.caps.perRecipientPerMonth || 'none'}`)
  }
  for (const stage of config.stages) {
    const d = defaults.stages.find((s) => s.type === stage.type)
    if (!d) {
      out.push(`Stage ${stage.type}: added`)
      continue
    }
    if (d.delayMs !== stage.delayMs) out.push(`Stage ${stage.type}: delay changed`)
    if (d.template !== stage.template) out.push(`Stage ${stage.type}: template ${d.template} → ${stage.template}`)
  }
  for (const d of defaults.stages) {
    if (!config.stages.some((s) => s.type === d.type)) out.push(`Stage ${d.type}: removed`)
  }
  for (const key of Object.keys(STOP_RULES) as StopRuleKey[]) {
    if (config.stopRules[key] !== defaults.stopRules[key]) {
      out.push(`${STOP_RULES[key]}: ${defaults.stopRules[key] ? 'on' : 'off'} → ${config.stopRules[key] ? 'on' : 'off'}`)
    }
  }
  return out
}
