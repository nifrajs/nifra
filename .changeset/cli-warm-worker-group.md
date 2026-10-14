---
"@nifrajs/cli": patch
---

Stopping a warm `nifra_run`/`nifra_render` worker now ends the processes the app started too. The worker was signalled alone, so a child process the backend spawned kept running after the worker exited (and after the MCP server closed). It now runs in its own process group, which gets SIGTERM and then SIGKILL after the grace period, and a terminal signal to the server reaches it.
