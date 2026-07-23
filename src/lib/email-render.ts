// ════════════════════════════════════════════════════════════════════════
//  TEMPLATE RENDERING — one place that turns a template key into HTML + text.
//  (owner spec 2026-07-21)
//  ---------------------------------------------------------------------
//  WHY THIS IS NOT `import { TEMPLATES } from '../workers/email.worker'`:
//  that module constructs a BullMQ Worker at import time. Importing it from a
//  Next.js route handler would open a Redis connection and start consuming the
//  email queue inside the web process — a worker nobody meant to start.
//
//  So the component map is duplicated here, and a conformance test
//  (email-admin-features.test.ts) asserts THIS map covers every key in the
//  worker's ALLOWED_TEMPLATES. A template added to one and not the other fails
//  the build rather than producing a preview that silently differs from what
//  the customer receives.
// ════════════════════════════════════════════════════════════════════════

import * as React from 'react'
import { render } from '@react-email/render'

import PreApprovalEmail from '../emails/pre-approval'
import FinalConfirmationEmail from '../emails/final-confirmation'
import BookingDeclinedEmail from '../emails/booking-declined'
import PaymentReceiptEmail from '../emails/payment-receipt'
import BookingUpdatedEmail from '../emails/booking-updated'
import BookingCancellationEmail from '../emails/booking-cancellation'
import JobReminderEmail from '../emails/job-reminder'
import JobCompletionEmail from '../emails/job-completion'
import ReviewRequestEmail from '../emails/review-request'
import AbandonedCheckoutEmail from '../emails/abandoned-checkout'
import ReferralEmail from '../emails/referral'
import PaymentFailedEmail from '../emails/payment-failed'
import InformationRequiredEmail from '../emails/information-required'
import OperationalAlertEmail from '../emails/operational-alert'
import FinalInvoiceEmail from '../emails/final-invoice'
import ReferralRewardEmail from '../emails/referral-reward'
import QuoteFollowupEmail from '../emails/quote-followup'

type Renderer = (payload: Record<string, unknown>) => React.ReactElement

/** Template key → component. Mirrors src/workers/email.worker.ts TEMPLATES. */
export const RENDERERS: Record<string, Renderer> = {
  'pre-approval': (p) => PreApprovalEmail(p as never),
  'final-confirmation': (p) => FinalConfirmationEmail(p as never),
  'booking-declined': (p) => BookingDeclinedEmail(p as never),
  'payment-receipt': (p) => PaymentReceiptEmail(p as never),
  'booking-updated': (p) => BookingUpdatedEmail(p as never),
  'booking-cancellation': (p) => BookingCancellationEmail(p as never),
  'job-reminder': (p) => JobReminderEmail(p as never),
  'job-completion': (p) => JobCompletionEmail(p as never),
  'review-request': (p) => ReviewRequestEmail(p as never),
  'abandoned-checkout': (p) => AbandonedCheckoutEmail(p as never),
  referral: (p) => ReferralEmail(p as never),
  'payment-failed': (p) => PaymentFailedEmail(p as never),
  'information-required': (p) => InformationRequiredEmail(p as never),
  'operational-alert': (p) => OperationalAlertEmail(p as never),
  'final-invoice': (p) => FinalInvoiceEmail(p as never),
  'referral-reward': (p) => ReferralRewardEmail(p as never),
  // Multi-stage templates vary their copy from a `stage` prop, exactly as the
  // worker does — a preview of stage 3 must be stage 3.
  'abandoned-checkout-2': (p) => AbandonedCheckoutEmail({ ...p, stage: 2 } as never),
  'abandoned-checkout-3': (p) => AbandonedCheckoutEmail({ ...p, stage: 3 } as never),
  'quote-followup-1': (p) => QuoteFollowupEmail({ ...p, stage: 1 } as never),
  'quote-followup-2': (p) => QuoteFollowupEmail({ ...p, stage: 2 } as never),
  'quote-followup-final': (p) => QuoteFollowupEmail({ ...p, stage: 3 } as never),
  // followups.ts renders these two from the review-request component.
  'review-reminder': (p) => ReviewRequestEmail({ ...p, reminder: true } as never),
  'repeat-reminder': (p) => ReviewRequestEmail({ ...p, repeat: true } as never),
}

export type RenderedTemplate = { html: string; text: string }

/**
 * Render a template. Returns a typed error rather than throwing: a template
 * that blows up on a preview is a normal thing to want reported in the UI, not
 * a 500 that tells the owner nothing.
 */
export async function renderTemplate(
  template: string,
  payload: Record<string, unknown>
): Promise<RenderedTemplate | { error: string }> {
  const renderer = RENDERERS[template]
  if (!renderer) return { error: `No renderer registered for template "${template}".` }
  try {
    const element = renderer(payload)
    const [html, text] = await Promise.all([render(element), render(element, { plainText: true })])
    return { html, text }
  } catch (err) {
    return { error: `Render failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/** Template keys this module can render. */
export const renderableTemplates = (): string[] => Object.keys(RENDERERS)
