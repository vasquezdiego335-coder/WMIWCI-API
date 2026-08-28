// ════════════════════════════════════════════════════════════════════════
//  contact-route-deps.ts — the seam /api/contact performs its effects through.
//
//  WHY THIS EXISTS. The contact route called persistence, the Discord queue and
//  the operations alert directly, so there was no way to drive the REAL handler
//  and observe what it did without a database and a Redis. The consequence was
//  that its most important behaviour went untested for its whole life: the route
//  answered `{ok:true}` for an enquiry that was never stored, and no test could
//  have caught it, because no test could make the store fail.
//
//  Modelled on `quote-capture-deps.ts`, deliberately, so there is ONE way this
//  codebase makes a route testable rather than two.
//
//  DELIBERATELY NARROW. Only the four effectful calls are swappable. The Zod
//  schema, the honeypot decision, the consent normalisation, the status codes
//  and the response bodies are NOT — a test able to stub those would stop
//  testing the thing under test.
//
//  `__setContactRouteDeps` is a TEST-ONLY entry point. It is called from no
//  route, worker or script, and `contact-route.test.ts` asserts that, so it
//  cannot quietly become a production configuration hook.
// ════════════════════════════════════════════════════════════════════════
import { ingestLeadSafe } from './leads'
import { apiLogger } from './logger'

/** The Discord alert the team actually reads. Shape owned by the worker. */
export type ContactAlertJob = {
  type: 'contact-message'
  payload: Record<string, unknown>
}

export type ContactRouteDeps = {
  /** Persist the enquiry. Never throws; returns null when the write failed. */
  capture: typeof ingestLeadSafe
  /** Queue the team's Discord notice. MAY throw — the route must survive it. */
  enqueue: (job: ContactAlertJob) => Promise<unknown>
  /** Durable operations alert. Fire-and-forget; must never mask the response. */
  alert: (title: string, lines: { message: string }[]) => Promise<unknown>
  /** Non-quote nurture enrolment. Fire-and-forget, self-refusing. */
  nurture: (leadId: string) => Promise<unknown>
}

const PRODUCTION: ContactRouteDeps = {
  capture: ingestLeadSafe,
  //  Imported lazily so this module keeps a queue-free import graph: the
  //  offline tests import the route and must not open a Redis connection.
  async enqueue(job) {
    const { discordQueue } = await import('./queues')
    return discordQueue.add(job.type, job as never)
  },
  async alert(title, lines) {
    const { postOpsAlert } = await import('./ops-alert')
    return postOpsAlert(title, lines)
  },
  async nurture(leadId) {
    const { onLeadCaptured } = await import('./journeys')
    return onLeadCaptured(leadId)
  },
}

let current: ContactRouteDeps = PRODUCTION

/** What the route uses. Production unless a test has replaced it. */
export function contactRouteDeps(): ContactRouteDeps {
  return current
}

/** TEST ONLY. Returns a restore function; always call it in a `finally`, or
 *  the next test in the same process inherits the stub. */
export function __setContactRouteDeps(next: Partial<ContactRouteDeps>): () => void {
  const previous = current
  current = { ...current, ...next }
  return () => {
    current = previous
  }
}

/** Fire an effect that must never change the response. One place, so the
 *  swallow is deliberate and visible rather than repeated inline. */
export function fireAndForget(p: Promise<unknown>, what: string): void {
  void p.catch((err) => apiLogger.warn({ err: String(err).slice(0, 200) }, `${what} failed (non-fatal)`))
}
