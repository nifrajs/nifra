# @nifrajs/agent-telemetry

Child-span telemetry for AI tool calls made through Nifra tool and MCP endpoints.

```sh
bun add @nifrajs/agent-telemetry @nifrajs/otel
```

```ts
import { agentTelemetry, consoleAgentExporter } from "@nifrajs/agent-telemetry"

app.use(agentTelemetry({ exporter: consoleAgentExporter() }))
```

Requests under `/_nifra/tool/*` and requests to `/mcp` receive tool-name, input-size, output-size,
duration, and status observations. When `@nifrajs/otel` owns the request observation, tool spans are
attached as children; otherwise the plugin creates a standalone observation. Other routes pass through.

## Tracing agent runs

`traceAgentRun` turns a `@nifrajs/agent` run's step evidence into an OpenTelemetry trace: one
`nifra.agent.run` span per run, one child span per evidence item, with tool names, effect ids, error
codes, and effect-ledger heads carried as span attributes. Only the runner's constrained evidence
fields are exported - prompts, tool inputs, and outputs cannot enter a trace.

```ts
import { traceAgentRun } from "@nifrajs/agent-telemetry"
import { combineAgentTelemetry, runAgent } from "@nifrajs/agent"

const trace = traceAgentRun({ agent: agent.name, turnId, exporter })
const result = await runAgent(agent, input, {
  ...ports,
  telemetry: combineAgentTelemetry(ports.telemetry, trace.telemetry),
})
trace.end(result)
```

Model evidence arrives as a started/terminal pair and becomes one timed `nifra.agent.model` span;
tool, approval, budget, and state evidence are terminal-only and become instant children. Pass
`parent` (for example the enclosing request observation's `context`) to nest runs under the HTTP
span, or `traceparent` to continue an inbound W3C trace; `trace.context` is the run span's identity,
forwardable with `traceHeaders`. Telemetry is fail-open: a throwing exporter never fails the turn.

## For AI agents

Start with [`LLM.md`](./LLM.md) - this package's contract card (the exports you call + its footguns),
one cheap read instead of the whole corpus. For the wider framework: the repo's
[`AGENTS.md`](../../AGENTS.md) is the copy-paste quick reference, and
[`llms-full.txt`](../../llms-full.txt) is the full machine-readable corpus. Run `nifra check` as the
done-gate, or `nifra mcp` to give the agent live project tools.
