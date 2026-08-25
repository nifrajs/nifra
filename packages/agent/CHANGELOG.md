# @nifrajs/agent

## 3.2.0

### Minor Changes

- 7aee593: Model-port streaming and a shared UI state channel. `ports.deltas` (an `AgentDeltaSink`) puts an optional `onDelta` callback on every model request; a streaming port calls it per chunk - text, reasoning, tool-call argument text, or a `usage` delta reporting the decision's settled token counts (optionally attributed to a provider and model). Deltas are transient observer data: never validated, persisted, or replayed, and a failing sink never fails the model step. `combineAgentDeltaSinks` fans deltas out like `combineAgentTelemetry` fans evidence. `createAgentSharedState(initial)` adds a per-run JSON document patched with RFC 6902 operations (`add`/`replace`/`remove`, atomic per batch, prototype-grafting pointer segments refused) and observed via `subscribe`.
- 8486ed8: Add `mountAgent` (`@nifrajs/agent/mount`) - a one-call HTTP seam that exposes an agent definition as `POST /agent`, reading the request body through core's bounded, proto-guarded framing lane and driving the bounded runner. It negotiates a Server-Sent Events evidence stream on `Accept: text/event-stream` (one `step` event per evidence item, then a final `result`) and returns the projected run result as JSON otherwise. Ports - model, state store, approval transport, capabilities, budgets - are supplied per request through a factory, so the seam performs no I/O of its own and carries no credentials or durable state.
- 3eacb4a: Resumable SSE evidence streams.

  `@nifrajs/agent/events` gains the `AgentEvidenceLog` seam and its in-memory reference
  (`createMemoryAgentEvidenceLog`): per-turn step evidence is recorded, replayable after a `seq`
  cursor, and live-subscribable while the turn runs.

  With an `evidenceLog` configured, `mountAgent` and `mountAgUI` stamp evidence frames with SSE
  `id: <seq>` and serve reconnects: a re-POST of the same turn with a `Last-Event-ID` header replays
  the missed evidence and rejoins a still-running turn live, or replays the stored terminal frame -
  the run is never re-executed. Malformed cursors are rejected with 400, unknown turns with 409.

- 893f7b3: Agent-run tracing and composable telemetry ports.

  `@nifrajs/agent-telemetry` gains `traceAgentRun`: one OpenTelemetry span per bounded agent run, one
  child span per step evidence item, with tool names, effect ids, error codes, and effect-ledger heads
  as span attributes. Only the runner's constrained token-only evidence is exported; telemetry is
  fail-open and can never fail the turn it observes.

  `@nifrajs/agent` gains `combineAgentTelemetry` to fan one run's step evidence out to several
  telemetry ports. The HTTP seams - `mountAgent`, the A2A adapter, and the AG-UI adapter - now compose
  their SSE evidence stream with a caller-injected telemetry port instead of replacing it.

### Patch Changes

- 1a041a9: Add provider-neutral gateway and deployment contracts with deterministic reference adapters and evidence-safe policy checks.
- 7551709: Harden runtime boundaries and defaults: clean up subprocess abort listeners, support short Cloudflare
  KV sessions, bound and incrementally sweep the default memory cache, make image reads and cancellation
  safe, emit content-derived image validators, require trusted forwarded hosts, avoid caching dynamic SSR
  metadata, and reject invalid upload or image limits.
- Updated dependencies [8b58d1f]
- Updated dependencies [095c320]
- Updated dependencies [7504864]
- Updated dependencies [e88c23a]
- Updated dependencies [c39712e]
- Updated dependencies [9010fd3]
- Updated dependencies [ea2356e]
- Updated dependencies [a816b87]
  - @nifrajs/core@3.2.0

## 3.1.0

### Patch Changes

- Updated dependencies [5b78473]
- Updated dependencies [1400f6c]
- Updated dependencies [a7db515]
  - @nifrajs/core@3.1.0

## 3.0.0

### Patch Changes

- Updated dependencies [f3d2a35]
- Updated dependencies [6e43c15]
- Updated dependencies [f0fd370]
- Updated dependencies [86a555b]
- Updated dependencies [8c5f4cf]
- Updated dependencies [f0fd370]
- Updated dependencies [381bbf3]
- Updated dependencies [36801ae]
- Updated dependencies [9acadba]
- Updated dependencies [99fc683]
- Updated dependencies [73d894d]
  - @nifrajs/core@3.0.0

## 2.14.1

### Patch Changes

- Updated dependencies [bf93902]
  - @nifrajs/core@2.14.1

## 2.14.0

### Patch Changes

- Updated dependencies [701961a]
- Updated dependencies [62133bf]
- Updated dependencies [8dffdf4]
  - @nifrajs/core@2.14.0

## 2.13.0

### Patch Changes

- Updated dependencies [e0b2dd6]
- Updated dependencies [7535ce1]
- Updated dependencies [1704308]
  - @nifrajs/core@2.13.0

## 2.12.1

### Patch Changes

- Updated dependencies [fba30c7]
  - @nifrajs/core@2.12.1

## 2.12.0

### Minor Changes

- e2d1939: Add typed tool contracts with shared fail-closed adapters, static verification work graphs, bounded provider-neutral agent turns, deterministic trajectory replay, and an explicit execution-policy seam with a non-isolating local process adapter.

### Patch Changes

- c2f99b1: `maxOutputBytes` bounds a local process's total captured output rather than each stream separately. A
  process writing to both stdout and stderr could retain twice the configured limit, so the option's
  value did not describe what a run could hold. Both streams now draw from one budget.
- Updated dependencies [df100d3]
- Updated dependencies [0efacea]
- Updated dependencies [cd1732c]
- Updated dependencies [df100d3]
- Updated dependencies [9a9346e]
- Updated dependencies [b5f47c0]
- Updated dependencies [fc33c0f]
- Updated dependencies [c4e8bb0]
- Updated dependencies [11d1658]
- Updated dependencies [5f71c23]
- Updated dependencies [3788b36]
- Updated dependencies [ae5338f]
- Updated dependencies [8847825]
- Updated dependencies [9a9346e]
- Updated dependencies [5e4e31a]
- Updated dependencies [9a9346e]
- Updated dependencies [b045f9e]
- Updated dependencies [9a9346e]
- Updated dependencies [9a9346e]
- Updated dependencies [dbc0b79]
- Updated dependencies [bd5c624]
- Updated dependencies [a5d3f5b]
- Updated dependencies [00819c5]
- Updated dependencies [e2bdd4a]
- Updated dependencies [e2d1939]
- Updated dependencies [e83e6eb]
- Updated dependencies [f8b0097]
  - @nifrajs/core@2.12.0
