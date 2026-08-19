# @nifrajs/agent-protocol

Small, backend-neutral contracts for local coding-agent sessions.

The package contains versioned session snapshots, streamed assistant/tool/approval
events, bounded live event streams, and backend interfaces. It has no runtime
dependencies and does not import Nifra framework packages, model SDKs, or UI code.

```ts
import { createAgentEventStream } from "@nifrajs/agent-protocol"

const events = createAgentEventStream(256)
events.push(/* a versioned AgentEvent */)
```

Use `@nifrajs/pi` for the Pi backend or implement `AgentBackend` for another
runtime. The protocol is intentionally small so CLI, desktop, mobile, and CI
clients can share it without pulling in the Nifra application framework.

For AI agents, see [`LLM.md`](./LLM.md) and the full corpus
[`../../llms-full.txt`](../../llms-full.txt).
