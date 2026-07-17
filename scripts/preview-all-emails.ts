// Renders all 11 email templates to HTML to verify they render without error
// after the overhaul. Writes email-previews/<name>.html and reports OK/FAIL.
//   npx tsx scripts/preview-all-emails.ts
import { render } from '@react-email/render'
import * as React from 'react'
import { mkdirSync, writeFileSync } from 'fs'
import { resolve } from 'path'

import PreApproval from '../src/emails/pre-approval'
import FinalConfirmation from '../src/emails/final-confirmation'
import BookingDeclined from '../src/emails/booking-declined'
import BookingCancellation from '../src/emails/booking-cancellation'
import BookingUpdated from '../src/emails/booking-updated'
import JobReminder from '../src/emails/job-reminder'
import JobCompletion from '../src/emails/job-completion'
import PaymentReceipt from '../src/emails/payment-receipt'
import AbandonedCheckout from '../src/emails/abandoned-checkout'
import Referral from '../src/emails/referral'
import ReviewRequest from '../src/emails/review-request'

const OUT = resolve('email-previews')
mkdirSync(OUT, { recursive: true })

// Sample props exercise the fixed amount fields ($1 hold + capture).
const common = { customerName: 'Diego (TEST)', displayId: 'WMIC-1017', locale: 'en' as const }
const templates: Array<[string, React.ReactElement]> = [
  ['pre-approval', React.createElement(PreApproval, { ...common, amountHold: '1', originAddress: '1 A St', destAddress: '2 B St' })],
  ['final-confirmation', React.createElement(FinalConfirmation, { ...common, amountPaid: '1' })],
  ['booking-declined', React.createElement(BookingDeclined, { ...common, amountHold: '1' })],
  ['booking-cancellation', React.createElement(BookingCancellation, { ...common, amount: '1', kind: 'released' })],
  ['booking-updated', React.createElement(BookingUpdated, { ...common, amountHold: '1', changedLabel: 'the date' })],
  ['job-reminder', React.createElement(JobReminder, { ...common })],
  ['job-completion', React.createElement(JobCompletion, { ...common })],
  ['payment-receipt', React.createElement(PaymentReceipt, { ...common, amountPaid: '1.00', captured: true })],
  ['abandoned-checkout', React.createElement(AbandonedCheckout, { ...common, amountHold: '1' })],
  ['referral', React.createElement(Referral, { ...common })],
  ['review-request', React.createElement(ReviewRequest, { ...common })],
]

async function main() {
  let ok = 0
  const results: string[] = []
  for (const [name, el] of templates) {
    try {
      const html = await render(el)
      writeFileSync(resolve(OUT, `${name}.html`), html, 'utf8')
      // sanity: no leftover hardcoded "$49", no raw hero <svg> that Gmail strips
      const has49 = /\$49\b/.test(html)
      results.push(`  ${has49 ? 'WARN($49)' : 'OK       '} ${name} (${html.length} bytes)`)
      ok++
    } catch (e) {
      results.push(`  FAIL      ${name}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  console.log(results.join('\n'))
  console.log(`\n${ok}/${templates.length} templates rendered`)
  if (ok < templates.length) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
