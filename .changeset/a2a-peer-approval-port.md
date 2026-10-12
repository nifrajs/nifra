---
"@nifrajs/a2a": patch
"@nifrajs/agent": patch
---

`mountA2A` defaults `resumeApproval` to `"port"`: a resumed task asks `ports.approval` again and hands it the peer's `approval` as `callerDecision`, so the agent that asked for a tool can no longer approve its own call. Without an approval port such a resume stays `TASK_STATE_INPUT_REQUIRED`. Return `resumeApproval: "caller"` from `ports` to keep the previous behavior when the peer is the approver, such as a human operator's client.
