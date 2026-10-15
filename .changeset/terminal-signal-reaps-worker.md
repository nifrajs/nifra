---
"@nifrajs/cli": patch
---

A `nifra` server that takes SIGTERM or Ctrl+C waits for the warm worker it had to SIGKILL to exit before it ends, so the worker is gone when the server is, instead of lingering in the process table until its new parent reaps it.
