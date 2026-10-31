---
"@nifrajs/cli": minor
---

When the project installs a different `@nifrajs/cli` during an MCP session, `nifra mcp` starts that CLI, replays the handshake to it, and serves the rest of the session from it, then sends `notifications/tools/list_changed`. Before, the server went on listing and running the tools of the release it started with until it was restarted. A project CLI that does not answer the handshake leaves the session where it was.
