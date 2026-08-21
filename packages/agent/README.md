# @nifrajs/agent

Provider-neutral, typed, resumable agent turns over Nifra tool contracts.

The package owns one bounded turn at a time. Model providers, state, approvals, budgets, idempotency,
and telemetry are ports. The package never imports a model vendor and its state adapter stores only
token-only turn evidence.

```ts
import { createAgentState, runAgent } from "@nifrajs/agent"

const result = await runAgent(definition, { value: input }, ports, {
  state: createAgentState("support-1"),
  maxTurns: 8,
})
```

The public in-memory adapters are for local development and tests. Durable state, provider
credentials, and operated policy remain adapter concerns.

Gateway and deployment contracts are deliberately provider-neutral. Retry, fallback, budget,
deadline, workspace, and hostile-code isolation claims are admitted only from a host-approved
capability report. The local and replay reference profiles are not hostile-code sandboxes, and no
public package loads provider credentials or promises durable execution.

Several telemetry consumers can observe the same run: `combineAgentTelemetry(a, b, ...)` fans step
evidence out to every port in order, so an SSE evidence stream and an exporter (for example
`@nifrajs/agent-telemetry`'s `traceAgentRun`) compose instead of displacing each other. The HTTP
seams (`mountAgent`, `@nifrajs/a2a`, `@nifrajs/ag-ui`) compose their streaming evidence with any
telemetry port supplied through `ports`.

A model port can stream: when the caller wires an `AgentDeltaSink` into `ports.deltas`, every model
request carries an optional `onDelta` callback the port may call per chunk - user-visible text,
reasoning text, the raw argument text of the tool call being formed, or a `usage` delta reporting
the decision's settled token counts (optionally attributed to a provider and model, for observers
to sum across the run). Deltas are transient
observer data for live UIs (`@nifrajs/ag-ui` projects them onto `TEXT_MESSAGE_*`, `REASONING_*`,
and `TOOL_CALL_ARGS` frames): they are never validated, persisted, or replayed, and a failing sink
never fails the model step. `combineAgentDeltaSinks(a, b, ...)` fans deltas out the way
`combineAgentTelemetry` fans evidence.

`createAgentSharedState(initial)` is the run's shared UI state channel: a JSON document any port or
tool executor patches with RFC 6902 operations (`add`, `replace`, `remove`), with subscribers
observing every applied batch. Patches apply atomically - an invalid op rejects the whole batch -
and prototype-grafting pointer segments are refused. The document is per-run observer data, not
turn state: nothing in it is persisted by the runtime. `@nifrajs/ag-ui` projects the channel onto
AG-UI `STATE_SNAPSHOT`/`STATE_DELTA` events.

SSE streams are resumable: give `mountAgent` (or `@nifrajs/ag-ui`'s `mountAgUI`) an `evidenceLog`
and `step` frames carry `id: <seq>`. A client that loses the connection re-POSTs the same `turnId`
with a `Last-Event-ID` header and receives the missed evidence, rejoining a still-running turn live
or replaying the stored terminal frame - the run is never re-executed.
`createMemoryAgentEvidenceLog` (from `@nifrajs/agent/events`) is the single-process dev/test
reference; a durable, multi-process log is an adapter implementing the same `AgentEvidenceLog`
interface.

Execution policies can be required by a tool contract. `createLocalProcessAdapter` applies cwd and
environment filtering, timeouts, and cancellation to child processes. The local adapter is NOT a
security boundary. Without OS-level sandboxing it contains crashes and accidents, not hostile code.

For the compact agent contract, see [`LLM.md`](./LLM.md). The full machine-readable corpus is
[`../../llms-full.txt`](../../llms-full.txt).
