# @nifrajs/pi

## 5.0.0

### Patch Changes

- Wait for asynchronous Pi RPC pipe flushes and handle closed pipes when sending prompts, cancelling turns, reloading, or answering extension dialogs.
- 36bdc71: `@nifrajs/agent-protocol/conformance` exports `checkAgentBackend`, which drives an `AgentBackend` through the scenarios a host relies on (session snapshot, a valid turn that completes, a refused second message, cancel, approvals allowed, denied, unknown and cancelled, a closed session) and returns a report of passed, failed, and skipped checks. `AgentBackend.resolveApproval` now documents its result: a boolean once the backend took the answer, `undefined` when it does not know the approval. `PiBackend` forgets a turn's pending approvals when the turn ends, so an answer after a cancel returns `undefined` instead of reaching Pi.
- 7cc6505: `PiBackend` now answers an extension's `select`, `input` or `editor` dialog, or a `confirm` that arrives outside a turn, with `cancelled: true` straight away. These were ignored before, so an extension awaiting one without its own timeout held the turn open. A `confirm` during a turn still surfaces as `approval.required`.
- 4dcf69b: `maxRecordBytes` bounds each Pi JSONL record and the record still arriving, so a single stdout chunk that carries several records under the cap is accepted rather than failing as an oversized record.
- 6b0db44: fix(pi): a Pi turn whose reply, tool output, tool arguments, or streamed text is past what one event may carry completes, instead of failing with `PI_PROTOCOL`. A long reply or stream arrives as consecutive events that join back to the text; `tool.started` and `tool.completed` carry bounded display copies (a tool output past 64 KiB used to fail the turn). NUL in a prompt or in Pi's text no longer fails the turn.
- c52c8e5: fix(pi): a Pi turn whose model call failed ends in `session.failed` with code `PI_MODEL_FAILED` and Pi's error message (bounded, with any credential the provider echoed replaced by `[REDACTED]`), instead of `session.completed` with no answer. Pi reports such a failure only on the turn's last assistant message (`stopReason: "error"`) and still ends with an ordinary `agent_end`, so a sign-in, quota, or network failure used to look like an empty success. An `agent_end` Pi marks `willRetry` no longer ends the turn: the retried run's answer completes it.
- Updated dependencies [36bdc71]
- Updated dependencies [6b0db44]
- Updated dependencies [a3b3c51]
- Updated dependencies [343bae0]
- Updated dependencies [b435f13]
  - @nifrajs/agent-protocol@5.0.0

## 4.0.2

### Patch Changes

- @nifrajs/agent-protocol@4.0.2

## 4.0.1

### Patch Changes

- @nifrajs/agent-protocol@4.0.1

## 4.0.0

### Patch Changes

- 0e41410: `PiBackend` passes the model-provider credential variables Pi reads (such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, and the AWS and Google Cloud credentials) through to Pi, so a key set in the environment works without listing it in `env`. Other parent variables still stay out, and `env: { NAME: undefined }` withholds any of them.
- 3090e51: The `test` verification gate runs the project's suite with `bun test`. `--verify-after-turn test` in `nifra-agent` and the Pi extension's `nifra_test` tool used to run a `nifra test` command that does not exist, so the gate failed on every project.
  - @nifrajs/agent-protocol@4.0.0

## 3.5.0

### Patch Changes

- e95cd7e: Preserve the Windows runtime environment required by Pi child processes when applying the host's filtered environment policy.
  - @nifrajs/agent-protocol@3.5.0

## 3.4.0

### Patch Changes

- 8d23613: Add the opt-in `@nifrajs/webmcp` package: typed WebMCP registration, core-backed receipts, deterministic predictive-UI reconciliation, and host-independent conformance checks. Also tighten agent execution cancellation cleanup so aborted local work cannot leak into later turns.
- Updated dependencies [8d23613]
  - @nifrajs/agent-protocol@3.4.0

## 3.3.0

### Patch Changes

- @nifrajs/agent-protocol@3.3.0

## 3.2.0

### Minor Changes

- e3e197b: Add the isolated Nifra agent protocol, Pi backend adapter, extensible coding-agent CLI, secure local RPC, workflows, sessions, verification, self-healing extensions, and Workbench integration.

### Patch Changes

- Updated dependencies [e3e197b]
  - @nifrajs/agent-protocol@3.2.0
