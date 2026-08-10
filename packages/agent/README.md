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

Execution policies can be required by a tool contract. `createLocalProcessAdapter` applies cwd and
environment filtering, timeouts, and cancellation to child processes. The local adapter is NOT a
security boundary. Without OS-level sandboxing it contains crashes and accidents, not hostile code.

For the compact agent contract, see [`LLM.md`](./LLM.md). The full machine-readable corpus is
[`../../llms-full.txt`](../../llms-full.txt).
