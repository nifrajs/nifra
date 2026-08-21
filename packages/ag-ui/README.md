# @nifrajs/ag-ui

Mount a nifra agent as an [AG-UI](https://docs.ag-ui.com) (Agent-User Interaction protocol) endpoint: one POST accepting `RunAgentInput`, a stream of AG-UI events out over SSE - run lifecycle, step and tool-call events projected from the runner's step evidence, text message events for the output, and a typed continuation for human-in-the-loop resume.

A protocol bridge over [`@nifrajs/agent`](../agent) - the request body reuses core's single bounded, prototype-guarded trust boundary, and the model, durable state store, and approval transport are injected per request through the same `ports` factory `mountAgent` uses. Dependency-free beyond the two nifra peers.

## Install

```bash
bun add @nifrajs/ag-ui @nifrajs/agent
```

## Mount

```ts
import { server } from "@nifrajs/core"
import { mountAgUI } from "@nifrajs/ag-ui"
import { agent } from "./agent" // an AgentDefinition

const app = server()
mountAgUI(app, {
  agent,
  ports: (c) => ({
    model: myModelPort,        // scope to the request subject
    capabilities: ["search.read"],
    state: myStateStore,       // required for resume
  }),
})
// POST /agui - RunAgentInput in, AG-UI events out (SSE)
```

## Event mapping

| Runner | AG-UI events |
| --- | --- |
| run starts | `RUN_STARTED`, then `CUSTOM { name: "nifra.turn" }` announcing the turn id |
| tool evidence | `TOOL_CALL_START` / `TOOL_CALL_END`, then `TOOL_CALL_RESULT` whose `content` is the token-only outcome `{ "outcome": "committed" \| "failed" \| "denied", "code"? }` |
| model, approval, budget, state evidence | `STEP_STARTED` / `STEP_FINISHED` |
| model text deltas | live `TEXT_MESSAGE_START` / `_CONTENT` (see streaming below) |
| model reasoning deltas | `REASONING_START` / `REASONING_MESSAGE_START` / `_CONTENT` / `_END` / `REASONING_END` |
| model tool-args deltas | provisional `TOOL_CALL_START` + `TOOL_CALL_ARGS`, closed by the call's tool evidence |
| shared state | `STATE_SNAPSHOT` on the seed and `STATE_DELTA` (RFC 6902 ops) per patch (see below) |
| model usage deltas | summed per `(provider, model)` into the `usage: TokenUsage[]` array on `RUN_FINISHED` |
| completed output | `TEXT_MESSAGE_START` / `_CONTENT` / `_END` (unless text was streamed), an optional `MESSAGES_SNAPSHOT` (see below), then `RUN_FINISHED` with `result` and `outcome: { "type": "success" }` |
| completed with a typed error | `RUN_ERROR` |
| suspended | `CUSTOM { name: "nifra.pending" }` with the continuation, then `RUN_FINISHED` with `outcome: { "type": "interrupt", "interrupts": [...] }` |

Evidence-derived events carry the evidence `timestamp`. The runtime is token-only by design - `TOOL_CALL_RESULT` reports the outcome and error code, never the tool's payload.

Agent input is `forwardedProps.input` when present, otherwise the content of the last `role: "user"` message.

## Token streaming

A model port that calls the request's optional `onDelta` callback (see `@nifrajs/agent`'s `AgentModelDelta`) streams live:

- `{ kind: "text", text }` opens a `TEXT_MESSAGE` and streams each chunk as `TEXT_MESSAGE_CONTENT`. When any text was streamed, the terminal text block is suppressed - the streamed text IS the assistant message, so a streaming port must stream all user-visible text. A non-streaming port keeps the single terminal block; nothing changes for it.
- `{ kind: "reasoning", text }` streams a `REASONING_*` message.
- `{ kind: "tool-args", name?, argsText }` opens a provisional `TOOL_CALL_START` (id `<turnId>:call:<n>`) and streams `TOOL_CALL_ARGS`. The tool evidence that follows closes the same call - `TOOL_CALL_END` plus the token-only `TOOL_CALL_RESULT` - instead of opening a second one.
- `{ kind: "usage", provider?, model?, inputTokens?, ... }` never becomes a frame. The counts are summed per `(provider, model)` across the run's model decisions and stamped as the spec `usage: TokenUsage[]` array on the terminal `RUN_FINISHED` (success and interrupt alike); non-finite figures are ignored.

