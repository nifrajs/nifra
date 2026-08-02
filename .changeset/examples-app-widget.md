---
"@nifrajs/cli": minor
---

The self-hosted docs MCP (`nifra docs-mcp` / `handleMcpHttp`) now serves `nifra_examples_app`, an MCP Apps widget that renders the verified code examples as an interactive, filterable list in hosts that support it; text-only hosts still get the example names. It reads the same bundled examples corpus as `nifra_example`, so every self-host exposes it from one definition.
