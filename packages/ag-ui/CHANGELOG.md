# @nifrajs/ag-ui

## 3.3.0

## 3.2.0

### Minor Changes

- 6eedba9: Widen AG-UI protocol conformance: tool evidence now ends with a `TOOL_CALL_RESULT` carrying the token-only outcome (`{ outcome, code? }`), evidence-derived events carry the evidence `timestamp`, and `RUN_FINISHED` reports the spec `outcome` - `{ type: "success" }` on completion, `{ type: "interrupt", interrupts: [...] }` on suspension with the continuation in the interrupt's `metadata`. Suspended runs resume through the standard `RunAgentInput.resume` array (a `cancelled` entry without an explicit approval resumes as a denial); the `forwardedProps.resume` form keeps working. A new `emitMessagesSnapshot` option (default off) emits a `MESSAGES_SNAPSHOT` of the request messages plus the assistant output before `RUN_FINISHED`.
- 7aee593: Live token streaming and the AG-UI state channel. A streaming model port now turns into live `TEXT_MESSAGE_*` frames (the terminal text block is suppressed when text was streamed), `REASONING_*` messages, and provisional `TOOL_CALL_START` + `TOOL_CALL_ARGS` calls that the following tool evidence closes. The `ports` factory receives `(c, run)` with `run.turnId` and `run.sharedState`: `body.state` seeds the document (announced as `STATE_SNAPSHOT`), and every patch streams as `STATE_DELTA` with RFC 6902 ops. `usage` deltas are summed per `(provider, model)` and stamped as the spec `usage: TokenUsage[]` array on the terminal `RUN_FINISHED` - kept by the stored terminal events, so a replayed stream reports the same totals. Non-streaming ports and existing single-argument `ports` factories are unaffected.
- 3eacb4a: Resumable SSE evidence streams.

  `@nifrajs/agent/events` gains the `AgentEvidenceLog` seam and its in-memory reference
  (`createMemoryAgentEvidenceLog`): per-turn step evidence is recorded, replayable after a `seq`
  cursor, and live-subscribable while the turn runs.

  With an `evidenceLog` configured, `mountAgent` and `mountAgUI` stamp evidence frames with SSE
  `id: <seq>` and serve reconnects: a re-POST of the same turn with a `Last-Event-ID` header replays
  the missed evidence and rejoins a still-running turn live, or replays the stored terminal frame -
  the run is never re-executed. Malformed cursors are rejected with 400, unknown turns with 409.

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
