---
"@nifrajs/mcp": minor
"@nifrajs/cli": patch
---

`defineMcpTool` accepts `annotations` (the MCP tool safety hints - `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`, `title`), surfaced in `tools/list` and `tools/describe`. Hosts use these to pick confirmation UX, and connector directory reviews expect every tool to declare them. The hosted docs tools (`nifra_docs`, `nifra_example`, `nifra_types`, `nifra_learn`, `nifra_examples_app`) now all declare themselves read-only and closed-world.
