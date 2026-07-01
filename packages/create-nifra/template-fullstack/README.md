# nifra-app

A full-stack [nifra](https://github.com/nifra) starter, scaffolded with `create-nifra --template fullstack`.
It wires the batteries a real app needs on top of the core framework:

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

- `src/app.ts` — routes + the `notes` domain, exported (without `listen`) so tests drive it via `app.fetch`.
- `src/index.ts` — boots the server and starts the job worker (`queue.start()`).
- `src/app.test.ts` — exercises pagination, the background job (`queue.drain()`), the cache, and storage.

Swap the in-memory `notes` array for your database, the `MemoryStorage` for `FileStorage`/`R2Storage`, and
the default in-memory cache/job stores for shared (Redis / CF KV) ones when you go multi-process.

Add a typed client from `typeof app`:

```ts
import { client } from "@nifrajs/client"
import type { App } from "./src/app.ts"

const api = client<App>("http://localhost:3000")
const { data } = await api.notes.get({ query: { limit: 20 } })
```
