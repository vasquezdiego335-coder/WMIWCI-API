// ════════════════════════════════════════════════════════════════════════
//  THE POLICY ENGINE (owner spec 2026-07-27)
//  ---------------------------------------------------------------------
//  THE AI RECOMMENDS. THIS DECIDES. There is no path by which a model's
//  opinion changes a classification: `classify()` takes a tool name and the
//  current mode, and returns one of three verdicts from a table written here,
//  in code, by a person. It does not read the recommendation's rationale, its
//  confidence, or anything else the model produced.
//
//  FOUR PROPERTIES THIS FILE GUARANTEES.
//
//  1. UNKNOWN IS FORBIDDEN. A name not in the table is refused. New tools are
//     therefore forbidden by default until somebody classifies them here on
//     purpose — the failure mode of forgetting is "it does not work", never
//     "it silently did something to a customer".
//
//  2. FORBIDDEN IS ABSOLUTE. Nothing downgrades it: not safe_auto, not an
//     owner approval, not an emergency. The forbidden list is the set of
//     actions that must not be reachable THROUGH THE AGENT at all, and several
//     of them (removing a suppression, recording consent) are things a human
//     can legitimately do — just not here, not through this door, and not with
//     a model's reasoning attached.
//
//  3. MODE NARROWS, NEVER WIDENS. read_only downgrades every `automatic` to
//     `approval_required`. No mode promotes anything.
//
//  4. THE AGENT CANNOT CHANGE ITS OWN PERMISSIONS. `enableSafeAutoMode` and
//     `raiseStageRecipientLimit` are forbidden, so the one thing a
//     misbehaving agent would need to do first — grant itself more room — is
//     the one thing it cannot do.
// ════════════════════════════════════════════════════════════════════════

import {
  AGENT_TOOL_NAMES,
  isAgentToolName,
  type AgentToolName,
  type EmailAgentMode,
  type PolicyClassification,
  type PolicyDecision,
} from './types'

/**
 * Read-only inspection. These touch nothing and are safe in every mode,
 * including read_only, because "look at this campaign" is not an action.
 */
const INSPECTION: AgentToolName[] = ['inspectCampaign', 'inspectCampaignRun', 'inspectEmailSend', 'inspectWebhookEvent']

/**
 * Bookkeeping inside the agent's own tables. These never touch the email
 * system, so they stay available in read_only — an agent that could not record
 * what it found would be useless in exactly the mode it is meant to run in.
 */
const BOOKKEEPING: AgentToolName[] = [
  'createIncident',
  'updateIncident',
  'resolveIncident',
  'sendDiscordIncidentAlert',
  'recordLesson',
  'createApprovalRequest',
]

/**
 * THE AUTOMATIC SET. Every entry earned its place by satisfying all four:
 *
 *   (a) it cannot cause an email to be sent to anybody;
 *   (b) it is idempotent — running it twice is the same as running it once;
 *   (c) it corrects data to match reality rather than changing reality;
 *   (d) doing nothing is worse than doing it.
 *
 * `retryTransientSendOnce` is the only one that can cause delivery, and it is
 * here under a hard constraint enforced by its executor rather than by
 * classification: exactly one retry, only for an error deterministically
 * classified transient, never for an ambiguous outcome.
 *
 * The two `pause*` tools are here because STOPPING is the safe direction. An
 * agent that must ask permission before stopping a duplicate send is an agent
 * that watches the duplicate send happen.
 */
const AUTOMATIC: Record<string, string> = {
  reconcileRunCounters:
    'Recomputes summary counters from the recipient rows that are already the canonical record. It changes no recipient and sends nothing.',
  finalizeSettledRun:
    'Closes a run in which every recipient has already reached a terminal state. It records a conclusion that is already true.',
  releaseExpiredLock:
    'Returns a claim whose worker is demonstrably gone to PENDING. The send-level idempotency key still prevents any duplicate delivery.',
  reprocessValidWebhookEvent:
    'Re-applies the suppression from a webhook that was already received and verified. It can only ever ADD a suppression, never remove one.',
  retryTransientSendOnce:
    'Retries exactly once, only where the failure is deterministically classified transient. An ambiguous or terminal outcome is never retried.',
  pauseCampaign:
    'Stops a campaign. Stopping is the safe direction: the cost of a wrong pause is a delayed email, the cost of a wrong send is a customer complaint.',
  pauseMarketingDispatch:
    'Turns the global marketing kill switch ON. Stopping is always allowed; only turning it back on requires a person.',
}

