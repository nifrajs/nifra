/**
 * @nifrajs/cron — runtime-agnostic in-process cron for long-running nifra servers (Bun/Node/Deno).
 *
 *   import { createScheduler } from "@nifrajs/cron"
 *
 *   const cron = createScheduler()
 *     .add("nightly-digest", "0 2 * * *", () => sendDigest())
 *     .add("poll-feed", "*\/5 * * * *", async () => { await poll() })
 *   cron.start()              // checks every 15s; fires each job once per matching minute
 *   // on shutdown: cron.stop()
 *
 * Standard 5-field expressions (`minute hour day-of-month month day-of-week`, local time) + the
 * common `@macros` (`@hourly`/`@daily`/`@weekly`/`@monthly`/`@yearly`). Overlap-safe (a still-running
 * job is skipped, not stacked), error-isolated (a throw goes to `onError`, never kills the loop),
 * graceful `stop()`. Dependency-free.
 *
 * Cloudflare Workers has no long-lived process — there, use the platform `scheduled` trigger via
 * `toFetchHandler(app, { scheduled })` (`@nifrajs/core`), not this.
 */

export { CronError, type CronFields, matches, nextRun, parseCron } from "./parse.ts"
export {
  type CronHandler,
  createScheduler,
  type Scheduler,
  type SchedulerOptions,
} from "./scheduler.ts"
