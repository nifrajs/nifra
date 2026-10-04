---
"@nifrajs/agent": patch
---

`createLocalProcessAdapter()` runs end every process the command started: on POSIX a background process the command leaves behind is stopped when the run ends, as it already was on a timeout or cancel. On Windows a timeout or cancel now ends the command's whole process tree with `taskkill /T /F` instead of only the direct child.
