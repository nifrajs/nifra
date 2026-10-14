# @nifrajs/jobs

## 5.2.1

No changes in this release.

## 5.2.0

### Patch Changes

- 9498cf8: The package ships its `CHANGELOG.md`, so the installed package has the notes for every version, as the GitHub release does. Before, the tarball held only the code, `README.md`, `LICENSE` and `package.json`.

## 5.1.0

### Patch Changes

- abb4354: The package now ships the MIT `LICENSE` text, as every other @nifrajs package already did.
- 158174d: `define({ retries })`, `define({ retries: { attempts } })` and `createQueue({ defaultAttempts })` now throw a `RangeError` for an attempt count that is not a whole number. Before, `retries: NaN` (or a `NaN` default) made the attempt limit `NaN`, so a failing job was retried forever and never dead-lettered. A count below 1 still means one attempt.
- 37eaebd: A job whose handler runs longer than the worker's `leaseMs` is no longer run a second time while the first run is still going. The worker now renews a running job's lease (about three times per `leaseMs`) through a new optional `JobStore.renew(id, until, lease)`, never starts a job it is already running when the store hands it back, and passes the lease token a store returns on `StoredJob.lease` to `complete`, `retry` and `deadLetter`, so a worker whose lease was taken over cannot settle the job. `MemoryJobStore` implements both; a custom store keeps working unchanged and gains the cross-worker protection once it implements them. `start()` (and a `define()` after it) now throws a `RangeError` when a job's `timeoutMs` is not below `leaseMs`; before, that setup let the job be leased again mid-attempt. Delivery stays at-least-once.

## 5.0.0

### Minor Changes

- 4d5208c: A worker no longer leaves free slots idle behind its slowest job. Each poll now leases due jobs into the slots free at that moment, and a slot frees as soon as its own job settles. Before, a poll waited until every job it had leased was done, so one long job held all `concurrency` slots. `process()` and `drain()` share those slots, and `process()` still waits for in-flight jobs when it has nothing new to start.

  A job definition takes `timeoutMs`. An attempt still running after that time fails with the new `JobTimeoutError`, is retried or dead-lettered like a throw, and frees its slot. The handler's new `ctx.signal` aborts with that error.

### Patch Changes

- 8118abd: A store that fails to record a finished job no longer sends that job back through the retry path. The handler had already succeeded, but the failure counted as the handler's: it was retried (running it again) or, on its last attempt, dead-lettered. The store error now surfaces as a store failure, and the lease decides any redelivery.
- 22581a1: A poll round settles only after every job it leased has settled, so a store failure in one job no longer frees the round's concurrency or lets `worker.stop()` return while a sibling handler is still running. `queue.drain()` runs its rounds through `queue.process()`, so concurrent drains and the worker's polls never run more than `concurrency` jobs at once.

## 4.0.2

## 4.0.1

## 4.0.0

### Minor Changes

- 1afbe9f: Queues take an `instrument` with around-hooks for each enqueue and each attempt, and jobs carry the producer's trace context.

  - `createQueue({ instrument })`: `enqueue(info, next)` wraps validation and the store write; `run(info, next)` wraps one attempt, and `next({ trace })` runs the handler with `ctx.trace` set and resolves to `"completed"`, `"retried"` or `"dead-lettered"`. A hook that throws, or never calls `next`, cannot change behavior.
  - `JobContext.trace` is the attempt's trace context, so `cache.for(ctx)` and a nested `job.for(ctx).enqueue()` stay in the same trace.
  - `job.for(context).enqueue()` stores `context.trace.traceparent` with the job; `EnqueueOptions.traceparent` sets it for producers outside a request. A value that is not a well-formed traceparent is dropped.
  - The store contract grows one optional field: `JobStore.enqueue({ traceparent? })` and `StoredJob.traceparent`. `MemoryJobStore` persists it. A store that drops it still runs every job.
  - `for(context)` works with an `instrument` alone, without a capability beacon.

### Patch Changes

- db535da: A worker started with `start()` keeps polling when the store's `lease` throws: the failure goes to the new `onPollError` option (default `console.error`) instead of becoming an unhandled rejection, and `stop()` resolves even if the last round failed.