/**
 * THE APPROVAL SET. Every one of these either sends something to a real
 * person, changes who will be sent to, or restarts something a human stopped.
 * The common thread: a mistake here is visible in somebody's inbox and cannot
 * be undone.
 */
const APPROVAL_REQUIRED: Record<string, string> = {
  resumeMarketingDispatch:
    'Restarting dispatch after a pause reverses a deliberate stop. The person who stopped it, or the owner, decides when the cause is fixed.',
  resumeCampaign: 'Resuming a campaign paused for a compliance reason means asserting the compliance problem is resolved.',
  rescheduleCampaign: 'Changes when real people receive email.',
  dispatchCampaignNow: 'Sends a campaign. This is never automatic under any mode.',
  retryFailedRecipients: 'Re-attempts delivery to real people, some of whom may already have received the message.',
}

/**
 * THE FORBIDDEN SET. Not "requires a very senior approval" — not reachable.
 *
 * Removing a suppression and recording consent are deliberately here even
 * though a human may legitimately do both: they must happen in the compliance
 * screens where the evidence lives, with a person's name on them, and never as
 * the downstream effect of a model recommending something.
 */
const FORBIDDEN: Record<string, string> = {
  removeSuppression:
    'The agent can never un-suppress an address. Somebody asked not to be contacted; only a person, in the suppression screen, may act on that.',
  raiseStageRecipientLimit:
    'The agent may never widen its own sending ceiling. Raising the Stage 2 limit is an owner decision made deliberately, not a repair.',
  enableSafeAutoMode:
    'The agent may never grant itself permission to act. Changing the operating mode is done by a person in the admin.',
}

/** Human-readable rules shown to the model, and printed in the admin. */
export const POLICY_SUMMARY: string[] = [
  'Deterministic checks decide what is true. The AI explains and recommends; it never decides.',
  'An unknown tool name is forbidden. There is no general-purpose action.',
  'The agent may never send a campaign, resend an email, reschedule, or change an audience.',
  'The agent may never create consent, remove a suppression, or bypass an unsubscribe.',
  'The agent may never raise the Stage 2 recipient limit or change its own operating mode.',
  'Stopping is always allowed; starting again always needs a person.',
  'In read_only mode nothing that changes the email system executes, whatever the AI recommends.',
  'Automatic repairs are limited per cycle, and every one is recorded with its before and after state.',
]

/** What the AI is told each tool does. Descriptions only — never permission. */
export const TOOL_DESCRIPTIONS: Record<AgentToolName, string> = {
  inspectCampaign: 'Read one campaign, its email config, audience and recent runs.',
  inspectCampaignRun: 'Read one run with its recipient state breakdown.',
  inspectEmailSend: 'Read one send with its provider outcome and events.',
  inspectWebhookEvent: 'Read one provider event and its processing state.',
  reconcileRunCounters: 'Recompute a finished run\'s counters from its recipient rows.',
  finalizeSettledRun: 'Close a run whose recipients have all reached a terminal state.',
  releaseExpiredLock: 'Return recipients stuck in SENDING past the stale window to PENDING.',
  reprocessValidWebhookEvent: 'Re-apply the suppression side effect of an already-verified webhook event.',
  retryTransientSendOnce: 'Re-open ONE send whose failure is classified transient, for exactly one more attempt.',
  pauseCampaign: 'Pause a campaign so it cannot dispatch.',
  pauseMarketingDispatch: 'Turn the global marketing kill switch on, stopping all campaign dispatch.',
  createIncident: 'Open an incident record.',
  updateIncident: 'Update an incident\'s summary, cause or status.',
  resolveIncident: 'Mark an incident resolved with a written resolution.',
  sendDiscordIncidentAlert: 'Post a deduplicated incident alert to the ops channel.',
  recordLesson: 'Store a structured lesson about a recurring pattern.',
  createApprovalRequest: 'Ask the owner to approve an action the agent may not take alone.',
  resumeMarketingDispatch: 'Turn the global marketing kill switch off. Requires owner approval.',
  resumeCampaign: 'Resume a paused campaign. Requires owner approval.',
  rescheduleCampaign: 'Change a campaign\'s send time. Requires owner approval.',
  dispatchCampaignNow: 'Dispatch a campaign immediately. Requires owner approval.',
  retryFailedRecipients: 'Re-attempt delivery to failed recipients. Requires owner approval.',
  removeSuppression: 'FORBIDDEN. The agent can never remove a suppression.',
  raiseStageRecipientLimit: 'FORBIDDEN. The agent can never raise its own sending limit.',
  enableSafeAutoMode: 'FORBIDDEN. The agent can never change its own operating mode.',
}