Each stream closes when a different delta kind starts, when tool evidence lands, or at the end of the run. Deltas are transient observer data: a `Last-Event-ID` replay carries evidence frames and the stored, unsuppressed terminal events only - the stored `RUN_FINISHED` keeps its `usage`.

## Shared state

The `ports` factory receives `(c, run)`; `run.sharedState` is the run's `AgentSharedState` channel and `run.turnId` the resolved turn id. `body.state` seeds the document and is announced with an upfront `STATE_SNAPSHOT`; every `patch` from a port or tool executor streams as `STATE_DELTA` carrying the RFC 6902 ops. A first patch on an unseeded document announces itself as a `STATE_SNAPSHOT` instead of a delta against a base the client never saw. The channel is per-run and transient - nothing in it is persisted.

```ts
mountAgUI(app, {
  agent,
  ports: (c, run) => ({
    model: myStreamingModelPort(run.sharedState), // patch progress as the run advances
    capabilities: ["search.read"],
  }),
})
```

With `emitMessagesSnapshot: true`, a successful run also emits `MESSAGES_SNAPSHOT` - the request's `messages` echoed back with the assistant output message appended - before `RUN_FINISHED`. It is off by default: the snapshot echoes client message payloads, and terminal events persist to the evidence log when one is configured.

## Human-in-the-loop resume

A suspended run finishes with `outcome: { "type": "interrupt", "interrupts": [interrupt] }` where the interrupt is:

```jsonc
{
  "id": "<turnId>",
  "reason": "approval",                    // approval | budget | model | cancelled | max_turns
  "toolCallId": "<effectId>",              // present for tool suspensions
  "responseSchema": { /* JSON Schema for the resume payload */ },
  "metadata": { "turnId": "…", "continuation": { "kind": "approval", "tool": "…", "effectId": "…" } }
}
```

Resume with the AG-UI `resume` array. The runtime keeps state token-only - it holds no interrupt registry - so the payload must echo `metadata.continuation`, with the suspended tool's input replayed in `continuation.input`:

```jsonc
{
  "threadId": "thread-1", "runId": "run-2", "messages": [],
  "forwardedProps": { "input": { "prompt": "go" } },
  "resume": [{
    "interruptId": "<interrupt id>",
    "status": "resolved",                  // "cancelled" without an approval resumes as a denial
    "payload": {
      "continuation": { "kind": "approval", "tool": "search.read", "effectId": "…", "input": { "q": "…" } },
      "approval": { "granted": true }
    }
  }]
}
```

The pre-interrupt form - the same `{ continuation, approval? }` object in `forwardedProps.resume` plus `forwardedProps.turnId` - keeps working. A resume that fails validation is ignored and the POST starts a fresh run.

## Resumable streams

Pass an `evidenceLog` to make a dropped SSE connection resumable. Evidence-derived frames then
carry SSE `id: <seq>`; a client reconnects by re-POSTing the same body with a `Last-Event-ID`
header and receives the missed events, rejoining a still-running turn live or replaying the stored
terminal events - the run is never re-executed.

```ts
import { createMemoryAgentEvidenceLog } from "@nifrajs/agent/events"

mountAgUI(app, { agent, ports, evidenceLog: createMemoryAgentEvidenceLog() })
```

The in-memory log is the single-process dev/test reference; a durable, multi-process log is an
adapter implementing the same `AgentEvidenceLog` interface.

The seam performs no authentication or authorization - wrap it with your app's route guards and scope every port in `ports(c)` to the caller.

## Docs

Part of the **[nifra](https://nifra.dev)** full-stack TypeScript framework - one core, five UI libraries, every runtime. Scaffold a new app with `bun create nifra`.
