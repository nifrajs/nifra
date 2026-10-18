---
"@nifrajs/agent-app": patch
---

When the transport's `authorize()` callback throws, `command()` and `stream()` now reject with an `AgentTransportError` reading `authorize() failed`, before any request is sent. The callback's own message used to be forwarded into the error, and a failed token refresh often names the credential it was refreshing.
