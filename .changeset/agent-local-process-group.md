---
"@nifrajs/agent": patch
---

`createLocalProcessAdapter()` bounds a run by everything the command starts:

- On POSIX each run leads its own process group. A timeout or cancel signals the whole group, so a shell's background or nested processes end with it and the result arrives within `timeMs` plus the kill grace. Runs still in flight are ended when the host process exits. Windows still signals only the direct child.
- A process that leaves the group but keeps the output pipes open no longer holds the result past the kill grace.
- A `timeMs` above setTimeout's range (about 24.8 days) waits the full budget instead of timing out at once.
