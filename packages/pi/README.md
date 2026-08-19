# @nifrajs/pi

Lightweight Pi JSONL/RPC adapter for the Nifra agent protocol.

It starts Pi in headless RPC mode, maps Pi lifecycle, assistant, tool,
compaction, extension, and error events into `@nifrajs/agent-protocol`, and
supports cancellation, reload, session identity, and bounded event buffering.

Reload defaults to a process restart with the same Pi session ID. This is the
reliable reload primitive in Pi's documented RPC protocol: the transcript stays
in Pi's session store while the new process loads changed extensions. The tiny
public-API bridge is still loaded for interactive Pi use. Set
`reloadCommand: "prompt"` only for an RPC implementation that dispatches slash
commands, or `reloadCommand: "rpc"` for one that provides a top-level reload
command. Set `enableReloadBridge: false` when supplying a custom bridge.

Set `enableNifraTools: true` to load the separately packaged Pi extension with
`nifra_context`, `nifra_check`, `nifra_assure`, and `nifra_test` tools. The
default is off so embedding Pi stays minimal.

```ts
import { PiBackend } from "@nifrajs/pi"

const backend = new PiBackend()
const session = await backend.createSession({ cwd: process.cwd() })
for await (const event of backend.send({ sessionId: session.id, message: "inspect this project" })) {
  console.log(event.type)
}
```

Pi stays an optional dependency of the agent product. Nothing in this package is
reachable from `@nifrajs/core`, `@nifrajs/client`, `@nifrajs/web`, or
`@nifrajs/schema`.

For AI agents, see [`LLM.md`](./LLM.md) and the full corpus
[`../../llms-full.txt`](../../llms-full.txt).
