# nifra-app

A batteries-included [nifra](https://github.com/nifrajs/nifra) backend starter, scaffolded with
`create-nifra --template batteries` (for a frontend + backend app, use `--template site` instead).
It wires the batteries a real API needs on top of the core framework:

| Package | Used for | Where |
|---|---|---|
| `@nifrajs/schema` | cursor pagination (`t.pageQuery`, `t.paginated`, `paginate`) | `GET /notes` |
| `@nifrajs/jobs` | background work off the request path (retries + backoff) | `POST /notes` → `index-note` |
| `@nifrajs/cache` | single-flight TTL cache | `GET /notes/:id` |
| `@nifrajs/storage` | blob storage (memory adapter; swap for R2/disk) | `PUT /notes/:id/attachment` |

```sh
bun install
bun run dev        # watch + serve on http://localhost:3000
bun test           # run the tests
bun run typecheck  # type-check
```

Security baseline: the scaffold installs response security headers, explicit-origin CORS, a 30-second
request deadline, bounded concurrency, and a 120-request/minute development rate limit. The in-memory
rate-limit store intentionally refuses production unless `NIFRA_ALLOW_MEMORY_RATE_LIMIT=true`; use a
shared store for a multi-instance deployment. If you add cookie sessions, install the signed CSRF
middleware and keep authenticated mutation routes covered by both authenticated and CSRF assurance.

- `src/app.ts` - routes + the `notes` domain, exported (without `listen`) so tests drive it via `app.fetch`.
- `src/index.ts` - boots the server and starts the job worker (`queue.start()`).
- `src/app.test.ts` - exercises pagination, the background job (`queue.drain()`), the cache, and storage.

Swap the in-memory `notes` array for your database, the `MemoryStorage` for `FileStorage`/`R2Storage`, and
the default in-memory cache/job stores for shared (Redis / CF KV) ones when you go multi-process.

Add a typed client from `typeof app`:

```ts
import { client } from "@nifrajs/client"
import type { App } from "./src/app.ts"

const api = client<App>("http://localhost:3000")
const { data } = await api.notes.get({ query: { limit: 20 } })
```
