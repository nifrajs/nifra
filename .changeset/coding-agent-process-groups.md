---
"@nifrajs/coding-agent": patch
---

`runNifraVerification`, `runNifraReview`, `runNifraContext` and `readProjectDiff` run their command as the leader of its own process group on POSIX. A timeout sends SIGTERM to the whole group, then SIGKILL after a grace period of up to 2 seconds, and stops waiting on output pipes once the command is gone, so a child that ignores SIGTERM or leaves a process behind no longer keeps the call pending.
