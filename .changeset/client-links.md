---
"@nifrajs/client": minor
---

The typed client gains request/response interceptors, a timeout, and a safe retry policy in `ClientOptions`.

- `onRequest` runs before each attempt and can return headers to merge - `await`ed, so async auth-token refresh works. `onResponse` observes the final response.
- `timeoutMs` aborts a slow call, surfacing as `{ ok: false, status: 0 }` with a `timeout` error (never a throw), combined with any per-call `signal`.
- `retry` enables automatic retries that are safe by construction: only idempotent methods (`GET/HEAD/OPTIONS/PUT/DELETE`) and only transient statuses (`502/503/504` by default) plus network errors are retried, with exponential backoff and jitter. A 4xx/429 and a non-idempotent method are never retried, so a retry can't duplicate a side effect. Off unless configured.
