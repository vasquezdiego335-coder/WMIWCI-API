import * as React from 'react'
import { render } from '@react-email/render'
import * as fs from 'fs'
import * as path from 'path'

import ReferralEmail from '../src/emails/referral'
import ReviewRequestEmail from '../src/emails/review-request'
import AbandonedCheckoutEmail from '../src/emails/abandoned-checkout'

const OUT = path.join(__dirname, '..', 'email-marketing-html')

const jobs: Array<{ file: string; el: React.ReactElement }> = [
  { file: 'referral.html', el: <ReferralEmail /> },
  { file: 'review-request.html', el: <ReviewRequestEmail /> },
  { file: 'abandoned-checkout.html', el: <AbandonedCheckoutEmail /> },
]

async function main() {
  for (const j of jobs) {
    const html = await render(j.el, { pretty: true })
    fs.writeFileSync(path.join(OUT, j.file), html, 'utf8')
    console.log('wrote', j.file, html.length, 'bytes')
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
