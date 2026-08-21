---
"@nifrajs/ag-ui": minor
---

Widen AG-UI protocol conformance: tool evidence now ends with a `TOOL_CALL_RESULT` carrying the token-only outcome (`{ outcome, code? }`), evidence-derived events carry the evidence `timestamp`, and `RUN_FINISHED` reports the spec `outcome` - `{ type: "success" }` on completion, `{ type: "interrupt", interrupts: [...] }` on suspension with the continuation in the interrupt's `metadata`. Suspended runs resume through the standard `RunAgentInput.resume` array (a `cancelled` entry without an explicit approval resumes as a denial); the `forwardedProps.resume` form keeps working. A new `emitMessagesSnapshot` option (default off) emits a `MESSAGES_SNAPSHOT` of the request messages plus the assistant output before `RUN_FINISHED`.
