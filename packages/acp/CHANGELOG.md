# @nifrajs/acp

## 5.6.0

### Patch Changes

- a6a066d: The error for an ACP agent that exits now names the reason the agent wrote to stderr even when the exit is observed before that line has been read. The exit waits for stderr to end, for at most half a second in case a process the agent left behind keeps it open.
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

- @nifrajs/agent-protocol@5.3.0

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

### Minor Changes

- 2e799e1: New package: `AcpBackend` drives an agent that speaks the Agent Client Protocol (version 1) over stdio, such as `claude-code-acp`, `codex-acp`, or `gemini --experimental-acp`, as an `AgentBackend`. Message chunks, thoughts, tool calls, plans, and usage map to `assistant.*`, `reasoning.delta`, `tool.*`, `plan.updated`, and `context.usage`; other updates travel as `x-acp.<kind>` extension events. Permission requests become approvals answered only with one-time options. The agent gets a filtered environment, error text is bounded with credentials masked, and a turn the agent does not end within `cancelGraceMs` of a cancel stops the agent.

### Patch Changes

- Updated dependencies [36bdc71]
- Updated dependencies [6b0db44]
- Updated dependencies [a3b3c51]
- Updated dependencies [343bae0]
- Updated dependencies [b435f13]
  - @nifrajs/agent-protocol@5.0.0
