---
"@nifrajs/cli": patch
---

The `nifra mcp` server process never evaluates `nifra.config.ts`. Monorepo detection, the app's own tools, resources and prompts, and `nifra_context`, `nifra_routes` and `nifra_scaffold` read the config in a short-lived subprocess that answers with plain data and exits, so anything the config does when imported (reading `.env` secrets, opening a connection, calling `process.exit`) happens there and not in the long-lived server. An invalid config reports the same error as before. A config that exits or hangs is reported as an error, and the server keeps running.
