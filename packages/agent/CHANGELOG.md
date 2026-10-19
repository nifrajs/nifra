# @nifrajs/agent

## 5.5.0

### Minor Changes

- abe746a: `createMemoryAgentEvidenceLog` bounds the evidence it keeps for one turn, across every resume of it, with the new `maxEvidencePerTurn` option (default 1024). `maxTurns` bounded how many turns were kept but not what each held, so a turn id that was run or resumed again and again kept every evidence item it ever recorded. Past the bound the oldest items are dropped, and a replay from a `Last-Event-ID` older than the items still held gets `undefined` - the mounted agent route answers `409 { error: "replay_unavailable" }` - instead of a stream with a silent gap.

### Patch Changes

- Updated dependencies [6cc9e11]
- Updated dependencies [28dd544]
- Updated dependencies [662afb0]
- Updated dependencies [662afb0]
- Updated dependencies [61113d8]
- Updated dependencies [389e1b6]
- Updated dependencies [662afb0]
- Updated dependencies [a11fe77]
- Updated dependencies [fa5b67c]
  - @nifrajs/core@5.5.0

## 5.4.0

### Patch Changes

- Updated dependencies [5183c00]
- Updated dependencies [01b97ec]
- Updated dependencies [e589893]
- Updated dependencies [ff66db6]
- Updated dependencies [529f8d2]
  - @nifrajs/core@5.4.0

## 5.3.0

### Patch Changes

- 61724f9: A cancelled turn no longer commits a model answer that arrives after the cancel. A model port that ignores its `signal` could still return output or a tool call, and output validation can be async; `turn` now rechecks the signal once the model answers and again after validating output, and suspends as `cancelled` instead of saving a completed state or running the tool.
- Updated dependencies [7ab9692]
- Updated dependencies [808bac8]
- Updated dependencies [d4bae56]
- Updated dependencies [007060d]
- Updated dependencies [190ab39]
- Updated dependencies [7cf8df3]
  - @nifrajs/core@5.3.0

## 5.2.1

### Patch Changes

- @nifrajs/core@5.2.1

## 5.2.0

### Patch Changes

- 9498cf8: The package ships its `CHANGELOG.md`, so the installed package has the notes for every version, as the GitHub release does. Before, the tarball held only the code, `README.md`, `LICENSE` and `package.json`.
- Updated dependencies [9498cf8]
- Updated dependencies [1f3ff32]
- Updated dependencies [4bb8e52]
- Updated dependencies [cdff19d]
- Updated dependencies [5edd0ba]
- Updated dependencies [000b4cb]
- Updated dependencies [c5455fb]
- Updated dependencies [6082ba5]
- Updated dependencies [fd58beb]
- Updated dependencies [ea25a61]
- Updated dependencies [ed13e36]
  - @nifrajs/core@5.2.0

## 5.1.0

### Patch Changes

- abb4354: The package now ships the MIT `LICENSE` text, as every other @nifrajs package already did.
- b5ff0bb: `mountA2A` defaults `resumeApproval` to `"port"`: a resumed task asks `ports.approval` again and hands it the peer's `approval` as `callerDecision`, so the agent that asked for a tool can no longer approve its own call. Without an approval port such a resume stays `TASK_STATE_INPUT_REQUIRED`. Return `resumeApproval: "caller"` from `ports` to keep the previous behavior when the peer is the approver, such as a human operator's client.
- a74c575: `mountAgent` now answers refusals and failures with the status they mean. A `Response` thrown from `ports` or `evidenceOwner` (a 401 with its challenge, say) is sent as built; before, every throw from either became `400 bad_request`. A refusal thrown from `evidenceOwner` now answers `403 { error: "forbidden" }`, and any other throw from `ports` reaches the app's error handling as the fault it is. In JSON mode a fresh run that throws now answers `500 { error: "run_failed" }`, the code the SSE stream already used; `409 resume_unavailable` is reserved for a POST that resumed a turn.
- Updated dependencies [b276c67]
- Updated dependencies [2a0a5d3]
- Updated dependencies [72e1b4b]
  - @nifrajs/core@5.1.0

## 5.0.0

### Minor Changes

