# @nifrajs/pi

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
