// ════════════════════════════════════════════════════════════════════════
//  RUN DIAGNOSIS (owner spec 2026-07-26, Phase 1 requirement 5)
//  ---------------------------------------------------------------------
//  What a failed run used to tell the owner:
//
//      RUN FAILED · 1 recipients · 0 sent · 5 skipped
//      ✗ Custom Id cannot contain :
//
//  A provider-library error string and nothing else. It does not say whether
//  anyone was emailed, whether it is safe to retry, or what to do next — so the
//  only honest reaction is to guess, and the tempting guess ("retry it") is the
//  one that can double-send to a real customer.
//
//  This module answers the operator's actual questions from data that is
//  already recorded. It is PURE: counts and flags in, verdict out. It decides
//  nothing and sends nothing — the callers stay authoritative.
//
//  THE ONE RULE IT ENCODES: the safety of a retry is decided by whether the
//  provider was ever handed the message, not by the run's status. A recipient
//  with an `emailSendId` may already have been delivered, so its outcome is
//  UNKNOWN and it is never offered as a safe retry. A missing email is a
//  smaller problem than a duplicate to a customer.
// ════════════════════════════════════════════════════════════════════════

/** Where a run died. Named for the operator, not for the stack. */
export type FailureStage =
  | 'audience_resolution' // never got a recipient list
  | 'preparation' // list frozen, nothing handed to the provider yet
  | 'sending' // at least one message reached the provider
  | 'none' // did not fail

export type RunDiagnosisInput = {
  runId: string
  status: string
  totalRecipients: number
  /** Recipient rows by state, e.g. { SENT: 3, PENDING: 1 }. */
  recipientCounts: Record<string, number>
  /** Recipients with an emailSendId — the provider was given these. */
  submittedCount?: number
  error?: string | null
  startedAt?: Date | string | null
  completedAt?: Date | string | null
  /** Provider message id of the most recent accepted send, when known. */
  lastProviderMessageId?: string | null
}

export type RunDiagnosis = {
  stage: FailureStage
  /** True when the run is finished and produced no delivery at all. */
  deadNoDelivery: boolean
  /** Recipients whose provider outcome cannot be determined from our data. */
  unknownOutcome: number
  /** Was ANY message handed to the provider during this run? */
  providerAttempted: boolean
  /** Retry cannot duplicate a delivery for this many recipients. */
  safeToRetry: number
  /** The next action, in the operator's words. Never "retry" when unsafe. */
  nextAction: string
  /** Plain-language summary of what happened. */
  summary: string
  /** The raw provider/library error, kept verbatim for support. */
  lastError: string | null
}

const n = (c: Record<string, number>, k: string) => c[k] ?? 0

/** Recipient states that never reached the provider and never will on their own. */
const NEVER_SENT = ['PENDING', 'DEFERRED']
/** States that are explanations, not failures — a decision was recorded. */
const EXPLAINED = ['SKIPPED', 'SUPPRESSED', 'UNSUBSCRIBED', 'INELIGIBLE', 'CONTEXT_INVALID', 'CANCELLED']