- 6340cd8: A replay connection that closes detaches its live view from the turn: `mountAgent` and `mountAgUI` return the view when the client cancels, and the memory evidence log stops sending evidence to a returned view. The logged run keeps recording for the next reconnect. `createMemoryAgentEvidenceLog({ maxSubscribers })` caps live views per running turn (default 64); one more ends the oldest. `createAgentEvidenceStream({ onReturn })` reports when a consumer returns its stream.
- 34b3014: New `resumeApproval: "port"` agent port option keeps the configured approval port authoritative when a run resumes. By default a step that suspended for approval takes the decision the resuming caller sends in `resume.approval`. Over A2A, or on a public AG-UI or `mountAgent` route, that caller can be the party asking for the tool. With `resumeApproval: "port"` the approval port is asked again and receives the caller's decision as `callerDecision`, and its verdict stands. Without a port, such a resume suspends again.
- 1af7543: Event streams stay bounded for a client that stops reading. `mountAgent` takes `maxOutputBytes` (default 4 MiB): past it an SSE response ends with an `output_limit` error frame, and with an `evidenceLog` a `Last-Event-ID` reconnect reads on. `respondMcpHttp` and `createMcpServer` take `maxPendingBytes` (default 4 MiB): an SSE stream with more than that waiting for its client is dropped and its tool call cancelled. The coding agent's `turn.send` stream advances the backend only as the client reads, and a resumable follower that falls `replayBytes` behind is dropped and can attach again from its cursor.

### Patch Changes

- 2198640: `assembleContext` counts each candidate set in the source order it returns, so a custom `tokenCounter` that scores the same items differently by order can no longer return text over the budget. The returned text is counted once more, and a count over the budget throws `ContextBudgetError`.
- 6b96131: `runModelGateway` gives each attempt its own abort signal and aborts it when the deadline passes or the caller cancels, so an adapter that honours `request.signal` stops working on a request whose result would be discarded. The deadline also covers the structured-output parser: a parse that finishes after it returns `timeout` instead of success.
- d6a7fa0: `runModelGateway` honours a `deadlineAt` more than about 24.8 days out instead of timing the attempt out at once, and a policy with any `maxAttempts` up to the 512 cap now runs every attempt. Retrying past roughly 128 to 255 attempts used to fail with `policy_denied` once the evidence log filled.
- 848ce97: `resumeAgent` accepts the continuation of a model, budget or cancelled suspension: echoing it back retries the model step, as omitting `resume` does, so an A2A client can resume such a task with the continuation the task reported. A continuation that names a tool or a different effect is still refused with `AgentResumeMismatchError`.
- Updated dependencies [a0a02f4]
- Updated dependencies [0aed425]
- Updated dependencies [eaf030b]
- Updated dependencies [7de0397]
- Updated dependencies [4199ff3]
- Updated dependencies [90d9ee6]
- Updated dependencies [364a234]
- Updated dependencies [c06cba5]
- Updated dependencies [f4d3852]
- Updated dependencies [4a82ae0]
- Updated dependencies [0ff867a]
- Updated dependencies [e7391bf]
- Updated dependencies [0b80a59]
- Updated dependencies [c64db12]
- Updated dependencies [3753104]
- Updated dependencies [4b3b1fa]
- Updated dependencies [3562557]
- Updated dependencies [53087f3]
- Updated dependencies [2def6c7]
- Updated dependencies [b5b5bc3]
- Updated dependencies [22e1777]
- Updated dependencies [3a483cd]
- Updated dependencies [35f52c7]
- Updated dependencies [343cb81]
- Updated dependencies [d91fd44]
- Updated dependencies [b13e071]
- Updated dependencies [077657f]
- Updated dependencies [a5963cb]
- Updated dependencies [05aac0e]
- Updated dependencies [1a6616f]
- Updated dependencies [7775c2b]
- Updated dependencies [846e2f6]
- Updated dependencies [aadd9fc]
- Updated dependencies [ea16748]
- Updated dependencies [fc0284a]
- Updated dependencies [5b22f4d]
- Updated dependencies [1b94593]
- Updated dependencies [9f58295]
- Updated dependencies [b9608ac]
- Updated dependencies [7a165de]
- Updated dependencies [4064f36]
- Updated dependencies [48aad8c]
- Updated dependencies [41050ed]
- Updated dependencies [fc837cb]
- Updated dependencies [b80ce77]
- Updated dependencies [9b1acc9]
- Updated dependencies [740109f]
- Updated dependencies [e0a25fe]
- Updated dependencies [3630b6e]
- Updated dependencies [1290c6d]
- Updated dependencies [d0a7d58]
  - @nifrajs/core@5.0.0

