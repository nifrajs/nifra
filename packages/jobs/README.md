# @nifrajs/jobs

Typed background jobs for nifra - enqueue work off the request path, run it with **retries + exponential
backoff + dead-lettering** on a **pluggable store**. The async companion to [`@nifrajs/cron`](../cron)
(cron schedules; jobs does the deferred work - email, webhooks, image processing). **Dependency-free.**

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

// In a route handler - enqueue and return immediately:
await email.enqueue({ to: "a@b.com", subject: "Welcome" })
await email.enqueue({ to: "b@b.com", subject: "Later" }, { delayMs: 60_000 }) // run in 1 min

// Start the worker on a long-running server (Bun/Node/Deno):
const worker = q.start({ concurrency: 4 })
// graceful shutdown: await worker.stop()
```

`enqueue` is typed against the handler's payload, and `input` (any [Standard Schema](https://standardschema.dev)
validator - `@nifrajs/schema`'s `t`, Zod, Valibot, …) validates it before it's stored, so a bad payload
fails at the call site, not three retries later.

## Retries

Per-job: `retries: number` (attempts) or `{ attempts, backoff }`. A handler that throws is routed to
`onError`, then retried with the backoff delay; after the last attempt it's **dead-lettered**, not lost.
An attempt count (and `createQueue({ defaultAttempts })`) must be a whole number; `NaN`, `Infinity` or
a fraction throws a `RangeError`, and a count below 1 means one attempt.

```ts
import { exponentialBackoff, fixedBackoff } from "@nifrajs/jobs"

q.define("flaky", { retries: { attempts: 3, backoff: fixedBackoff(5_000) }, handler })
createQueue({ backoff: exponentialBackoff({ baseMs: 500, maxMs: 60_000, jitter: 0.2 }) }) // queue default
```

## Stores

The default `MemoryJobStore` is single-process - correct for dev and a single server, but not durable and
not multi-worker. Implement the `JobStore` interface (`enqueue` / `lease` / `complete` / `retry` /
`deadLetter` / `counts`) over Redis/Postgres for durability or horizontal workers:

```ts
const q = createQueue({ store: new RedisJobStore(redis) })
```

Leasing is at-least-once: a leased job is hidden for `leaseMs`; a worker that dies mid-job releases it
back automatically. Make handlers **idempotent**.

While a handler runs, the worker renews its lease about three times per `leaseMs` through the store's
optional `renew(id, until, lease)`, so a job that runs longer than `leaseMs` is not handed to another
worker. A store without `renew` cannot do that: such a job may then run twice, on two workers, though
never twice on the same queue. Each `lease` may also return a `lease` token on the job; the queue
passes it back to `complete` / `retry` / `deadLetter` / `renew`, so a store can ignore a worker whose
lease another worker has since taken. `MemoryJobStore` does both.

A job's `timeoutMs` bounds each attempt: one still running after that many ms fails with a
`JobTimeoutError` (then retries or dead-letters), frees its worker slot, and aborts `ctx.signal`. Pass the
signal on to `fetch` or your driver, since a handler that ignores it keeps running unobserved.
`timeoutMs` must be below the worker's `leaseMs`: `start()` (and a later `define()`) throws a
`RangeError` otherwise.

```ts
q.define("render", { timeoutMs: 10_000, async handler(id, ctx) { await fetch(url(id), { signal: ctx.signal }) } })
```

`enqueue` may pass an optional `traceparent` (the producer's W3C trace context); a store should persist
it and hand it back on every `lease`. A store that drops it still runs every job - a traced run only
loses its link to the producer. `jobStoreCertificationProfile({ traceparent: true })` from
`@nifrajs/testing/certification` checks the round trip as an optional capability.

The queue remains agent-agnostic. `@nifrajs/coding-agent` can place content-free run-dispatch
identities in a dedicated `JobStore`, but this package does not import or define agent concepts. A
`MemoryJobStore` is disposable single-process storage; production durability, authorization,
retention, reconciliation, and worker coordination belong to the caller's operated adapter. No
exactly-once delivery guarantee is implied by a lease.

## Tracing

`instrument` takes around-hooks for each enqueue and each attempt. `jobTracing()` from
`@nifrajs/otel/jobs` fills them with OpenTelemetry messaging spans:

```ts
import { jobTracing } from "@nifrajs/otel/jobs"

const q = createQueue({ store, instrument: jobTracing({ exporter }) })
const email = q.define("send-email", {
  async handler({ to }, ctx) {
    await cache.for(ctx).wrap(`tmpl:welcome`, loadTemplate) // ctx.trace keeps the cache span in the trace
    await send(to)
  },
})

app.post("/signup", async (c) => ({ id: await email.for(c).enqueue({ to: c.body.email }) }))
```

- `email.for(c).enqueue()` stores `c.trace.traceparent` with the job. Outside a request, pass
  `{ traceparent }` to `enqueue`. A value that is not a well-formed traceparent is dropped.
- Each enqueue is a `send send-email` producer span; each attempt a `process send-email` consumer span,
  a child of the send span (plus a link to it). Retries are separate process spans; the attempt that
  dead-letters the job is marked `nifra.job.dead_lettered`.
- The handler sees `ctx.trace` (the process span), so `cache.for(ctx)` and a nested
  `job.for(ctx).enqueue()` stay in the same trace.
- `for(context)` needs a `beacon`, an `instrument`, or both.

A hook that throws, or never calls `next`, cannot change behavior: the work still runs, uninstrumented.

## Cloudflare Workers

Workers has no long-lived process, so don't call `start()`. Back the queue with a durable store and a
[CF Queue](https://developers.cloudflare.com/queues/), enqueue via the producer binding, and drain from
the consumer:

```ts
export default {
  async queue(_batch, env) {
    const q = createQueue({ store: new D1JobStore(env.DB), instrument: jobTracing({ exporter }) })
    await q.process() // one round; the platform schedules invocations
  },
}
```

When a CF Queue message carries the job itself rather than a pointer into the store, put the
`traceparent` in the message body next to the payload and hand it back as `StoredJob.traceparent`, so
the run stays in the producer's trace.

## API

- `createQueue(options?)` → `Queue` - `{ store?, onError?, now?, defaultAttempts?, backoff?, beacon?, capabilities?, instrument? }`.
- `queue.define(name, { handler, input?, retries?, timeoutMs? })` → typed `JobHandle` with `.enqueue(payload, { delayMs? | runAt?, traceparent? })` and `.for(context)`.
- `queue.enqueue(name, payload, options?)` - enqueue by name.
- `queue.start({ concurrency?, pollIntervalMs?, leaseMs? })` → `Worker` (`.stop()` drains gracefully). Each poll fills the slots free at that moment, so one slow job holds only its own slot.
- `queue.process()` - run one poll round (for Workers / custom drivers). `queue.drain()` - process until nothing is due or in flight.
- `queue.counts()` → `{ pending, active, dead }`. `queue.store` - the underlying store.
- Stores: `MemoryJobStore`. Backoff: `exponentialBackoff`, `fixedBackoff`, `noBackoff`.

## For AI agents

Start with [`LLM.md`](./LLM.md) - this package's contract card (the exports you call + its footguns),
one cheap read instead of the whole corpus. For the wider framework: the repo's
[`AGENTS.md`](../../AGENTS.md) is the copy-paste quick reference, and
[`llms-full.txt`](../../llms-full.txt) is the full machine-readable corpus. Run `nifra check` as the
done-gate, or `nifra mcp` to give the agent live project tools.
