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

## For AI agents

Start with [`LLM.md`](./LLM.md) — this package's contract card (the exports you call + its footguns),
one cheap read instead of the whole corpus. For the wider framework: the repo's
[`AGENTS.md`](../../AGENTS.md) is the copy-paste quick reference, and
[`llms-full.txt`](../../llms-full.txt) is the full machine-readable corpus. Run `nifra check` as the
done-gate, or `nifra mcp` to give the agent live project tools.