export function diagnoseRun(input: RunDiagnosisInput): RunDiagnosis {
  const c = input.recipientCounts ?? {}
  const sent = n(c, 'SENT')
  const failed = n(c, 'FAILED')
  const explained = EXPLAINED.reduce((t, k) => t + n(c, k), 0)
  const neverSent = NEVER_SENT.reduce((t, k) => t + n(c, k), 0)
  const inFlight = n(c, 'SENDING')

  const terminal = input.status === 'FAILED' || input.status === 'CANCELLED' || input.status === 'COMPLETED' || input.status === 'COMPLETED_WITH_ERRORS'
  const isFailure = input.status === 'FAILED' || failed > 0

  // Was the provider ever involved? `submittedCount` is authoritative when the
  // caller supplies it (it counts rows with an emailSendId); otherwise a SENT
  // row proves it and the absence of one does not.
  const providerAttempted = input.submittedCount != null ? input.submittedCount > 0 : sent > 0

  // A row still SENDING, or FAILED after submission, has an outcome we cannot
  // read from our own tables. Bounded by what was actually submitted so this
  // never over-reports.
  const submittedNotSettled = input.submittedCount != null ? Math.max(0, input.submittedCount - sent) : 0
  const unknownOutcome = Math.min(failed + inFlight, submittedNotSettled) + (input.submittedCount == null ? inFlight : 0)

  let stage: FailureStage = 'none'
  if (isFailure || (terminal && neverSent > 0)) {
    if (input.totalRecipients === 0) stage = 'audience_resolution'
    else if (providerAttempted) stage = 'sending'
    else stage = 'preparation'
  }

  // Retry is safe only for recipients that certainly never reached the provider.
  const safeToRetry = neverSent + (failed - unknownOutcome > 0 ? failed - unknownOutcome : 0)

  const deadNoDelivery = terminal && sent === 0

  const parts: string[] = []
  if (stage === 'audience_resolution') {
    parts.push('The run failed before it had any recipients — the audience resolved to nobody, so no email was attempted.')
  } else if (stage === 'preparation') {
    parts.push(
      `The run failed while preparing recipients. Nothing was handed to the email provider, so no one received anything and no duplicate is possible.`
    )
  } else if (stage === 'sending') {
    parts.push(`The run failed after ${sent} message${sent === 1 ? '' : 's'} had already been accepted by the provider.`)
  } else if (terminal) {
    parts.push(`The run finished: ${sent} sent.`)
  } else {
    parts.push(`The run is ${input.status.toLowerCase().replace(/_/g, ' ')}.`)
  }
  if (explained > 0) parts.push(`${explained} recipient${explained === 1 ? '' : 's'} were skipped with a recorded reason.`)
  if (neverSent > 0 && !terminal) parts.push(`${neverSent} still waiting.`)
  if (unknownOutcome > 0) {
    parts.push(
      `${unknownOutcome} recipient${unknownOutcome === 1 ? ' has an' : 's have'} UNKNOWN provider outcome — ` +
        `${unknownOutcome === 1 ? 'it' : 'they'} may already have been delivered.`
    )
  }

  let nextAction: string
  if (stage === 'audience_resolution') {
    nextAction = 'Fix the audience (it matched nobody), then start a new run. There is nothing to retry.'
  } else if (unknownOutcome > 0) {
    nextAction =
      'Do NOT retry yet. Check these addresses in the Resend dashboard first — retrying an unknown outcome can send a customer a duplicate.'
  } else if (stage === 'preparation' && safeToRetry > 0) {
    nextAction = `Safe to retry: ${safeToRetry} recipient${safeToRetry === 1 ? '' : 's'} never reached the provider. Fix the cause above, then Retry failed or start a new run.`
  } else if (stage === 'sending' && safeToRetry > 0) {
    nextAction = `Safe to retry the ${safeToRetry} recipient${safeToRetry === 1 ? '' : 's'} that were never submitted. Already-sent messages are untouched.`
  } else if (deadNoDelivery && terminal) {
    nextAction = 'Nothing was delivered and nothing is retryable. Resolve the cause, then start a new run.'
  } else {
    nextAction = 'No action needed.'
  }

  return {
    stage,
    deadNoDelivery,
    unknownOutcome,
    providerAttempted,
    safeToRetry,
    nextAction,
    summary: parts.join(' '),
    lastError: input.error ?? null,
  }
}

/**
 * Translate a provider/library error into something an owner can act on.
 * Falls back to the raw text — an unrecognised error is shown verbatim rather
 * than replaced by a vague generic message.
 */
export function explainRunError(error: string | null | undefined): string | null {
  if (!error) return null
  const e = error.trim()
  if (/Custom Id cannot contain/i.test(e)) {
    return `${e} — a queue job id contained a character the queue reserves. This was the colon-in-job-id defect; the campaign could not dispatch at all.`
  }
  if (/rate.?limit|429/i.test(e)) return `${e} — the provider throttled us. Waiting and retrying the unsent recipients is safe.`
  if (/unauthor|forbidden|401|403|api.?key/i.test(e)) return `${e} — the provider rejected our credentials. Check RESEND_API_KEY before retrying.`
  if (/domain|not verified|dkim|spf/i.test(e)) return `${e} — a sending-domain problem. Fix DNS/verification first; retrying now will fail the same way.`
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|socket|network/i.test(e)) {
    return `${e} — a network or Redis connectivity failure, not a rejection of the content. Recipients that were never submitted are safe to retry.`
  }
  return e
}
