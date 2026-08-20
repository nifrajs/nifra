---
"@nifrajs/agent-telemetry": minor
"@nifrajs/agent": minor
"@nifrajs/a2a": patch
"@nifrajs/ag-ui": patch
---

Agent-run tracing and composable telemetry ports.

`@nifrajs/agent-telemetry` gains `traceAgentRun`: one OpenTelemetry span per bounded agent run, one
child span per step evidence item, with tool names, effect ids, error codes, and effect-ledger heads
as span attributes. Only the runner's constrained token-only evidence is exported; telemetry is
fail-open and can never fail the turn it observes.

`@nifrajs/agent` gains `combineAgentTelemetry` to fan one run's step evidence out to several
telemetry ports. The HTTP seams - `mountAgent`, the A2A adapter, and the AG-UI adapter - now compose
their SSE evidence stream with a caller-injected telemetry port instead of replacing it.
