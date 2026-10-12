---
"@nifrajs/cli": patch
---

`nifra mcp` now answers `initialize` (and `ping`) straight away while the app loads in the background, and a monorepo's apps load side by side. Before, the server read the app's declared tools before it answered anything, one app after another, so a backend whose import awaited a database connection held up the handshake for as long as the import took (up to 30 seconds per app), and an MCP client could give up on the server. Tool, resource and prompt calls still wait for the app as before.
