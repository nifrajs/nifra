# @nifrajs/coding-agent

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
