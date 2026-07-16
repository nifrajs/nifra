---
"@nifrajs/agent-telemetry": major
"@nifrajs/cli": major
"@nifrajs/mcp": major
"@nifrajs/middleware": major
"@nifrajs/otel": major
"@nifrajs/web": major
"nifra": major
---

Remove Nifra's remaining deprecated and compatibility-only public surfaces for the 2.0 cutover.

- `@nifrajs/core` and `nifra` now expose only the lean HTTP server API at their package roots. Import
  optional systems from their documented subpaths. The deprecated invariant runner and the
  `@nifrajs/budget` compatibility package are removed; use `@nifrajs/testing` and
  `@nifrajs/core/budget` respectively.
- Web redirects accept only an options object as their second argument, the prerender enumeration
  wrapper is removed in favor of `enumerateStaticRoutes()`, and fragment navigation resolves IDs only.
- MCP Apps metadata uses only `_meta.ui.resourceUri`; the deprecated flat `ui/resourceUri` key is gone.
- Telemetry uses `ObservationAdapter` directly; the `AgentSpan`, `AgentSpanExporter`, and `SpanExporter`
  aliases are removed.
- Invalid HTTP method overrides always fail closed with 400; the legacy ignore mode is removed.
- `nifra build` always emits a complete target deploy directory and defaults to Bun. The old
  client-only build branch is removed; `nifra start` runs the generated Bun `server.js`.
