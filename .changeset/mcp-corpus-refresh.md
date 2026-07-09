---
"@nifrajs/cli": patch
---

fix(cli): refresh the `nifra mcp` types/examples corpus for the 1.3.0 API + gate it

`@nifrajs/cli` bundles the MCP corpus (`docs/types.json` / `examples.json`) behind `nifra_types` and
`nifra_context`. It shipped **stale in 1.3.0** — the release regenerated `api-reference.md` + the LLM cards
but not this corpus — so agents couldn't see `server().tool()` / `.resource()` / `.prompt()`,
`onValidationError`, `RouteSchema.errors`, `ToolAnnotations`, or `generateLlmsTxt` via MCP. Regenerated.

To prevent recurrence: `changeset:publish` now runs `gen:llms` after the build, so every published tarball
carries a corpus regenerated from that exact build — the corpus can no longer ship stale regardless of what's
committed.
