---
"@nifrajs/agent": patch
---

`runModelGateway` gives each attempt its own abort signal and aborts it when the deadline passes or the caller cancels, so an adapter that honours `request.signal` stops working on a request whose result would be discarded. The deadline also covers the structured-output parser: a parse that finishes after it returns `timeout` instead of success.
