---
"@nifrajs/coding-agent": minor
---

`OrchestrationHost` takes `onStepFailed(runId, nodeId, failure)`, so an app can say why a run failed without wrapping every catalog step. `failure.code` is `STEP_FAILED` or `GATE_REJECTED`; `failure.message` is what the step threw (bounded to 4096 characters, as the workflow kernel already bounds it) or a rejecting verify gate's string `reason`. Run evidence and `RunResult` stay content-free, so the message is not masked: mask anything sensitive before keeping it. A throw from the callback is ignored.
