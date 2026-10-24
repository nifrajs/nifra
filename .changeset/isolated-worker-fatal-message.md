---
"@nifrajs/coding-agent": patch
---

An isolated extension whose module fails to load rejects `start()` with the module's own error, as documented. Under load it could instead reject with `isolated extension worker exited with code 1`: the worker's exit could be seen before its error line was read, and the worker could exit before that line was written. The worker now exits once the line is written, and the exit is reported only after the worker's output is read.
