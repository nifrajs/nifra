# @nifrajs/runner

Run requests through a nifra app and capture **structured results** — the shared engine behind the
website playground (humans) and the agent run/verify tool (an AI writes code → runs it → sees the
failure → fixes it). It only touches `app.fetch(Request) → Response`, which is Web-standard, so it runs
unchanged in the browser, Bun, Node, Deno, and on the edge — and depends on nothing.

```ts
import { runApp } from "@nifrajs/runner"
import { app } from "./app"

const results = await runApp(app, [
  { path: "/users/1" },
  { method: "POST", path: "/users", body: { name: "Ada" } },
])
// → [{ method, path, ok, status, headers, body, durationMs }, …]
```

- **`runApp(app, requests, options?)`** — run a batch in order; one `RunResult` per request. Never
  throws: a crash on any request becomes that result's `error` and the batch continues.
- **`runRequest(app, spec, options?)`** — a single request.

A plain object/array `body` is JSON-encoded (with a JSON content-type unless you set one); a
string/`Uint8Array` is sent as-is. Relative paths resolve against `options.origin`
(default `http://nifra.local`). Body text is captured up to `options.maxBodyChars` (default 64 KB).

It's a **runner, not a security sandbox**: it calls the app you hand it in-process, with no isolation.
Isolation, when you need it, comes from the host — the browser tab for the playground, your own
process/CI for the agent runner. Don't feed it code you wouldn't already run.
