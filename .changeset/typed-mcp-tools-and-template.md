---
"@nifrajs/mcp": minor
"create-nifra": minor
---

Schema-typed MCP tools, and the default template demonstrates the contract.

- `defineMcpTool` accepts `input`: a Standard Schema (nifra's `t`, zod, valibot, arktype, …) that
  validates every call's arguments before the handler runs and types the handler's `args`. Invalid
  arguments return an in-band `isError` result naming each issue, so a calling agent can correct
  and retry. Schemas that carry a JSON Schema (nifra's `t` does) become the advertised
  `inputSchema` automatically; an explicit `inputSchema` still overrides. The raw
  `inputSchema`-only form keeps working unchanged.
- The `api` template's app now ships a `t`-validated route (body + response schemas) and its tests
  drive the app through `testClient` - the contract-first pitch is visible in the first file a new
  user opens, not just the docs.
