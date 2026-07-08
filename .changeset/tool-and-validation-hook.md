---
"@nifrajs/core": minor
---

feat(core): `onValidationError` route hook + `server().tool()`

Two additions for building agent-facing endpoints on Nifra:

- **`onValidationError` route hook**: a `RouteSchema` callback that runs when a request fails schema
  validation. It receives the Standard Schema issues and the request context, and may return a `Response`
  (short-circuit the route), a repaired payload (re-validated before dispatch — still invalid → the original
  `422` stands), or `undefined` (keep the `422`). Makes validation recovery pluggable instead of every
  handler re-checking by hand.

- **`server().tool(name, config, handler)`**: register a `.tool()` route (`POST /_nifra/tool/:name`) with
  typed `input`/`output` Standard Schemas. The handler's `input` is inferred from the input schema; the
  descriptor is tagged as an MCP tool so `nifra mcp` exposes it in `tools/list`.
