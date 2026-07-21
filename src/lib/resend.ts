import { Resend } from 'resend'

export const resend = new Resend(process.env.RESEND_API_KEY ?? 're_placeholder')

// Brand line retired 2026-07-17: "We Move It. We Clear It." → "Move It Clear It."
export const EMAIL_FROM = process.env.EMAIL_FROM ?? 'Move It Clear It <hello@moveitclearit.com>'
export const EMAIL_REPLY_TO = process.env.EMAIL_REPLY_TO ?? 'hello@moveitclearit.com'
