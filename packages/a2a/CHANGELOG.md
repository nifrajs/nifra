# @nifrajs/a2a

## 3.2.0

### Minor Changes

- fdca0ce: New agent protocol adapter packages. `@nifrajs/a2a` mounts a nifra agent as an Agent2Agent (A2A) 1.0 server: the agent card on GET, the JSON-RPC binding on POST with `SendMessage`, `SendStreamingMessage` (step evidence over SSE), and `GetTask`, plus human-in-the-loop resume through message metadata. `@nifrajs/ag-ui` mounts the same agent as an AG-UI endpoint: `RunAgentInput` in, the AG-UI event stream out - run lifecycle, tool-call and step events, text message events for the output, and a typed continuation for resume. Both are protocol bridges over `@nifrajs/agent` - the request body goes through core's bounded, prototype-guarded framing lane, and the model, state store, and approval transport are injected per request.

### Patch Changes

- 893f7b3: Agent-run tracing and composable telemetry ports.

  `@nifrajs/agent-telemetry` gains `traceAgentRun`: one OpenTelemetry span per bounded agent run, one
  child span per step evidence item, with tool names, effect ids, error codes, and effect-ledger heads
  as span attributes. Only the runner's constrained token-only evidence is exported; telemetry is
  fail-open and can never fail the turn it observes.

  `@nifrajs/agent` gains `combineAgentTelemetry` to fan one run's step evidence out to several
  telemetry ports. The HTTP seams - `mountAgent`, the A2A adapter, and the AG-UI adapter - now compose
  their SSE evidence stream with a caller-injected telemetry port instead of replacing it.