## 3.5.0

### Minor Changes

- 82c3018: Add content-free dead-letter projections (`toDeadLetterView`, `toQueueHealth`) for queue triage without exposing payloads or error text; an OpenAPI 3.x inventory importer (`importOpenAPI`, `diffOpenApiInventory`) so export/import roundtrips prove the route table survives in CI; and a seeded hostile prediction/projection lab (`runPredictionLab`, `assertPredictionLab`) covering stale versions, expiry, prototype-grafting and non-atomic patches, commit conflicts, rollback paths, and WebMCP/MCP projection parity. `nifra check` also flags hand-rolled `EventSource`/`WebSocket` to the app's own API under the existing typed-client rule.

## 3.4.0

## 3.3.0

## 3.2.0

## 3.1.0

## 3.0.0

## 2.14.1

## 2.14.0

## 2.13.0

## 2.12.1

## 2.12.0

## 2.11.0

## 2.10.0

## 2.9.1

## 2.9.0

## 2.8.2

### Patch Changes

- f7d68e8: Numeric limit options (body/payload byte caps, TTLs, cache sizes, concurrency, ISR revalidate windows) are now validated at construction and throw a `RangeError` on non-finite or out-of-range values instead of silently disabling the bound - a `NaN` cap previously made `size > max` comparisons fail open. JWT `requiredClaims` now checks own properties only, so inherited names like `toString` no longer satisfy a required claim. `@nifrajs/mcp-db` gates multi-statement input with a real tokenizer, bounds `run_query` materialization to `maxRows + 1` via a wrapping subquery, and skips SQLite planner pseudo-nodes when verifying the table allowlist. `nifra scaffold` refuses to write through symlinked route directories.

## 2.8.1

## 2.8.0

## 2.7.1

## 2.7.0

## 2.6.1

## 2.6.0

## 2.5.0

## 2.4.0

## 2.3.0

### Minor Changes

- e8aeab9: Cache, queue and storage operations can produce capability evidence.

  ```ts
  import { useCapability } from "@nifrajs/core/capabilities";

  const cache = createCache({ beacon: useCapability });
  await cache.for(c).set(key, value); // announces `cache.write`, and fails closed if undeclared
  ```

  Static provenance answers what a MODULE can reach, so its evidence is as broad as the module holding
  it. A call answers which ROUTE did what. That is the gap these close: the token is produced by the
  operation rather than by a policy file asserting an import implies it.

  `useCapability` is passed in rather than imported, so all three packages keep their zero dependencies -
  a cache should not pull the server into a bundle that only wanted a cache. Nothing changes for existing
  code: the unbound `cache.set(...)`, `job.enqueue(...)` and `adapter.put(...)` paths are untouched, and
  `for(context)` without a configured beacon throws rather than handing back something that quietly
  produces no evidence.

  Storage takes a `withCapabilityBeacon(adapter, { beacon })` wrapper instead of an interface method,
  because `StorageAdapter` is meant to be implemented outside the package and a new method would break
  every adapter already written. `cache.wrap` announces read AND write, since a miss writes and which one
  happens is not knowable before the call.

## 2.2.0

## 2.1.0

## 2.0.0

## 1.13.0

## 1.12.0

## 1.11.0

## 1.10.0

## 1.9.1

## 1.9.0

## 1.8.0

## 1.7.0

## 1.6.0

## 1.5.0

## 1.4.0

## 1.3.1

## 1.3.0

## 1.2.2

## 1.2.1

## 1.2.0

## 1.1.0

### Minor Changes

- 56c3ee7: feat(jobs): add `@nifrajs/jobs` - typed background job queue

  Enqueue work off the request path and run it with retries, exponential backoff, and dead-lettering on a
  pluggable store (`JobStore` + an in-memory default). An in-process worker for Bun/Node/Deno with bounded
  concurrency and a graceful `stop()`; on Cloudflare Workers drive a durable store from a CF Queues
  consumer via `process()`. The async companion to `@nifrajs/cron`. Dependency-free; payloads validate at
  `enqueue` against any Standard Schema (e.g. `@nifrajs/schema`'s `t`).
