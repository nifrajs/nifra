---
"@nifrajs/cli": patch
---

The MCP tools that run project code in a subprocess (`nifra_test`, `nifra_run`, `nifra_render`, `nifra_ws`, the database tools and the app's own tools) end on time when their timeout or a cancel fires. A process the project started could hold the output pipes open after its parent was killed, so a 2 second `nifra_test` timeout took as long as that process lived. On macOS and Linux these subprocesses now lead their own process group, and stopping one stops everything it started. `nifra_test` follows a SIGTERM with SIGKILL after two seconds.
