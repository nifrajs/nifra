---
"@nifrajs/jobs": minor
---

Queues take an `instrument` with around-hooks for each enqueue and each attempt, and jobs carry the producer's trace context.

- `createQueue({ instrument })`: `enqueue(info, next)` wraps validation and the store write; `run(info, next)` wraps one attempt, and `next({ trace })` runs the handler with `ctx.trace` set and resolves to `"completed"`, `"retried"` or `"dead-lettered"`. A hook that throws, or never calls `next`, cannot change behavior.
- `JobContext.trace` is the attempt's trace context, so `cache.for(ctx)` and a nested `job.for(ctx).enqueue()` stay in the same trace.
- `job.for(context).enqueue()` stores `context.trace.traceparent` with the job; `EnqueueOptions.traceparent` sets it for producers outside a request. A value that is not a well-formed traceparent is dropped.
- The store contract grows one optional field: `JobStore.enqueue({ traceparent? })` and `StoredJob.traceparent`. `MemoryJobStore` persists it. A store that drops it still runs every job.
- `for(context)` works with an `instrument` alone, without a capability beacon.
