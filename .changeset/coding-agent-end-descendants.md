---
"@nifrajs/coding-agent": patch
---

A command that exits normally no longer leaves the processes it started running: on POSIX its process group gets SIGTERM, then SIGKILL after two seconds. A background process that held the output open no longer delays the call by the drain grace.
