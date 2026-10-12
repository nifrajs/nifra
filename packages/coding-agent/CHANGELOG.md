# @nifrajs/coding-agent

## 5.1.0

### Patch Changes

- abb4354: The package now ships the MIT `LICENSE` text, as every other @nifrajs package already did.
- 44798e8: On Windows, an extension module on a different drive from the project root is refused as outside the project, by both the in-process `ExtensionHost` and `IsolatedExtension`. A project directory whose name starts with `..` (such as `..cache`) is no longer mistaken for one outside it.
- Updated dependencies [abb4354]
  - @nifrajs/agent@5.1.0
  - @nifrajs/agent-protocol@5.1.0
  - @nifrajs/agent-review@5.1.0
  - @nifrajs/jobs@5.1.0
  - @nifrajs/pi@5.1.0

## 5.0.0

### Minor Changes

- a3b3c51: Backends can send their own events. A `type` of `x-<vendor>.<name>` (lowercase, at most 64 characters) with an optional `turnId` and a bounded `data` value is now a valid `AgentEvent` (`AgentExtensionEvent`, `isAgentExtensionEventType`). Before, `isAgentEvent` refused every type the protocol did not define, so a vendor frame such as Codex's plan or a reviewer notice failed the whole turn. `CodingAgentHost` passes extension events through, records only their type and turn as evidence, and takes `extensionEvents: { "x-codex.plan": (event) => boolean }` to check the types it knows; a refused one fails the turn like a malformed event. `@nifrajs/agent-app`'s `toEventView` projects one to `ExtensionEventView` (type, turn, `hasData`, never the data). An exhaustive `switch` over `event.type` now needs a `default` branch for extension events.

  `agentEventProblem(value)` says why an event is invalid, naming the field and the limit it broke but never its content, and the host's `BACKEND_PROTOCOL` failure now carries it: `backend emitted an invalid agent event: turn.started.prompt is longer than 262144 characters` instead of the bare first half.

