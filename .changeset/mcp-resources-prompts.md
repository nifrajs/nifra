---
"@nifrajs/core": minor
"@nifrajs/cli": minor
---

feat: `server().resource()` / `.prompt()` — app-declared MCP resources & prompts

Completing the MCP trio alongside `.tool()`: an app can now expose its own MCP **resources**
(`.resource(uri, { name, description?, mimeType? }, read)`) and **prompts** (`.prompt(name, { description,
arguments? }, handler)`). `nifra mcp` surfaces them in `resources/list` + `resources/read` and `prompts/list`
+ `prompts/get` (namespaced per app in a monorepo). The `read`/`handler` closures run in the app process, so
they capture whatever app state they need — no HTTP round-trip.
