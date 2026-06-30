/**
 * @nifrajs/jobs — typed background jobs for nifra: enqueue work, run it off the request path with
 * retries + backoff + dead-lettering, on a pluggable store. The async companion to `@nifrajs/cron`
 * (cron schedules; jobs does the deferred work — email, webhooks, image processing). Dependency-free;
 * runs on Bun/Node/Deno via an in-process worker. On Cloudflare Workers, drive a durable store from a
 * CF Queues consumer (`await q.process()`); see the README.
 *
 *   import { createQueue } from "@nifrajs/jobs"
 *
 *   const q = createQueue()
 *   const email = q.define("send-email", { async handler({ to }: { to: string }) { await send(to) } })
 *   await email.enqueue({ to: "a@b.com" })
 *   q.start()
 */

export { type ExponentialOptions, exponentialBackoff, fixedBackoff, noBackoff } from "./backoff.ts"
export { MemoryJobStore } from "./memory-store.ts"
export {
  createQueue,
  JobError,
  JobValidationError,
  type Queue,
  type QueueOptions,
  type Worker,
  type WorkerOptions,
} from "./queue.ts"
export type {
  Backoff,
  EnqueueOptions,
  JobContext,
  JobCounts,
  JobDefinition,
  JobHandle,
  JobHandler,
  JobStore,
  RetryPolicy,
  StandardResult,
  StandardSchemaV1,
  StoredJob,
} from "./types.ts"
