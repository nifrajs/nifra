# @nifrajs/devtools

Interactive request-trace DevTools for `nifra dev`, with a secured SSE stream and browser overlay.

```sh
bun add -d @nifrajs/devtools
```

```ts
import { devtools } from "@nifrajs/devtools"

app.use(devtools())
```

The plugin is enabled by default only when `NODE_ENV=development`. It records a bounded event buffer
and serves the overlay stream at `/_nifra/devtools`; remote hosts and cross-origin access stay denied
unless explicitly allowed. Leave it unregistered in production for zero request-path overhead.

## For AI agents

Start with [`LLM.md`](./LLM.md) — this package's contract card (the exports you call + its footguns),
one cheap read instead of the whole corpus. For the wider framework: the repo's
[`AGENTS.md`](../../AGENTS.md) is the copy-paste quick reference, and
[`llms-full.txt`](../../llms-full.txt) is the full machine-readable corpus. Run `nifra check` as the
done-gate, or `nifra mcp` to give the agent live project tools.
