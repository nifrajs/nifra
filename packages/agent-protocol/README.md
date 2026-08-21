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

## Version 1 compatibility

Version 1 is additive. Hosts advertise capabilities and clients use only the negotiated intersection;
an unsupported command is a stable `feature_unsupported` result. Optional fields are ignored by older
peers, while a cursor gap returns `resync_required` instead of silently skipping evidence. A future
major requires a recorded semantic incompatibility, dual decoders, cross-version fixtures, and an
approved migration plan.

Run evidence and lifecycle values are structural only: identifiers, statuses, counters, timestamps,
digests, and opaque references. Prompts, model output, tool arguments, and filesystem paths do not
belong in these public contracts.

For AI agents, see [`LLM.md`](./LLM.md) and the full corpus
[`../../llms-full.txt`](../../llms-full.txt).
