// Side-effect module for lifecycle-enqueue-durability.test.ts. Import it FIRST.
//
//  1. Turns the journeys AND post-job follow-ups on before journeys.ts /
//     followups.ts load: both flags are module-level consts read once at import.
//  2. Captures every log line written through queueLogger.child(...) and
//     webhookLogger, so a test can prove a caller did NOT log "scheduled" when
//     an enqueue failed. The loggers are patched before any module under test
//     creates its child logger. Nothing is printed.
//
// Not a test file; never listed in `npm test`.
process.env.EMAIL_JOURNEYS_ENABLED = 'true'
// Promotional journeys also need the promotions kill switch (2026-09-16).
process.env.EMAIL_PROMOTIONS_ENABLED = 'true'
process.env.MARKETING_FOLLOWUPS_ENABLED = 'true'
delete process.env.EMAIL_PROMOTIONAL_ALLOWLIST

import { queueLogger, webhookLogger } from '../logger'

export type CapturedLog = { level: 'debug' | 'info' | 'warn' | 'error'; msg: string; obj: Record<string, unknown> }
export const captured: CapturedLog[] = []

type Capturable = Record<'debug' | 'info' | 'warn' | 'error', (...args: unknown[]) => void>

function capture(target: Capturable, bindings: Record<string, unknown>): void {
  for (const level of ['debug', 'info', 'warn', 'error'] as const) {
    target[level] = (a?: unknown, b?: unknown) => {
      const obj = typeof a === 'object' && a !== null ? (a as Record<string, unknown>) : {}
      const msg = typeof a === 'string' ? a : typeof b === 'string' ? b : ''
      captured.push({ level, msg, obj: { ...bindings, ...obj } })
    }
  }
}

const originalChild = queueLogger.child.bind(queueLogger)
;(queueLogger as unknown as { child: (b: Record<string, unknown>) => unknown }).child = (bindings: Record<string, unknown>) => {
  const child = originalChild(bindings)
  capture(child as unknown as Capturable, bindings)
  return child
}
capture(webhookLogger as unknown as Capturable, { module: 'webhook' })
