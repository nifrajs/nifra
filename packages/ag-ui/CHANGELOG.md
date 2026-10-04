# @nifrajs/ag-ui

## 4.0.0

### Minor Changes

- 7b2ff47: Resumable agent streams can be scoped to the caller:

  - New `evidenceOwner` option on `mountAgent` and `mountAgUI`. It returns the caller's user or tenant id, and turns are recorded and replayed under it. Another caller's `Last-Event-ID` reconnect or reused turn id finds none of that caller's turns. It runs before any replay is served, and throwing from it refuses the request.
  - New `scopeAgentEvidenceLog(log, owner)` in `@nifrajs/agent/events` returns the per-owner view of an `AgentEvidenceLog` that the seams use.
  - `mountAgent` answers `400 { error: "invalid_turn_id" }` for a `turnId` that is not a bounded token before it reads the evidence log, matching `mountAgUI`.

### Patch Changes

- d2329f5: A resume continues only the step the turn suspended on. The saved state keeps a SHA-256 digest of the suspended tool input, and a continuation that names another tool, effect id or kind, or replays different input, is refused with `AgentResumeMismatchError` before anything runs (`mountAgent` answers 409). A caller's `approval` answers only a step that suspended for approval; a step suspended for budget or cancellation asks the approval port again.
- 1eb77df: An SSE client that disconnects mid-run no longer ends the turn as failed. With an `evidenceLog`, the run keeps going and records its real result, so a `Last-Event-ID` reconnect replays that result instead of `run_failed`/`RUN_ERROR`. Without an `evidenceLog`, the disconnect aborts `ports.signal` (combined with any signal the caller's ports carry), so the model and tool loop stop and the turn suspends as `cancelled`.
- Updated dependencies [6695a23]
- Updated dependencies [7b2ff47]
- Updated dependencies [422248c]
- Updated dependencies [62115dd]
- Updated dependencies [dbc91b6]
- Updated dependencies [d2329f5]
- Updated dependencies [1eb77df]
- Updated dependencies [dde125b]
- Updated dependencies [72b62fa]
- Updated dependencies [aa44e93]
- Updated dependencies [4a3ee60]
- Updated dependencies [aad6297]
- Updated dependencies [dad0d41]
- Updated dependencies [538adc2]
- Updated dependencies [f47edd1]
- Updated dependencies [df9530a]
- Updated dependencies [3e6973f]
- Updated dependencies [25e8edf]
- Updated dependencies [2b5e5fc]
- Updated dependencies [3b090de]
- Updated dependencies [da7d792]
- Updated dependencies [612a296]
- Updated dependencies [fb14dfa]
- Updated dependencies [8ae97f6]
- Updated dependencies [4af6f39]
- Updated dependencies [ca8b50d]
- Updated dependencies [b00a889]
- Updated dependencies [b53d64f]
- Updated dependencies [66fd712]
- Updated dependencies [9c3d524]
- Updated dependencies [738e7a1]
- Updated dependencies [4801cac]
- Updated dependencies [1b2d53a]
- Updated dependencies [25fe13d]
- Updated dependencies [0852290]
- Updated dependencies [0589dbe]
- Updated dependencies [2e2d8c0]
- Updated dependencies [856f5ce]
- Updated dependencies [18aa5aa]
- Updated dependencies [cfd86b3]
- Updated dependencies [8ff96c9]
- Updated dependencies [4c46199]
- Updated dependencies [eef4932]
- Updated dependencies [6de8686]
- Updated dependencies [d7892ea]
- Updated dependencies [4936309]
- Updated dependencies [ff5a779]
- Updated dependencies [bbdc5a1]
- Updated dependencies [10bc446]
- Updated dependencies [e8270d9]
- Updated dependencies [ff4a062]
- Updated dependencies [43ba944]
- Updated dependencies [46c741a]
- Updated dependencies [7bfa25e]
- Updated dependencies [4936309]
- Updated dependencies [6e257a6]
- Updated dependencies [4a03d30]
- Updated dependencies [8e30090]
- Updated dependencies [28f3aaf]
- Updated dependencies [6d20355]
- Updated dependencies [6907cbe]
- Updated dependencies [b64c3ee]
- Updated dependencies [bda9637]
- Updated dependencies [81c720e]
- Updated dependencies [ed60b23]
- Updated dependencies [a158b74]
- Updated dependencies [ff25d68]
  - @nifrajs/agent@4.0.0
  - @nifrajs/core@4.0.0

## 3.5.0

### Patch Changes

- d5b7c22: Harden request boundaries, error handling, resource limits, signing, and cross-runtime adapters for safer production releases.

## 3.4.0

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