## 4.0.2

### Patch Changes

- @nifrajs/core@4.0.2

## 4.0.1

### Patch Changes

- @nifrajs/core@4.0.1

## 4.0.0

### Minor Changes

- 7b2ff47: Resumable agent streams can be scoped to the caller:

  - New `evidenceOwner` option on `mountAgent` and `mountAgUI`. It returns the caller's user or tenant id, and turns are recorded and replayed under it. Another caller's `Last-Event-ID` reconnect or reused turn id finds none of that caller's turns. It runs before any replay is served, and throwing from it refuses the request.
  - New `scopeAgentEvidenceLog(log, owner)` in `@nifrajs/agent/events` returns the per-owner view of an `AgentEvidenceLog` that the seams use.
  - `mountAgent` answers `400 { error: "invalid_turn_id" }` for a `turnId` that is not a bounded token before it reads the evidence log, matching `mountAgUI`.

### Patch Changes

- 6695a23: `AgentDeployment` runs its lifecycle calls one at a time, so each call sees the state the previous one left:

  - `cancel()` or `dispose()` during an in-flight `start()` aborts the start's `signal`. It then runs once the start settles, against the workload that start left running. A start that stops on the signal rejects with `cancelled`. Previously the cancel ran first, without the workload's handle, and the start then left the deployment `running`.
  - A plan refused by `prepare()` (an invalid plan, a capability or authority refusal) is recorded in `evidenceRecords` as `failed`, like every other refusal.

- 422248c: `createLocalProcessAdapter()` bounds a run by everything the command starts:

  - On POSIX each run leads its own process group. A timeout or cancel signals the whole group, so a shell's background or nested processes end with it and the result arrives within `timeMs` plus the kill grace. Runs still in flight are ended when the host process exits. Windows still signals only the direct child.
  - A process that leaves the group but keeps the output pipes open no longer holds the result past the kill grace.
  - A `timeMs` above setTimeout's range (about 24.8 days) waits the full budget instead of timing out at once.

- 62115dd: `createLocalProcessAdapter()` runs end every process the command started: on POSIX a background process the command leaves behind is stopped when the run ends, as it already was on a timeout or cancel. On Windows a timeout or cancel now ends the command's whole process tree with `taskkill /T /F` instead of only the direct child.
- dbc91b6: `createMemoryAgentEvidenceLog()` evicts the oldest finished turn first when `maxTurns` is reached, and only evicts a running turn when none has finished. An evicted running turn now ends its rejoined `Last-Event-ID` replays (with no result) instead of leaving them waiting forever, since its later `finish()` can no longer reach it.
- d2329f5: A resume continues only the step the turn suspended on. The saved state keeps a SHA-256 digest of the suspended tool input, and a continuation that names another tool, effect id or kind, or replays different input, is refused with `AgentResumeMismatchError` before anything runs (`mountAgent` answers 409). A caller's `approval` answers only a step that suspended for approval; a step suspended for budget or cancellation asks the approval port again.
- 1eb77df: An SSE client that disconnects mid-run no longer ends the turn as failed. With an `evidenceLog`, the run keeps going and records its real result, so a `Last-Event-ID` reconnect replays that result instead of `run_failed`/`RUN_ERROR`. Without an `evidenceLog`, the disconnect aborts `ports.signal` (combined with any signal the caller's ports carry), so the model and tool loop stop and the turn suspends as `cancelled`.
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
  - @nifrajs/core@4.0.0

## 3.5.0

### Patch Changes

- Updated dependencies [6046984]
- Updated dependencies [d5b7c22]
  - @nifrajs/core@3.5.0

## 3.4.0

### Minor Changes

- Add a provider-neutral `@nifrajs/agent/context` contract for deterministic, token-budgeted context
  selection and asynchronous source collection.

### Patch Changes

- 8d23613: Add the opt-in `@nifrajs/webmcp` package: typed WebMCP registration, core-backed receipts, deterministic predictive-UI reconciliation, and host-independent conformance checks. Also tighten agent execution cancellation cleanup so aborted local work cannot leak into later turns.
- Updated dependencies [719d82e]
  - @nifrajs/core@3.4.0

## 3.3.0

### Patch Changes

- @nifrajs/core@3.3.0

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
