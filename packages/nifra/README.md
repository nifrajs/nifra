# nifra

The unscoped meta-entry for the **nifra** full-stack framework. It re-exports [`@nifrajs/core`](https://www.npmjs.com/package/@nifrajs/core), so:

```ts
import { server } from "nifra" // === @nifrajs/core
```

(The schema builder `t` lives in `@nifrajs/schema`; the rest of the framework is under `@nifrajs/*`.)

Most apps start with the scaffolder rather than this package:

```bash
bun create nifra my-app
```

The framework is a set of focused packages under the `@nifrajs/*` scope:

- `@nifrajs/core` — the Bun-native, Web-standard server (`server()`, routing, validation). This package re-exports it.
- `@nifrajs/web` + `@nifrajs/web-{react,vue,svelte,solid,preact,vanilla}` — full-stack SSR on five UI frameworks.
- `@nifrajs/client` — the end-to-end typed client.
- `@nifrajs/schema` · `@nifrajs/middleware` · `@nifrajs/better-auth` · `@nifrajs/otel` · `@nifrajs/cli` … — schema, middleware, auth, tracing, the CLI/MCP toolchain, and more.

Docs + an AI-readable reference: [`/llms.txt`](https://nifra.dev/llms.txt) · [`/llms-full.txt`](https://nifra.dev/llms-full.txt).

MIT.

## For AI agents

Building on nifra with an AI coding agent? The repo's [`AGENTS.md`](../../AGENTS.md) is the copy-paste
quick reference, and [`llms-full.txt`](../../llms-full.txt) is the full machine-readable corpus. Run
`nifra check` as the done-gate, or `nifra mcp` to give the agent live project tools.