- b435f13: Three events join the protocol: `reasoning.delta` (`turnId`, optional `itemId`, `text`), `plan.updated` (`turnId`, optional `callId` and `explanation`, and `entries` of `content` up to 4096 characters, `status` `pending` | `in_progress` | `completed`, optional `priority`; each event is the whole plan), and `context.usage` (`usedTokens`, optional `windowTokens`, `inputTokens`, `outputTokens`, `cachedInputTokens`, `reasoningTokens`, `estimated`). The plan entry shape is ACP's. `NifraBackend`'s model port can stream `{ type: "reasoning_delta", text, itemId? }` and `{ type: "usage", usedTokens, ... }` chunks, which become those events; a count that is not a non-negative integer is dropped. `CodingAgentHost` keeps only counts as evidence (a plan's entry and completed counts, never its text), and `toEventView` projects them to `ReasoningDeltaView`, `PlanUpdatedView`, and `ContextUsageView` (with `fill` when the window is known). An exhaustive `switch` over `event.type` needs the three new cases.
- 794c5f2: `RunRecoveryMachine` records an `effect-started` checkpoint before it invokes an effect. A dispatch redelivered after its worker was lost mid-effect is dead-lettered with `idempotency_required` unless its idempotency proof exists; it is no longer run again. `DispatchBoundary` gains `"effect-started"`, so a custom `RunDispatchStore` must accept it. An effect that calls `checkpoint("before-effect")` still declares that a redelivery may rerun it.
- 64e7416: A post-turn gate whose command is not installed no longer starts repair turns. `runNifraVerification` returns `unavailable: true` when the gate's command cannot be found or run (a missing working directory still counts as a failure), and `createVerificationRepairTask` makes no task for it, so the host emits one `verification.completed` with `ok: false` and the turn ends. Before, a missing `nifra` binary sent the agent up to `maxRepairAttempts` repair turns asking it to fix the project. `isVerificationAvailable(name, { cwd, command?, env? })` answers the same question before a turn without running the gate.
- a08e400: `HandoffCoordinator` now expires overdue boundaries when it opens, lists or inspects them, so a pending handoff nobody decided no longer holds a `maxPending` slot past its deadline. Settled boundaries are kept up to a new `maxRetained` option (default 256) and evicted oldest first.
- 854315c: `CodingAgentRpcServer` takes `resumableTurns`, so a desktop or mobile client that drops its connection no longer loses the turn. Each `turn.send` SSE frame now carries `id: <seq>`. With `resumableTurns: true`, the turn runs on the server whether or not a client is reading; `turn.attach` with `{ afterSeq }` or a `Last-Event-ID` header replays the frames after that seq and follows the rest. The newest `replayEvents` frames (default 1024), up to `replayBytes` (default 8 MiB), are held; an older cursor answers `409 resync_required`, a second `turn.send` while one runs answers `409 turn_running`, and a turn no client has followed for `detachedTimeoutMs` (default 2 minutes) is cancelled. Without the option a disconnect still cancels the turn and `turn.attach` answers `501 feature_unsupported`. The server also passes `extensionEvents` through to its host.
- 191a235: `OrchestrationHost` keeps one values map for every layer of a run, so a node reads what a node in an earlier layer set, across a pause too. The values stay in memory for the run and are not written into its evidence. `WorkflowRunnerOptions.values` takes the map a runner reads and writes, so a driver can carry values from one run into the next.
- d06daf1: `OrchestrationHost` takes `onStepFailed(runId, nodeId, failure)`, so an app can say why a run failed without wrapping every catalog step. `failure.code` is `STEP_FAILED` or `GATE_REJECTED`; `failure.message` is what the step threw (bounded to 4096 characters, as the workflow kernel already bounds it) or a rejecting verify gate's string `reason`. Run evidence and `RunResult` stay content-free, so the message is not masked: mask anything sensitive before keeping it. A throw from the callback is ignored.
- 6b0db44: fix(coding-agent): a native tool call whose input holds a string past 64 KiB (a `write_file` of a large file) runs, instead of failing the turn with `NATIVE_TURN_FAILED` before the tool is called. The `tool.started` event carries a bounded display copy of the input; approval and the tool get all of it. A reply longer than one event's text arrives whole as consecutive `assistant.message` events, and the model's history keeps it whole, instead of being cut at `maxMessageChars`. The new `maxReplyChars` option (default 1 MiB, at least 256) caps the reply and its stream; `maxMessageChars` now caps only the message `send` accepts, and a message past one event's text runs with a bounded `turn.started` prompt. NUL in a prompt, reply, tool input, or tool output, a tool call without input, a model asking for a tool name the protocol refuses, and an empty error message no longer produce an event `isAgentEvent` refuses; a prompt with NUL used to leave the turn's stream open forever. A failing tool's message is kept to 64 KiB, like its output.

### Patch Changes

- c8577dd: The coding-agent RPC `approval.list` names each pending approval `approvalId`, the name `approval.resolve` takes, and keeps `id`. `AgentAppClient.listApprovals()` reads either name, so pending approvals from the RPC host are no longer dropped. The workbench refreshes its approval list when a turn reports `approval.required` or `approval.resolved`, while the turn is still streaming.
- 1af7543: Event streams stay bounded for a client that stops reading. `mountAgent` takes `maxOutputBytes` (default 4 MiB): past it an SSE response ends with an `output_limit` error frame, and with an `evidenceLog` a `Last-Event-ID` reconnect reads on. `respondMcpHttp` and `createMcpServer` take `maxPendingBytes` (default 4 MiB): an SSE stream with more than that waiting for its client is dropped and its tool call cancelled. The coding agent's `turn.send` stream advances the backend only as the client reads, and a resumable follower that falls `replayBytes` behind is dropped and can attach again from its cursor.
- f41c20c: The interactive `nifra-agent` CLI answers `/approve`, `/deny` and `/approvals` while a turn is running. Before, it read no input until the turn ended, so a turn waiting on an approval could never get one. Other prompts and commands typed during a turn still run in order once it ends.
- a1cfb14: `CodingAgentHost.resolveApproval` settles the approval with the host's broker before telling the backend, and returns `undefined` without telling the backend when the broker no longer holds it (unknown, expired, already settled, or bound to a coordinate). An approval the broker denies on its own, by timeout or when it closes, is denied in the backend too, so a backend that keeps approvals open longer than the host, or a Pi confirmation still waiting, can no longer run the action after the host expired it.
- bf3e16e: `CodingAgentHost.start` refuses a second start while one is in flight, and `stop()` during startup waits for it and closes the session it created, so neither leaves a live backend session behind. Concurrent RPC `session.create` and `session.resume` requests share one start and return the same session.
- 7403d72: `FileSessionStore` reads a directory written by `nifra-agent --migrate-session`: each migrated record comes back as a content-free entry whose type is its stable event code, and the next append continues the sequence. Before, the store read the migrated history as empty and restarted at sequence 0.
- 4beafe6: `migrateLegacySession` now stops reading a legacy session file as soon as it passes `maxSourceBytes`, instead of reading the whole file into memory before checking. The committed target is re-read against its expected size the same way.
- d608a8d: `ContextWindow` compaction keeps pinned and authoritative records, newest first, within half of `maxTokens` and folds older ones into the summary, and the summary is no longer than `maxTokens` characters. A long run of approvals no longer grows the window past its bound; the session store still keeps every record.
- f315597: `runNifraVerification`, `runNifraReview`, `runNifraContext` and `readProjectDiff` run their command as the leader of its own process group on POSIX. A timeout sends SIGTERM to the whole group, then SIGKILL after a grace period of up to 2 seconds, and stops waiting on output pipes once the command is gone, so a child that ignores SIGTERM or leaves a process behind no longer keeps the call pending.
- 2edff3a: `CodingAgentRpcServer` session snapshots now list the Agent App features the server answers itself: `approvals` and `resume` always, `checkpoint` and `fork` with a session store or a backend that supports them, and `workflows` with an extension host. An `AgentAppClient` connected to it can call `resume()` instead of being refused for a feature the host never granted.
- f0474f3: `FileSessionStore.append` keeps a running count of each session file's entries and bytes, so an append under `maxEntries` and `maxBytes` no longer reads the log back. When a log passes either cap, it is compacted down to three quarters of both caps, so the next rewrite is many appends away instead of on every append.
- 4f8dc55: A subagent's `timeoutMs` and cancellation now cover acquiring its isolated worktree: the run settles at the deadline even while `isolatedWorktree` is still pending, and a lease that arrives later is cleaned up without starting work in it.
- 0e1b263: `UiExtensionHost` now type-checks every manifest field, so an array id, an object label, a string theme or an unknown slot or density rolls the reload back. The active graph holds only the documented manifest fields; extra keys are dropped.
- d5ea565: The RPC `workflow.run` reply now carries the workflow's `values` as a plain object. They were sent as a `Map`, which serialises to `{}`, so a remote caller never saw what the steps set.
- 8ea8d46: The evidence stores hash each record synchronously instead of through `crypto.subtle`, which sent every append to a worker thread and back: 10,000 appends take about 21 ms instead of 141 ms (more on a loaded machine). Digests are unchanged.
- Updated dependencies [36bdc71]
- Updated dependencies [2198640]
- Updated dependencies [6b0db44]
- Updated dependencies [a3b3c51]
- Updated dependencies [6b96131]
- Updated dependencies [d6a7fa0]
- Updated dependencies [343bae0]
- Updated dependencies [b435f13]
- Updated dependencies [6340cd8]
- Updated dependencies [34b3014]
- Updated dependencies [848ce97]
- Updated dependencies [42153fb]
- Updated dependencies [1af7543]
- Updated dependencies [8118abd]
- Updated dependencies [22581a1]
- Updated dependencies [4d5208c]
- Updated dependencies [7cc6505]
- Updated dependencies [4dcf69b]
- Updated dependencies [6b0db44]
- Updated dependencies [c52c8e5]
  - @nifrajs/agent-protocol@5.0.0
  - @nifrajs/pi@5.0.0
  - @nifrajs/agent@5.0.0
  - @nifrajs/agent-review@5.0.0
  - @nifrajs/jobs@5.0.0

## 4.0.2

### Patch Changes

- @nifrajs/agent@4.0.2
- @nifrajs/agent-protocol@4.0.2
- @nifrajs/agent-review@4.0.2
- @nifrajs/jobs@4.0.2
- @nifrajs/pi@4.0.2

## 4.0.1

### Patch Changes

- @nifrajs/agent@4.0.1
- @nifrajs/agent-protocol@4.0.1
- @nifrajs/agent-review@4.0.1
- @nifrajs/jobs@4.0.1
- @nifrajs/pi@4.0.1

## 4.0.0

### Minor Changes

- d36c997: `BoundedSubagentRunner` reports an executor that keeps running after its run timed out or was cancelled. `onAbandoned` receives the spec, the reason, the cwd it was given, and a `settled` promise; the runner's `abandoned` count holds it until it settles; and `maxAbandoned` refuses new children while that many still run. Runners that share an `abandonment` ledger are counted together. An executor that honours its abort signal is not reported. The orchestration host counts across all its runs, with `onSubagentAbandoned(runId, nodeId, abandonment)`, `abandonedSubagents`, and `limits.maxAbandonedSubagents`.
- 62fd960: `ApprovalManager` and the handoff approval mirror:

  - An approval opened with a `coordinate` is approved only through `resolveMatched()`. `resolve(id, true)` returns `undefined` and leaves it pending; `resolve(id, false)` still denies it.
  - `HandoffCoordinator` gives the approval it pairs with a handoff that handoff's coordinate, and settles it through `resolveMatched()` with its own clock. An untyped approve over RPC no longer settles the approval while the handoff stays open.
  - `request()` resolves with a decision made while `onRequired` is still running. Previously that decision was broadcast but the waiter resolved `false`.
  - `offer()` and `request()` for an id that is already pending return `undefined` and `false`, and the pending approval is unchanged. Previously the second call replaced the first, which then never settled.
  - Approval and session ids accept the agent protocol's full token alphabet, including `/`. `observe()` cuts an action label longer than 512 characters instead of throwing, so a protocol-valid `approval.required` event no longer ends the turn.
  - A rejected `onResolved` promise, or an `onRequired` failure behind a handoff's approval, no longer surfaces as an unhandled rejection.
  - `HandoffCoordinator.open()` refuses a `sessionId` outside the token alphabet with `invalid_handoff`.

- 2cbcca8: The orchestration evidence digest (`evidenceDigest`, `EvidenceStore.digest()`) now counts repeated records. A run whose node retried before succeeding no longer has the same digest as a clean run. Previously retries with an even number of repeats cancelled out. The digest is still independent of record order, `seq`, timing and run id. Digests recorded by earlier versions do not match the new ones, so re-record any stored baselines.

### Patch Changes

- c7dcc3e: `nifra-agent` loads `.nifra/extensions/**` only when started with the new `--extensions` flag. An extension's top-level code runs as soon as it is imported, before its `capabilities` can be refused, so starting the agent in a cloned repository no longer runs that repository's code.
- 23cd462: `NifraBackend` takes a `maxHistoryChars` option (default 1 MiB) that caps the conversation a session sends to the model. Past it, whole earlier turns are dropped, oldest first; the current turn is always sent in full. Each model request gets a frozen snapshot of the history without re-copying every message.
- 3235050: A `parallel` workflow step stops at its first failure. No queued step starts after a step fails, and `WorkflowRunner.run()` returns only after the steps already running have finished. Previously the failure was reported at once while the remaining steps kept starting.
- 07ce32c: The agent RPC server throttles only failed authorization attempts. A request carrying the right token is served during a backoff, so wrong guesses from another caller no longer block the real client.
- e6cc620: On Windows, a session id containing `:` (including the default `<id>:fork:<time>` id `FileSessionStore.fork()` makes) is stored under a file name with `:` written as `%3A`, so forks, checkpoints and session migration no longer address an NTFS alternate data stream. File names on other platforms are unchanged.
- 1c9efd8: `BoundedSubagentRunner` releases a workspace lease only after its executor settles. A run that times out or is cancelled still returns at once, and its lease's `cleanup` runs when the executor finishes, so an executor that ignores the signal keeps its `cwd` until it stops. A run whose signal is already aborted no longer asks `isolatedWorktree` for a lease.
- 915e9d7: `BoundedSubagentRunner` checks a subagent's working directory against the workspace `root` and `allowedRoots` by physical path. A symlink inside the root that points outside it is refused like any other path outside the root, whether it comes from `spec.cwd` or from an `isolatedWorktree` lease. A directory that does not exist yet is checked through its nearest existing parent. On Windows, a working directory on another drive is refused.
- 438d19b: Under a workspace policy, `BoundedSubagentRunner` hands its executor the `cwd` it checked with that path's symlinks already resolved, instead of the path as written. Re-pointing a link after the check no longer changes where the executor runs.
- e129e80: A subagent's `timeoutMs` now ends `BoundedSubagentRunner.run()` even when the executor ignores the abort signal: the result is `{ ok: false, error: "subagent timed out" }` (or `"subagent cancelled"` when the runner's `signal` aborts), and the workspace lease is cleaned up. A runner whose `signal` is already aborted no longer starts the executor.
- ae0f696: On Windows, a session whose id starts with a reserved device name (`con`, `nul`, `aux`, `prn`, `com0`-`com9`, `lpt0`-`lpt9`, in any case, alone or before a `.`) is stored under a file name with its first character percent-encoded, since Windows treats `nul.jsonl` as the NUL device.
- 3090e51: The `test` verification gate runs the project's suite with `bun test`. `--verify-after-turn test` in `nifra-agent` and the Pi extension's `nifra_test` tool used to run a `nifra test` command that does not exist, so the gate failed on every project.
- Updated dependencies [6695a23]
- Updated dependencies [7b2ff47]
- Updated dependencies [422248c]
- Updated dependencies [62115dd]
- Updated dependencies [dbc91b6]
- Updated dependencies [d2329f5]
- Updated dependencies [1eb77df]
- Updated dependencies [1afbe9f]
- Updated dependencies [db535da]
- Updated dependencies [0e41410]
- Updated dependencies [3090e51]
  - @nifrajs/agent@4.0.0
  - @nifrajs/jobs@4.0.0
  - @nifrajs/pi@4.0.0
  - @nifrajs/agent-protocol@4.0.0
  - @nifrajs/agent-review@4.0.0

