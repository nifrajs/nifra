# @nifrajs/pi

## 5.7.0

### Patch Changes

- @nifrajs/agent-protocol@5.7.0

## 5.6.0

### Patch Changes

- 2248445: `@nifrajs/agent-protocol` exports `childProcessEnv` and `childProcessBaseEnv`: the environment a host
  hands a process it spawns, built from the platform and host environment the caller passes. The ACP
  and Pi backends and the coding agent's isolated extension worker build their child environments with
  it, so all three pass the same Windows set. An ACP agent on Windows now also receives `BUN_INSTALL`
  and `USERDOMAIN`.
- Updated dependencies [2248445]
  - @nifrajs/agent-protocol@5.6.0

## 5.5.1

### Patch Changes

- @nifrajs/agent-protocol@5.5.1

## 5.5.0

### Patch Changes

- 0658806: `PiBackend` masks the credentials it hands the Pi process wherever a model or extension error echoes one: every value from the provider environment and from `env`, apart from the base `PATH`/`HOME`/locale variables, becomes `[REDACTED]` in the error a turn rejects with and in its `session.failed` event, whatever the key looks like. A value under six characters is masked where it stands alone, so a number or a yes/no word such as `1` or `true` stays readable in the diagnostic. The key-shape fallback in Pi and ACP also recognizes Groq (`gsk_`), xAI (`xai-`), Hugging Face (`hf_`) and NVIDIA (`nvapi-`) keys.
- @nifrajs/agent-protocol@5.5.0

## 5.4.0

### Patch Changes

- @nifrajs/agent-protocol@5.4.0

## 5.3.0

### Patch Changes

- 1a3af3e: Records from a cancelled Pi run no longer leak into the next turn. Pi finishes an aborted run on its own schedule, so a delta or `agent_end` it sent after a new prompt was written became the new turn's output and could complete it with the old answer. `PiBackend` now drains a cancelled run: its records are dropped until Pi ends it (`agent_end`) or answers the abort, a dialog it opens meanwhile is cancelled, and the next prompt is written only after. A cancel before the prompt reached Pi no longer sends Pi an abort.
- @nifrajs/agent-protocol@5.3.0
- 5f240c4: A Pi turn whose provider refused its sign-in or API key now fails with `PI_AUTH_REQUIRED`, so a client can ask for a new login or key; any other failed model call stays `PI_MODEL_FAILED`. An expired OAuth login (`invalid_refresh_token`) or an incorrect API key used to report `PI_MODEL_FAILED` like an overloaded model. The 5.3.0 upgrade notes say so.

## 5.2.1

### Patch Changes

- @nifrajs/agent-protocol@5.2.1

## 5.2.0

### Patch Changes

- 9498cf8: The package ships its `CHANGELOG.md`, so the installed package has the notes for every version, as the GitHub release does. Before, the tarball held only the code, `README.md`, `LICENSE` and `package.json`.
- Updated dependencies [9498cf8]
  - @nifrajs/agent-protocol@5.2.0

## 5.1.0

### Patch Changes

- abb4354: The package now ships the MIT `LICENSE` text, as every other @nifrajs package already did.
- Updated dependencies [abb4354]
  - @nifrajs/agent-protocol@5.1.0

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
