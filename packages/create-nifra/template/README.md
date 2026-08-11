# nifra-app

A starter [nifra](https://github.com/nifra) app, scaffolded with `create-nifra`.

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

- `src/app.ts` - your routes (exported without `listen`, so tests drive it via `app.fetch`).
- `src/index.ts` - boots the server.
- `src/app.test.ts` - an example test.

Add a typed client from `typeof app`:

```ts
import { client } from "@nifrajs/client"
import type { App } from "./src/app.ts"

const api = client<App>("http://localhost:3000")
const { data } = await api.users({ id: "42" }).get()
```
