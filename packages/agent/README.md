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

Several telemetry consumers can observe the same run: `combineAgentTelemetry(a, b, ...)` fans step
evidence out to every port in order, so an SSE evidence stream and an exporter (for example
`@nifrajs/agent-telemetry`'s `traceAgentRun`) compose instead of displacing each other. The HTTP
seams (`mountAgent`, `@nifrajs/a2a`, `@nifrajs/ag-ui`) compose their streaming evidence with any
telemetry port supplied through `ports`.

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
