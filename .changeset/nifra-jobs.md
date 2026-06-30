---
"@nifrajs/jobs": minor
---

feat(jobs): add `@nifrajs/jobs` — typed background job queue

Enqueue work off the request path and run it with retries, exponential backoff, and dead-lettering on a
pluggable store (`JobStore` + an in-memory default). An in-process worker for Bun/Node/Deno with bounded
concurrency and a graceful `stop()`; on Cloudflare Workers drive a durable store from a CF Queues
consumer via `process()`. The async companion to `@nifrajs/cron`. Dependency-free; payloads validate at
`enqueue` against any Standard Schema (e.g. `@nifrajs/schema`'s `t`).
