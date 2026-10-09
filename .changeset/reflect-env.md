---
"@nifrajs/cli": minor
---

CLI commands that import the app only to read its declarations (`check`, `routes`, `context`, `openapi`, `contracts`, `capabilities`, `manifest`, `doctor`, `diff`, `sync-routes`, `sync-manifest`, and `assure` without its bundle flags) set `NIFRA_REFLECT` to the command name first, so app code can skip connecting to its services. A catalog command whose app keeps the process open after the command has answered (a client that reconnects, an interval) now exits 2 seconds later with its own exit code and a note, instead of running until it is killed.
