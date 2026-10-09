---
"@nifrajs/cli": patch
---

`nifra replay` and the `nifra_replay` MCP tool now work in a project reached through a symlinked directory, and refuse a replay file that is itself a link out of the project.
