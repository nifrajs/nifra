# Jobs / cron operability

`@nifrajs/jobs` owns scheduling and retries; the `JobStore` owns persistence; `toDeadLetterView`
owns what leaves the server. `@nifrajs/cron` schedules; jobs does the deferred work.

## Delay and eligibility

`enqueue(payload, { delayMs })` becomes eligible `delayMs` after now. `{ runAt }` is an absolute
epoch-ms eligibility time and overrides `delayMs` when both are set. Both are tested with an
injected clock (`now: () => ms`) - see `packages/jobs/test/queue.test.ts` ("a delayed job is not
run before its runAt"). No unique/dedupe key exists: enqueueing the same payload twice runs it
twice. A unique-job semantic stays deferred until two independent consumers prove the need; the
durable dedupe belongs behind a store adapter, not in this package.

## Delivery and leases

Delivery is at-least-once. The worker leases due jobs (`leaseMs`, default 30s); a worker that dies
mid-job without `complete`/`retry` releases the job back automatically. Handlers must therefore be
idempotent. `stop()` drains the in-flight round gracefully. A throw never tears down the loop -
error isolation is tested ("a failing job is dead-lettered while a sibling completes").

## Runtimes

- Bun / Node / Deno: `q.start({ concurrency, pollIntervalMs, leaseMs })`.
- Cloudflare Workers (no long-lived process): do NOT call `start()`. Drive a durable store from a
  CF Queues consumer with `await q.process()` inside the `queue()` handler. `MemoryJobStore` is
  single-process dev only: a restart loses pending jobs and it is unsafe across workers. Bring a
  Redis/Postgres-backed `JobStore` for durability or multiple workers (private depth).

## Poison queues

A job that exhausts `attempts` is moved to the dead-letter set with its last error - it is never
retried unbounded and it never blocks siblings or later work. Proven in
`packages/jobs/test/poison-queue.test.ts`: quarantine after exactly `attempts` tries, loop
survives, new work still runs.

## Dead-letter observability

`store.deadLetters()` is server-side. Project it through `toDeadLetterView()` before it reaches
any endpoint, dashboard, or fixture: `{ id, name, errorFingerprint }` only. The fingerprint is a
deterministic FNV-1a grouping identifier, not a confidentiality or authorization boundary; common
error text can be guessed from an unkeyed fingerprint; it is not an authorization input.
`toQueueHealth(counts())` passes `{ pending, active, dead }` through. Payloads and error text stay in
server logs.

Feeding `agent-app`: the projection output maps 1:1 onto `EvidenceTimelineView` with status
`dead-lettered` (`id` -> `eventId`/`nodeId`, `name` -> run correlation, fingerprint ->
`regressionId`). The browser mapping itself lands with the Workbench review projection (N4) and
must keep the content-free key set - never add payload, error text, or stack to the view.
