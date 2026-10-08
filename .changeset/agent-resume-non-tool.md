---
"@nifrajs/agent": patch
"@nifrajs/a2a": patch
---

`resumeAgent` accepts the continuation of a model, budget or cancelled suspension: echoing it back retries the model step, as omitting `resume` does, so an A2A client can resume such a task with the continuation the task reported. A continuation that names a tool or a different effect is still refused with `AgentResumeMismatchError`.
