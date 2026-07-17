# @nifrajs/jobs

Typed background jobs for nifra — enqueue work off the request path, run it with **retries + exponential
backoff + dead-lettering** on a **pluggable store**. The async companion to [`@nifrajs/cron`](../cron)
(cron schedules; jobs does the deferred work — email, webhooks, image processing). **Dependency-free.**

```ts
import { createQueue } from "@nifrajs/jobs"
import { t } from "@nifrajs/schema"

const q = createQueue()

const email = q.define("send-email", {
  input: t.object({ to: t.string(), subject: t.string() }), // validated at enqueue (the trust boundary)
  retries: { attempts: 5 },                                 // 5 tries, exponential backoff, then dead-letter
  async handler({ to, subject }, ctx) {
    await send(to, subject) // ctx = { id, name, attempt }
  },
})

// In a route handler — enqueue and return immediately:
await email.enqueue({ to: "a@b.com", subject: "Welcome" })
await email.enqueue({ to: "b@b.com", subject: "Later" }, { delayMs: 60_000 }) // run in 1 min

// Start the worker on a long-running server (Bun/Node/Deno):
const worker = q.start({ concurrency: 4 })
// graceful shutdown: await worker.stop()
```

`enqueue` is typed against the handler's payload, and `input` (any [Standard Schema](https://standardschema.dev)
validator — `@nifrajs/schema`'s `t`, Zod, Valibot, …) validates it before it's stored, so a bad payload
fails at the call site, not three retries later.

## Retries

Per-job: `retries: number` (attempts) or `{ attempts, backoff }`. A handler that throws is routed to
`onError`, then retried with the backoff delay; after the last attempt it's **dead-lettered**, not lost.

```ts
import { exponentialBackoff, fixedBackoff } from "@nifrajs/jobs"

q.define("flaky", { retries: { attempts: 3, backoff: fixedBackoff(5_000) }, handler })
createQueue({ backoff: exponentialBackoff({ baseMs: 500, maxMs: 60_000, jitter: 0.2 }) }) // queue default
```

## Stores

The default `MemoryJobStore` is single-process — correct for dev and a single server, but not durable and
not multi-worker. Implement the `JobStore` interface (`enqueue` / `lease` / `complete` / `retry` /
`deadLetter` / `counts`) over Redis/Postgres for durability or horizontal workers:

```ts
const q = createQueue({ store: new RedisJobStore(redis) })
```

Leasing is at-least-once: a leased job is hidden for `leaseMs`; a worker that dies mid-job releases it
back automatically. Make handlers **idempotent**.

## Cloudflare Workers

Workers has no long-lived process, so don't call `start()`. Back the queue with a durable store and a
[CF Queue](https://developers.cloudflare.com/queues/), enqueue via the producer binding, and drain from
the consumer:

```ts
export default {
  async queue(_batch, env) {
    const q = createQueue({ store: new D1JobStore(env.DB) })
    await q.process() // one round; the platform schedules invocations
  },
}
```

## API

- `createQueue(options?)` → `Queue` — `{ store?, onError?, now?, defaultAttempts?, backoff? }`.
- `queue.define(name, { handler, input?, retries? })` → typed `JobHandle` with `.enqueue(payload, { delayMs? | runAt? })`.
- `queue.enqueue(name, payload, options?)` — enqueue by name.
- `queue.start({ concurrency?, pollIntervalMs?, leaseMs? })` → `Worker` (`.stop()` drains gracefully).
- `queue.process()` — run one poll round (for Workers / custom drivers). `queue.drain()` — process until empty.
- `queue.counts()` → `{ pending, active, dead }`. `queue.store` — the underlying store.
- Stores: `MemoryJobStore`. Backoff: `exponentialBackoff`, `fixedBackoff`, `noBackoff`.

## For AI agents

Start with [`LLM.md`](./LLM.md) — this package's contract card (the exports you call + its footguns),
one cheap read instead of the whole corpus. For the wider framework: the repo's
[`AGENTS.md`](../../AGENTS.md) is the copy-paste quick reference, and
[`llms-full.txt`](../../llms-full.txt) is the full machine-readable corpus. Run `nifra check` as the
done-gate, or `nifra mcp` to give the agent live project tools.
