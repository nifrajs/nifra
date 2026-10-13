---
"@nifrajs/cli": minor
"create-nifra": minor
---

A project that declares `@nifrajs/cli` now launches its MCP server as `bunx @nifrajs/cli mcp`, with no version pin. `bunx` runs the CLI the project installs, so the server moves with every upgrade and the launch never goes stale. New scaffolds and `nifra init-agents` write this form. `nifra init-agents --sync-mcp` and `nifra upgrade --write` drop an existing pin in such a project, and `nifra doctor` points out a pin that is left. A project that does not declare the CLI keeps the exact-version pin, since an unpinned `bunx` there would run a cached `latest`. A launch in a workspace root's files stays pinned too, because the root need not hold the CLI's bin. `create-nifra/agent-files`: `mcpConfig(pin?)`, `mcpJson(pin?)` and `agentsMcpSection(pin?)` take an optional pin. `MCP_CONFIG` is now the unpinned config a scaffold writes.
