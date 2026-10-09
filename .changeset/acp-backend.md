---
"@nifrajs/acp": minor
---

New package: `AcpBackend` drives an agent that speaks the Agent Client Protocol (version 1) over stdio, such as `claude-code-acp`, `codex-acp`, or `gemini --experimental-acp`, as an `AgentBackend`. Message chunks, thoughts, tool calls, plans, and usage map to `assistant.*`, `reasoning.delta`, `tool.*`, `plan.updated`, and `context.usage`; other updates travel as `x-acp.<kind>` extension events. Permission requests become approvals answered only with one-time options. The agent gets a filtered environment, error text is bounded with credentials masked, and a turn the agent does not end within `cancelGraceMs` of a cancel stops the agent.
