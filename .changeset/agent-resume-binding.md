---
"@nifrajs/agent": patch
"@nifrajs/a2a": patch
"@nifrajs/ag-ui": patch
---

A resume continues only the step the turn suspended on. The saved state keeps a SHA-256 digest of the suspended tool input, and a continuation that names another tool, effect id or kind, or replays different input, is refused with `AgentResumeMismatchError` before anything runs (`mountAgent` answers 409). A caller's `approval` answers only a step that suspended for approval; a step suspended for budget or cancellation asks the approval port again.