## 3.5.0

### Patch Changes

- 6430334: Add the provider-neutral, content-free review report contract and expose `nifra review` through the CLI, authenticated agent RPC, and Workbench-safe view projections.
- 322786e: Keep the session store loadable on Windows by reading file-open flags from the platform-safe filesystem constants.
- Updated dependencies [6430334]
- Updated dependencies [82c3018]
- Updated dependencies [e95cd7e]
  - @nifrajs/agent-review@3.5.0
  - @nifrajs/jobs@3.5.0
  - @nifrajs/pi@3.5.0
  - @nifrajs/agent@3.5.0
  - @nifrajs/agent-protocol@3.5.0

## 3.4.0

### Patch Changes

- 719d82e: Centralize release-facing evidence and certification seams so generated views, runtime adapters, and
  consumer checks stay aligned.
- Updated dependencies [8d23613]
- Updated dependencies
  - @nifrajs/agent-protocol@3.4.0
  - @nifrajs/agent@3.4.0
  - @nifrajs/pi@3.4.0
  - @nifrajs/jobs@3.4.0

## 3.3.0

### Minor Changes

- 10085ce: Add the native approval protocol flow to `@nifrajs/coding-agent`. Native turns can now emit bounded, ordered approval events and resolve pending approvals through the backend protocol, while retaining compatibility with the existing boolean approval callback.

### Patch Changes

- @nifrajs/agent@3.3.0
- @nifrajs/agent-protocol@3.3.0
- @nifrajs/jobs@3.3.0
- @nifrajs/pi@3.3.0

## 3.2.0

### Minor Changes

- e3e197b: Add the isolated Nifra agent protocol, Pi backend adapter, extensible coding-agent CLI, secure local RPC, workflows, sessions, verification, self-healing extensions, and Workbench integration.

### Patch Changes

- 1a041a9: Add provider-neutral gateway and deployment contracts with deterministic reference adapters and evidence-safe policy checks.
- Updated dependencies [7aee593]
- Updated dependencies [8486ed8]
- Updated dependencies [1a041a9]
- Updated dependencies [3eacb4a]
- Updated dependencies [e3e197b]
- Updated dependencies [893f7b3]
- Updated dependencies [7551709]
  - @nifrajs/agent@3.2.0
  - @nifrajs/agent-protocol@3.2.0
  - @nifrajs/pi@3.2.0
  - @nifrajs/jobs@3.2.0
