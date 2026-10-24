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

In an app with [`keepAlive`](https://nifra.dev/docs/keep-alive) routes, the overlay also lists the
kept pages under its request log: each one's path and instance, how long it has been hidden and how
many elements it renders.

Each SSE connection also has a finite pending-byte budget (`maxPendingBytes`, default 64 KiB),
including keep-alive frames. A slow reader that fills that budget is closed and releases its
connection slot. Already queued frames drain before EOF; the overflow frame is dropped. Browser
`EventSource` reconnects automatically. Initial delivery includes only the newest history suffix
that fits the byte budget. This is a recent trace view, so reconnects can have event-id gaps when
older events no longer fit the history or connection budget; it does not guarantee lossless replay.

## For AI agents

Start with [`LLM.md`](./LLM.md) - this package's contract card (the exports you call + its footguns),
one cheap read instead of the whole corpus. For the wider framework: the repo's
[`AGENTS.md`](../../AGENTS.md) is the copy-paste quick reference, and
[`llms-full.txt`](../../llms-full.txt) is the full machine-readable corpus. Run `nifra check` as the
done-gate, or `nifra mcp` to give the agent live project tools.
