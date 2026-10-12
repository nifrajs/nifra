# @nifrajs/acp

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