/**
 * The one function with authority.
 *
 * `mode` narrows the answer and can never widen it. Note the ordering: the
 * forbidden table is consulted FIRST, before anything else can matter.
 */
export function classify(toolName: string, mode: EmailAgentMode): PolicyDecision {
  // 1. UNKNOWN IS FORBIDDEN. Checked before everything, including mode.
  if (!isAgentToolName(toolName)) {
    return {
      classification: 'forbidden',
      reason: `"${String(toolName).slice(0, 60)}" is not a tool this system has. Only the ${AGENT_TOOL_NAMES.length} allowlisted tools exist, and anything else is refused without being interpreted.`,
    }
  }

  // 2. FORBIDDEN IS ABSOLUTE. No mode and no approval reaches past this.
  if (toolName in FORBIDDEN) {
    return { classification: 'forbidden', reason: FORBIDDEN[toolName] }
  }

  // 3. `off` means off. Even inspection stops, because in `off` mode there is
  //    no cycle to inspect from.
  if (mode === 'off') {
    return { classification: 'forbidden', reason: 'The agent is switched off. Nothing executes in this mode.' }
  }

  // 4. Reading and agent-internal bookkeeping are safe in every live mode.
  if (INSPECTION.includes(toolName)) {
    return { classification: 'automatic', reason: 'Read-only inspection. It changes nothing.' }
  }
  if (BOOKKEEPING.includes(toolName)) {
    return {
      classification: 'automatic',
      reason: 'Records the agent\'s own findings, incidents, alerts and approval requests. It does not touch the email system.',
    }
  }

  // 5. Explicit approval set.
  if (toolName in APPROVAL_REQUIRED) {
    return { classification: 'approval_required', reason: APPROVAL_REQUIRED[toolName] }
  }

  // 6. The automatic repairs — but only in safe_auto.
  if (toolName in AUTOMATIC) {
    if (mode !== 'safe_auto') {
      return {
        classification: 'approval_required',
        reason: `The agent is in ${mode} mode, so this repair is proposed rather than performed. In safe_auto it would run automatically: ${AUTOMATIC[toolName]}`,
      }
    }
    return { classification: 'automatic', reason: AUTOMATIC[toolName] }
  }

  // 7. A known tool nobody classified. Refused, and it says so — this is the
  //    branch that catches a tool added to the enum and forgotten here.
  return {
    classification: 'forbidden',
    reason: `"${toolName}" exists but has no policy classification, so it is refused. A tool with no explicit decision about it is never given the benefit of the doubt.`,
  }
}

/** Tool descriptions plus their classification under a given mode, for the AI. */
export function availableTools(mode: EmailAgentMode): Array<{ name: AgentToolName; description: string; classification: PolicyClassification }> {
  return AGENT_TOOL_NAMES.map((name) => ({
    name,
    description: TOOL_DESCRIPTIONS[name],
    classification: classify(name, mode).classification,
  }))
}

/** Every tool that could ever execute without a human. Used by tests. */
export const AUTOMATIC_TOOL_NAMES: AgentToolName[] = (Object.keys(AUTOMATIC) as AgentToolName[]).concat(INSPECTION, BOOKKEEPING)
export const APPROVAL_TOOL_NAMES: AgentToolName[] = Object.keys(APPROVAL_REQUIRED) as AgentToolName[]
export const FORBIDDEN_TOOL_NAMES: AgentToolName[] = Object.keys(FORBIDDEN) as AgentToolName[]
