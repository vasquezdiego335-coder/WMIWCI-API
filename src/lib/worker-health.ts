// ════════════════════════════════════════════════════════════════════════
//  WORKER HEALTH VERDICT — pure, so the rules are unit-tested offline
//  ---------------------------------------------------------------------
//  The worker's /health used to say "ok" when REDIS_URL merely existed and the
//  worker count was non-zero — both facts true the instant the process started,
//  whether or not Redis answered or a single worker was actually consuming.
//  Health is now three real observations:
//    1. no required configuration is missing;
//    2. Redis answers a PING (src/lib/redis-health.ts);
//    3. every BullMQ worker is running and not paused.
//  The Discord gateway is REPORTED but does not decide health: approval cards
//  post over REST, so a reconnecting gateway does not stop customer email.
// ════════════════════════════════════════════════════════════════════════

export type WorkerAttachment = { name: string; running: boolean; paused: boolean }

export type WorkerHealthInput = {
  envMissing: string[]
  /** null = not checked (workers never started). */
  redis: { ok: boolean } | null
  workers: WorkerAttachment[]
  /** Workers the host is expected to run; fewer than this is degraded. */
  expectedWorkers: number
}

export type WorkerHealthVerdict = { ok: boolean; problems: string[] }

export function evaluateWorkerHealth(input: WorkerHealthInput): WorkerHealthVerdict {
  const problems: string[] = []
  if (input.envMissing.length > 0) problems.push(`missing configuration: ${input.envMissing.join(', ')}`)
  if (!input.redis) problems.push('redis not checked (workers not started)')
  else if (!input.redis.ok) problems.push('redis did not answer PING')
  if (input.workers.length < input.expectedWorkers) {
    problems.push(`only ${input.workers.length} of ${input.expectedWorkers} queue workers started`)
  }
  for (const w of input.workers) {
    if (!w.running) problems.push(`queue worker "${w.name}" is not running`)
    else if (w.paused) problems.push(`queue worker "${w.name}" is paused`)
  }
  return { ok: problems.length === 0, problems }
}

/** How long a host with missing configuration keeps serving 503 before exiting. */
export const CONFIG_FAILURE_EXIT_DEFAULT_MS = 120_000
