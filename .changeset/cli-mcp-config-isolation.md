---
"@nifrajs/cli": patch
---

The `nifra mcp` server process never evaluates `nifra.config.ts`. Monorepo detection, the app's own tools, resources and prompts, and `nifra_context`, `nifra_routes` and `nifra_scaffold` read the config in a short-lived subprocess that answers with plain data and exits, so anything the config does when imported (opening a connection, starting a timer, calling `process.exit`) happens there and not in the long-lived server. The config is read again only after `nifra.config.ts` or `backend/framework.ts` changes, so editing `backend/app.ts` does not run it. An invalid config reports the same error as before. A config that exits or hangs is reported as an error, and the server keeps running.
