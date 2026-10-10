---
"@nifrajs/agent-protocol": minor
"@nifrajs/pi": patch
---

`@nifrajs/agent-protocol/conformance` exports `checkAgentBackend`, which drives an `AgentBackend` through the scenarios a host relies on (session snapshot, a valid turn that completes, a refused second message, cancel, approvals allowed, denied, unknown and cancelled, a closed session) and returns a report of passed, failed, and skipped checks. `AgentBackend.resolveApproval` now documents its result: a boolean once the backend took the answer, `undefined` when it does not know the approval. `PiBackend` forgets a turn's pending approvals when the turn ends, so an answer after a cancel returns `undefined` instead of reaching Pi.
