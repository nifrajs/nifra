# @nifrajs/client

A browser-safe, **end-to-end-typed** client for [nifra](../../README.md) servers — an
Eden-style proxy that **never throws**.

```sh
bun add @nifrajs/client
```

```ts
import { client } from "@nifrajs/client"
import type { App } from "./server" // `typeof app` from @nifrajs/core

const api = client<App>("http://localhost:3000")

const { ok, status, data, error } = await api.users({ id: "42" }).get()
//                                          ^? typed from the server route
```

- **Zero codegen.** Types flow from `typeof app` (coupled) — or from a contract via
  `client(contract, url)` (decoupled), with no dependency on the server's source.
- **Proxy chaining.** Path segments are properties, `:params` are calls, verbs are
  methods: `api.users({ id }).posts({ postId }).get()`. The root is `api.index`.
- **Result, never exceptions.** Every call resolves to `{ ok, status, data, error }`,
  so the failure path is in the types. Bodies are positional (`api.users.post({ name })`);
  pass `{ query, headers, signal }` as call options.
- **Environment-agnostic.** No Bun/Node APIs — runs in the browser, workers, or any
  runtime with `fetch`.

ESM-only. MIT.

## For AI agents

Building on nifra with an AI coding agent? The repo's [`AGENTS.md`](../../AGENTS.md) is the copy-paste
quick reference, and [`llms-full.txt`](../../llms-full.txt) is the full machine-readable corpus. Run
`nifra check` as the done-gate, or `nifra mcp` to give the agent live project tools.
