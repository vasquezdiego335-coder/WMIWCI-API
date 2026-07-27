// ════════════════════════════════════════════════════════════════════════
//  APPROVED-CONFIGURATION IDENTITY (owner spec 2026-07-26)
//  ---------------------------------------------------------------------
//  `editedAfterApproval` compared `config.updatedAt > config.approvedAt`. Every
//  write to that row bumps updatedAt — including persisting a validation RESULT.
//  So Validate invalidated Approve, the dispatch error told the operator to
//  "re-validate and re-approve", and doing exactly that re-broke it. The only
//  documented workaround was "do not click Validate after Approve", which is not
//  an acceptable permanent workflow.
//
//  Approval must mean "I approved THIS send configuration". So we hash exactly
//  the fields that decide WHO receives WHAT and compare hashes instead of
//  timestamps. Anything that does not change the send — validation output, status
//  notes, dispatch counters, audit writes — is invisible to this hash by
//  construction, because it is simply not in the list.
// ════════════════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto'
import { editedAfterApproval } from './email-campaign-run'

/** The send-affecting shape of a campaign configuration. */
export type SendConfigFields = {
  template: string | null
  subject: string | null
  audienceId: string | null
  scheduledAt: Date | null
  utmSource: string | null
  utmMedium: string | null
  utmCampaign: string | null
  utmContent: string | null
  discountCode: string | null
}

/**
 * Deterministic hash of the send-affecting configuration.
 *
 * DELIBERATELY EXCLUDED — each of these was a false-invalidation source:
 * validation, statusNote, dispatchedAt, dispatchedCount, createdAt, updatedAt,
 * approvedAt, approvedById/Name. Sender and reply-to are environment-level
 * rather than per-campaign, so they are not part of a campaign's approved
 * identity: changing them is an infrastructure change, not an edit to this
 * campaign.
 *
 * A unit separator joins the parts so that ("a","b") and ("ab","") can never
 * collide, and a null is encoded distinctly from an empty string.
 */
/**
 * SCHEDULED-AT IS DELIBERATELY NOT HASHED (bug #10, found in use 2026-07-27).
 *
 * It was, and that made the CORRECT workflow self-invalidating. The lifecycle
 * is VALIDATING -> READY -> (approve) -> SCHEDULED: scheduling happens AFTER
 * approval by design, and that transition writes scheduledAt. With the send
 * time in the hash, the very next legitimate step always produced "edited after
 * approval", so an owner who followed the intended sequence exactly was told
 * they had tampered with the campaign.
 *
 * Removing it loses no safety, because WHEN is governed separately and more
 * strictly than WHAT:
 *   * the transition to SCHEDULED already refuses without approvedAt;
 *   * it requires the email.manage_campaign permission;
 *   * the UI confirms the exact send time before it is applied;
 *   * it is written to the audit log;
 *   * `action:'update'` refuses to touch a campaign that is not DRAFT,
 *     VALIDATING or FAILED — so there is no other path that can change it.
 *
 * The hash answers "is this the same campaign that was approved?" — which is
 * WHAT goes out and TO WHOM. That is what a stale approval must not cover.
 */
export function sendConfigHash(config: SendConfigFields): string {
  const SEP = '\u001f'
  const NULL_MARK = '\u0000null'
  const enc = (v: string | null | undefined) => (v == null ? NULL_MARK : v)
  // Field ORDER is fixed and explicit so the hash stays stable across refactors.
  const parts = [
    enc(config.template),
    enc(config.subject),
    enc(config.audienceId),
    enc(config.utmSource),
    enc(config.utmMedium),
    enc(config.utmCampaign),
    enc(config.utmContent),
    enc(config.discountCode),
  ]
  return createHash('sha256').update(parts.join(SEP)).digest('hex').slice(0, 32)
}

/**
 * Does this configuration still match what an owner approved?
 *
 * Hash-based when the approval recorded one. Falls back to the old timestamp
 * rule for rows approved before the column existed — conservative, because the
 * fallback ASKS for re-approval rather than assuming a stale approval still
 * covers the current content.
 *
 * THE ONE authority: both the dispatch guard and the admin UI call this, so the
 * button and the refusal cannot disagree.
 */
export function needsReapproval(
  config: SendConfigFields & {
    approvedAt: Date | null
    updatedAt: Date
    approvedConfigHash: string | null
  }
): boolean {
  if (!config.approvedAt) return true
  if (config.approvedConfigHash) return sendConfigHash(config) !== config.approvedConfigHash
  return editedAfterApproval({ approvedAt: config.approvedAt, updatedAt: config.updatedAt })
}
