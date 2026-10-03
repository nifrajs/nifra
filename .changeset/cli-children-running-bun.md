---
"@nifrajs/cli": patch
---

`nifra_run`, `nifra_render`, `nifra_ws`, `nifra_test`, the `nifra check` typecheck and the `nifra fix` rebuild and codemod start their child processes with the Bun that runs nifra, not the first `bun` on `PATH`. An MCP client that starts `nifra mcp` with a minimal `PATH` no longer breaks them, and a `bun` shim earlier on `PATH` is never picked up.
