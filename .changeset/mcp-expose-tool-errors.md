---
"@nifrajs/mcp": minor
"@nifrajs/cli": patch
---

`handleRpc` takes `exposeToolErrors`, which answers a throwing tool with `Tool execution failed: <message>` instead of the bare text. It is off by default, so a remote caller still sees nothing from an error message. `nifra mcp` turns it on for its stdio server, so the local agent sees why a project tool failed, for example the error that stopped the backend from loading.
