---
"@nifrajs/cli": patch
---

When `nifra mcp` hands the session to the project's own `@nifrajs/cli` (the project installs another release), that CLI now runs with no `.env` files loaded, the same as the server itself. Before, the hand-off started the project's `node_modules/.bin/nifra` shim, whose Bun loaded the project's `.env`, and the inherited marker then told that CLI the values were already gone, so the project's secrets stayed inside the MCP process. The hand-off now runs the script the package's `bin` names with `bun --no-env-file`.
