---
"@nifrajs/coding-agent": patch
---

The coding agent's bounded commands (`nifra context`, `nifra review`, the verification gates, the diff reader) now finish when the command itself exits. Before, a command that exited cleanly but left a background process holding its output open was waited on until the full timeout and then reported as timed out, even though it had succeeded. Its output is still read for two seconds after the exit; past that the leftover process is no longer waited on, and the result carries the command's real exit status with `timedOut: false`.
