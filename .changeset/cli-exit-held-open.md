---
"@nifrajs/cli": patch
---

`nifra build`, `nifra sdk` and `nifra upgrade --write` now exit once they finish, even when the app they imported keeps the process alive (a database or Redis client, an interval). nifra waits two seconds, says on stderr what is holding the process, and exits with the command's own exit code, as the read-only commands such as `nifra routes` already did. Before, these commands finished their work and then never exited, so a CI step or script running them hung.
