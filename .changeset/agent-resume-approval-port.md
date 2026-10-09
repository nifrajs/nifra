---
"@nifrajs/agent": minor
"@nifrajs/a2a": patch
"@nifrajs/ag-ui": patch
---

New `resumeApproval: "port"` agent port option keeps the configured approval port authoritative when a run resumes. By default a step that suspended for approval takes the decision the resuming caller sends in `resume.approval`. Over A2A, or on a public AG-UI or `mountAgent` route, that caller can be the party asking for the tool. With `resumeApproval: "port"` the approval port is asked again and receives the caller's decision as `callerDecision`, and its verdict stands. Without a port, such a resume suspends again.
