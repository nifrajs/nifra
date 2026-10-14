---
"@nifrajs/cli": patch
---

`nifra mcp` no longer hangs at startup in a project whose bunfig preload keeps its process alive. The probes that tell which variables the project's `.env` files set ran the project's preloads and waited for the process to end; they now skip the project's bunfig, exit as soon as they have printed, and are bounded in time and output. A probe that still fails stops the server with an error naming the cause, instead of serving with values it cannot attribute.
