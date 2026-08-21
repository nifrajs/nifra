# @nifrajs/a2a

Mount a nifra agent as an [Agent2Agent (A2A)](https://a2a-protocol.org) protocol server. The agent card is served on GET, the A2A 1.0 JSON-RPC binding on POST: `SendMessage` runs one bounded agent turn, `SendStreamingMessage` streams step evidence over SSE, `GetTask` projects the stored turn state.

A protocol bridge over [`@nifrajs/agent`](../agent) - the request body reuses core's single bounded, prototype-guarded trust boundary, and the model, durable state store, and approval transport are injected per request through the same `ports` factory `mountAgent` uses. Dependency-free beyond the two nifra peers.

## Install

```bash
bun add @nifrajs/a2a @nifrajs/agent
```

## Mount

```ts
import { server } from "@nifrajs/core"
import { mountA2A } from "@nifrajs/a2a"
import { agent } from "./agent" // an AgentDefinition

const app = server()
mountA2A(app, {
  agent,
  card: { url: "https://api.example.com/a2a", version: "1.0.0" },
  ports: (c) => ({
    model: myModelPort,        // scope to the request subject
    capabilities: ["search.read"],
    state: myStateStore,       // required for GetTask and resume
  }),
})
// GET  /.well-known/agent-card.json  - the agent card
// POST /a2a                          - SendMessage | SendStreamingMessage | GetTask
```

## Task mapping

One A2A task is one agent turn: `taskId` is the runner's `turnId`.

| Run result | Task state |
| --- | --- |
| completed with output | `TASK_STATE_COMPLETED` + an `output` artifact |
| completed with a typed error | `TASK_STATE_FAILED` (error in `metadata`) |
| suspended (approval, budget, model, max turns) | `TASK_STATE_INPUT_REQUIRED` |
| suspended (cancelled) | `TASK_STATE_CANCELED` |

Agent input is `message.metadata.input` when present, otherwise the first `text` part. Structured output returns as a `text` part carrying JSON.

## Human-in-the-loop resume

A suspended task's status message carries the pending continuation in `metadata`. Send it back to continue the same task - the runtime keeps state token-only, so a suspended tool's input must be replayed in `continuation.input`:

```jsonc
{
  "jsonrpc": "2.0", "id": 2, "method": "SendMessage",
  "params": {
    "message": {
      "messageId": "m2", "role": "ROLE_USER", "parts": [],
      "taskId": "<task id from the suspension>",
      "metadata": {
        "input": { "prompt": "go" },
        "resume": {
          "continuation": { "kind": "approval", "tool": "search.read", "effectId": "…", "input": { "q": "…" } },
          "approval": { "granted": true }
        }
      }
    }
  }
}
```

Cross-request registries (cancellation, subscription fan-out, push notifications) are deliberately out of scope for the stateless seam; those spec methods answer `UnsupportedOperationError` (-32004).

The seam performs no authentication or authorization - wrap it with your app's route guards and scope every port in `ports(c)` to the caller.

## Docs

Part of the **[nifra](https://nifra.dev)** full-stack TypeScript framework - one core, five UI libraries, every runtime. Scaffold a new app with `bun create nifra`.

For AI agents, see [`LLM.md`](./LLM.md) and the full corpus
[`../../llms-full.txt`](../../llms-full.txt).
